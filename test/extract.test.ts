import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { CanvasError } from "../src/canvas.js";
import { CacheEntry, extract, extractInWorker, FileReader, parseRange, render } from "../src/extract.js";

const fixture = (name: string) => readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url));

const entry = (extracted: CacheEntry["extracted"]): CacheEntry => ({
  v: 0,
  file_id: "1",
  updated_at: "2026-01-01T00:00:00Z",
  display_name: "x",
  content_type: "x",
  extracted,
});

describe("parseRange", () => {
  it("defaults to everything", () => assert.deepEqual(parseRange(undefined, 3), [0, 1, 2]));
  it("parses lists and ranges", () => assert.deepEqual(parseRange("1-2, 5,7-", 8), [0, 1, 4, 6, 7]));
  it("clamps the end", () => assert.deepEqual(parseRange("2-99", 3), [1, 2]));
  it("rejects out-of-range starts", () => assert.throws(() => parseRange("9", 3), /out of range/));
  it("rejects garbage", () => assert.throws(() => parseRange("a-b", 3), /Bad page range/));
});

describe("extract", () => {
  it("reads PDF pages and flags pages without a text layer", async () => {
    const x = await extract(fixture("sample.pdf"), "application/pdf", "sample.pdf");
    assert.equal(x.kind, "pdf");
    assert.equal(x.units.length, 3);
    assert.match(x.units[0].text, /Projections and transformations\nPinhole camera model/);
    assert.match(x.units[2].text, /no text layer/);
    assert.match(x.note ?? "", /1 page/);
  });

  it("reads DOCX sections, headings and tables", async () => {
    const x = await extract(fixture("sample.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx");
    assert.deepEqual(
      x.units.map((u) => u.label),
      ["Lab 3 answers", "Part 2"],
    );
    assert.match(x.units[0].text, /Name: ____ & co <x>/);
    assert.match(x.units[0].text, /Q1 \| answer\nQ2 \| b/);
  });

  it("reads PPTX slides in order with titles and speaker notes", async () => {
    const x = await extract(fixture("sample.pptx"), "application/vnd.openxmlformats-officedocument.presentationml.presentation", "a.pptx");
    assert.deepEqual(
      x.units.map((u) => u.label),
      ["Projections", "Second"],
    );
    assert.match(x.units[0].text, /Pinhole camera\nHomogeneous coords\n\n\[speaker notes\]\nSay something about focal length/);
  });

  it("lists ZIP entries without extracting them", async () => {
    const zip = zipSync({ "lab/lab1.py": strToU8("print(1)"), "lab/img/": new Uint8Array() });
    const x = await extract(zip, "application/zip", "lab.zip");
    assert.equal(x.kind, "zip");
    assert.match(x.units[0].text, /lab\/lab1\.py {2}\(8 bytes\)/);
  });

  it("splits long plain text into parts", async () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const x = await extract(strToU8(text), "text/plain", "a.txt");
    assert.equal(x.units.length, 3);
    assert.equal(x.units[2].label, "lines 301-400");
  });

  it("splits oversized units so each part fits in max_chars", async () => {
    const text = Array.from({ length: 140 }, () => "x".repeat(200)).join("\n");
    const x = await extract(strToU8(text), "text/plain", "a.txt");
    assert.ok(x.units.length >= 3);
    assert.ok(x.units.every((u) => u.text.length <= 12_000));
    assert.match(x.units[0].label ?? "", /\(part 1\/\d\)/);
  });

  it("refuses unsupported formats with a clear message", async () => {
    await assert.rejects(extract(new Uint8Array([1, 2]), "application/msword", "old.doc"), /Legacy \.doc/);
  });
});

describe("render", () => {
  const e = entry({ kind: "pdf", unit: "page", units: [{ text: "a".repeat(50) }, { text: "b".repeat(50) }, { text: "c" }] });

  it("adds a header and page markers", () => {
    const out = render(e, { maxChars: 10_000, cached: true });
    assert.match(out, /^display_name: x\n/);
    assert.match(out, /pages: 3 \(showing 1-3\)\ntruncated: false\ncached: true/);
    assert.match(out, /--- page 2\/3 ---\nb{50}/);
  });

  it("truncates and says which range to request next", () => {
    const out = render(e, { maxChars: 100, cached: false });
    assert.match(out, /truncated: true/);
    assert.match(out, /continue with pages="2-3"/);
  });

  it("suggests raising max_chars when the first unit alone is too long", () => {
    const out = render(e, { pages: "1", maxChars: 20, cached: false });
    assert.match(out, /raise max_chars/);
  });
});

describe("extract options and worker", () => {
  it("finds DOCX headings by outline level whatever the style is called", async () => {
    const doc = (style: string, text: string) => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const docx = zipSync({
      "word/document.xml": strToU8(
        `<w:document><w:body>${doc("Rubrik1", "Inledning")}${doc("Normal", "Text ett")}${doc("Rubrik1", "Metod")}${doc("Normal", "Text två")}</w:body></w:document>`,
      ),
      "word/styles.xml": strToU8(
        `<w:styles><w:style w:type="paragraph" w:styleId="Rubrik1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>`,
      ),
    });
    const x = await extract(docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx");
    assert.deepEqual(
      x.units.map((u) => u.label),
      ["Inledning", "Metod"],
    );
  });

  it("caps the number of PDF pages and says so", async () => {
    const x = await extract(fixture("sample.pdf"), "application/pdf", "a.pdf", { maxPages: 1 });
    assert.equal(x.units.length, 1);
    assert.match(x.note ?? "", /first 1 of 3 pages/);
  });

  it("extracts in a worker thread and maps errors back", async () => {
    const x = await extractInWorker(fixture("sample.pdf"), "application/pdf", "a.pdf", {}, 20_000);
    assert.equal(x.units.length, 3);
    await assert.rejects(extractInWorker(new Uint8Array([1]), "image/png", "a.png", {}, 20_000), (e: CanvasError) => e.status === 415);
  });
});

describe("FileReader cache", () => {
  it("evicts least recently used entries beyond the size cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-mcp-cache-"));
    const canvas = { download: async () => ({ bytes: strToU8("x".repeat(3000)), contentType: "text/plain" }) } as any;
    const reader = new FileReader(canvas, { cacheDir: dir, cacheMaxBytes: 7000, maxBytes: 1e6, timeoutMs: 1000, useWorker: false });
    const meta = (id: string) => ({ display_name: `${id}.txt`, "content-type": "text/plain", size: 3000, updated_at: "2026-01-01T00:00:00Z", url: "x" });
    for (const id of ["1", "2", "3"]) {
      await reader.readWithMeta(id, meta(id));
      await new Promise((r) => setTimeout(r, 20));
    }
    const left = readdirSync(dir).map((n) => n.split("_")[0]).sort();
    assert.deepEqual(left, ["2", "3"]);
    assert.equal((await reader.readWithMeta("3", meta("3"))).cached, true);
  });
});
