import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applySnapshot,
  Entity,
  fieldDiffs,
  filePageChanges,
  Kind,
  KindResult,
  ranges,
  SnapshotService,
  textDiff,
} from "../src/snapshot.js";
import { Store } from "../src/store.js";
import { setDisplayTimeZone } from "../src/time.js";

const assignment = (id: string, fields: Record<string, unknown>, text = ""): Entity => ({
  kind: "assignment",
  id,
  title: String(fields.name ?? id),
  url: `https://canvas.example.edu/courses/1/assignments/${id}`,
  data: { fields, text },
});

function run(store: Store, at: string, results: [Kind, KindResult][]) {
  const runId = store.startRun("1", at);
  const r = applySnapshot(store, "1", runId, at, new Map(results));
  store.finishRun(runId, { finished_at: at, duration_ms: 1, ok: 1, baseline: r.baseline ? 1 : 0, counts: r.counts, errors: [], events: r.events });
  return store.eventsForRuns([runId]);
}

describe("diff helpers", () => {
  it("reports scalar old→new and array added/removed", () => {
    assert.deepEqual(fieldDiffs({ due_at: "a", items: ["x", "y"], same: 1 }, { due_at: "b", items: ["y", "z"], same: 1 }), [
      { field: "due_at", old: "a", new: "b" },
      { field: "items", added: ["z"], removed: ["x"] },
    ]);
  });

  it("summarizes text changes as a unified diff", () => {
    const d = textDiff("one\ntwo\nthree", "one\nTWO\nthree");
    assert.equal(d.summary, "+1 / -1 lines");
    assert.match(d.diff, /-two\n\+TWO/);
  });

  it("compresses page numbers into ranges", () => assert.equal(ranges([1, 3, 4, 5, 9]), "1, 3-5, 9"));

  it("reports changed, added and removed PDF pages", () => {
    assert.deepEqual(filePageChanges(["a", "b", "c"], ["a", "B", "c", "d"]), { pages_changed: "2", pages_added: "4" });
    assert.deepEqual(filePageChanges(["a", "b", "c"], ["a"]), { pages_removed: "2-3" });
  });
});

describe("applySnapshot", () => {
  it("makes the first run a silent baseline, then reports added/changed/removed", () => {
    const store = new Store(":memory:");
    const base = run(store, "2026-11-01T03:30:00Z", [
      ["assignment", { complete: true, entities: [assignment("a1", { name: "Lab 1", due_at: "2026-11-13T17:00:00Z" }), assignment("a2", { name: "Lab 2" })] }],
    ]);
    assert.deepEqual(
      base.map((e) => e.change),
      ["baseline"],
    );

    const next = run(store, "2026-11-02T03:30:00Z", [
      [
        "assignment",
        {
          complete: true,
          entities: [assignment("a1", { name: "Lab 1", due_at: "2026-11-16T17:00:00Z" }), assignment("a3", { name: "Lab 3" })],
        },
      ],
    ]);
    const byChange = Object.fromEntries(next.map((e) => [e.change, e]));
    assert.deepEqual(byChange.changed.details.fields, [{ field: "due_at", old: "2026-11-13T17:00:00Z", new: "2026-11-16T17:00:00Z" }]);
    assert.equal(byChange.added.entity_id, "a3");
    assert.equal(byChange.removed.entity_id, "a2");
  });

  it("absorbs fields added by a later version instead of reporting them", () => {
    const store = new Store(":memory:");
    run(store, "2026-11-01T03:30:00Z", [["assignment", { complete: true, entities: [assignment("a1", { name: "Lab 1" })] }]]);
    run(store, "2026-11-01T04:30:00Z", [["assignment", { complete: true, entities: [assignment("a1", { name: "Lab 1" })] }]]);
    const upgraded = run(store, "2026-11-02T03:30:00Z", [
      ["assignment", { complete: true, entities: [assignment("a1", { name: "Lab 1", needs_grading: 0 })] }],
    ]);
    assert.deepEqual(upgraded, []);
    const later = run(store, "2026-11-03T03:30:00Z", [
      ["assignment", { complete: true, entities: [assignment("a1", { name: "Lab 1", needs_grading: 4 })] }],
    ]);
    assert.deepEqual(later[0].details.fields, [{ field: "needs_grading", old: 0, new: 4 }]);
  });

  it("absorbs items from a newly readable source once, then reports new ones", () => {
    const store = new Store(":memory:");
    const files = (ids: string[], quiet?: string[]): [Kind, KindResult][] => [
      ["page", { complete: true, entities: ids.map((id) => assignment(id, { name: id })).map((e) => ({ ...e, kind: "page" as Kind })), ...(quiet ? { quiet: { source: "page:index", ids: new Set(quiet) } } : {}) }],
    ];
    run(store, "2026-11-01T03:30:00Z", files(["p1", "p0"]));
    run(store, "2026-11-01T15:30:00Z", files(["p1"]));
    assert.deepEqual(run(store, "2026-11-02T03:30:00Z", files(["p0", "p1", "p2", "p3"], ["p0", "p2", "p3"])), [], "first indexed run is quiet, reappearances too");
    const next = run(store, "2026-11-03T03:30:00Z", files(["p0", "p1", "p2", "p3", "p4"], ["p4"]));
    assert.deepEqual(
      next.map((e) => [e.change, e.entity_id]),
      [["added", "p4"]],
    );
  });

  it("produces no events when nothing changed", () => {
    const store = new Store(":memory:");
    const state: [Kind, KindResult][] = [["assignment", { complete: true, entities: [assignment("a1", { name: "Lab 1" }, "Do it")] }]];
    run(store, "2026-11-01T03:30:00Z", state);
    assert.deepEqual(run(store, "2026-11-02T03:30:00Z", state), []);
  });

  it("never marks things removed from an incomplete source or a kept id", () => {
    const store = new Store(":memory:");
    const two = [assignment("a1", { name: "1" }), assignment("a2", { name: "2" })];
    run(store, "2026-11-01T03:30:00Z", [["assignment", { complete: true, entities: two }]]);
    assert.deepEqual(run(store, "2026-11-02T03:30:00Z", [["assignment", { complete: false, entities: [] }]]), []);
    assert.deepEqual(run(store, "2026-11-03T03:30:00Z", [["assignment", { complete: true, keep: new Set(["a2"]), entities: [two[0]] }]]), []);
  });

  it("reports a removed item that comes back as re-added", () => {
    const store = new Store(":memory:");
    const a = assignment("a1", { name: "1" });
    run(store, "2026-11-01T03:30:00Z", [["assignment", { complete: true, entities: [a, assignment("a2", { name: "2" })] }]]);
    run(store, "2026-11-02T03:30:00Z", [["assignment", { complete: true, entities: [a] }]]);
    const back = run(store, "2026-11-03T03:30:00Z", [["assignment", { complete: true, entities: [a, assignment("a2", { name: "2" })] }]]);
    assert.equal(back[0].change, "added");
    assert.match(String(back[0].details.note), /reappeared/);
  });

  it("baselines a kind silently the first time it becomes readable", () => {
    const store = new Store(":memory:");
    run(store, "2026-11-01T03:30:00Z", [["assignment", { complete: true, entities: [] }]]);
    const quiz: Entity = { kind: "quiz", id: "q1", title: "Quiz", data: { fields: { title: "Quiz" } } };
    assert.deepEqual(run(store, "2026-11-02T03:30:00Z", [["quiz", { complete: true, entities: [quiz] }]]), []);
  });

  it("flags announcements without posted_at as unpublished/old", () => {
    const store = new Store(":memory:");
    run(store, "2026-11-01T03:30:00Z", [["announcement", { complete: true, entities: [] }]]);
    const ann: Entity = { kind: "announcement", id: "n1", title: "Old", data: { fields: { title: "Old", posted_at: null }, text: "hi" } };
    const [ev] = run(store, "2026-11-02T03:30:00Z", [["announcement", { complete: true, entities: [ann] }]]);
    assert.match(String(ev.details.note), /unpublished\/old/);
  });
});

describe("scheduler", () => {
  const service = (store: Store) => {
    store.setCourses([{ course_id: "1", label: "C1", name: null, role: "student" }], "2026-10-01T00:00:00Z");
    return new SnapshotService({} as any, {} as any, store, {
      include: [],
      exclude: [],
      scope: "dashboard",
      dailyAt: "04:30",
      maxAgeHours: 20,
      retentionDays: 120,
      crawlMaxPages: 200,
      announcementDays: 730,
      extract: "linked",
    });
  };

  it("is due after the daily time until a run has started since then (Stockholm time, across DST)", () => {
    setDisplayTimeZone("Europe/Stockholm");
    const store = new Store(":memory:");
    const s = service(store);
    // 2026-10-25 is the CEST→CET switch; 04:30 local = 03:30Z.
    assert.equal(s.isDue(new Date("2026-10-25T03:00:00Z")), false, "before 04:30 local");
    assert.equal(s.isDue(new Date("2026-10-25T03:31:00Z")), true, "after 04:30, never run");
    const id = store.startRun("1", "2026-10-25T03:31:00Z");
    store.finishRun(id, { finished_at: "2026-10-25T03:32:00Z", duration_ms: 1, ok: 1, baseline: 1, counts: {}, errors: [] , events: 0 });
    assert.equal(s.isDue(new Date("2026-10-25T09:00:00Z")), false, "already ran today");
    assert.equal(s.isDue(new Date("2026-10-26T03:31:00Z")), true, "next day");
  });

  it("is stale until every course has a recent successful run", () => {
    const store = new Store(":memory:");
    const s = service(store);
    const now = new Date("2026-11-02T12:00:00Z");
    assert.equal(s.isStale(now), true);
    const id = store.startRun("1", "2026-11-02T03:30:00Z");
    store.finishRun(id, { finished_at: "2026-11-02T03:31:00Z", duration_ms: 1, ok: 1, baseline: 1, counts: {}, errors: [], events: 0 });
    assert.equal(s.isStale(now), false);
    assert.equal(s.isStale(new Date("2026-11-03T12:00:00Z")), true, "older than maxAgeHours");
  });
});
