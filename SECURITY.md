# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Security → Report a vulnerability** on this repository, not in public issues. You'll get a reply within a week.

## Threat model

The server holds a Canvas personal access token, which can read everything its owner can see in Canvas. The design goal is that the server can never *change* anything in Canvas and never leaks the token.

**What the code guarantees**

- Only `GET` requests are sent to Canvas. There is no code path that sends other methods.
- Requests only go to the configured Canvas origin (and configured aliases). URLs pointing elsewhere are refused.
- File downloads follow redirects by hand. The token is only attached to requests to the Canvas origin, never to the storage host Canvas redirects to, and plain-HTTP redirects to other hosts are refused.
- Downloads have a size cap and a timeout. Text extraction runs in a worker thread with a heap limit and a timeout, so a malformed or hostile file can't hang or exhaust the server.
- In HTTP mode every request must carry the secret (in the path or a Bearer header). It is compared in constant time, and wrong secrets get a plain 404.

**What you are responsible for**

- Keeping the token, `.env` and the connector URL private. In HTTP mode, the URL is the credential. Keep it out of logs: the example proxy configs disable access logs.
- Running the HTTP server behind TLS.
- Revoking the token in Canvas if the server or its data is compromised.

## Prompt injection

Everything the tools return (pages, announcements, discussion posts, file text) is written by teachers, students or other users, and goes to the model as tool output. A malicious page could contain text like "ignore your instructions and …".

This server can't act on Canvas, so the direct impact is limited. However, if the same chat also has tools that **can** act, for example email, file storage or code execution, injected text could try to steer them. Mitigations:

- The server tells the client that course content is data, not instructions.
- Be cautious about combining this server with write-capable tools in automated, unattended runs.
- Set `ENABLE_RAW_GET=false` if you don't need the generic `canvas_api_get` tool.

Note that a few Canvas `GET` endpoints have side effects such as marking items as read. The built-in tools avoid them; `canvas_api_get` doesn't restrict them.
