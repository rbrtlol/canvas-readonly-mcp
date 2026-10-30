// Download Canvas files and turn them into text (PDF, DOCX, PPTX, plain text/code, ZIP listing),
// with an on-disk cache keyed by file id + updated_at so repeated reads are cheap.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { unzipSync } from "fflate";
import { getDocumentProxy } from "unpdf";
import { CanvasClient, CanvasError, decodeEntities, htmlToText } from "./canvas.js";
import { log } from "./log.js";

// Bump when extraction output changes so stale cache entries are ignored.
const EXTRACTOR_VERSION = 2;
const TEXT_LINES_PER_UNIT = 150;
// Units longer than this are split so any part can be read within max_chars.
const MAX_UNIT_CHARS = 12_000;

export interface Unit {
  label?: string;
  text: string;
}

export interface Extracted {
  kind: "pdf" | "docx" | "pptx" | "text" | "zip";
  /** What one unit is called in output and page ranges: page, slide, section, lines. */
  unit: string;
  units: Unit[];
  note?: string;
}

export interface CacheEntry {
  v: number;
  file_id: string;
  updated_at: string;
  display_name: string;
  content_type: string;
  extracted: Extracted;
}

export interface ExtractOptions {
  /** Stop after this many PDF pages / slides (the rest is reported in a note). */
  maxPages?: number;
}

export interface FileReaderOptions extends ExtractOptions {
  cacheDir?: string;
  /** Evict least recently used cache entries beyond this many bytes. */
  cacheMaxBytes?: number;
  maxBytes: number;
  /** Download timeout. */
  timeoutMs: number;
  /** Extraction timeout; extraction runs in a worker thread with a memory limit. */
  extractTimeoutMs?: number;
  /** false runs extraction in-process (tests). */
  useWorker?: boolean;
}

const TEXT_EXT =
  /\.(txt|md|markdown|rst|csv|tsv|json|ya?ml|toml|ini|cfg|xml|tex|bib|py|ipynb|m|c|h|cc|cpp|hpp|java|js|mjs|ts|sh|r|jl|rs|go|sql|log|html?)$/i;

export class FileReader {
  private cacheOk: boolean;

  constructor(private canvas: CanvasClient, private opts: FileReaderOptions) {
    this.cacheOk = Boolean(opts.cacheDir);
  }

  async read(courseId: string, fileId: string): Promise<{ meta: any; entry: CacheEntry; cached: boolean }> {
    return this.readWithMeta(fileId, await this.metadata(courseId, fileId));
  }

  /** Like read(), for callers that already hold the file's Canvas metadata. */
  async readWithMeta(fileId: string, meta: any): Promise<{ meta: any; entry: CacheEntry; cached: boolean }> {
    if (meta.locked_for_user) {
      throw new CanvasError(403, `File ${meta.display_name} is locked: ${htmlToText(meta.lock_explanation) || "not available yet"}`);
    }
    if (!meta.url) throw new CanvasError(403, `Canvas gave no download URL for ${meta.display_name} (locked or hidden for your role)`);
    if (meta.size > this.opts.maxBytes) {
      throw new CanvasError(413, `${meta.display_name} is ${(meta.size / 1048576).toFixed(1)} MB, over the ${this.opts.maxBytes / 1048576} MB limit`);
    }

    const key = `${meta.updated_at}|${meta.modified_at}|${meta.size}|${EXTRACTOR_VERSION}`;
    const cachePath = this.cacheOk
      ? join(this.opts.cacheDir!, `${fileId}_${createHash("sha256").update(key).digest("hex").slice(0, 16)}.json`)
      : null;
    if (cachePath) {
      const hit = await readFile(cachePath, "utf8").then(JSON.parse, () => null);
      if (hit?.v === EXTRACTOR_VERSION) {
        const now = new Date();
        await utimes(cachePath, now, now).catch(() => {}); // mtime = last use, for LRU eviction
        return { meta, entry: hit, cached: true };
      }
    }

    const { bytes, contentType } = await this.canvas.download(meta.url, this.opts);
    const ct = meta["content-type"] || contentType || "application/octet-stream";
    const name = meta.display_name ?? meta.filename ?? "";
    const opts = { maxPages: this.opts.maxPages };
    const extracted =
      this.opts.useWorker === false
        ? await extract(bytes, ct, name, opts)
        : await extractInWorker(bytes, ct, name, opts, this.opts.extractTimeoutMs ?? 60_000);
    const entry: CacheEntry = {
      v: EXTRACTOR_VERSION,
      file_id: fileId,
      updated_at: meta.updated_at,
      display_name: meta.display_name,
      content_type: ct,
      extracted,
    };
    if (cachePath) await this.store(fileId, cachePath, entry);
    return { meta, entry, cached: false };
  }

  private async metadata(courseId: string, fileId: string): Promise<any> {
    try {
      return await this.canvas.get(`/api/v1/courses/${courseId}/files/${fileId}`);
    } catch (e) {
      // A file linked from the course may live in another context (user/group files).
      if (e instanceof CanvasError && (e.status === 404 || e.status === 403)) {
        return this.canvas.get(`/api/v1/files/${fileId}`).catch(() => {
          throw e;
        });
      }
      throw e;
    }
  }

  private async store(fileId: string, path: string, entry: CacheEntry) {
    try {
      await mkdir(this.opts.cacheDir!, { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(entry));
      await rename(tmp, path);
      // Drop older versions of the same file.
      for (const name of await readdir(this.opts.cacheDir!)) {
        if (name.startsWith(`${fileId}_`) && join(this.opts.cacheDir!, name) !== path) {
          await unlink(join(this.opts.cacheDir!, name)).catch(() => {});
        }
      }
      await this.evict();
    } catch (e) {
      log(`File cache disabled (${(e as Error).message})`);
      this.cacheOk = false;
    }
  }

  /** Delete least recently used entries until the cache fits in cacheMaxBytes. */
  private async evict() {
    const cap = this.opts.cacheMaxBytes;
    if (!cap) return;
    const dir = this.opts.cacheDir!;
    const files = await Promise.all(
      (await readdir(dir)).filter((n) => n.endsWith(".json")).map(async (n) => ({ path: join(dir, n), ...(await stat(join(dir, n))) })),
    );
    let total = files.reduce((sum, f) => sum + f.size, 0);
    for (const f of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= cap) break;
      await unlink(f.path).catch(() => {});
      total -= f.size;
    }
  }
}

/**
 * Run extract() in a worker thread so a malformed or hostile file can't block the server or
 * exhaust its memory: the worker has a heap limit and is terminated on timeout.
 */
export function extractInWorker(
  bytes: Uint8Array,
  contentType: string,
  name: string,
  opts: ExtractOptions,
  timeoutMs: number,
): Promise<Extracted> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./extract-worker.js", import.meta.url), {
      workerData: { bytes, contentType, name, opts },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new CanvasError(504, `Extracting ${name} took longer than ${timeoutMs / 1000}s; gave up`));
    }, timeoutMs);
    worker.once("message", (m: { ok: true; result: Extracted } | { ok: false; status: number; message: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (m.ok) resolve(m.result);
      else reject(new CanvasError(m.status, m.message));
    });
    worker.once("error", (e: Error) => {
      clearTimeout(timer);
      reject(new CanvasError(500, `Extracting ${name} failed: ${e.message}`));
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new CanvasError(500, `Extracting ${name} failed (worker exited with code ${code}, likely out of memory)`));
    });
  });
}

export async function extract(bytes: Uint8Array, contentType: string, name: string, opts: ExtractOptions = {}): Promise<Extracted> {
  const x = await extractRaw(bytes, contentType, name, opts);
  return { ...x, units: x.units.flatMap(splitLong) };
}

function splitLong(u: Unit): Unit[] {
  if (u.text.length <= MAX_UNIT_CHARS) return [u];
  const parts: string[] = [];
  let cur = "";
  for (const line of u.text.split("\n")) {
    if (cur && cur.length + line.length + 1 > MAX_UNIT_CHARS) {
      parts.push(cur);
      cur = "";
    }
    // A single enormous line (minified code, etc.) gets hard-wrapped.
    for (let i = 0; i < line.length; i += MAX_UNIT_CHARS) {
      const piece = line.slice(i, i + MAX_UNIT_CHARS);
      if (i > 0) {
        parts.push(cur);
        cur = "";
      }
      cur += (cur ? "\n" : "") + piece;
    }
    if (!line) cur += "\n";
  }
  if (cur) parts.push(cur);
  return parts.map((text, k) => ({ label: `${u.label ? `${u.label} ` : ""}(part ${k + 1}/${parts.length})`, text }));
}

async function extractRaw(bytes: Uint8Array, contentType: string, name: string, opts: ExtractOptions): Promise<Extracted> {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  const lower = name.toLowerCase();
  const maxPages = opts.maxPages ?? Infinity;
  if (ct === "application/pdf" || lower.endsWith(".pdf")) return extractPdf(bytes, maxPages);
  if (ct.includes("wordprocessingml") || lower.endsWith(".docx")) return extractDocx(bytes);
  if (ct.includes("presentationml") || lower.endsWith(".pptx")) return extractPptx(bytes, maxPages);
  if (ct === "application/zip" || ct === "application/x-zip-compressed" || lower.endsWith(".zip")) return listZip(bytes);
  if (ct.startsWith("text/") || ct === "application/json" || ct === "application/xml" || TEXT_EXT.test(lower)) {
    let text = new TextDecoder("utf-8").decode(bytes);
    if (ct === "text/html" || /\.html?$/.test(lower)) text = htmlToText(text, Infinity);
    return splitLines(text);
  }
  throw new CanvasError(
    415,
    `Can't extract text from ${name || "this file"} (${ct}). Supported: PDF, DOCX, PPTX, plain text/code, ZIP (listing).` +
      (lower.endsWith(".doc") || lower.endsWith(".ppt") ? " Legacy .doc/.ppt binary formats aren't supported." : ""),
  );
}

// ---- PDF ----

async function extractPdf(bytes: Uint8Array, maxPages: number): Promise<Extracted> {
  const doc = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  const total = doc.numPages;
  const units: Unit[] = [];
  let empty = 0;
  try {
    for (let i = 1; i <= Math.min(total, maxPages); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let out = "";
      let lastY: number | null = null;
      let lastXEnd: number | null = null;
      for (const item of content.items as any[]) {
        if (typeof item.str !== "string") continue;
        const x = item.transform[4];
        const y = item.transform[5];
        const h = item.height || 10;
        if (item.str) {
          if (lastY !== null && Math.abs(y - lastY) > h * 0.5) out += "\n";
          else if (lastXEnd !== null && x - lastXEnd > h * 0.15 && !/\s$/.test(out) && !/^\s/.test(item.str)) out += " ";
          out += item.str;
          lastY = y;
          lastXEnd = x + item.width;
        }
        if (item.hasEOL) {
          out += "\n";
          lastY = null;
          lastXEnd = null;
        }
      }
      page.cleanup();
      const text = tidy(out);
      if (text.replace(/\s/g, "").length < 3) {
        empty++;
        units.push({ text: "[no text layer on this page — probably an image or scan]" });
      } else {
        units.push({ text });
      }
    }
  } finally {
    await doc.loadingTask.destroy();
  }
  return {
    kind: "pdf",
    unit: "page",
    units,
    ...noteOf([
      empty ? `${empty} page(s) have no text layer (images/scans); OCR is not enabled.` : "",
      total > maxPages ? `Only the first ${maxPages} of ${total} pages were extracted (EXTRACT_MAX_PAGES).` : "",
    ]),
  };
}

const noteOf = (notes: string[]) => {
  const note = notes.filter(Boolean).join(" ");
  return note ? { note } : {};
};

// ---- Office (OOXML) ----

function unzipSome(bytes: Uint8Array, want: (name: string) => boolean): Record<string, string> {
  let total = 0;
  const files = unzipSync(bytes, {
    filter: (f) => {
      if (!want(f.name)) return false;
      total += f.originalSize;
      if (total > 200 * 1048576) throw new CanvasError(413, "Archive expands to more than 200 MB; refusing to extract");
      return true;
    },
  });
  const dec = new TextDecoder("utf-8");
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, dec.decode(v)]));
}

const xmlText = (xml: string) => decodeEntities(xml.replace(/<[^>]+>/g, ""));

/**
 * Heading level per paragraph style, from the outline level Word stores in styles.xml. This works
 * whatever language the style names are in ("Heading 1", "Rubrik 1", "Überschrift 1", …).
 */
function docxHeadingStyles(stylesXml: string | undefined): Map<string, number> {
  const levels = new Map<string, number>();
  for (const m of (stylesXml ?? "").matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const lvl = m[2].match(/<w:outlineLvl w:val="(\d)"/)?.[1];
    if (lvl !== undefined && Number(lvl) < 9) levels.set(m[1], Number(lvl) + 1);
    else if (/^title$/i.test(m[1]) || /<w:name w:val="Title"/.test(m[2])) levels.set(m[1], 1);
  }
  return levels;
}

function extractDocx(bytes: Uint8Array): Extracted {
  const files = unzipSome(bytes, (n) => n === "word/document.xml" || n === "word/styles.xml");
  const xml = files["word/document.xml"];
  if (!xml) throw new CanvasError(422, "Not a valid DOCX (word/document.xml missing)");
  const headingStyles = docxHeadingStyles(files["word/styles.xml"]);
  const sections: Unit[] = [{ text: "" }];
  const body = xml.replace(/<w:tab\/>/g, "<w:t>\t</w:t>").replace(/<w:br[^>]*\/>/g, "<w:t>\n</w:t>");
  for (const m of body.matchAll(/<w:p[ >][\s\S]*?<\/w:p>|<\/w:tc>|<\/w:tr>/g)) {
    const p = m[0];
    const cur = sections[sections.length - 1];
    if (p === "</w:tc>") {
      cur.text = cur.text.replace(/\n$/, "") + " | ";
      continue;
    }
    if (p === "</w:tr>") {
      cur.text = cur.text.replace(/ \| $/, "") + "\n";
      continue;
    }
    const text = [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((t) => decodeEntities(t[1])).join("");
    const style = p.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? "";
    const direct = p.match(/<w:outlineLvl w:val="(\d)"/)?.[1];
    const byName = /^(heading|title)\s*(\d?)$/i.exec(style); // documents without styles.xml
    const level =
      direct !== undefined && Number(direct) < 9
        ? Number(direct) + 1
        : (headingStyles.get(style) ?? (byName ? Number(byName[2] || 1) : undefined));
    if (level !== undefined && text.trim()) {
      const hasBody = cur.text.split("\n").some((l) => l.trim() && !l.startsWith("#"));
      if (level <= 2 && hasBody) sections.push({ label: text.trim(), text: "" });
      else if (level <= 2) cur.label = cur.label ? `${cur.label} ${text.trim()}` : text.trim();
      sections[sections.length - 1].text += `${"#".repeat(level + 1)} ${text.trim()}\n`;
    } else {
      cur.text += `${text}\n`;
    }
  }
  const units = sections.map((s) => ({ ...s, text: tidy(s.text) })).filter((s) => s.text);
  return { kind: "docx", unit: "section", units: units.length ? units : [{ text: "" }] };
}

function relsMap(xml: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of (xml ?? "").matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = m[1].match(/\bId="([^"]+)"/)?.[1];
    const target = m[1].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) map.set(id, target);
  }
  return map;
}

function resolveZipPath(fromDir: string, target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : `${fromDir}/${target}`).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}

function drawingMlText(xml: string, skipPlaceholders: RegExp = /$^/): string {
  const shapes = xml.match(/<p:(?:sp|graphicFrame)\b[\s\S]*?<\/p:(?:sp|graphicFrame)>/g) ?? [];
  const lines: string[] = [];
  for (const shape of shapes) {
    const ph = shape.match(/<p:ph\b[^>]*type="([^"]+)"/)?.[1];
    if (ph && skipPlaceholders.test(ph)) continue;
    const s = shape.replace(/<a:br\/>/g, "<a:t>\n</a:t>").replace(/<\/a:tc>/g, "<a:t> | </a:t>").replace(/<\/a:tr>/g, "<a:p></a:p>");
    for (const p of s.match(/<a:p>[\s\S]*?<\/a:p>|<a:p\/>/g) ?? []) {
      const t = [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeEntities(m[1])).join("");
      if (t.trim()) lines.push(t.replace(/ \| $/, ""));
    }
  }
  return tidy(lines.join("\n"));
}

function extractPptx(bytes: Uint8Array, maxPages: number): Extracted {
  const files = unzipSome(
    bytes,
    (n) =>
      n === "ppt/presentation.xml" ||
      n === "ppt/_rels/presentation.xml.rels" ||
      /^ppt\/(slides|notesSlides)\/(_rels\/)?[^/]+\.xml(\.rels)?$/.test(n),
  );
  const pres = files["ppt/presentation.xml"];
  if (!pres) throw new CanvasError(422, "Not a valid PPTX (ppt/presentation.xml missing)");
  const rels = relsMap(files["ppt/_rels/presentation.xml.rels"]);
  let slidePaths = [...pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)]
    .map((m) => rels.get(m[1]))
    .filter((t): t is string => Boolean(t))
    .map((t) => resolveZipPath("ppt", t));
  if (!slidePaths.length) {
    slidePaths = Object.keys(files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/\d+/g)!.pop()) - Number(b.match(/\d+/g)!.pop()));
  }

  const total = slidePaths.length;
  const units: Unit[] = slidePaths.slice(0, maxPages).map((path) => {
    const xml = files[path] ?? "";
    const titleShape = xml.match(/<p:sp\b(?:(?!<\/p:sp>)[\s\S])*?<p:ph\b[^>]*type="(?:title|ctrTitle)"[\s\S]*?<\/p:sp>/)?.[0];
    const title = titleShape ? xmlText(titleShape.replace(/<a:br\/>/g, " ")).replace(/\s+/g, " ").trim() : undefined;
    let text = drawingMlText(xml);
    const dir = path.slice(0, path.lastIndexOf("/"));
    const slideRels = relsMap(files[`${dir}/_rels/${path.slice(dir.length + 1)}.rels`]);
    const notesTarget = [...slideRels.values()].find((t) => t.includes("notesSlide"));
    if (notesTarget) {
      const notes = drawingMlText(files[resolveZipPath(dir, notesTarget)] ?? "", /^(sldImg|sldNum|hdr|ftr|dt)$/);
      if (notes) text += `\n\n[speaker notes]\n${notes}`;
    }
    return { ...(title ? { label: title } : {}), text: text || "[no text on this slide]" };
  });
  return {
    kind: "pptx",
    unit: "slide",
    units,
    ...noteOf([total > maxPages ? `Only the first ${maxPages} of ${total} slides were extracted (EXTRACT_MAX_PAGES).` : ""]),
  };
}

// ---- other ----

function listZip(bytes: Uint8Array): Extracted {
  const entries: string[] = [];
  unzipSync(bytes, {
    filter: (f) => {
      entries.push(`${f.name}${f.name.endsWith("/") ? "" : `  (${f.originalSize} bytes)`}`);
      return false;
    },
  });
  const units = splitLines(entries.join("\n")).units;
  return {
    kind: "zip",
    unit: "lines",
    units,
    note: "ZIP archive: showing the file listing only (contents are not extracted).",
  };
}

function splitLines(text: string): Extracted {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const units: Unit[] = [];
  for (let i = 0; i < lines.length; i += TEXT_LINES_PER_UNIT) {
    const end = Math.min(i + TEXT_LINES_PER_UNIT, lines.length);
    units.push({ label: `lines ${i + 1}-${end}`, text: lines.slice(i, end).join("\n") });
  }
  return { kind: "text", unit: "lines", units: units.length ? units : [{ text: "" }] };
}

function tidy(s: string): string {
  return s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- rendering ----

/** Parse "1-5", "3", "2-4,9", "7-" against a total; returns 0-based indices. */
export function parseRange(spec: string | undefined, total: number): number[] {
  if (!spec?.trim()) return Array.from({ length: total }, (_, i) => i);
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = part.trim().match(/^(\d+)?\s*(-)?\s*(\d+)?$/);
    if (!m || (!m[1] && !m[3])) throw new CanvasError(400, `Bad page range "${part}" — use e.g. "1-5" or "3,7-9"`);
    const from = Number(m[1] ?? 1);
    const to = m[2] ? Number(m[3] ?? total) : from;
    if (from < 1 || from > total) throw new CanvasError(400, `Page ${from} is out of range (1-${total})`);
    for (let i = from; i <= Math.min(to, total); i++) out.add(i - 1);
  }
  return [...out].sort((a, b) => a - b);
}

export function render(
  entry: CacheEntry,
  opts: { pages?: string; maxChars: number; cached: boolean },
): string {
  const x = entry.extracted;
  const total = x.units.length;
  const idx = parseRange(opts.pages, total);
  const multi = total > 1 || x.kind !== "text";
  const unitName = x.unit === "lines" ? "part" : x.unit;
  let body = "";
  let truncatedAt: number | null = null;
  for (const i of idx) {
    const u = x.units[i];
    const marker = multi ? `\n--- ${unitName} ${i + 1}/${total}${u.label ? `: ${u.label}` : ""} ---\n` : "";
    const chunk = `${marker}${u.text}\n`;
    if (body.length + chunk.length > opts.maxChars) {
      body += chunk.slice(0, Math.max(0, opts.maxChars - body.length));
      truncatedAt = i;
      break;
    }
    body += chunk;
  }
  const shown = idx.length ? `${idx[0] + 1}-${(truncatedAt ?? idx[idx.length - 1]) + 1}` : "none";
  const header = [
    `display_name: ${entry.display_name}`,
    `file_id: ${entry.file_id}`,
    `content_type: ${entry.content_type}`,
    `updated_at: ${entry.updated_at}`,
    `${unitName}s: ${total} (showing ${shown})`,
    `truncated: ${truncatedAt !== null}`,
    `cached: ${opts.cached}`,
    ...(x.note ? [`note: ${x.note}`] : []),
  ];
  const footer =
    truncatedAt !== null
      ? truncatedAt === idx[0]
        ? `\n…[truncated at ${opts.maxChars} chars inside ${unitName} ${truncatedAt + 1}; raise max_chars (up to 75000) to see all of it]`
        : `\n…[truncated at ${opts.maxChars} chars inside ${unitName} ${truncatedAt + 1}; continue with pages="${truncatedAt + 1}-${idx[idx.length - 1] + 1}"]`
      : "";
  return `${header.join("\n")}\n${body.trimEnd()}${footer}`;
}
