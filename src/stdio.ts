// stdio transport, for local clients (Claude Desktop, Claude Code, …) that start the server
// themselves. Snapshots refresh shortly after startup and on demand when they're stale.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApp } from "./app.js";
import { Config } from "./config.js";

export async function runStdio(config: Config) {
  const app = await createApp(config);
  await app.buildServer().connect(new StdioServerTransport());
  app.snapshots?.startScheduler();
}
