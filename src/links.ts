// Finding Canvas file links in HTML (pages, assignments, announcements), resolving the
// $CANVAS_OBJECT_REFERENCE$-style placeholders left behind by course copies, and crawling a
// course for linked files — students get 403 on the course files index, so links are the way in.

import { CanvasClient, CanvasError, decodeEntities } from "./canvas.js";

export interface FileLink {
  file_id: string;
  /** Course the link points into, when the URL says so (may differ from the page's course). */
  course_id?: string;
  text: string;
  title?: string;
}

export interface UnresolvedLink {
  placeholder: string;
  text?: string;
}

export interface HtmlAnalysis {
  /** HTML with file links rewritten to "file:<id>" and placeholders resolved or removed. */
  html: string;
  files: FileLink[];
  /** Slugs of pages in the same course that this HTML links to. */
  pages: string[];
  unresolved: UnresolvedLink[];
}

export interface LinkContext {
  base: string;
  courseId: string;
  /** Other origins of the same Canvas instance; links to them count as Canvas links. */
  aliases?: string[];
  /** Lower-cased module name -> module id, used to resolve module placeholders by link title. */
  modules?: Map<string, string>;
}

const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const ATTR_RE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const PLACEHOLDER_RE =
  /^(?:\$|%24)(CANVAS_OBJECT_REFERENCE|CANVAS_COURSE_REFERENCE|WIKI_REFERENCE|IMS-CC-FILEBASE|IMS_CC_FILEBASE)(?:\$|%24)(.*)$/i;
const MIGRATION_ID_RE = /\/i[0-9a-f]{32}\b/;
export const MODULE_PLACEHOLDER_RE = /(?:\$|%24)CANVAS_OBJECT_REFERENCE(?:\$|%24)\/modules\//i;

/**
 * Pull a file id out of anything that refers to a Canvas file: a bare id, a course/user file URL
 * (…/files/123?verifier=…&wrap=1, …/files/123/download, …/files/123/preview), an API endpoint
 * (/api/v1/files/123) or a $CANVAS_OBJECT_REFERENCE$/attachments/123 placeholder.
 */
export function parseFileRef(ref: string): { file_id: string; course_id?: string } | null {
  const s = decodeEntities(ref.trim());
  if (/^\d+$/.test(s)) return { file_id: s };
  const m = s.match(/(?:\/courses\/(\d+))?\/files\/(\d+)(?=[/?#&]|$)/);
  if (m) return { file_id: m[2], course_id: m[1] };
  const a = s.match(/(?:\$|%24)CANVAS_OBJECT_REFERENCE(?:\$|%24)\/attachments\/(\d+)/i);
  if (a) return { file_id: a[1] };
  return null;
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? "");
  return out;
}

const innerText = (html: string) =>
  decodeEntities(html.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();

/** A relative URL, or an absolute one on the Canvas base or one of its aliases. */
function isCanvasUrl(u: string, ctx: LinkContext): boolean {
  if (u.startsWith("/")) return !u.startsWith("//");
  return [ctx.base, ...(ctx.aliases ?? [])].some((o) => u === o || u.startsWith(`${o}/`));
}

function pageSlug(href: string, ctx: LinkContext): string | null {
  if (!isCanvasUrl(href, ctx)) return null;
  const m = href.match(/^(?:https?:\/\/[^/]+)?\/courses\/(\d+)\/(?:pages|wiki)\/([^/?#]+)/);
  if (!m || m[1] !== ctx.courseId) return null;
  try {
    return decodeURIComponent(m[2]);
  } catch {
    return m[2];
  }
}

/** Resolve a placeholder href to a real URL, or null if it can't be (e.g. a stale migration id). */
function resolvePlaceholder(href: string, title: string | undefined, ctx: LinkContext): string | null {
  const m = href.match(PLACEHOLDER_RE);
  if (!m) return href;
  const kind = m[1].toUpperCase();
  const rest = m[2];
  const course = `${ctx.base}/courses/${ctx.courseId}`;
  if (kind === "CANVAS_COURSE_REFERENCE" || kind === "WIKI_REFERENCE") {
    return MIGRATION_ID_RE.test(rest) ? null : course + rest;
  }
  if (kind === "CANVAS_OBJECT_REFERENCE") {
    const att = rest.match(/^\/attachments\/(\d+)/);
    if (att) return `${course}/files/${att[1]}`;
    if (rest.startsWith("/modules/") && title) {
      const id = ctx.modules?.get(title.trim().toLowerCase());
      if (id) return `${course}/modules#module_${id}`;
    }
  }
  return null;
}

/** Extract file/page links from Canvas HTML and rewrite it for readable text output. */
export function analyzeHtml(html: string | null | undefined, ctx: LinkContext): HtmlAnalysis {
  const files: FileLink[] = [];
  const pages = new Set<string>();
  const unresolved: UnresolvedLink[] = [];
  const seenFiles = new Set<string>();
  if (!html) return { html: "", files, pages: [], unresolved };

  const rewritten = html.replace(ANCHOR_RE, (whole, rawAttrs: string, inner: string) => {
    const attrs = parseAttrs(rawAttrs);
    const text = innerText(inner);
    let href = attrs.href ?? "";

    if (PLACEHOLDER_RE.test(href)) {
      const resolved = resolvePlaceholder(href, attrs.title, ctx);
      if (!resolved) {
        unresolved.push({ placeholder: decodeURIComponent(href.replace(/%24/gi, "$")), text: text || attrs.title });
        return text ? `${text} [broken link]` : "";
      }
      href = resolved;
    }

    const onCanvas = (u: string) => isCanvasUrl(u, ctx);
    const endpoint = attrs["data-api-endpoint"] ?? "";
    const ref =
      (onCanvas(href) ? parseFileRef(href) : null) ??
      (attrs["data-api-returntype"] === "File" && onCanvas(endpoint) ? parseFileRef(endpoint) : null);
    if (ref) {
      const label = text || attrs.title || "";
      const key = `${ref.file_id}|${label}`;
      if (!seenFiles.has(key)) {
        seenFiles.add(key);
        files.push({
          file_id: ref.file_id,
          ...(ref.course_id && ref.course_id !== ctx.courseId ? { course_id: ref.course_id } : {}),
          text: label,
          ...(attrs.title && attrs.title !== label ? { title: attrs.title } : {}),
        });
      }
      return `<a href="file:${ref.file_id}">${label || attrs.title || "file"}</a>`;
    }

    const slug = pageSlug(href, ctx);
    if (slug) pages.add(slug);
    return href === attrs.href ? whole : `<a href="${href}">${inner}</a>`;
  });

  return { html: rewritten, files, pages: [...pages], unresolved };
}

export async function moduleNameMap(canvas: CanvasClient, courseId: string): Promise<Map<string, string>> {
  const mods = await canvas.getAll(`/api/v1/courses/${courseId}/modules`).catch(() => []);
  return new Map(mods.map((m: any) => [String(m.name).trim().toLowerCase(), String(m.id)]));
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

interface Occurrence {
  course_id: string;
  texts: Set<string>;
  linked_from: Set<string>;
}

export interface CrawlError {
  source: string;
  message: string;
}

/** Everything the crawler fetched, so the snapshot job can reuse it without refetching. */
export interface CourseCrawl {
  ctx: LinkContext;
  modules: any[] | null;
  front: any | null;
  syllabus: string | null;
  assignments: any[] | null;
  announcements: any[] | null;
  /** Pages fetched, keyed by slug (front page included). */
  pages: Map<string, any>;
  /** Page slugs that were linked but failed to load. */
  failedPages: string[];
  /**
   * Files with Canvas metadata (`meta`) or the error that prevented reading it. `linked` is false
   * for files only known from the course files index (when the user's role may list it).
   */
  files: { file_id: string; course_id?: string; linked: boolean; link_texts: string[]; linked_from: string[]; meta?: any; error?: string }[];
  /** Whether the pages / files index endpoints were usable (otherwise everything came from links). */
  indexed: { pages: boolean; files: boolean };
  scanned: Record<string, number>;
  errors: CrawlError[];
}

/**
 * Crawl a course: front page, syllabus, module items, assignment descriptions, announcements, and
 * every same-course page reachable from those. The pages and files index endpoints are used when
 * the user's role allows them (often not for students); otherwise pages are discovered by
 * following links. Collects every linked file with its metadata.
 */
export async function crawlCourse(
  canvas: CanvasClient,
  courseId: string,
  opts: { maxPages: number; assignmentInclude?: string[]; announcementDays?: number },
): Promise<CourseCrawl> {
  const api = `/api/v1/courses/${courseId}`;
  const found = new Map<string, Occurrence>();
  const errors: CrawlError[] = [];
  const scanned = { pages: 0, assignments: 0, announcements: 0, module_items: 0 };
  const pageQueue: string[] = [];
  const pagesSeen = new Set<string>();
  const pages = new Map<string, any>();
  const failedPages: string[] = [];
  const attempt = <T>(source: string, p: Promise<T>): Promise<T | null> =>
    p.catch((e) => {
      errors.push({ source, message: (e as Error).message.slice(0, 200) });
      return null;
    });

  const modules = await attempt("modules", canvas.getAll(`${api}/modules`, { "include[]": ["items", "content_details"] }));
  const ctx: LinkContext = {
    base: canvas.baseUrl,
    courseId,
    aliases: canvas.canvasOrigins.filter((o) => o !== canvas.baseUrl),
    modules: new Map((modules ?? []).map((m: any) => [String(m.name).trim().toLowerCase(), String(m.id)])),
  };

  const add = (fileId: string, fileCourse: string | undefined, text: string, from: string) => {
    let o = found.get(fileId);
    if (!o) found.set(fileId, (o = { course_id: fileCourse ?? courseId, texts: new Set(), linked_from: new Set() }));
    if (text) o.texts.add(text);
    o.linked_from.add(from);
  };
  const enqueuePage = (slug: string) => {
    if (!pagesSeen.has(slug)) {
      pagesSeen.add(slug);
      pageQueue.push(slug);
    }
  };
  const scanHtml = (html: string | null | undefined, from: string) => {
    const a = analyzeHtml(html, ctx);
    for (const f of a.files) add(f.file_id, f.course_id, f.text || f.title || "", from);
    a.pages.forEach(enqueuePage);
  };

  for (const m of modules ?? []) {
    for (const item of m.items ?? []) {
      scanned.module_items++;
      if (item.type === "File" && item.content_id) add(String(item.content_id), undefined, item.title, `module: ${m.name}`);
      if (item.type === "Page" && item.page_url) enqueuePage(item.page_url);
    }
  }

  const days = opts.announcementDays ?? 365;
  // Index endpoints are optional: 403/404 (disabled for this role) just means "crawl instead".
  const optional = <T>(p: Promise<T>) => p.catch(() => null);
  const [pagesIndex, filesIndex, front, course, assignments, announcements] = await Promise.all([
    optional(canvas.getAll(`${api}/pages`, { "include[]": ["body"], published: true }, 1000)),
    optional(canvas.getAll(`${api}/files`, {}, 3000)),
    // 404 just means the course has no front page.
    canvas.get(`${api}/front_page`).catch((e) => {
      if (!(e instanceof CanvasError && e.status === 404)) errors.push({ source: "front_page", message: e.message.slice(0, 200) });
      return null;
    }),
    attempt("syllabus", canvas.get(api, { "include[]": ["syllabus_body"] })),
    attempt("assignments", canvas.getAll(`${api}/assignments`, { "include[]": opts.assignmentInclude, order_by: "due_at" }, 500)),
    attempt(
      "announcements",
      canvas.getAll(
        "/api/v1/announcements",
        {
          "context_codes[]": [`course_${courseId}`],
          start_date: new Date(Date.now() - days * 86_400_000).toISOString(),
          end_date: new Date(Date.now() + 86_400_000).toISOString(),
        },
        300,
      ),
    ),
  ]);

  for (const p of pagesIndex ?? []) {
    // Bodies are normally included; fetch the page individually if not.
    if (p.body === undefined || p.body === null) {
      enqueuePage(p.url);
      continue;
    }
    pagesSeen.add(p.url);
    pages.set(p.url, p);
    scanned.pages++;
    scanHtml(p.body, `page: ${p.title}${p.front_page ? " (front page)" : ""}`);
  }
  if (front && !pages.has(front.url)) {
    pagesSeen.add(front.url);
    pages.set(front.url, front);
    scanned.pages++;
    scanHtml(front.body, `page: ${front.title} (front page)`);
  }
  if (course?.syllabus_body) scanHtml(course.syllabus_body, "syllabus");
  for (const a of assignments ?? []) {
    scanned.assignments++;
    scanHtml(a.description, `assignment: ${a.name}`);
  }
  for (const d of announcements ?? []) {
    scanned.announcements++;
    scanHtml(d.message, `announcement: ${d.title}`);
    for (const att of d.attachments ?? []) add(String(att.id), undefined, att.display_name, `announcement: ${d.title}`);
  }

  while (pageQueue.length && scanned.pages < opts.maxPages) {
    const batch = pageQueue.splice(0, Math.min(4, opts.maxPages - scanned.pages));
    const results = await Promise.all(
      batch.map((slug) =>
        canvas.get(`${api}/pages/${encodeURIComponent(slug)}`).catch((e) => {
          errors.push({ source: `page ${slug}`, message: (e as Error).message.slice(0, 200) });
          failedPages.push(slug);
          return null;
        }),
      ),
    );
    for (const p of results) {
      if (!p) continue;
      scanned.pages++;
      pagesSeen.add(p.url);
      pages.set(p.url, p);
      scanHtml(p.body, `page: ${p.title}`);
    }
  }
  if (pageQueue.length) {
    errors.push({ source: "pages", message: `${pageQueue.length} linked pages not scanned (max_pages reached)` });
    failedPages.push(...pageQueue);
  }

  const indexMeta = new Map((filesIndex ?? []).map((f: any) => [String(f.id), f]));
  const linked = await mapLimit([...found.entries()], 6, async ([fileId, o]) => {
    const base = {
      file_id: fileId,
      ...(o.course_id !== courseId ? { course_id: o.course_id } : {}),
      linked: true,
      link_texts: [...o.texts],
      linked_from: [...o.linked_from],
    };
    const known = o.course_id === courseId ? indexMeta.get(fileId) : undefined;
    if (known) return { ...base, meta: known };
    try {
      return { ...base, meta: await canvas.get(`/api/v1/courses/${o.course_id}/files/${fileId}`) };
    } catch (e) {
      return { ...base, error: e instanceof CanvasError ? e.message.slice(0, 160) : String(e) };
    }
  });
  const unlinked = [...indexMeta.entries()]
    .filter(([id]) => !found.has(id))
    .map(([id, meta]) => ({ file_id: id, linked: false, link_texts: [], linked_from: ["course files"], meta }));
  const files = [...linked, ...unlinked];

  return {
    ctx,
    modules,
    front,
    syllabus: course ? (course.syllabus_body ?? "") : null,
    assignments,
    announcements,
    pages,
    failedPages,
    files,
    indexed: { pages: pagesIndex !== null, files: filesIndex !== null },
    scanned,
    errors,
  };
}

/** list_linked_files: the crawl reduced to a compact file list. */
export async function crawlCourseFiles(
  canvas: CanvasClient,
  courseId: string,
  opts: { maxPages: number },
): Promise<{ files: any[]; scanned: Record<string, number>; skipped: string[] }> {
  const c = await crawlCourse(canvas, courseId, opts);
  const files = c.files.filter((f) => f.linked).map(({ meta: f, linked, ...rest }) =>
    f
      ? {
          ...rest,
          display_name: f.display_name,
          size: f.size,
          content_type: f["content-type"],
          updated_at: f.updated_at,
          ...(f.locked_for_user ? { locked: f.lock_explanation ?? true } : {}),
        }
      : rest,
  );
  files.sort((a: any, b: any) => String(a.display_name ?? "~").localeCompare(String(b.display_name ?? "~")));
  return { files, scanned: c.scanned, skipped: c.errors.map((e) => `${e.source}: ${e.message.slice(0, 120)}`) };
}
