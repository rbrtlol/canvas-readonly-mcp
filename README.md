# canvas-readonly-mcp

A **read-only** [MCP](https://modelcontextprotocol.io) server for **Canvas LMS**. It lets Claude (or any MCP client) read your courses, deadlines, announcements, pages and the *contents* of course files (lecture slides, lab instructions), and keeps a daily change log, so "what's new in my courses?" is one cheap call.

- **Read-only by design:** it only ever sends `GET` requests to Canvas. It can't submit, post, or change anything.
- **Works for any Canvas instance and any role:** students, TAs, teachers.
- **Your token stays local:** it runs on your machine (stdio) or your own server (HTTP). Nothing goes through a third party.

> Not affiliated with or endorsed by Instructure. "Canvas" is a trademark of Instructure, Inc.

## What you can ask

- "What changed in my courses since yesterday?"
- "What's due in the next two weeks, and what have I not submitted?"
- "Summarize the lab 2 instructions" (the server finds the PDF linked from the course and returns its text)
- "Which slides in lecture 5 changed since last week?"

## Tools

| Tool | What it's for |
|---|---|
| `canvas_changes_since` | What changed since a time (default 26h): new/changed pages, assignments (due dates, grades), announcements, discussions, quizzes, events, files (which PDF pages changed). The daily-check tool. |
| `canvas_course_snapshot` | Stored state of a course (optionally only some kinds, e.g. assignments). No Canvas calls. |
| `canvas_snapshot_status` | Snapshot health: courses and your role, last run, counts, errors, next run. |
| `canvas_run_snapshot` | Take a snapshot now and return what changed. |
| `canvas_list_courses` | Your courses, ids and your role in each. |
| `canvas_whats_new` | Canvas activity stream since a time. |
| `canvas_list_planner_items` | Everything dated in a window, with submission status. |
| `canvas_list_assignments` / `canvas_get_assignment` | Assignments, due dates, descriptions; "needs grading" counts for TAs/teachers. |
| `canvas_list_announcements` | Announcements across courses. |
| `canvas_get_syllabus` | The syllabus page. |
| `canvas_list_modules` | Module structure with items. |
| `canvas_list_pages` / `canvas_get_page` | Course pages as text, with their file links. |
| `canvas_list_linked_files` | Every file linked from the course (front page, pages, modules, assignments, announcements). Works even when the files tab is hidden. |
| `canvas_list_files` | Course files; falls back to linked files when your role can't list them. |
| `canvas_read_file` | Text of a PDF (per page), PPTX (per slide + notes), DOCX (per section), text/code file, or ZIP listing. Takes a file id or any Canvas file URL; supports page ranges. |
| `canvas_list_calendar_events` | Calendar events. |
| `canvas_get_grades` | Your own scores, grades and comments (as a student). |
| `canvas_api_get` | Escape hatch: any `GET /api/v1/...` endpoint (can be disabled). |

## Quick start

### 1. Get a Canvas access token

In Canvas: **Account → Settings → + New access token**. Give it a purpose ("Claude") and preferably an expiry date. Some institutions disable personal tokens; if the button is missing, ask your Canvas admins.

You also need your Canvas address, e.g. `https://canvas.yourschool.edu` or `https://yourschool.instructure.com`.

### 2a. Local: Claude Desktop, Claude Code and other stdio clients (easiest)

Requires Node.js 22.13 or newer.

**Claude Code:**

```bash
claude mcp add canvas \
  -e CANVAS_BASE_URL=https://canvas.yourschool.edu \
  -e CANVAS_TOKEN=your-token \
  -- npx -y canvas-readonly-mcp
```

**Claude Desktop:** add this to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "canvas": {
      "command": "npx",
      "args": ["-y", "canvas-readonly-mcp"],
      "env": {
        "CANVAS_BASE_URL": "https://canvas.yourschool.edu",
        "CANVAS_TOKEN": "your-token"
      }
    }
  }
}
```

In stdio mode, snapshots refresh shortly after the client starts the server, and in the background whenever they're older than `SNAPSHOT_MAX_AGE_H` (default 20h). Data is stored in your user data directory (`~/Library/Application Support/canvas-readonly-mcp` on macOS, `~/.local/share/canvas-readonly-mcp` on Linux, `%APPDATA%\canvas-readonly-mcp` on Windows).

### 2b. Server: claude.ai custom connectors (HTTP)

claude.ai connects from the internet, so this needs a server with HTTPS.

```bash
mkdir canvas-mcp && cd canvas-mcp
curl -O https://raw.githubusercontent.com/rbrtlol/canvas-readonly-mcp/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/rbrtlol/canvas-readonly-mcp/main/.env.example
# Fill in CANVAS_BASE_URL and CANVAS_TOKEN, then:
sed -i "s/^MCP_SECRET=.*/MCP_SECRET=$(openssl rand -hex 32)/" .env
chmod 600 .env
docker compose up -d
curl -s localhost:8787/healthz   # {"ok":true}
```

Put a reverse proxy with TLS in front of it: [`deploy/Caddyfile.example`](deploy/Caddyfile.example) (automatic certificates) or [`deploy/nginx.conf.example`](deploy/nginx.conf.example). In claude.ai, add a **custom connector** with the URL

```
https://canvas-mcp.example.com/mcp/<MCP_SECRET>
```

and leave the OAuth fields empty. Clients that support headers can use `https://…/mcp` with `Authorization: Bearer <MCP_SECRET>` instead.

Without Docker: `npx canvas-readonly-mcp --http --env-file .env`.

## Configuration

All settings are environment variables (or a file passed with `--env-file`).

| Variable | Default | Meaning |
|---|---|---|
| `CANVAS_BASE_URL` | **required** | Your Canvas address. |
| `CANVAS_TOKEN` | **required** | Personal access token. |
| `MCP_SECRET` | required for `--http` | At least 32 characters; part of the connector URL. |
| `CANVAS_HOST_ALIASES` | | Other hostnames of the same Canvas, comma-separated (e.g. `yourschool.instructure.com` when you use a custom domain). Links to them are recognized. |
| `DISPLAY_TZ` | your Canvas profile's | Time zone for displayed times (IANA name, e.g. `Europe/Stockholm`). |
| `ENABLE_RAW_GET` | `true` | Set `false` to remove `canvas_api_get`. |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | HTTP listen address (`0.0.0.0` in the Docker image). |
| `DATA_DIR` | OS user data dir | Where the database and cache live. `DB_PATH` / `CACHE_DIR` override each. |
| `SNAPSHOT_ENABLED` | `true` | Turn the snapshot/change-log feature off entirely. |
| `SNAPSHOT_COURSES` | | Only these course ids (overrides `SNAPSHOT_SCOPE`). `id:label:role` overrides the label and role. |
| `SNAPSHOT_SCOPE` | `dashboard` | Which courses to snapshot: `dashboard` = the courses on your Canvas dashboard (your favorites, or Canvas's automatic pick if you haven't chosen any); `active` = every active enrollment. Courses whose end date has passed are skipped either way. |
| `SNAPSHOT_EXCLUDE` | | Course ids to skip. |
| `SNAPSHOT_AT` | `04:30` | Daily snapshot time in `DISPLAY_TZ`, or `off`. |
| `SNAPSHOT_MAX_AGE_H` | `20` | Refresh at startup / on demand when older than this. |
| `SNAPSHOT_EXTRACT` | `linked` | Which files' text to hash for change detection: `linked`, `all` (also files only in the files index), `none`. |
| `EVENT_RETENTION_DAYS` | `120` | How long change events are kept. |
| `CRAWL_MAX_PAGES` / `ANNOUNCEMENT_DAYS` | `200` / `730` | Crawl limits per course. |
| `MAX_FILE_MB` / `DOWNLOAD_TIMEOUT_S` | `50` / `60` | Download limits. |
| `EXTRACT_TIMEOUT_S` / `EXTRACT_MAX_PAGES` | `60` / `500` | Text extraction limits. |
| `CACHE_MAX_MB` | `500` | Extracted-text cache size; least recently used entries are evicted. |

## How it works

**Finding files.** Many Canvas setups hide the files and pages lists from students. The server therefore uses those lists when your role may see them, and otherwise follows links from the front page, modules, syllabus, assignments and announcements. `canvas_get_page` shows file links inline as `(file:<id>)`. Leftover `$CANVAS_OBJECT_REFERENCE$` links from course copies are resolved where possible and otherwise marked as broken.

**Reading files.** `canvas_read_file` downloads the file (the token is only sent to Canvas itself, never to the storage host it redirects to) and extracts text in a separate worker thread with memory and time limits. Results are cached by file id and `updated_at`. Scanned PDFs without a text layer are reported as such (no OCR). Legacy `.doc`/`.ppt` aren't supported.

**Snapshots and the change log.** Once a day (and when stale), the server stores the state of each course on your Canvas dashboard in SQLite (star a course under *Courses → All courses* to add it, or set `SNAPSHOT_COURSES`): pages, modules, assignments (with your submission status and grade), announcements and discussions (with a teacher/TA flag), quizzes, calendar events, the syllabus, and file metadata with a per-page content hash for PDFs. Each item is normalized (HTML to text, volatile fields dropped) and hashed. Differences become change events with old → new values, short text diffs, and changed PDF page numbers. The first run is a silent baseline. Announcements with no `posted_at` (copied from an earlier course round) are flagged "unpublished/old". Items are only marked removed when every source that could link to them was read successfully, so a temporary error never produces false "removed" events.

**Roles.** Your role in each course comes from your enrollment. As a **student**, your submissions, grades and missing/late flags are tracked. As a **TA or teacher**, your own submissions are skipped, only staff discussion topics are tracked, and assignments show how many submissions need grading. **Observer** accounts work for course content, but the observed student's submissions aren't tracked.

**Rate limits.** The server watches Canvas's `X-Rate-Limit-Remaining`, backs off on 403 "Rate Limit Exceeded", 429 and 5xx responses, and limits how many requests run at once.

## Security and privacy

- Treat the token like a password: it can read everything you can see in Canvas. The server never sends it anywhere except your Canvas.
- In HTTP mode the connector URL contains the secret: anyone with it can read your Canvas data (read-only). Wrong secrets get a plain 404. Rotate by changing `MCP_SECRET`.
- Course content (pages, announcements, file text) is written by other people and goes to the model as tool output. See [SECURITY.md](SECURITY.md) about prompt injection.
- Data stays on your machine/server: a SQLite database and an extracted-text cache. Delete `DATA_DIR` (or the Docker volumes) to remove it.

## Development

```bash
npm install
npm test             # unit + integration tests against a mock Canvas
npm run typecheck
npm run build
CANVAS_BASE_URL=… CANVAS_TOKEN=… node dist/cli.js          # stdio
node dist/cli.js --http --env-file .env                     # HTTP
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
