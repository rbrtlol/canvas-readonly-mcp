# Changelog

## Unreleased

### Added

- `PRIVACY.md`: what is read, stored and sent where (no telemetry, no hosted service), linked from the README and the Desktop extension.
- README help for schools that turn personal access tokens off or make them expire quickly.

### Changed

- Clearer tool descriptions, so clients pick the right tool: `canvas_changes_since` is the place to start for "what changed" and `canvas_whats_new` is Canvas's activity feed (for inbox messages); `canvas_list_linked_files` is the default way to find course material and `canvas_list_files` is the full Files area; `canvas_course_snapshot` is for overviews, the list/get tools for live data and full detail; `canvas_list_assignments` describes what it returns and when to use the planner or `canvas_get_assignment` instead.

## 2.2.0 (2026-11-12)

### Added

- Claude Desktop extension: each release has a `canvas-readonly-mcp-<version>.mcpb` that installs with one click and asks for the Canvas address and token (stored in the system keychain). No Node.js or config file needed. Build it locally with `npm run bundle`.
- Listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.rbrtlol/canvas-readonly-mcp`, with both the npm package and the `.mcpb`. Releases publish there automatically.

### Changed

- Dependency update: `unpdf` 1.9.1.

## 2.1.0 (2026-11-03)

### Added

- `canvas_search`: full-text search (SQLite FTS5) over everything the snapshots store, including the text of linked files per page/slide. Prefix matching, phrases, diacritics-insensitive. The first snapshot after upgrading indexes file text that was extracted earlier (mostly from the file cache).
- `canvas_list_discussions` / `canvas_get_discussion`: discussion threads with replies, via the `/view` endpoint (doesn't mark entries as read).
- `canvas_list_quizzes` / `canvas_get_quiz`: classic quizzes (settings, instructions, your latest attempt) and New Quizzes.
- `canvas_get_assignment` returns the rubric, and for students the submission with comments and the rubric assessment per criterion.

### Changed

- Database schema version 3 (search index). Older servers refuse the upgraded database.
- Dependency updates: `diff` 9.0.0, `unpdf` 1.9.0, `fflate` 0.8.3.

## 2.0.0 (2026-10-30)

First public release, generalized from a personal KTH setup.

### Breaking

- All tools are prefixed with `canvas_` (e.g. `read_file` → `canvas_read_file`, `changes_since` → `canvas_changes_since`). The generic GET tool is now `canvas_api_get`.
- `CANVAS_BASE_URL` is required (it used to default to canvas.kth.se).
- Snapshot courses are discovered automatically: the courses on your Canvas dashboard (`SNAPSHOT_SCOPE=dashboard`, the default) or every active enrollment (`active`), skipping courses that have ended. `SNAPSHOT_COURSES` is now an optional include list; the old `id:label:ta` form still works as an override.
- `SNAPSHOT_ON_STARTUP` is replaced by `SNAPSHOT_MAX_AGE_H`: stale snapshots refresh at startup and on demand.
- `canvas_run_snapshot` waits at most `wait_s` (default 25 s) and then continues in the background.
- The Docker entry point is `node dist/cli.js --http`.

### Added

- stdio mode (`npx canvas-readonly-mcp`) for Claude Desktop, Claude Code and other local clients.
- Roles from enrollments (student, TA, teacher, observer); "needs grading" counts for TAs/teachers; New Quizzes labeled.
- Uses the pages and files index endpoints when your role allows them, and falls back to following links otherwise. `canvas_list_files` falls back to linked files instead of failing with 403.
- `CANVAS_HOST_ALIASES` for instances reachable under several hostnames.
- Display time zone from your Canvas profile (`DISPLAY_TZ` overrides).
- Text extraction in a worker thread with memory/time limits; page cap; LRU cache size cap.
- One shared request budget per Canvas client; schema migrations for the database.
- `ENABLE_RAW_GET` to turn off the raw GET tool.
- Tests (node:test) with a mock Canvas, CI, release workflow for npm and GHCR.

### Fixed

- Requests were throttled for 4.5 s each when Canvas (or a proxy) didn't send `X-Rate-Limit-Remaining`.
- Links on hosts that merely start with the Canvas hostname (e.g. `canvas.school.edu.evil.com`) were treated as Canvas links.

## 1.2.0

Nightly snapshots and change events (`changes_since`, `course_snapshot`, `snapshot_status`, `run_snapshot`).

## 1.1.0

`read_file` and `list_linked_files`; file links in `get_page`.

## 1.0.0

Initial read-only Canvas tools.
