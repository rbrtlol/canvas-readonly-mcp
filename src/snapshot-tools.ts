import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KINDS, SnapshotService } from "./snapshot.js";
import { EventRow } from "./store.js";
import { DISPLAY_TZ, fmtLocal, localizeTimes } from "./time.js";
import { RO, wrap } from "./tools.js";

const DEFAULT_WAIT_S = 25;
// Tabs the course has turned off: permanent and expected, not worth flagging as errors.
const DISABLED_RE = /has been disabled for this course/i;
const kindsSchema = z.array(z.enum(KINDS)).optional();

function compactEvent(e: EventRow) {
  return {
    change: e.change,
    kind: e.kind,
    title: e.title,
    id: e.entity_id,
    detected_at: e.detected_at,
    ...(e.url ? { url: e.url } : {}),
    ...e.details,
  };
}

export function registerSnapshotTools(server: McpServer, snaps: SnapshotService) {
  // Inactive (past) courses too, so old events keep their labels.
  const label = (id: string) => snaps.store.courses(false).find((c) => c.course_id === id)?.label ?? id;

  const groupByCourse = (events: EventRow[]) => {
    const byCourse = new Map<string, EventRow[]>();
    for (const e of events) byCourse.set(e.course_id, [...(byCourse.get(e.course_id) ?? []), e]);
    return [...byCourse.entries()].map(([course_id, evs]) => ({
      course_id,
      course: label(course_id),
      events: evs.map(compactEvent),
    }));
  };

  server.registerTool(
    "canvas_changes_since",
    {
      title: "Changes since",
      description:
        "What changed in your courses since a time, from stored snapshots (taken daily, and refreshed in the background when stale): " +
        "added/changed/removed pages, assignments (due dates, grades), announcements, discussions, quizzes, events, files " +
        "(with which PDF pages changed), with old→new field values and short text diffs. Grouped by course, newest first. " +
        `Times are ${DISPLAY_TZ}. Default since: 26 hours ago. The best first call for a daily check.`,
      inputSchema: {
        since: z.string().optional().describe("ISO timestamp; default 26h ago"),
        course_id: z.string().optional(),
        kinds: kindsSchema.describe(`Filter to some of: ${KINDS.join(", ")}`),
      },
      annotations: { ...RO, openWorldHint: false },
    },
    wrap(async (a: { since?: string; course_id?: string; kinds?: string[] }) => {
      snaps.ensureFresh();
      const since = new Date(a.since ?? Date.now() - 26 * 3_600_000);
      if (Number.isNaN(since.getTime())) throw new Error(`Bad since timestamp "${a.since}"`);
      const events = snaps.store.eventsSince(since.toISOString(), a.course_id, a.kinds);
      const grouped = groupByCourse(events);
      const courses = snaps.courses
        .filter((c) => !a.course_id || c.id === a.course_id)
        .map((c) => {
          const last = snaps.store.lastRun(c.id);
          const g = grouped.find((x) => x.course_id === c.id);
          return {
            course_id: c.id,
            course: c.label,
            last_snapshot: last?.started_at ?? "never",
            ...(last && !last.ok ? { last_snapshot_failed: true } : {}),
            events: g?.events ?? [],
          };
        });
      // Events for courses no longer configured are still reported.
      for (const g of grouped) if (!courses.some((c) => c.course_id === g.course_id)) courses.push({ ...g, last_snapshot: "n/a" });
      return localizeTimes({
        timezone: DISPLAY_TZ,
        since: since.toISOString(),
        total_events: events.length,
        ...(snaps.inProgress
          ? { snapshot_running_since: snaps.inProgress.started, note: "a snapshot is running; call again in a minute or two for its changes" }
          : {}),
        courses,
      });
    }),
  );

  server.registerTool(
    "canvas_course_snapshot",
    {
      title: "Course snapshot",
      description:
        "The stored state of a course from the latest snapshot (no Canvas calls), compact. " +
        `Use kinds (${KINDS.join(", ")}) to keep it small, e.g. ["assignment"] for all deadlines and grades.`,
      inputSchema: {
        course_id: z.string(),
        kinds: kindsSchema,
        text_chars: z.number().int().min(0).max(5000).optional().describe("Chars of page/description text per item, default 300"),
      },
      annotations: { ...RO, openWorldHint: false },
    },
    wrap(async (a: { course_id: string; kinds?: string[]; text_chars?: number }) => {
      snaps.ensureFresh();
      const rows = snaps.store.entities(a.course_id).filter((r) => !a.kinds?.length || a.kinds.includes(r.kind));
      const max = a.text_chars ?? 300;
      const byKind: Record<string, unknown[]> = {};
      for (const r of rows) {
        const { content_hash, ...fields } = r.data.fields as Record<string, unknown>;
        const extra = r.data.extra ?? {};
        const text = r.data.text ?? "";
        (byKind[r.kind] ??= []).push({
          id: r.entity_id,
          ...fields,
          ...(r.kind === "file" ? { updated_at: extra.updated_at, linked_from: extra.linked_from } : {}),
          ...(r.kind === "announcement" && fields.posted_at == null ? { note: "unpublished/old (posted_at null)" } : {}),
          ...(max && text ? { text: text.length > max ? text.slice(0, max) + "…" : text } : {}),
          first_seen: r.first_seen,
        });
      }
      for (const list of Object.values(byKind)) {
        list.sort((x: any, y: any) => String(x.due_at ?? x.start_at ?? x.posted_at ?? "~").localeCompare(String(y.due_at ?? y.start_at ?? y.posted_at ?? "~")));
      }
      const last = snaps.store.lastRun(a.course_id);
      if (!last) {
        const known = snaps.courses.map((c) => `${c.id} ${c.label}`).join(", ") || "none yet";
        throw new Error(
          `No snapshot yet for course ${a.course_id}${snaps.inProgress ? " (one is running now — try again shortly)" : ""}. Known courses: ${known}`,
        );
      }
      return localizeTimes({ course_id: a.course_id, course: label(a.course_id), snapshot_at: last.started_at, timezone: DISPLAY_TZ, ...byKind });
    }),
  );

  server.registerTool(
    "canvas_snapshot_status",
    {
      title: "Snapshot status",
      description: "Health of the snapshot job: courses and your role in each, last run per course, duration, item counts, errors (e.g. 403s), next run, DB size.",
      inputSchema: {},
      annotations: { ...RO, openWorldHint: false },
    },
    wrap(async () => {
      const st = snaps.store.stats();
      return localizeTimes({
        timezone: DISPLAY_TZ,
        schedule: snaps.opts.dailyAt === "off" ? "disabled" : `daily at ${snaps.opts.dailyAt}`,
        next_run: snaps.nextRun(),
        running: snaps.inProgress,
        db: { size_kb: Math.round(st.bytes / 1024), entities: st.entities, events: st.events },
        courses: snaps.lastRuns().map((c) => ({
          course_id: c.id,
          course: c.label,
          role: c.role,
          ...(c.last
            ? {
                last_run: c.last.started_at,
                duration_s: Math.round((c.last.duration_ms ?? 0) / 100) / 10,
                ok: Boolean(c.last.ok),
                baseline: Boolean(c.last.baseline),
                events: c.last.events,
                counts: c.last.counts,
                errors: c.last.errors.filter((e) => !DISABLED_RE.test(e.message)),
                unavailable: c.last.errors.filter((e) => DISABLED_RE.test(e.message)).map((e) => `${e.source} (disabled for this course)`),
              }
            : { last_run: "never" }),
        })),
      });
    }),
  );

  server.registerTool(
    "canvas_run_snapshot",
    {
      title: "Run snapshot now",
      description:
        "Take a snapshot now (read-only GETs to Canvas) for one or all active courses and return the change events it produced. " +
        "Waits up to wait_s seconds; if it takes longer it continues in the background — check canvas_snapshot_status / canvas_changes_since later.",
      inputSchema: {
        course_id: z.string().optional(),
        wait_s: z.number().int().min(0).max(90).optional().describe(`Seconds to wait for the result, default ${DEFAULT_WAIT_S}`),
      },
      annotations: RO,
    },
    wrap(async ({ course_id, wait_s }: { course_id?: string; wait_s?: number }) => {
      const known = snaps.courses;
      if (course_id && known.length && !known.some((c) => c.id === course_id)) {
        throw new Error(`Course ${course_id} isn't one of your active courses (${known.map((c) => `${c.id} ${c.label}`).join(", ")})`);
      }
      const { promise, joined } = snaps.run(course_id ? [course_id] : undefined);
      const waitMs = (wait_s ?? DEFAULT_WAIT_S) * 1000;
      const done = await Promise.race([promise, new Promise<null>((r) => setTimeout(() => r(null), waitMs))]);
      if (!done) {
        return { status: `running in the background (started ${fmtLocal(snaps.inProgress?.started ?? new Date())}); check canvas_snapshot_status or canvas_changes_since in a few minutes` };
      }
      const runs = snaps.store.runsByIds(done);
      return localizeTimes({
        ...(joined ? { note: "a snapshot was already running; these are its results" } : {}),
        runs: runs.map((r) => ({
          course_id: r.course_id,
          course: label(r.course_id),
          ok: Boolean(r.ok),
          duration_s: Math.round((r.duration_ms ?? 0) / 100) / 10,
          errors: r.errors.length,
        })),
        courses: groupByCourse(snaps.store.eventsForRuns(done)),
      });
    }),
  );
}
