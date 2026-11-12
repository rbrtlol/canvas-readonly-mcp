// The Claude Desktop extension manifest (mcpb/manifest.json) lists the tools statically for the
// install dialog; keep it in sync with what the server registers.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("mcpb manifest", () => {
  it("lists exactly the tools the server registers", () => {
    const registered = ["src/tools.ts", "src/snapshot-tools.ts"]
      .flatMap((f) => [...read(f).matchAll(/registerTool\(\s*"([^"]+)"/g)].map((m) => m[1]))
      .sort();
    const manifest = JSON.parse(read("mcpb/manifest.json"));
    const listed = (manifest.tools as { name: string }[]).map((t) => t.name).sort();
    assert.ok(registered.length > 20, "found the registerTool calls");
    assert.deepEqual(listed, registered);
  });

  it("passes only settings the server knows", () => {
    const manifest = JSON.parse(read("mcpb/manifest.json"));
    const config = read("src/config.ts");
    for (const key of Object.keys(manifest.server.mcp_config.env)) assert.match(config, new RegExp(`\\b${key}:`), key);
  });
});
