import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { htmlToText } from "../src/canvas.js";
import { analyzeHtml, parseFileRef } from "../src/links.js";

const ctx = { base: "https://canvas.example.edu", courseId: "100" };

describe("parseFileRef", () => {
  const cases: [string, ReturnType<typeof parseFileRef>][] = [
    ["123", { file_id: "123" }],
    ["https://canvas.example.edu/courses/100/files/123?verifier=abc&wrap=1", { file_id: "123", course_id: "100" }],
    ["https://canvas.example.edu/courses/100/files/123/download?verifier=abc", { file_id: "123", course_id: "100" }],
    ["https://canvas.example.edu/files/123/download?download_frd=1", { file_id: "123", course_id: undefined }],
    ["/api/v1/files/42", { file_id: "42", course_id: undefined }],
    ["$CANVAS_OBJECT_REFERENCE$/attachments/77", { file_id: "77" }],
    ["%24CANVAS_OBJECT_REFERENCE%24/attachments/77", { file_id: "77" }],
    ["https://canvas.example.edu/courses/100/files/folder/slides", null],
    ["not a link", null],
  ];
  for (const [input, expected] of cases) {
    it(input, () => assert.deepEqual(parseFileRef(input), expected));
  }
});

describe("analyzeHtml", () => {
  const html = `
    <p>Lab 1 (<a title="python_lab1.pdf" href="https://canvas.example.edu/courses/100/files/531?verifier=x&amp;wrap=1"
       data-api-endpoint="https://canvas.example.edu/api/v1/courses/100/files/531" data-api-returntype="File">Python</a>)
    sheet <a href="/courses/100/files/647/download?verifier=y">(DOC)</a></p>
    <a href="https://canvas.example.edu/courses/100/pages/course-info">Course info</a>
    <a href="https://canvas.example.edu/courses/999/pages/elsewhere">Other course</a>
    <a href="https://github.com/x/y/files/123">external</a>
    <a title="Week 1" href="%24CANVAS_OBJECT_REFERENCE%24/modules/iabc">Week one</a>
    <a href="%24CANVAS_OBJECT_REFERENCE%24/modules/i17221772e914d9fdc826c2f3958826e3"></a>
    <a href="$CANVAS_OBJECT_REFERENCE$/attachments/555">old slides</a>
    <a href="%24CANVAS_COURSE_REFERENCE%24/assignments">Assignments</a>`;
  const a = analyzeHtml(html, { ...ctx, modules: new Map([["week 1", "9"]]) });

  it("finds Canvas file links but not external /files/ URLs", () => {
    assert.deepEqual(
      a.files.map((f) => f.file_id),
      ["531", "647", "555"],
    );
    assert.equal(a.files[0].text, "Python");
    assert.equal(a.files[0].title, "python_lab1.pdf");
  });

  it("collects same-course page links only", () => {
    assert.deepEqual(a.pages, ["course-info"]);
  });

  it("resolves placeholders where possible and reports the rest", () => {
    const text = htmlToText(a.html);
    assert.match(text, /Week one \(https:\/\/canvas\.example\.edu\/courses\/100\/modules#module_9\)/);
    assert.match(text, /Assignments \(https:\/\/canvas\.example\.edu\/courses\/100\/assignments\)/);
    assert.match(text, /old slides \(file:555\)/);
    assert.equal(a.unresolved.length, 1);
    assert.match(a.unresolved[0].placeholder, /^\$CANVAS_OBJECT_REFERENCE\$\/modules\//);
  });

  it("rewrites file links to file:<id> without verifiers", () => {
    assert.doesNotMatch(a.html, /verifier/);
    assert.match(htmlToText(a.html), /Python \(file:531\)/);
  });

  it("handles empty input", () => {
    assert.deepEqual(analyzeHtml(null, ctx), { html: "", files: [], pages: [], unresolved: [] });
  });
});
