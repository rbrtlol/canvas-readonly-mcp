import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { applySnapshot, Entity } from "../src/snapshot.js";
import { ftsQuery, Store } from "../src/store.js";
import { discussionThread, mapQuiz, mapRubric } from "../src/tools.js";

describe("ftsQuery", () => {
  it("turns words into prefix terms and keeps quoted phrases", () => {
    assert.equal(ftsQuery("dyn prog"), '"dyn"* "prog"*');
    assert.equal(ftsQuery('"dynamic programming" lab'), '"dynamic programming" "lab"*');
    assert.equal(ftsQuery("a b", true), '"a"* OR "b"*');
  });

  it("drops FTS syntax and punctuation", () => {
    assert.equal(ftsQuery('NEAR(x) title:"y" -z*'), '"NEAR"* "x"* "title"* "y" "z"*');
    assert.equal(ftsQuery("Övning 3.2"), '"Övning"* "3"* "2"*');
    assert.equal(ftsQuery('?! ""'), null);
  });
});

describe("search index maintenance", () => {
  const page = (id: string, title: string, text: string): Entity => ({ kind: "page", id, title, data: { fields: { title }, text } });

  it("follows changes and removals", () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "canvas-mcp-test-")), "s.db"));
    const at = (n: number) => `2026-11-0${n}T00:00:00Z`;
    const apply = (n: number, entities: Entity[]) =>
      applySnapshot(store, "1", store.startRun("1", at(n)), at(n), new Map([["page", { complete: true, entities }]]));
    const ids = (q: string) => store.search(ftsQuery(q)!, { limit: 10 }).map((h) => h.entity_id);

    apply(1, [page("a", "Graphs", "Dijkstra's algorithm"), page("b", "Trees", "Binary search trees")]);
    assert.deepEqual(ids("dijkstra"), ["a"]);
    apply(2, [page("a", "Graphs", "Bellman-Ford"), page("b", "Trees", "Binary search trees")]);
    assert.deepEqual(ids("dijkstra"), []);
    assert.deepEqual(ids("bellman"), ["a"]);
    apply(3, [page("a", "Graphs", "Bellman-Ford")]);
    assert.deepEqual(ids("binary"), [], "removed items leave the index");
    assert.deepEqual(ids("graphs"), ["a"], "titles are searchable");
  });
});

describe("discussionThread", () => {
  it("builds the reply tree with names and merges entries newer than the cached view", () => {
    const t = discussionThread({
      participants: [
        { id: 1, display_name: "Ada" },
        { id: 2, display_name: "Bob" },
      ],
      view: [
        {
          id: 10,
          user_id: 1,
          created_at: "2026-11-01T10:00:00Z",
          message: "<p>Question?</p>",
          replies: [{ id: 11, user_id: 2, created_at: "2026-11-01T11:00:00Z", message: "Answer", rating_sum: 2 }],
        },
        { id: 12, deleted: true, created_at: "2026-11-01T12:00:00Z" },
      ],
      new_entries: [
        { id: 14, parent_id: 13, user_id: 2, created_at: "2026-11-02T10:00:00Z", message: "Reply to new" },
        { id: 13, parent_id: 11, user_id: 1, created_at: "2026-11-02T09:00:00Z", message: "Thanks" },
        { id: 11, parent_id: 10, user_id: 2, created_at: "2026-11-01T11:00:00Z", message: "Answer" },
      ],
    });
    assert.equal(t.count, 5);
    assert.deepEqual(t.entries[0], {
      id: 10,
      author: "Ada",
      created_at: "2026-11-01T10:00:00Z",
      message: "Question?",
      replies: [
        {
          id: 11,
          author: "Bob",
          created_at: "2026-11-01T11:00:00Z",
          message: "Answer",
          likes: 2,
          replies: [
            {
              id: 13,
              author: "Ada",
              created_at: "2026-11-02T09:00:00Z",
              message: "Thanks",
              replies: [{ id: 14, author: "Bob", created_at: "2026-11-02T10:00:00Z", message: "Reply to new" }],
            },
          ],
        },
      ],
    });
    assert.deepEqual(t.entries[1], { id: 12, author: null, created_at: "2026-11-01T12:00:00Z", message: "(deleted)" });
  });
});

describe("mapRubric", () => {
  const rubric = [
    {
      id: "c1",
      description: "Correctness",
      long_description: "Code passes the tests",
      points: 6,
      ratings: [
        { id: "r1", points: 6, description: "All pass" },
        { id: "r2", points: 3, description: "Some pass", long_description: "At least half" },
      ],
    },
    { id: "c2", description: "Style", points: 4, ratings: [] },
  ];

  it("lists criteria with rating levels", () => {
    assert.deepEqual(mapRubric(rubric)[0], {
      criterion: "Correctness",
      details: "Code passes the tests",
      points: 6,
      ratings: ["6: All pass", "3: Some pass — At least half"],
    });
  });

  it("adds your assessment per criterion", () => {
    const [c1, c2] = mapRubric(rubric, { c1: { points: 3, rating_id: "r2", comments: "Edge cases fail" }, c2: { points: 4 } });
    assert.deepEqual([c1.your_points, c1.your_rating, c1.comments], [3, "Some pass", "Edge cases fail"]);
    assert.deepEqual([c2.your_points, "your_rating" in c2], [4, false]);
  });
});

describe("mapQuiz", () => {
  it("spells out unlimited attempts and lock state", () => {
    const q = mapQuiz({ id: 1, title: "Q", allowed_attempts: -1, locked_for_user: true, lock_explanation: "<p>Opens Monday</p>", time_limit: 30 });
    assert.equal(q.allowed_attempts, "unlimited");
    assert.equal(q.lock_explanation, "Opens Monday");
    assert.equal(q.time_limit_min, 30);
  });
});
