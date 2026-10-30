// Course snapshots: collect the current state of each active course (GET-only), normalize and
// hash every entity, store it in SQLite, and record what changed since the last run.

import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { CanvasClient, CanvasError, htmlToText, sleep } from "./canvas.js";
import { FileReader } from "./extract.js";
import { analyzeHtml, CourseCrawl, crawlCourse, LinkContext, mapLimit } from "./links.js";
import { EntityData, EntityRow, EventRow, RunRow, Store } from "./store.js";
import { log } from "./log.js";
import { localParts } from "./time.js";

export const KINDS = [
  "page",
  "module",
  "assignment",
  "announcement",
  "discussion",
  "quiz",
  "event",
  "syllabus",
  "file",
] as const;
export type Kind = (typeof KINDS)[number];

export const ROLES = ["student", "ta", "teacher", "observer"] as const;
export type Role = (typeof ROLES)[number];

export interface CourseConfig {
  id: string;
  label: string;
  name?: string | null;
  /**
   * Your role in the course. "ta"/"teacher": your own submissions are skipped and only staff
   * discussion topics are kept. "observer": no own submissions either.
   */
  role: Role;
}

const isStaff = (role: Role) => role === "ta" || role === "teacher";

/** SNAPSHOT_COURSES entry: "123", or legacy "123:Label" / "123:Label:ta" to override discovery. */
export function parseCourseOverride(spec: string): { id: string; label?: string; role?: Role } {
  const [id, label, role] = spec.split(":").map((x) => x.trim());
  if (!/^\d+$/.test(id)) throw new Error(`Bad SNAPSHOT_COURSES entry "${spec}" (expected a course id)`);
  if (role && !(ROLES as readonly string[]).includes(role)) throw new Error(`Bad role "${role}" in SNAPSHOT_COURSES (use ${ROLES.join(", ")})`);
  return { id, ...(label ? { label } : {}), ...(role ? { role: role as Role } : {}) };
}

/** Strongest role wins when someone has several enrollments in a course. */
export function roleFromEnrollments(types: string[]): Role {
  const t = types.map((x) => x.toLowerCase().replace(/enrollment$/, ""));
  if (t.includes("teacher") || t.includes("designer")) return "teacher";
  if (t.includes("ta")) return "ta";
  if (t.includes("student")) return "student";
  return t.includes("observer") ? "observer" : "student";
}

/** Active courses with the user's role in each, filtered by SNAPSHOT_COURSES / SNAPSHOT_EXCLUDE. */
export type CourseScope = "dashboard" | "active";

/** Courses whose course or term end date passed more than this long ago are skipped. */
const ENDED_GRACE_MS = 14 * 86_400_000;

function hasEnded(c: any, now: number): boolean {
  if (c.concluded) return true;
  const end = c.end_at ?? c.term?.end_at;
  return Boolean(end) && Date.parse(end) < now - ENDED_GRACE_MS;
}

/**
 * Courses to snapshot. Many institutions never conclude old enrollments, so "active" alone can mean
 * every course you ever took. The default scope is therefore your dashboard: the courses you've
 * favorited, or Canvas's automatic pick of current courses if you haven't chosen any.
 * An explicit include list (SNAPSHOT_COURSES) overrides the scope.
 */
export async function discoverCourses(
  canvas: CanvasClient,
  include: string[],
  exclude: string[],
  scope: CourseScope = "dashboard",
  now = Date.now(),
): Promise<CourseConfig[]> {
  const overrides = new Map(include.map(parseCourseOverride).map((o) => [o.id, o]));
  const list = await canvas.getAll("/api/v1/courses", { enrollment_state: "active", "include[]": ["term", "concluded"] }, 500);
  let dashboard: Set<string> | null = null;
  if (!overrides.size && scope === "dashboard") {
    try {
      const favs = await canvas.getAll("/api/v1/users/self/favorites/courses", {}, 200);
      dashboard = new Set(favs.map((c: any) => String(c.id)));
    } catch (e) {
      log(`couldn't read your dashboard courses (${(e as Error).message}); using all active courses`);
    }
  }
  return list
    .filter((c: any) => c.name && !c.access_restricted_by_date)
    .filter((c: any) => (overrides.size ? overrides.has(String(c.id)) : !hasEnded(c, now)))
    .filter((c: any) => !dashboard || dashboard.has(String(c.id)))
    .filter((c: any) => !exclude.includes(String(c.id)))
    .map((c: any) => {
      const o = overrides.get(String(c.id));
      return {
        id: String(c.id),
        label: o?.label ?? c.course_code ?? c.name,
        name: c.name,
        role: o?.role ?? roleFromEnrollments((c.enrollments ?? []).map((e: any) => String(e.type ?? e.role ?? ""))),
      };
    });
}

export interface Entity {
  kind: Kind;
  id: string;
  title: string;
  url?: string | null;
  data: EntityData;
}

export interface KindResult {
  entities: Entity[];
  /** False if the source failed: nothing of this kind is marked removed this run. */
  complete: boolean;
  /** Ids we know exist but couldn't read this run (never marked removed). */
  keep?: Set<string>;
  /**
   * Items that come from a source this run could read (e.g. the files index, visible to TAs).
   * The first time a source is read its items are absorbed silently, like a baseline, instead of
   * all showing up as "added".
   */
  quiet?: { source: string; ids: Set<string> };
}

const DIFF_CHARS = 1500;
const PAUSE_BETWEEN_COURSES_MS = 3000;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hashData = (d: EntityData) => sha(JSON.stringify({ f: d.fields, t: d.text ?? "" }));

/** HTML -> stable text: file links reduced to file:<id>, whitespace collapsed. */
function normText(html: string | null | undefined, ctx: LinkContext): string {
  if (!html) return "";
  return htmlToText(analyzeHtml(html, ctx).html, 1_000_000)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const clean = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === undefined ? null : v]));

// ---- collection ----

async function staffRoles(canvas: CanvasClient, courseId: string): Promise<Map<string, string> | null> {
  const users = await canvas.getAll(
    `/api/v1/courses/${courseId}/users`,
    { "enrollment_type[]": ["teacher", "ta"], "include[]": ["enrollments"] },
    500,
  );
  const roles = new Map<string, string>();
  for (const u of users) {
    const types = (u.enrollments ?? []).map((e: any) => e.type);
    roles.set(String(u.id), types.includes("TeacherEnrollment") ? "teacher" : "ta");
  }
  return roles;
}

function authorOf(topic: any, staff: Map<string, string> | null) {
  const id = topic.author?.id ?? topic.user_id;
  return {
    author: topic.author?.display_name ?? topic.user_name ?? null,
    // Unknown when the staff list is unavailable or the post has no author (copied from an old round).
    author_role: staff && id != null ? (staff.get(String(id)) ?? "student") : null,
  };
}

interface CollectOptions {
  crawlMaxPages: number;
  announcementDays: number;
  extract: "linked" | "all" | "none";
}

async function collectCourse(
  canvas: CanvasClient,
  files: FileReader,
  store: Store,
  course: CourseConfig,
  opts: CollectOptions,
  errors: { source: string; message: string }[],
): Promise<Map<Kind, KindResult>> {
  const id = course.id;
  const api = `/api/v1/courses/${id}`;
  const attempt = async <T>(source: string, p: Promise<T>): Promise<T | null> => {
    try {
      return await p;
    } catch (e) {
      errors.push({ source, message: (e as Error).message.slice(0, 240) });
      return null;
    }
  };

  const crawl: CourseCrawl = await crawlCourse(canvas, id, {
    maxPages: opts.crawlMaxPages,
    assignmentInclude: course.role === "student" ? ["submission"] : undefined,
    announcementDays: opts.announcementDays,
  });
  errors.push(...crawl.errors);
  const ctx = crawl.ctx;

  const [staff, discussions, quizzes, events] = [
    await attempt("staff list (teacher/TA roles)", staffRoles(canvas, id)),
    await attempt("discussions", canvas.getAll(`${api}/discussion_topics`, {}, 300)),
    await attempt("quizzes", canvas.getAll(`${api}/quizzes`, {}, 300)),
    await attempt(
      "calendar events",
      canvas.getAll("/api/v1/calendar_events", { "context_codes[]": [`course_${id}`], type: "event", all_events: true }, 1000),
    ),
  ];

  const out = new Map<Kind, KindResult>();
  out.set("page", {
    complete: crawlComplete(crawl),
    keep: new Set(crawl.failedPages),
    // The crawl doesn't record which pages only the index had, so the first indexed run absorbs all new ones.
    ...(crawl.indexed.pages ? { quiet: { source: "page:index", ids: new Set(crawl.pages.keys()) } } : {}),
    entities: [...crawl.pages.values()].map((p) => ({
      kind: "page",
      id: p.url,
      title: p.title,
      url: p.html_url,
      data: { fields: clean({ title: p.title, front_page: Boolean(p.front_page), locked: Boolean(p.locked_for_user) }), text: normText(p.body, ctx) },
    })),
  });

  if (crawl.modules) {
    out.set("module", {
      complete: true,
      entities: crawl.modules.map((m: any) => ({
        kind: "module",
        id: String(m.id),
        title: m.name,
        url: `${ctx.base}/courses/${id}/modules#module_${m.id}`,
        data: {
          fields: clean({
            name: m.name,
            position: m.position,
            unlock_at: m.unlock_at,
            items: (m.items ?? []).map((i: any) => `${"  ".repeat(i.indent ?? 0)}${i.type}: ${i.title}`),
          }),
        },
      })),
    });
  }

  if (crawl.assignments) {
    out.set("assignment", {
      complete: true,
      entities: crawl.assignments.map((a: any) => {
        const s = a.submission;
        return {
          kind: "assignment",
          id: String(a.id),
          title: a.name,
          url: a.html_url,
          data: {
            fields: clean({
              name: a.name,
              due_at: a.due_at,
              unlock_at: a.unlock_at,
              lock_at: a.lock_at,
              points: a.points_possible,
              submission_types: (a.submission_types ?? []).join(", "),
              // New Quizzes are assignments (classic quizzes are under kind "quiz"). Fields are only
              // added when present so stored hashes stay stable for everything else.
              ...(a.is_quiz_lti_assignment ? { quiz_engine: "new_quizzes" } : {}),
              ...(isStaff(course.role) && typeof a.needs_grading_count === "number" ? { needs_grading: a.needs_grading_count } : {}),
              ...(course.role === "student"
                ? {
                    submission_state: s?.workflow_state,
                    submitted_at: s?.submitted_at,
                    grade: s?.grade,
                    score: s?.score,
                    missing: s?.missing,
                    late: s?.late,
                  }
                : {}),
            }),
            text: normText(a.description, ctx),
          },
        };
      }),
    });
  }

  if (crawl.announcements) {
    out.set("announcement", {
      complete: true,
      entities: crawl.announcements.map((d: any) => ({
        kind: "announcement",
        id: String(d.id),
        title: d.title,
        url: d.html_url,
        data: {
          fields: clean({ title: d.title, ...authorOf(d, staff), posted_at: d.posted_at, delayed_post_at: d.delayed_post_at }),
          text: normText(d.message, ctx),
        },
      })),
    });
  }

  if (discussions) {
    const relevant = discussions.filter((d: any) => {
      if (!isStaff(course.role) || !staff) return true;
      return authorOf(d, staff).author_role !== "student";
    });
    out.set("discussion", {
      complete: true,
      entities: relevant.map((d: any) => ({
        kind: "discussion",
        id: String(d.id),
        title: d.title,
        url: d.html_url,
        data: {
          fields: clean({
            title: d.title,
            ...authorOf(d, staff),
            posted_at: d.posted_at,
            due_at: d.assignment?.due_at,
            locked: Boolean(d.locked),
          }),
          text: normText(d.message, ctx),
        },
      })),
    });
  }

  if (quizzes) {
    out.set("quiz", {
      complete: true,
      entities: quizzes.map((q: any) => ({
        kind: "quiz",
        id: String(q.id),
        title: q.title,
        url: q.html_url,
        data: {
          fields: clean({
            title: q.title,
            due_at: q.due_at,
            unlock_at: q.unlock_at,
            lock_at: q.lock_at,
            points: q.points_possible,
            questions: q.question_count,
            time_limit_min: q.time_limit,
            allowed_attempts: q.allowed_attempts,
          }),
          text: normText(q.description, ctx),
        },
      })),
    });
  }

  if (events) {
    out.set("event", {
      complete: true,
      entities: events.map((e: any) => ({
        kind: "event",
        id: String(e.id),
        title: e.title,
        url: e.html_url,
        data: {
          fields: clean({ title: e.title, start_at: e.start_at, end_at: e.end_at, location: e.location_name, address: e.location_address }),
          text: normText(e.description, ctx),
        },
      })),
    });
  }

  if (crawl.syllabus !== null) {
    out.set("syllabus", {
      complete: true,
      entities: [
        {
          kind: "syllabus",
          id: "syllabus",
          title: "Syllabus",
          url: `${ctx.base}/courses/${id}/assignments/syllabus`,
          data: { fields: {}, text: normText(crawl.syllabus, ctx) },
        },
      ],
    });
  }

  out.set("file", await collectFiles(files, store, course, crawl, opts.extract, errors));
  return out;
}

/** File metadata for every linked file; text is (re-)extracted only when new or updated_at changed. */
async function collectFiles(
  files: FileReader,
  store: Store,
  course: CourseConfig,
  crawl: CourseCrawl,
  extractPolicy: CollectOptions["extract"],
  errors: { source: string; message: string }[],
): Promise<KindResult> {
  const prev = new Map(store.entities(course.id, "file", true).map((r) => [r.entity_id, r]));
  const keep = new Set<string>();
  const entities = await mapLimit(crawl.files, 2, async (f): Promise<Entity | null> => {
    if (!f.meta) {
      keep.add(f.file_id);
      errors.push({ source: `file ${f.file_id} (${f.link_texts[0] ?? ""})`, message: f.error ?? "no metadata" });
      return null;
    }
    const m = f.meta;
    const old = prev.get(f.file_id);
    let content_hash: string | null = null;
    let page_hashes: string[] | null = null;
    let extract_note: string | null = null;
    let extract_retry = false;
    if (old && old.data.extra?.updated_at === m.updated_at && !old.data.extra?.extract_retry) {
      content_hash = (old.data.fields.content_hash as string | null) ?? null;
      page_hashes = (old.data.extra?.page_hashes as string[] | null) ?? null;
      extract_note = (old.data.extra?.extract_note as string | null) ?? null;
    } else if (extractPolicy === "all" || (extractPolicy === "linked" && f.linked)) {
      try {
        const { entry } = await files.readWithMeta(f.file_id, m);
        const units = entry.extracted.units.map((u) => u.text);
        content_hash = sha(units.join("\f")).slice(0, 32);
        page_hashes = units.map((t) => sha(t).slice(0, 12));
      } catch (e) {
        // Unsupported formats (images, .doc) just aren't diffable by content; that's not an error.
        extract_note = (e as Error).message.slice(0, 160);
        // Unsupported, too large or locked won't change until the file does; anything else is retried.
        const permanent = e instanceof CanvasError && [403, 413, 415].includes(e.status);
        extract_retry = !permanent;
        if (!(e instanceof CanvasError && e.status === 415)) {
          errors.push({ source: `extract file ${f.file_id} (${m.display_name})`, message: extract_note });
        }
      }
    }
    return {
      kind: "file",
      id: f.file_id,
      title: m.display_name,
      url: `${crawl.ctx.base}/courses/${f.course_id ?? course.id}/files/${f.file_id}`,
      data: {
        fields: clean({
          name: m.display_name,
          size: m.size,
          content_type: m["content-type"],
          // Unextractable files fall back to updated_at as their content identity.
          content_hash: content_hash?.startsWith("updated:") || !content_hash ? `updated:${m.updated_at}` : content_hash,
          pages: page_hashes?.length ?? null,
        }),
        extra: clean({
          updated_at: m.updated_at,
          page_hashes,
          linked_from: f.linked_from,
          link_texts: f.link_texts,
          ...(extract_note ? { extract_note } : {}),
          ...(extract_retry ? { extract_retry } : {}),
        }),
      },
    };
  });
  return {
    complete: crawlComplete(crawl),
    keep,
    entities: entities.filter((e): e is Entity => e !== null),
    ...(crawl.indexed.files ? { quiet: { source: "file:index", ids: new Set(crawl.files.filter((f) => !f.linked).map((f) => f.file_id)) } } : {}),
  };
}

/**
 * Pages and files are found by following links, so something is only "removed" if every source
 * that could link to it was read. A 404 page link is fine (it has no links of its own).
 */
export function crawlComplete(crawl: CourseCrawl): boolean {
  return crawl.errors.every((e) => e.source.startsWith("page ") && e.message.startsWith("Canvas 404"));
}

// ---- diffing ----

/**
 * Fields added to snapshots after 1.2.0, stored only when they have a value. Their first
 * appearance on an item stored by an older version isn't a change. Append to this list when
 * adding such a field.
 */
export const LATER_FIELDS = new Set(["quiz_engine", "needs_grading"]);

export function fieldDiffs(oldF: Record<string, unknown>, newF: Record<string, unknown>) {
  const out: Record<string, unknown>[] = [];
  for (const k of new Set([...Object.keys(oldF), ...Object.keys(newF)])) {
    if (LATER_FIELDS.has(k) && !(k in oldF)) continue;
    const a = oldF[k] ?? null;
    const b = newF[k] ?? null;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (Array.isArray(a) && Array.isArray(b)) {
      out.push({ field: k, added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) });
    } else {
      out.push({ field: k, old: a, new: b });
    }
  }
  return out;
}

export function textDiff(a: string, b: string): { summary: string; diff: string } {
  const patch = createTwoFilesPatch("before", "after", a + "\n", b + "\n", undefined, undefined, { context: 1 });
  const lines = patch.split("\n").slice(4); // drop Index/===/---/+++ headers
  const added = lines.filter((l) => l.startsWith("+")).length;
  const removed = lines.filter((l) => l.startsWith("-")).length;
  let diff = lines.join("\n").trim();
  if (diff.length > DIFF_CHARS) diff = diff.slice(0, DIFF_CHARS) + "\n…";
  return { summary: `+${added} / -${removed} lines`, diff };
}

/** "3, 7-9" */
export function ranges(nums: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(i === j ? `${nums[i]}` : `${nums[i]}-${nums[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

export function filePageChanges(oldH: string[] | null | undefined, newH: string[] | null | undefined) {
  if (!oldH || !newH) return {};
  const changed: number[] = [];
  for (let i = 0; i < Math.min(oldH.length, newH.length); i++) if (oldH[i] !== newH[i]) changed.push(i + 1);
  return {
    ...(changed.length ? { pages_changed: ranges(changed) } : {}),
    ...(newH.length > oldH.length ? { pages_added: ranges(Array.from({ length: newH.length - oldH.length }, (_, k) => oldH.length + k + 1)) } : {}),
    ...(newH.length < oldH.length ? { pages_removed: `${newH.length + 1}-${oldH.length}` } : {}),
  };
}

const OLD_ANNOUNCEMENT_NOTE = "unpublished/old: posted_at is null (probably copied from a previous course round)";

function changeDetails(kind: Kind, old: EntityRow | undefined, cur: Entity): Record<string, unknown> {
  if (!old) {
    const d: Record<string, unknown> = { fields: cur.data.fields };
    if (cur.data.text) d.text_preview = cur.data.text.slice(0, 600);
    if (kind === "announcement" && cur.data.fields.posted_at == null) d.note = OLD_ANNOUNCEMENT_NOTE;
    if (kind === "file") delete (d.fields as any).content_hash;
    return d;
  }
  const d: Record<string, unknown> = {};
  const fields = fieldDiffs(old.data.fields, cur.data.fields).filter((f) => f.field !== "content_hash");
  if (fields.length) d.fields = fields;
  if ((old.data.text ?? "") !== (cur.data.text ?? "")) Object.assign(d, textDiff(old.data.text ?? "", cur.data.text ?? ""));
  if (kind === "file") {
    Object.assign(d, filePageChanges(old.data.extra?.page_hashes as string[], cur.data.extra?.page_hashes as string[]));
    if (old.data.fields.content_hash !== cur.data.fields.content_hash && !d.pages_changed && !d.pages_added && !d.pages_removed) {
      d.note = "file content changed";
    }
  }
  if (kind === "announcement" && cur.data.fields.posted_at == null) d.note = OLD_ANNOUNCEMENT_NOTE;
  return d;
}

/** Write one course's collected state and return the number of events produced. */
export function applySnapshot(store: Store, courseId: string, runId: number, now: string, results: Map<Kind, KindResult>) {
  let events = 0;
  const firstRun = !store.lastRun(courseId, true);
  const counts: Record<string, number> = {};
  store.transaction(() => {
    for (const [kind, res] of results) {
      counts[kind] = res.entities.length;
      const baseline = !store.isBaselined(courseId, kind);
      const quiet = res.quiet && !store.isBaselined(courseId, res.quiet.source) ? res.quiet.ids : null;
      const prev = new Map(store.entities(courseId, kind, true).map((r) => [r.entity_id, r]));
      const seen = new Set<string>();
      const emit = (change: EventRow["change"], e: { id: string; title: string; url?: string | null }, details: Record<string, unknown>) => {
        events++;
        store.addEvent({ run_id: runId, course_id: courseId, kind, entity_id: e.id, change, title: e.title, url: e.url ?? null, detected_at: now, details });
      };

      for (const e of res.entities) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        const old = prev.get(e.id);
        const hash = hashData(e.data);
        store.upsertEntity({
          course_id: courseId,
          kind,
          entity_id: e.id,
          title: e.title ?? "",
          url: e.url ?? null,
          data: e.data,
          hash,
          first_seen: old?.first_seen ?? now,
          last_seen: now,
          removed_at: null,
        });
        if (baseline) continue;
        if (!old) {
          if (!quiet?.has(e.id)) emit("added", e, changeDetails(kind, undefined, e));
        }
        else if (old.removed_at) {
          if (!quiet?.has(e.id)) emit("added", e, { ...changeDetails(kind, undefined, e), note: `reappeared (was removed ${old.removed_at})` });
        }
        else if (old.hash !== hash) {
          // A hash change with no visible difference (e.g. after a normalization tweak) is not news.
          const details = changeDetails(kind, old, e);
          if (Object.keys(details).length) emit("changed", e, details);
        }
      }

      if (res.complete) {
        for (const old of prev.values()) {
          if (old.removed_at || seen.has(old.entity_id) || res.keep?.has(old.entity_id)) continue;
          store.markRemoved(courseId, kind, old.entity_id, now);
          if (!baseline) emit("removed", { id: old.entity_id, title: old.title, url: old.url }, { fields: old.data.fields });
        }
      }
      // A kind is baselined once it has been read successfully.
      if (baseline && (res.complete || res.entities.length)) store.setBaselined(courseId, kind, now);
      if (res.quiet) store.setBaselined(courseId, res.quiet.source, now);
    }
    if (firstRun) {
      events++;
      store.addEvent({
        run_id: runId,
        course_id: courseId,
        kind: "course",
        entity_id: courseId,
        change: "baseline",
        title: "Baseline snapshot (first run — no per-item events)",
        url: null,
        detected_at: now,
        details: { counts },
      });
    }
  });
  return { events, counts, baseline: firstRun };
}

// ---- service ----

export interface SnapshotOptions extends CollectOptions {
  /** Which courses to snapshot when no include list is given. */
  scope: CourseScope;
  /** SNAPSHOT_COURSES entries; empty = every active course. */
  include: string[];
  exclude: string[];
  /** "HH:MM" in DISPLAY_TZ, or "off". */
  dailyAt: string;
  /** Snapshots older than this are refreshed at startup and when a tool asks for fresh data. */
  maxAgeHours: number;
  retentionDays: number;
  startupDelayMs?: number;
}

export class SnapshotService {
  private running: { promise: Promise<number[]>; started: string; courses: string[] } | null = null;

  constructor(
    private canvas: CanvasClient,
    private files: FileReader,
    readonly store: Store,
    readonly opts: SnapshotOptions,
  ) {}

  /** Courses from the last discovery (stored, so no Canvas call). */
  get courses(): CourseConfig[] {
    return this.store.courses().map((c) => ({ id: c.course_id, label: c.label, name: c.name, role: c.role as Role }));
  }

  get inProgress() {
    return this.running ? { started: this.running.started, courses: this.running.courses } : null;
  }

  /** Run (or join) a snapshot; resolves to the run ids produced. */
  run(courseIds?: string[]): { promise: Promise<number[]>; joined: boolean } {
    if (this.running) return { promise: this.running.promise, joined: true };
    const running = { promise: null as unknown as Promise<number[]>, started: new Date().toISOString(), courses: courseIds ?? [] };
    running.promise = (async () => {
      const courses = await this.refreshCourses();
      const targets = courseIds?.length ? courses.filter((c) => courseIds.includes(c.id)) : courses;
      if (courseIds?.length && !targets.length) {
        throw new Error(`Course ${courseIds.join(", ")} is not among your active courses (${courses.map((c) => `${c.id} ${c.label}`).join(", ")})`);
      }
      running.courses = targets.map((c) => c.id);
      return this.runCourses(targets);
    })().finally(() => {
      this.running = null;
    });
    this.running = running;
    return { promise: running.promise, joined: false };
  }

  /** Re-discover active courses; on failure keep the stored list. */
  private async refreshCourses(): Promise<CourseConfig[]> {
    try {
      const found = await discoverCourses(this.canvas, this.opts.include, this.opts.exclude, this.opts.scope);
      this.store.setCourses(
        found.map((c) => ({ course_id: c.id, label: c.label, name: c.name ?? null, role: c.role })),
        new Date().toISOString(),
      );
      return found;
    } catch (e) {
      log(`course discovery failed, using the stored course list: ${(e as Error).message}`);
      return this.courses;
    }
  }

  private async runCourses(targets: CourseConfig[]): Promise<number[]> {
    this.store.pruneEvents(new Date(Date.now() - this.opts.retentionDays * 86_400_000).toISOString());
    const runIds: number[] = [];
    for (const [i, course] of targets.entries()) {
      if (i > 0) await sleep(PAUSE_BETWEEN_COURSES_MS);
      runIds.push(await this.runCourse(course));
    }
    return runIds;
  }

  private async runCourse(course: CourseConfig): Promise<number> {
    const started = Date.now();
    const startedIso = new Date(started).toISOString();
    const runId = this.store.startRun(course.id, startedIso);
    const errors: { source: string; message: string }[] = [];
    let result = { events: 0, counts: {} as Record<string, number>, baseline: false };
    let ok = 1;
    try {
      const collected = await collectCourse(this.canvas, this.files, this.store, course, this.opts, errors);
      result = applySnapshot(this.store, course.id, runId, startedIso, collected);
    } catch (e) {
      ok = 0;
      errors.push({ source: "course", message: (e as Error).message.slice(0, 300) });
    }
    this.store.finishRun(runId, {
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      ok,
      baseline: result.baseline ? 1 : 0,
      counts: result.counts,
      errors,
      events: result.events,
    });
    log(
      `snapshot ${course.label} (${course.id}, ${course.role}): ${ok ? "ok" : "FAILED"} in ${((Date.now() - started) / 1000).toFixed(1)}s, ` +
        `${result.events} events, ${errors.length} errors`,
    );
    return runId;
  }

  /** True if no course is known yet, or any course lacks a successful run within maxAgeHours. */
  isStale(at: Date = new Date()): boolean {
    const courses = this.courses;
    if (!courses.length) return true;
    return courses.some((c) => {
      const last = this.store.lastRun(c.id, true);
      return !last || at.getTime() - Date.parse(last.started_at) > this.opts.maxAgeHours * 3_600_000;
    });
  }

  /** Start a background run if the data is stale. Returns true if a run is now in progress. */
  ensureFresh(): boolean {
    if (this.running) return true;
    if (!this.isStale()) return false;
    this.run().promise.catch((e) => log("snapshot failed:", e));
    return true;
  }

  /** Daily run at opts.dailyAt local time, plus a catch-up run shortly after startup if stale. */
  startScheduler() {
    setTimeout(() => this.ensureFresh(), this.opts.startupDelayMs ?? 15_000).unref();
    if (this.opts.dailyAt === "off") return;
    const tick = () => {
      if (this.running || !this.isDue()) return;
      this.run().promise.catch((e) => log("scheduled snapshot failed:", e));
    };
    setInterval(tick, 60_000).unref();
  }

  /** Due when local time has passed dailyAt today and some course hasn't run since then. */
  isDue(at: Date = new Date()): boolean {
    if (this.opts.dailyAt === "off") return false;
    const now = localParts(at);
    if (now.time < this.opts.dailyAt) return false;
    const courses = this.courses;
    if (!courses.length) return true;
    // A manual one-course run doesn't count for the rest.
    return courses.some((c) => {
      const started = this.store.lastRun(c.id)?.started_at;
      if (!started) return true;
      const last = localParts(new Date(started));
      return !(last.date === now.date && last.time >= this.opts.dailyAt);
    });
  }

  nextRun(): string | null {
    if (this.opts.dailyAt === "off") return null;
    const now = localParts(new Date());
    return `${this.isDue() || now.time < this.opts.dailyAt ? "today" : "tomorrow"} ${this.opts.dailyAt}`;
  }

  lastRuns(): (CourseConfig & { last: RunRow | null })[] {
    return this.courses.map((c) => ({ ...c, last: this.store.lastRun(c.id) }));
  }
}
