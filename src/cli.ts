#!/usr/bin/env node
// Entry point: `canvas-readonly-mcp` (stdio) or `canvas-readonly-mcp --http`.

// node:sqlite prints an ExperimentalWarning on Node 22; keep other warnings. This must run before
// anything imports node:sqlite, hence the dynamic imports below.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.error(w);
});

const HELP = `canvas-readonly-mcp — read-only MCP server for Canvas LMS

Usage:
  canvas-readonly-mcp                 run over stdio (for Claude Desktop, Claude Code, …)
  canvas-readonly-mcp --http          run the HTTP server (for claude.ai custom connectors)
  canvas-readonly-mcp --env-file .env load settings from a file first

Required environment: CANVAS_BASE_URL, CANVAS_TOKEN (and MCP_SECRET with --http).
See the README for all settings.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.error(HELP);
    return;
  }
  const envFile = args.indexOf("--env-file");
  if (envFile !== -1) process.loadEnvFile(args[envFile + 1] ?? ".env");
  if (args.includes("--version")) {
    const { VERSION } = await import("./app.js");
    console.error(VERSION);
    return;
  }

  const { loadConfig } = await import("./config.js");
  const mode = args.includes("--http") ? "http" : "stdio";
  const config = loadConfig(mode);
  if (mode === "http") await (await import("./http.js")).runHttp(config);
  else await (await import("./stdio.js")).runStdio(config);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
