// End-to-end against a mock Canvas: discovery, crawling (with and without index endpoints),
// file extraction, and snapshot runs producing change events.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { CanvasClient } from "../src/canvas.js";
import { FileReader } from "../src/extract.js";
import { crawlCourse } from "../src/links.js";
import { discoverCourses, parseCourseOverride, roleFromEnrollments, SnapshotService } from "../src/snapshot.js";
import { Store } from "../src/store.js";
import { json, MockCanvas, startMockCanvas } from "./mock-canvas.js";

const pdf = readFileSync(new URL("../../test/fixtures/sample.pdf", import.meta.url));

/** A small course: front page linking a page and a PDF, a course-copy placeholder, one assignment. */
function seedCourse(canvas: MockCanvas, opts: { dueAt: string; pdfUpdated: string; indexes?: boolean }) {
  const b = canvas.base;
  const api = "/api/v1/courses/7";
  canvas.routeJson("/api/v1/courses", [
    { id: 7, name: "Image Analysis", course_code: "IA101", enrollments: [{ type: "student" }] },
    { id: 8, name: "Databases", course_code: "DB200", enrollments: [{ type: "student" }, { type: "ta" }] },
    { id: 9, name: "Old", course_code: "OLD", access_restricted_by_date: true },
    { id: 10, name: "Last year", course_code: "LY", enrollments: [{ type: "student" }], term: { end_at: "2025-06-01T00:00:00Z" } },
  ]);
  canvas.routeJson("/api/v1/users/self/favorites/courses", [{ id: 7 }, { id: 10 }]);
  canvas.routeJson("/api/v1/users/self/profile", { name: "Test", time_zone: "Europe/Stockholm" });
  canvas.routeJson(`${api}/modules`, [{ id: 1, name: "Week 1", items: [{ type: "Page", title: "Labs", page_url: "labs" }] }]);
  canvas.routeJson(`${api}/front_page`, {
    url: "front",
    title: "Front",
    front_page: true,
    html_url: `${b}/courses/7/pages/front`,
    body:
      `<a href="${b}/courses/7/pages/labs">Labs</a> ` +
      `<a href="${b}/courses/7/files/500?verifier=v&amp;wrap=1" title="lecture.pdf">(notes)</a> ` +
      `<a href="%24CANVAS_OBJECT_REFERENCE%24/modules/i17221772e914d9fdc826c2f3958826e3"></a>`,
  });
  canvas.routeJson(`${api}/pages/labs`, {
    url: "labs",
    title: "Labs",
    html_url: `${b}/courses/7/pages/labs`,
    body: `<p>Lab 1 is due soon.</p><a href="https://alias.example.com/courses/7/files/501/download">Lab 1</a>`,
  });
  canvas.routeJson(api, { id: 7, syllabus_body: "<p>Syllabus</p>" });
  canvas.routeJson(`${api}/assignments`, [
    { id: 70, name: "Lab 1", due_at: opts.dueAt, points_possible: 10, submission_types: ["online_upload"], html_url: `${b}/courses/7/assignments/70`, submission: { workflow_state: "unsubmitted", missing: false, late: false } },
  ]);
  canvas.routeJson("/api/v1/announcements", [
    { id: 90, title: "Welcome", posted_at: "2026-10-28T10:00:00Z", message: "<p>Hi</p>", author: { id: 5, display_name: "Prof" } },
    { id: 91, title: "Copied from last year", posted_at: null, message: "<p>Old</p>", author: {} },
  ]);
  canvas.routeJson(`${api}/users`, [{ id: 5, enrollments: [{ type: "TeacherEnrollment" }] }]);
  canvas.routeJson(`${api}/discussion_topics`, []);
  canvas.route(`${api}/quizzes`, (_q, res) => json(res, { message: "That page has been disabled for this course" }, 404));
  canvas.routeJson("/api/v1/calendar_events", []);
  for (const id of ["500", "501"]) {
    canvas.routeJson(`${api}/files/${id}`, {
      id,
      display_name: id === "500" ? "lecture.pdf" : "lab1.pdf",
      "content-type": "application/pdf",
      size: pdf.length,
      updated_at: opts.pdfUpdated,
      url: `${b}/files/${id}/download?verifier=v`,
    });
    canvas.route(`/files/${id}/download`, (_q, res) => {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(pdf);
    });
  }
  if (opts.indexes) {
    canvas.routeJson(`${api}/pages`, [
      { url: "front", title: "Front", front_page: true, html_url: `${b}/courses/7/pages/front`, body: "<p>Front</p>" },
      { url: "unlinked", title: "Unlinked page", html_url: `${b}/courses/7/pages/unlinked`, body: "<p>Only in the index</p>" },
    ]);
    canvas.routeJson(`${api}/files`, [{ id: 502, display_name: "old-exam.pdf", "content-type": "application/pdf", size: 10, updated_at: "2026-01-01T00:00:00Z", url: `${b}/files/502/download` }]);
  } else {
    canvas.route(`${api}/pages`, (_q, res) => json(res, { message: "That page has been disabled for this course" }, 404));
    canvas.route(`${api}/files`, (_q, res) => json(res, { status: "unauthorized", errors: [{ message: "user not authorised to perform that action" }] }, 403));
  }
}

describe("roles and course discovery", () => {
  it("maps enrollments to the strongest role", () => {
    assert.equal(roleFromEnrollments(["StudentEnrollment"]), "student");
    assert.equal(roleFromEnrollments(["student", "ta"]), "ta");
    assert.equal(roleFromEnrollments(["TaEnrollment", "TeacherEnrollment"]), "teacher");
    assert.equal(roleFromEnrollments(["designer"]), "teacher");
    assert.equal(roleFromEnrollments(["ObserverEnrollment"]), "observer");
  });

  it("parses SNAPSHOT_COURSES entries, including the legacy id:label:role form", () => {
    assert.deepEqual(parseCourseOverride("4321:CS101:ta"), { id: "4321", label: "CS101", role: "ta" });
    assert.deepEqual(parseCourseOverride("42"), { id: "42" });
    assert.throws(() => parseCourseOverride("abc"), /course id/);
    assert.throws(() => parseCourseOverride("1:x:boss"), /Bad role/);
  });

  describe("against a mock Canvas", () => {
    let canvas: MockCanvas;
    before(async () => {
      canvas = await startMockCanvas();
      seedCourse(canvas, { dueAt: "2026-11-13T17:00:00Z", pdfUpdated: "2026-10-01T00:00:00Z" });
    });
    after(() => canvas.close());

    it("defaults to dashboard courses that haven't ended", async () => {
      const client = new CanvasClient(canvas.base, "t".repeat(40));
      assert.deepEqual(await discoverCourses(client, [], [], "dashboard", Date.parse("2026-11-01")), [
        { id: "7", label: "IA101", name: "Image Analysis", role: "student" },
      ]);
    });

    it("can take every active course, and applies include/exclude", async () => {
      const client = new CanvasClient(canvas.base, "t".repeat(40));
      assert.deepEqual(await discoverCourses(client, [], [], "active", Date.parse("2026-11-01")), [
        { id: "7", label: "IA101", name: "Image Analysis", role: "student" },
        { id: "8", label: "DB200", name: "Databases", role: "ta" },
      ]);
      assert.deepEqual(
        (await discoverCourses(client, ["10"], [], "dashboard", Date.parse("2026-11-01"))).map((c) => c.id),
        ["10"],
        "an explicit include list wins over the end date",
      );
      assert.deepEqual(
        (await discoverCourses(client, ["8:DB:teacher"], [])).map((c) => [c.id, c.label, c.role]),
        [["8", "DB", "teacher"]],
      );
      assert.deepEqual(
        (await discoverCourses(client, [], ["8"], "active")).map((c) => c.id),
        ["7"],
      );
    });
  });
});

describe("crawlCourse", () => {
  let canvas: MockCanvas;
  beforeEach(async () => {
    await canvas?.close();
    canvas = await startMockCanvas();
  });
  after(() => canvas.close());

  it("follows links when the index endpoints are disabled, including alias-host links", async () => {
    seedCourse(canvas, { dueAt: "2026-11-13T17:00:00Z", pdfUpdated: "2026-10-01T00:00:00Z" });
    const client = new CanvasClient(canvas.base, "t".repeat(40), { aliases: ["https://alias.example.com"] });
    const c = await crawlCourse(client, "7", { maxPages: 50 });
    assert.deepEqual(c.indexed, { pages: false, files: false });
    assert.deepEqual([...c.pages.keys()].sort(), ["front", "labs"]);
    assert.deepEqual(
      c.files.map((f) => [f.file_id, f.linked, f.meta?.display_name]),
      [
        ["500", true, "lecture.pdf"],
        ["501", true, "lab1.pdf"],
      ],
    );
    assert.deepEqual(c.errors, [], "disabled index endpoints are not errors");
  });

  it("uses the pages and files index when the role allows it", async () => {
    seedCourse(canvas, { dueAt: "2026-11-13T17:00:00Z", pdfUpdated: "2026-10-01T00:00:00Z", indexes: true });
    const client = new CanvasClient(canvas.base, "t".repeat(40));
    const c = await crawlCourse(client, "7", { maxPages: 50 });
    assert.deepEqual(c.indexed, { pages: true, files: true });
    assert.ok(c.pages.has("unlinked"), "pages only in the index are included");
    const unlinked = c.files.find((f) => f.file_id === "502");
    assert.equal(unlinked?.linked, false);
  });
});

describe("SnapshotService end to end", () => {
  let canvas: MockCanvas;
  after(() => canvas.close());

  it("baselines, then reports a due-date change and a changed PDF page", async () => {
    canvas = await startMockCanvas();
    seedCourse(canvas, { dueAt: "2026-11-13T17:00:00Z", pdfUpdated: "2026-10-01T00:00:00Z" });
    const client = new CanvasClient(canvas.base, "t".repeat(40), { aliases: ["https://alias.example.com"], retryBaseMs: 5 });
    const dir = mkdtempSync(join(tmpdir(), "canvas-mcp-test-"));
    const files = new FileReader(client, { cacheDir: join(dir, "cache"), maxBytes: 1e6, timeoutMs: 5000, useWorker: false });
    const store = new Store(join(dir, "canvas.db"));
    const snaps = new SnapshotService(client, files, store, {
      include: ["7"],
      exclude: [],
      scope: "dashboard",
      dailyAt: "off",
      maxAgeHours: 20,
      retentionDays: 120,
      crawlMaxPages: 50,
      announcementDays: 730,
      extract: "linked",
    });

    const [firstRun] = await snaps.run().promise;
    assert.deepEqual(
      store.eventsForRuns([firstRun]).map((e) => e.change),
      ["baseline"],
    );
    const status = store.lastRun("7")!;
    assert.equal(status.ok, 1);
    assert.equal(status.counts.file, 2);
    assert.ok(
      status.errors.some((e) => e.source === "quizzes"),
      "a disabled tab is recorded",
    );
    assert.deepEqual(snaps.courses, [{ id: "7", label: "IA101", name: "Image Analysis", role: "student" }]);

    // Nothing changed: no events.
    const [same] = await snaps.run().promise;
    assert.deepEqual(store.eventsForRuns([same]), []);

    // Due date moved and the lecture PDF re-uploaded with a different second page.
    seedCourse(canvas, { dueAt: "2026-11-16T17:00:00Z", pdfUpdated: "2026-11-02T00:00:00Z" });
    const changedPdf = Buffer.from(pdf.toString("latin1").replace("Homogeneous coordinates", "Homogeneous coordinatez"), "latin1");
    canvas.route("/files/500/download", (_q, res) => {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(changedPdf);
    });
    const [changed] = await snaps.run().promise;
    const events = store.eventsForRuns([changed]);
    const due = events.find((e) => e.kind === "assignment")!;
    assert.deepEqual(due.details.fields, [{ field: "due_at", old: "2026-11-13T17:00:00Z", new: "2026-11-16T17:00:00Z" }]);
    const file = events.find((e) => e.kind === "file" && e.entity_id === "500")!;
    assert.equal(file.details.pages_changed, "2");
    assert.ok(!events.some((e) => e.kind === "file" && e.entity_id === "501"), "only updated_at changed for 501, same content");
  });
});

describe("Store migrations", () => {
  it("upgrades a database created before schema versioning", () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-mcp-test-"));
    const path = join(dir, "old.db");
    // What version 1.2.0 created: the tables, but user_version 0 and no courses table.
    const legacy = new Store(path);
    legacy.db.exec("DROP TABLE courses; PRAGMA user_version = 0;");
    legacy.db.close();

    const s = new Store(path);
    assert.equal(s.schemaVersion, 2);
    s.setCourses([{ course_id: "1", label: "C", name: null, role: "student" }], "2026-11-01T00:00:00Z");
    assert.equal(s.courses().length, 1);
  });

  it("refuses a database from a newer version", () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-mcp-test-"));
    const path = join(dir, "new.db");
    const s = new Store(path);
    s.db.exec("PRAGMA user_version = 99;");
    s.db.close();
    assert.throws(() => new Store(path), /newer version/);
  });
});
