# Privacy

canvas-readonly-mcp is software you run yourself: on your computer (Claude Desktop extension, `npx`) or on your own server (Docker / HTTP). There is no hosted service, no account with the author, and no telemetry. The author never receives your token or any of your data.

## What it reads

With the Canvas access token you provide, it reads what your Canvas account can see: courses, assignments, grades and submission feedback, announcements, discussions, quizzes, pages, calendar events and the files linked from your courses. It only sends `GET` requests, so it never changes anything in Canvas.

## Where your data goes

- **To Canvas:** requests go only to the Canvas address you configure (and any aliases you add). The token is sent only there, never to the file storage host Canvas redirects downloads to.
- **To your AI client:** tool results (course text, grades, file text) go to the MCP client you connect, such as Claude, and from there to that client's model provider. Their privacy policy covers what happens next. For Claude, see [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).
- **Nowhere else.** The server makes no other network requests.

## What it stores, and where

- **Your token:** in your system keychain (Claude Desktop extension), or in the environment or `.env` file you configure.
- **Snapshots:** a SQLite database with the state of your courses and a log of changes, kept so it can tell you what changed and search your course content. Change events are deleted after `EVENT_RETENTION_DAYS` (default 120).
- **File text cache:** text extracted from course files, capped at `CACHE_MAX_MB` (default 500 MB).

Both live in your data directory: `~/Library/Application Support/canvas-readonly-mcp` (macOS), `%APPDATA%\canvas-readonly-mcp` (Windows), `~/.local/share/canvas-readonly-mcp` (Linux), `DATA_DIR` if you set it, or the Docker volumes. Delete that directory (or the volumes) to remove everything. Revoke the token in Canvas under **Account → Settings** to cut off access.

## Other people's data

Canvas shows you content written by teachers and classmates (announcements, discussion posts, names). The server stores and passes on only what your account can already see, for your own use. If you are a TA or teacher, your token can see student data. Handle it under your institution's rules, and think twice before sending it to an AI provider your institution hasn't approved.

## Contact

Questions or concerns: open an issue at https://github.com/rbrtlol/canvas-readonly-mcp/issues, or report security problems privately as described in [SECURITY.md](SECURITY.md).
