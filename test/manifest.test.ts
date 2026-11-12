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

// server.json is the MCP Registry entry. The registry checks that the published npm package's
// mcpName matches its name, so name and versions must follow package.json.
describe("MCP Registry server.json", () => {
  const pkg = JSON.parse(read("package.json"));
  const server = JSON.parse(read("server.json"));
  const npm = server.packages.find((p: { registryType: string }) => p.registryType === "npm");

  it("matches package.json", () => {
    assert.equal(server.name, pkg.mcpName);
    assert.equal(server.version, pkg.version, "bump server.json together with package.json");
    assert.equal(npm.identifier, pkg.name);
    assert.equal(npm.version, pkg.version, "bump server.json together with package.json");
  });

  it("stays within registry limits", () => {
    assert.ok(server.description.length <= 100, `description is ${server.description.length} chars (max 100)`);
    assert.match(server.name, /^io\.github\.rbrtlol\/[a-zA-Z0-9._-]+$/);
  });

  it("asks for the same settings as the Desktop extension", () => {
    const manifest = JSON.parse(read("mcpb/manifest.json"));
    const names = npm.environmentVariables.map((v: { name: string }) => v.name).sort();
    assert.deepEqual(names, Object.keys(manifest.server.mcp_config.env).sort());
  });
});
