import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";

const base = { CANVAS_BASE_URL: "https://canvas.example.edu/", CANVAS_TOKEN: "x".repeat(40) };

describe("loadConfig", () => {
  it("applies defaults and normalizes the base URL to an origin", () => {
    const c = loadConfig("stdio", { ...base, DATA_DIR: "/tmp/d" });
    assert.equal(c.CANVAS_BASE_URL, "https://canvas.example.edu");
    assert.equal(c.SNAPSHOT_AT, "04:30");
    assert.equal(c.MAX_FILE_MB, 50);
    assert.equal(c.ENABLE_RAW_GET, true);
    assert.equal(c.dbPath, "/tmp/d/canvas.db");
    assert.equal(c.cacheDir, "/tmp/d/cache");
  });

  it("treats empty values as unset", () => {
    const c = loadConfig("stdio", { ...base, SNAPSHOT_AT: "", DISPLAY_TZ: "" });
    assert.equal(c.SNAPSHOT_AT, "04:30");
    assert.equal(c.DISPLAY_TZ, undefined);
  });

  it("parses lists, numbers and booleans", () => {
    const c = loadConfig("stdio", {
      ...base,
      SNAPSHOT_COURSES: "1, 2:Label:ta",
      CANVAS_HOST_ALIASES: "school.instructure.com",
      MAX_FILE_MB: "10",
      ENABLE_RAW_GET: "false",
    });
    assert.deepEqual(c.SNAPSHOT_COURSES, ["1", "2:Label:ta"]);
    assert.deepEqual(c.CANVAS_HOST_ALIASES, ["school.instructure.com"]);
    assert.equal(c.MAX_FILE_MB, 10);
    assert.equal(c.ENABLE_RAW_GET, false);
  });

  it("requires the Canvas settings and explains what's wrong", () => {
    assert.throws(() => loadConfig("stdio", {}), /CANVAS_BASE_URL[\s\S]*CANVAS_TOKEN/);
    assert.throws(() => loadConfig("stdio", { ...base, SNAPSHOT_AT: "4.30" }), /SNAPSHOT_AT/);
  });

  it("requires a long MCP_SECRET only in HTTP mode", () => {
    assert.throws(() => loadConfig("http", base), /MCP_SECRET/);
    assert.throws(() => loadConfig("http", { ...base, MCP_SECRET: "short" }), /MCP_SECRET/);
    assert.equal(loadConfig("http", { ...base, MCP_SECRET: "s".repeat(32) }).mode, "http");
  });
});
