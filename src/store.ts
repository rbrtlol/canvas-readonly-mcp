// SQLite persistence for course snapshots: one row per entity, change events, and run log.
// Uses Node's built-in node:sqlite (no native build step in the Alpine image).

import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface EntityData {
  /** Structured, hashed fields; diffed field by field. */
  fields: Record<string, unknown>;
  /** Normalized long text (page body, description, message); hashed and diffed as text. */
  text?: string;
  /** Stored but not hashed (volatile or derived values, e.g. a file's updated_at). */
  extra?: Record<string, unknown>;
}

export interface EntityRow {
  course_id: string;
  kind: string;
  entity_id: string;
  title: string;
  url: string | null;
  data: EntityData;
  hash: string;
  first_seen: string;
  last_seen: string;
  removed_at: string | null;
}

export interface EventRow {
  id?: number;
  run_id: number;
  course_id: string;
  kind: string;
  entity_id: string;
  change: "added" | "changed" | "removed" | "baseline";
  title: string;
  url: string | null;
  detected_at: string;
  details: Record<string, unknown>;
}

export interface RunRow {
  id: number;
  course_id: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  ok: number;
  baseline: number;
  counts: Record<string, number>;
  errors: { source: string; message: string }[];
  events: number;
}

export interface CourseRow {
  course_id: string;
  label: string;
  name: string | null;
  role: string;
}

// Migration n brings a database from user_version n to n+1. Never edit a released migration;
// append a new one. The first uses IF NOT EXISTS because it predates versioning.
const MIGRATIONS = [
  `
CREATE TABLE IF NOT EXISTS entities (
  course_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  data TEXT NOT NULL,
  hash TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY (course_id, kind, entity_id)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  course_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  change TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  detected_at TEXT NOT NULL,
  details TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_time ON events (detected_at);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  ok INTEGER NOT NULL DEFAULT 0,
  baseline INTEGER NOT NULL DEFAULT 0,
  counts TEXT NOT NULL DEFAULT '{}',
  errors TEXT NOT NULL DEFAULT '[]',
  events INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_by_course ON runs (course_id, id);
-- When each (course, kind) got its baseline; kinds without one don't emit "added" events.
CREATE TABLE IF NOT EXISTS kind_baselines (
  course_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  baselined_at TEXT NOT NULL,
  PRIMARY KEY (course_id, kind)
);
`,
  `
-- Courses found by discovery, so tools can label courses without calling Canvas.
CREATE TABLE courses (
  course_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
`,
  `
-- Full-text search over snapshot text. search_docs says what each FTS row belongs to (rowid = id):
-- one row per item, or one per page/slide/section for files with extracted text (unit = 1-based).
CREATE TABLE search_docs (
  id INTEGER PRIMARY KEY,
  course_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  unit INTEGER
);
CREATE INDEX search_docs_by_entity ON search_docs (course_id, kind, entity_id);
CREATE VIRTUAL TABLE search USING fts5(title, body, tokenize = 'unicode61 remove_diacritics 2');
-- Index what is already stored; file text is added by the next snapshot (mostly from the file cache).
INSERT INTO search_docs (course_id, kind, entity_id) SELECT course_id, kind, entity_id FROM entities WHERE removed_at IS NULL;
INSERT INTO search (rowid, title, body)
SELECT d.id, e.title,
  CASE WHEN e.kind = 'module' THEN COALESCE((SELECT group_concat(value, char(10)) FROM json_each(e.data, '$.fields.items')), '')
       ELSE COALESCE(json_extract(e.data, '$.text'), '') END
FROM search_docs d JOIN entities e USING (course_id, kind, entity_id);
`,
];

export interface SearchHit {
  course_id: string;
  kind: string;
  entity_id: string;
  unit: number | null;
  title: string;
  url: string | null;
  snippet: string;
}

/**
 * Plain words become prefix terms that must all match ("dyn prog" finds "dynamic programming");
 * "quoted text" is a phrase. With any = true, terms are OR'ed instead. Null if nothing searchable.
 */
export function ftsQuery(q: string, any = false): string | null {
  const terms: string[] = [];
  for (const m of q.matchAll(/"([^"]*)"|([^\s"]+)/g)) {
    const words = (m[1] ?? m[2]).match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!words.length) continue;
    if (m[1] !== undefined) terms.push(`"${words.join(" ")}"`);
    else terms.push(...words.map((w) => `"${w}"*`));
  }
  return terms.length ? terms.join(any ? " OR " : " ") : null;
}

const parseEntity = (r: any): EntityRow => ({ ...r, data: JSON.parse(r.data) });
const parseEvent = (r: any): EventRow => ({ ...r, details: JSON.parse(r.details) });
const parseRun = (r: any): RunRow => ({ ...r, counts: JSON.parse(r.counts), errors: JSON.parse(r.errors) });

export class Store {
  readonly db: DatabaseSync;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  private migrate() {
    const current = Number((this.db.prepare("PRAGMA user_version").get() as any).user_version);
    if (current > MIGRATIONS.length) {
      throw new Error(`Database ${this.path} is from a newer version of this server (schema ${current}); upgrade the server`);
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  get schemaVersion(): number {
    return Number((this.db.prepare("PRAGMA user_version").get() as any).user_version);
  }

  /** Replace the set of active courses (others stay, marked inactive, so old events keep labels). */
  setCourses(courses: CourseRow[], at: string) {
    this.transaction(() => {
      this.db.prepare("UPDATE courses SET active = 0").run();
      const up = this.db.prepare(
        `INSERT INTO courses (course_id, label, name, role, active, updated_at) VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT (course_id) DO UPDATE SET label = excluded.label, name = excluded.name, role = excluded.role, active = 1, updated_at = excluded.updated_at`,
      );
      for (const c of courses) up.run(c.course_id, c.label, c.name, c.role, at);
    });
  }

  courses(activeOnly = true): CourseRow[] {
    return this.db.prepare(`SELECT course_id, label, name, role FROM courses ${activeOnly ? "WHERE active = 1" : ""} ORDER BY label`).all() as any;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  entities(courseId: string, kind?: string, includeRemoved = false): EntityRow[] {
    const sql =
      "SELECT * FROM entities WHERE course_id = ?" +
      (kind ? " AND kind = ?" : "") +
      (includeRemoved ? "" : " AND removed_at IS NULL") +
      " ORDER BY kind, title";
    const args = kind ? [courseId, kind] : [courseId];
    return this.db.prepare(sql).all(...args).map(parseEntity);
  }

  upsertEntity(e: EntityRow) {
    this.db
      .prepare(
        `INSERT INTO entities (course_id, kind, entity_id, title, url, data, hash, first_seen, last_seen, removed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (course_id, kind, entity_id) DO UPDATE SET
           title = excluded.title, url = excluded.url, data = excluded.data, hash = excluded.hash,
           last_seen = excluded.last_seen, removed_at = excluded.removed_at`,
      )
      .run(e.course_id, e.kind, e.entity_id, e.title, e.url, JSON.stringify(e.data), e.hash, e.first_seen, e.last_seen, e.removed_at);
  }

  markRemoved(courseId: string, kind: string, entityId: string, at: string) {
    this.db
      .prepare("UPDATE entities SET removed_at = ? WHERE course_id = ? AND kind = ? AND entity_id = ?")
      .run(at, courseId, kind, entityId);
  }

  isBaselined(courseId: string, kind: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM kind_baselines WHERE course_id = ? AND kind = ?").get(courseId, kind));
  }

  setBaselined(courseId: string, kind: string, at: string) {
    this.db.prepare("INSERT OR IGNORE INTO kind_baselines (course_id, kind, baselined_at) VALUES (?, ?, ?)").run(courseId, kind, at);
  }

  addEvent(ev: EventRow) {
    this.db
      .prepare(
        "INSERT INTO events (run_id, course_id, kind, entity_id, change, title, url, detected_at, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(ev.run_id, ev.course_id, ev.kind, ev.entity_id, ev.change, ev.title, ev.url, ev.detected_at, JSON.stringify(ev.details));
  }

  eventsSince(since: string, courseId?: string, kinds?: string[]): EventRow[] {
    let sql = "SELECT * FROM events WHERE detected_at >= ?";
    const args: (string | number)[] = [since];
    if (courseId) {
      sql += " AND course_id = ?";
      args.push(courseId);
    }
    if (kinds?.length) {
      sql += ` AND kind IN (${kinds.map(() => "?").join(",")})`;
      args.push(...kinds);
    }
    return this.db.prepare(sql + " ORDER BY id DESC LIMIT 2000").all(...args).map(parseEvent);
  }

  eventsForRuns(runIds: number[]): EventRow[] {
    if (!runIds.length) return [];
    return this.db
      .prepare(`SELECT * FROM events WHERE run_id IN (${runIds.map(() => "?").join(",")}) ORDER BY id DESC`)
      .all(...runIds)
      .map(parseEvent);
  }

  private searchDocIds(courseId: string, kind: string, entityId: string, unitsOnly = false): number[] {
    const sql = `SELECT id FROM search_docs WHERE course_id = ? AND kind = ? AND entity_id = ?${unitsOnly ? " AND unit IS NOT NULL" : ""}`;
    return this.db.prepare(sql).all(courseId, kind, entityId).map((r: any) => Number(r.id));
  }

  /** Replace an item's search rows: one for a string body, one per unit for an array (files). */
  indexEntity(courseId: string, kind: string, entityId: string, title: string, body: string | string[]) {
    this.unindexEntity(courseId, kind, entityId);
    const doc = this.db.prepare("INSERT INTO search_docs (course_id, kind, entity_id, unit) VALUES (?, ?, ?, ?)");
    const fts = this.db.prepare("INSERT INTO search (rowid, title, body) VALUES (?, ?, ?)");
    const rows: [number | null, string][] = typeof body === "string" ? [[null, body]] : body.length ? body.map((t, i) => [i + 1, t]) : [[null, ""]];
    for (const [unit, text] of rows) fts.run(Number(doc.run(courseId, kind, entityId, unit).lastInsertRowid), title, text);
  }

  unindexEntity(courseId: string, kind: string, entityId: string) {
    const ids = this.searchDocIds(courseId, kind, entityId);
    if (!ids.length) return;
    const list = ids.map(() => "?").join(",");
    this.db.prepare(`DELETE FROM search WHERE rowid IN (${list})`).run(...ids);
    this.db.prepare(`DELETE FROM search_docs WHERE id IN (${list})`).run(...ids);
  }

  isIndexed(courseId: string, kind: string, entityId: string, unitsOnly = false): boolean {
    return this.searchDocIds(courseId, kind, entityId, unitsOnly).length > 0;
  }

  /** Change an item's title without touching its indexed text. */
  retitleIndexed(courseId: string, kind: string, entityId: string, title: string) {
    for (const id of this.searchDocIds(courseId, kind, entityId)) this.db.prepare("UPDATE search SET title = ? WHERE rowid = ?").run(title, id);
  }

  /** Best matches first (title matches weigh more). Throws on an invalid FTS query. */
  search(match: string, opts: { courseId?: string; kinds?: string[]; limit: number }): SearchHit[] {
    let sql = `
      SELECT d.course_id, d.kind, d.entity_id, d.unit, s.title, e.url,
        snippet(search, -1, '«', '»', '…', 20) AS snippet
      FROM search s
      JOIN search_docs d ON d.id = s.rowid
      LEFT JOIN entities e ON e.course_id = d.course_id AND e.kind = d.kind AND e.entity_id = d.entity_id
      WHERE search MATCH ?`;
    const args: (string | number)[] = [match];
    if (opts.courseId) {
      sql += " AND d.course_id = ?";
      args.push(opts.courseId);
    }
    if (opts.kinds?.length) {
      sql += ` AND d.kind IN (${opts.kinds.map(() => "?").join(",")})`;
      args.push(...opts.kinds);
    }
    sql += " ORDER BY bm25(search, 5.0, 1.0) LIMIT ?";
    args.push(opts.limit);
    return this.db.prepare(sql).all(...args) as any;
  }

  pruneEvents(olderThan: string): number {
    return Number(this.db.prepare("DELETE FROM events WHERE detected_at < ?").run(olderThan).changes);
  }

  startRun(courseId: string, at: string): number {
    return Number(this.db.prepare("INSERT INTO runs (course_id, started_at) VALUES (?, ?)").run(courseId, at).lastInsertRowid);
  }

  finishRun(id: number, r: Omit<RunRow, "id" | "course_id" | "started_at">) {
    this.db
      .prepare("UPDATE runs SET finished_at = ?, duration_ms = ?, ok = ?, baseline = ?, counts = ?, errors = ?, events = ? WHERE id = ?")
      .run(r.finished_at, r.duration_ms, r.ok, r.baseline, JSON.stringify(r.counts), JSON.stringify(r.errors), r.events, id);
  }

  runsByIds(ids: number[]): RunRow[] {
    if (!ids.length) return [];
    return this.db
      .prepare(`SELECT * FROM runs WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`)
      .all(...ids)
      .map(parseRun);
  }

  lastRun(courseId: string, okOnly = false): RunRow | null {
    const r = this.db
      .prepare(`SELECT * FROM runs WHERE course_id = ? AND finished_at IS NOT NULL ${okOnly ? "AND ok = 1" : ""} ORDER BY id DESC LIMIT 1`)
      .get(courseId);
    return r ? parseRun(r) : null;
  }

  stats(): { bytes: number; entities: number; events: number } {
    let bytes = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        bytes += statSync(this.path + suffix).size;
      } catch {
        // file may not exist
      }
    }
    const count = (t: string) => Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n);
    return { bytes, entities: count("entities"), events: count("events") };
  }
}
