import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CanvasClient, CanvasError, htmlToText } from "./canvas.js";
import { FileReader, render } from "./extract.js";
import { analyzeHtml, crawlCourseFiles, LinkContext, MODULE_PLACEHOLDER_RE, moduleNameMap, parseFileRef } from "./links.js";
import { roleFromEnrollments } from "./snapshot.js";

const MAX_OUTPUT = 80_000;
export const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

export function ok(data: unknown) {
  let text = typeof data === "string" ? data : JSON.stringify(data);
  if (text.length > MAX_OUTPUT) text = text.slice(0, MAX_OUTPUT) + "\n…[truncated — narrow the query]";
  return { content: [{ type: "text" as const, text }] };
}

export function wrap<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      const msg = e instanceof CanvasError ? e.message : `Error: ${(e as Error).message}`;
      return { content: [{ type: "text" as const, text: msg }], isError: true };
    }
  };
}

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString();

// ---- compact mappers: keep responses small and useful ----
const mapCourse = (c: any) => ({
  id: c.id,
  name: c.name,
  code: c.course_code,
  ...(c.enrollments ? { role: roleFromEnrollments(c.enrollments.map((e: any) => String(e.type ?? ""))) } : {}),
  term: c.term?.name,
  start: c.start_at,
  end: c.end_at,
});

const mapAssignment = (a: any) => ({
  id: a.id,
  course_id: a.course_id,
  name: a.name,
  due_at: a.due_at,
  unlock_at: a.unlock_at,
  lock_at: a.lock_at,
  points: a.points_possible,
  submission_types: a.submission_types,
  ...(a.is_quiz_lti_assignment ? { quiz_engine: "new_quizzes" } : {}),
  // Only present for graders (TAs/teachers).
  needs_grading: a.needs_grading_count ?? undefined,
  submitted: a.submission ? ["submitted", "graded", "pending_review"].includes(a.submission.workflow_state) : undefined,
  grade: a.submission?.grade ?? undefined,
  missing: a.submission?.missing ?? undefined,
  late: a.submission?.late ?? undefined,
  url: a.html_url,
});

/** Body text plus structured file links; file links appear in the text as "(file:<id>)". */
async function readableHtml(canvas: CanvasClient, courseId: string, html: string | null | undefined, maxLen?: number) {
  const ctx: LinkContext = { base: canvas.baseUrl, courseId, aliases: canvas.canvasOrigins.filter((o) => o !== canvas.baseUrl) };
  if (html && MODULE_PLACEHOLDER_RE.test(html)) ctx.modules = await moduleNameMap(canvas, courseId);
  const a = analyzeHtml(html, ctx);
  return {
    body: htmlToText(a.html, maxLen),
    file_links: a.files,
    ...(a.unresolved.length ? { unresolved_links: a.unresolved.length } : {}),
  };
}

export function registerTools(server: McpServer, canvas: CanvasClient, files: FileReader, opts: { enableRawGet: boolean }) {
  server.registerTool(
    "canvas_whoami",
    {
      title: "Who am I",
      description: "Return the Canvas profile the token belongs to. Use to verify the connection works.",
      inputSchema: {},
      annotations: RO,
    },
    wrap(async () => {
      const p = await canvas.get("/api/v1/users/self/profile");
      return { id: p.id, name: p.name, login: p.login_id, time_zone: p.time_zone };
    }),
  );

  server.registerTool(
    "canvas_list_courses",
    {
      title: "List courses",
      description: "List your Canvas courses (active by default) with your role in each. Returns course ids needed by other tools.",
      inputSchema: {
        include_completed: z.boolean().optional().describe("Also include completed/past courses"),
      },
      annotations: RO,
    },
    wrap(async ({ include_completed }: { include_completed?: boolean }) => {
      const courses = await canvas.getAll("/api/v1/courses", {
        enrollment_state: include_completed ? undefined : "active",
        "include[]": ["term"],
      });
      return courses.filter((c: any) => c.name).map(mapCourse);
    }),
  );

  server.registerTool(
    "canvas_whats_new",
    {
      title: "What's new",
      description:
        "Recent activity across all active courses (announcements, new/changed assignments, discussions, grades, messages) since a timestamp. Best tool for a daily check.",
      inputSchema: {
        since: z.string().optional().describe("ISO timestamp; default 26 hours ago"),
      },
      annotations: RO,
    },
    wrap(async ({ since }: { since?: string }) => {
      const cutoff = new Date(since ?? isoDay(-26 / 24)).getTime();
      const items = await canvas.getAll("/api/v1/users/self/activity_stream", { only_active_courses: true }, 200);
      return items
        .filter((i: any) => new Date(i.updated_at ?? i.created_at).getTime() >= cutoff)
        .map((i: any) => ({
          type: i.type,
          title: i.title,
          course_id: i.course_id,
          updated_at: i.updated_at,
          url: i.html_url,
          message: htmlToText(i.message, 2000),
          grade: i.grade,
        }));
    }),
  );

  server.registerTool(
    "canvas_list_planner_items",
    {
      title: "Planner / to-do",
      description:
        "Everything with a date in a window across courses: assignments, quizzes, discussions, calendar events, with submission status. Default: today through 14 days ahead.",
      inputSchema: {
        start_date: z.string().optional().describe("ISO date, default now"),
        end_date: z.string().optional().describe("ISO date, default +14 days"),
        course_id: z.string().optional().describe("Limit to one course"),
      },
      annotations: RO,
    },
    wrap(async (a: { start_date?: string; end_date?: string; course_id?: string }) => {
      const items = await canvas.getAll("/api/v1/planner/items", {
        start_date: a.start_date ?? isoDay(0),
        end_date: a.end_date ?? isoDay(14),
        "context_codes[]": a.course_id ? [`course_${a.course_id}`] : undefined,
      });
      return items.map((i: any) => ({
        type: i.plannable_type,
        title: i.plannable?.title ?? i.plannable?.name,
        course: i.context_name,
        course_id: i.course_id,
        date: i.plannable_date,
        points: i.plannable?.points_possible,
        submitted: i.submissions?.submitted,
        graded: i.submissions?.graded,
        missing: i.submissions?.missing,
        url: i.html_url ? new URL(i.html_url, "https://x").pathname : undefined,
      }));
    }),
  );

  server.registerTool(
    "canvas_list_assignments",
    {
      title: "List assignments",
      description: "Assignments in a course with due dates and your submission status.",
      inputSchema: {
        course_id: z.string(),
        bucket: z
          .enum(["past", "overdue", "undated", "ungraded", "unsubmitted", "upcoming", "future"])
          .optional()
          .describe("Filter; omit for all"),
      },
      annotations: RO,
    },
    wrap(async ({ course_id, bucket }: { course_id: string; bucket?: string }) => {
      const list = await canvas.getAll(`/api/v1/courses/${course_id}/assignments`, {
        bucket,
        order_by: "due_at",
        "include[]": ["submission"],
      });
      return list.map((a: any) => mapAssignment(a));
    }),
  );

  server.registerTool(
    "canvas_get_assignment",
    {
      title: "Get assignment",
      description: "Full details of one assignment, including the description as text.",
      inputSchema: { course_id: z.string(), assignment_id: z.string() },
      annotations: RO,
    },
    wrap(async ({ course_id, assignment_id }: { course_id: string; assignment_id: string }) => {
      const a = await canvas.get(`/api/v1/courses/${course_id}/assignments/${assignment_id}`, {
        "include[]": ["submission"],
      });
      const { body, ...links } = await readableHtml(canvas, course_id, a.description);
      return { ...mapAssignment(a), description: body, ...links };
    }),
  );

  server.registerTool(
    "canvas_list_announcements",
    {
      title: "List announcements",
      description: "Course announcements, newest first. Defaults to all active courses, last 14 days.",
      inputSchema: {
        course_ids: z.array(z.string()).optional().describe("Default: all active courses"),
        since: z.string().optional().describe("ISO date, default 14 days ago"),
      },
      annotations: RO,
    },
    wrap(async ({ course_ids, since }: { course_ids?: string[]; since?: string }) => {
      let ids = course_ids;
      if (!ids?.length) {
        const courses = await canvas.getAll("/api/v1/courses", { enrollment_state: "active" });
        ids = courses.map((c: any) => String(c.id));
      }
      if (!ids.length) return [];
      const list = await canvas.getAll("/api/v1/announcements", {
        "context_codes[]": ids.map((id) => `course_${id}`),
        start_date: since ?? isoDay(-14),
        end_date: isoDay(1),
      });
      return list.map((d: any) => ({
        id: d.id,
        course: d.context_code,
        title: d.title,
        posted_at: d.posted_at,
        author: d.author?.display_name,
        url: d.html_url,
        message: htmlToText(d.message, 4000),
      }));
    }),
  );

  server.registerTool(
    "canvas_get_syllabus",
    {
      title: "Get syllabus",
      description: "Course syllabus / course overview text, if the course uses Canvas's syllabus page.",
      inputSchema: { course_id: z.string() },
      annotations: RO,
    },
    wrap(async ({ course_id }: { course_id: string }) => {
      const c = await canvas.get(`/api/v1/courses/${course_id}`, { "include[]": ["syllabus_body", "term"] });
      return { ...mapCourse(c), syllabus: htmlToText(c.syllabus_body) || "(empty — check modules or pages)" };
    }),
  );

  server.registerTool(
    "canvas_list_modules",
    {
      title: "List modules",
      description: "Course modules with their items (pages, files, assignments, links) — often the week-by-week structure of a course.",
      inputSchema: { course_id: z.string() },
      annotations: RO,
    },
    wrap(async ({ course_id }: { course_id: string }) => {
      const mods = await canvas.getAll(`/api/v1/courses/${course_id}/modules`, { "include[]": ["items"] });
      return mods.map((m: any) => ({
        id: m.id,
        name: m.name,
        unlock_at: m.unlock_at,
        state: m.state,
        items: (m.items ?? []).map((i: any) => ({
          type: i.type,
          title: i.title,
          page_url: i.page_url,
          content_id: i.content_id,
          external_url: i.external_url,
          due_at: i.content_details?.due_at,
          completed: i.completion_requirement?.completed,
        })),
      }));
    }),
  );

  server.registerTool(
    "canvas_list_pages",
    {
      title: "List pages",
      description: "Wiki pages in a course (title + url slug for canvas_get_page).",
      inputSchema: { course_id: z.string(), search: z.string().optional() },
      annotations: RO,
    },
    wrap(async ({ course_id, search }: { course_id: string; search?: string }) => {
      const pages = await canvas.getAll(`/api/v1/courses/${course_id}/pages`, {
        search_term: search,
        sort: "updated_at",
        order: "desc",
      });
      return pages.map((p: any) => ({ title: p.title, url: p.url, updated_at: p.updated_at, front_page: p.front_page }));
    }),
  );

  server.registerTool(
    "canvas_get_page",
    {
      title: "Get page",
      description:
        "Read a course page as text. Use page_url slug from canvas_list_pages/list_modules, or 'front_page'. " +
        "File links are shown inline as (file:<id>) and listed in file_links — pass the id to canvas_read_file.",
      inputSchema: { course_id: z.string(), page_url: z.string() },
      annotations: RO,
    },
    wrap(async ({ course_id, page_url }: { course_id: string; page_url: string }) => {
      const path =
        page_url === "front_page"
          ? `/api/v1/courses/${course_id}/front_page`
          : `/api/v1/courses/${course_id}/pages/${encodeURIComponent(page_url)}`;
      const p = await canvas.get(path);
      return { title: p.title, updated_at: p.updated_at, url: p.html_url, ...(await readableHtml(canvas, course_id, p.body)) };
    }),
  );

  server.registerTool(
    "canvas_list_files",
    {
      title: "List files",
      description:
        "Files in a course, newest first. Uses the course files index when your role may see it; otherwise (common for students) " +
        "falls back to the files linked from pages, modules, assignments and announcements, like canvas_list_linked_files.",
      inputSchema: { course_id: z.string(), search: z.string().optional() },
      annotations: RO,
    },
    wrap(async ({ course_id, search }: { course_id: string; search?: string }) => {
      let list: any[];
      try {
        list = await canvas.getAll(`/api/v1/courses/${course_id}/files`, { search_term: search, sort: "updated_at", order: "desc" }, 300);
      } catch (e) {
        if (!(e instanceof CanvasError && (e.status === 403 || e.status === 404))) throw e;
        const linked = await crawlCourseFiles(canvas, course_id, { maxPages: 60 });
        const q = search?.toLowerCase();
        return {
          note: "The course files index isn't available to your role, so these are the files linked from the course.",
          files: q ? linked.files.filter((f: any) => String(f.display_name ?? "").toLowerCase().includes(q)) : linked.files,
        };
      }
      return list.map((f: any) => ({
        id: f.id,
        name: f.display_name,
        type: f["content-type"],
        size_kb: Math.round((f.size ?? 0) / 1024),
        updated_at: f.updated_at,
      }));
    }),
  );

  server.registerTool(
    "canvas_list_linked_files",
    {
      title: "List linked files",
      description:
        "Find the course's files (slides, lab instructions, exercise sheets) by scanning the front page, pages reachable from it and from modules, " +
        "the syllabus, assignment descriptions, announcements and module items. Works for students, unlike canvas_list_files. " +
        "Returns file_id, display_name, size, linked_from — pass file_id to canvas_read_file.",
      inputSchema: {
        course_id: z.string(),
        max_pages: z.number().int().min(1).max(200).optional().describe("Max wiki pages to scan, default 60"),
      },
      annotations: RO,
    },
    wrap(async ({ course_id, max_pages }: { course_id: string; max_pages?: number }) => {
      return crawlCourseFiles(canvas, course_id, { maxPages: max_pages ?? 60 });
    }),
  );

  server.registerTool(
    "canvas_read_file",
    {
      title: "Read file contents",
      description:
        "Download a course file server-side and return its text: PDF (per page), PPTX (per slide, with speaker notes), DOCX (per section), " +
        "plain text/code, ZIP (listing). Give file_id, or url = any Canvas file link (e.g. https://canvas.school.edu/courses/1/files/2?verifier=…&wrap=1). " +
        "Long documents: use pages (e.g. \"1-5\", \"3,8-10\") — the output says when it was truncated and which range to request next.",
      inputSchema: {
        course_id: z.string(),
        file_id: z.string().optional(),
        url: z.string().optional().describe("Canvas file URL or (file:<id>) reference, instead of file_id"),
        pages: z.string().optional().describe("Page/slide/section range, e.g. \"1-5\". Default: all"),
        max_chars: z.number().int().min(1000).max(75_000).optional().describe("Default 40000"),
      },
      annotations: RO,
    },
    wrap(
      async (a: { course_id: string; file_id?: string; url?: string; pages?: string; max_chars?: number }) => {
        const ref = parseFileRef(a.file_id ?? a.url?.replace(/^file:/, "") ?? "");
        if (!ref) throw new Error("Give file_id, or a url containing /files/<id>");
        const { entry, cached } = await files.read(ref.course_id ?? a.course_id, ref.file_id);
        return render(entry, { pages: a.pages, maxChars: a.max_chars ?? 40_000, cached });
      },
    ),
  );

  server.registerTool(
    "canvas_list_calendar_events",
    {
      title: "Calendar events",
      description: "Canvas calendar events (lectures, seminars, exams if teachers added them) in a date range.",
      inputSchema: {
        start_date: z.string().optional().describe("ISO, default now"),
        end_date: z.string().optional().describe("ISO, default +14 days"),
        course_ids: z.array(z.string()).optional(),
      },
      annotations: RO,
    },
    wrap(async (a: { start_date?: string; end_date?: string; course_ids?: string[] }) => {
      const events = await canvas.getAll("/api/v1/calendar_events", {
        type: "event",
        start_date: a.start_date ?? isoDay(0),
        end_date: a.end_date ?? isoDay(14),
        "context_codes[]": a.course_ids?.map((id) => `course_${id}`),
      });
      return events.map((e: any) => ({
        title: e.title,
        start: e.start_at,
        end: e.end_at,
        location: e.location_name,
        course: e.context_code,
        description: htmlToText(e.description, 1000),
      }));
    }),
  );

  server.registerTool(
    "canvas_get_grades",
    {
      title: "Grades & submissions",
      description: "Your own submissions in a course (as a student) with scores, grades, late/missing flags and teacher comments.",
      inputSchema: { course_id: z.string() },
      annotations: RO,
    },
    wrap(async ({ course_id }: { course_id: string }) => {
      const subs = await canvas.getAll(`/api/v1/courses/${course_id}/students/submissions`, {
        "student_ids[]": ["self"],
        "include[]": ["assignment", "submission_comments"],
      });
      return subs.map((s: any) => ({
        assignment: s.assignment?.name,
        due_at: s.assignment?.due_at,
        state: s.workflow_state,
        score: s.score,
        points: s.assignment?.points_possible,
        grade: s.grade,
        late: s.late,
        missing: s.missing,
        comments: (s.submission_comments ?? []).map((c: any) => `${c.author_name}: ${c.comment}`),
      }));
    }),
  );

  if (opts.enableRawGet) server.registerTool(
    "canvas_api_get",
    {
      title: "Raw Canvas GET",
      description:
        "Escape hatch: GET any Canvas REST endpoint under /api/v1 (read-only). Example path: /api/v1/courses/123/discussion_topics",
      inputSchema: {
        path: z.string().regex(/^\/api\/v1\//, "must start with /api/v1/"),
        params: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
      },
      annotations: RO,
    },
    wrap(async ({ path, params }: { path: string; params?: Record<string, string | string[]> }) => {
      if (path.includes("..")) throw new Error("invalid path");
      return canvas.get(path, params);
    }),
  );
}
