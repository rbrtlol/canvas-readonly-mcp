// All settings come from environment variables, validated here in one place.
// The README's configuration table mirrors this file.

import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export type Mode = "http" | "stdio";

const int = (def: number, min = 1) => z.coerce.number().int().min(min).default(def);
const bool = (def: boolean) =>
  z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default(def ? "true" : "false")
    .transform((v) => ["true", "1", "yes"].includes(v));
const list = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
const origin = z
  .url({ protocol: /^https?$/, error: "must be your Canvas address, e.g. https://canvas.yourschool.edu" })
  .transform((u) => new URL(u).origin);

const schema = z.object({
  CANVAS_BASE_URL: origin,
  CANVAS_TOKEN: z
    .string({ error: "required: create one in Canvas under Account → Settings → New access token" })
    .min(20, "looks too short — create one in Canvas under Account → Settings → New access token"),
  /** Other hostnames of the same Canvas (e.g. school.instructure.com behind canvas.school.edu). */
  CANVAS_HOST_ALIASES: list,

  MCP_SECRET: z.string().optional(),
  HOST: z.string().default("127.0.0.1"),
  PORT: int(8787),

  DISPLAY_TZ: z.string().optional(),
  DATA_DIR: z.string().optional(),
  DB_PATH: z.string().optional(),
  CACHE_DIR: z.string().optional(),
  CACHE_MAX_MB: int(500),
  MAX_FILE_MB: int(50),
  DOWNLOAD_TIMEOUT_S: int(60),
  EXTRACT_TIMEOUT_S: int(60),
  EXTRACT_MAX_PAGES: int(500),
  ENABLE_RAW_GET: bool(true),

  SNAPSHOT_ENABLED: bool(true),
  /** Only these course ids (default: all active courses). "id" or legacy "id:label[:role]". */
  SNAPSHOT_COURSES: list,
  SNAPSHOT_EXCLUDE: list,
  /** Without SNAPSHOT_COURSES: "dashboard" (favorited / Canvas's current pick) or every "active" enrollment. */
  SNAPSHOT_SCOPE: z.enum(["dashboard", "active"]).default("dashboard"),
  SNAPSHOT_AT: z
    .string()
    .default("04:30")
    .refine((s) => s === "off" || /^([01]\d|2[0-3]):[0-5]\d$/.test(s), 'SNAPSHOT_AT must be "HH:MM" or "off"'),
  SNAPSHOT_MAX_AGE_H: int(20),
  SNAPSHOT_EXTRACT: z.enum(["linked", "all", "none"]).default("linked"),
  EVENT_RETENTION_DAYS: int(120),
  CRAWL_MAX_PAGES: int(200),
  ANNOUNCEMENT_DAYS: int(730),
});

export type Config = z.output<typeof schema> & {
  mode: Mode;
  dbPath: string;
  cacheDir: string;
};

/** Per-OS user data directory, used when neither DATA_DIR nor DB_PATH/CACHE_DIR is set. */
function defaultDataDir(): string {
  const app = "canvas-readonly-mcp";
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", app);
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), app);
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), app);
}

export function loadConfig(mode: Mode, env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty values (KEY= in .env files) as unset so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "config"}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const c = parsed.data;
  if (mode === "http" && (!c.MCP_SECRET || c.MCP_SECRET.length < 32)) {
    throw new Error("Invalid configuration:\n  MCP_SECRET: required in HTTP mode, at least 32 characters (openssl rand -hex 32)");
  }
  const dataDir = c.DATA_DIR ?? defaultDataDir();
  return {
    ...c,
    mode,
    dbPath: c.DB_PATH ?? join(dataDir, "canvas.db"),
    cacheDir: c.CACHE_DIR ?? join(dataDir, "cache"),
  };
}
