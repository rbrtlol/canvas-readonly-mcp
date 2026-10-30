# Changelog

## 2.0.0 (unreleased)

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
