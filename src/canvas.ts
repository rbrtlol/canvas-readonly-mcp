// Minimal read-only Canvas LMS REST client.
// Only GET requests are ever sent; the token never leaves the server.

export class CanvasError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Caps concurrent work so overlapping tool calls and snapshot runs share one budget. */
class Semaphore {
  private waiting: (() => void)[] = [];
  constructor(private free: number) {}

  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.waiting.push(r));
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    }
  }
}

export interface CanvasClientOptions {
  /** Other origins of the same Canvas instance (e.g. https://school.instructure.com). */
  aliases?: string[];
  retryBaseMs?: number;
  maxConcurrent?: number;
}

export class CanvasClient {
  private base: string;
  private origins: Set<string>;
  private retryBaseMs: number;
  private apiSlots: Semaphore;
  private downloadSlots = new Semaphore(2);

  constructor(
    baseUrl: string,
    private token: string,
    opts: CanvasClientOptions = {},
  ) {
    this.base = new URL(baseUrl).origin;
    this.origins = new Set([this.base, ...(opts.aliases ?? []).map(toOrigin)]);
    this.retryBaseMs = opts.retryBaseMs ?? 1000;
    this.apiSlots = new Semaphore(opts.maxConcurrent ?? 4);
  }

  get baseUrl(): string {
    return this.base;
  }

  /** The base URL plus any aliases, as origins. */
  get canvasOrigins(): string[] {
    return [...this.origins];
  }

  /** Map a URL on any alias host onto the configured base; refuse anything else. */
  private toCanvasUrl(raw: string | URL): URL {
    const url = new URL(raw);
    if (!this.origins.has(url.origin)) throw new CanvasError(400, `Refusing request to foreign host ${url.origin}`);
    return new URL(url.pathname + url.search, this.base);
  }

  private buildUrl(path: string, params?: Record<string, unknown>): string {
    // Never allow requests to leave the configured Canvas host.
    const url = this.toCanvasUrl(path.startsWith("http") ? path : this.base + path);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key.endsWith("[]") ? key : `${key}[]`, String(v));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /**
   * GET with Canvas rate-limit handling: slows down as X-Rate-Limit-Remaining drops, and retries
   * (with backoff) on 403 "Rate Limit Exceeded", 429 and 5xx. Only ever GET, so retrying is safe.
   */
  private async fetchRaw(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.apiSlots.use(async () => {
          const r = await fetch(url, {
            method: "GET",
            headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json+canvas-string-ids, application/json" },
            redirect: "follow",
            signal: AbortSignal.timeout(API_TIMEOUT_MS),
          });
          // Pace while holding the slot, so every caller slows down together.
          await this.pace(r);
          return r;
        });
      } catch (e) {
        if (attempt < MAX_RETRIES) {
          await sleep(this.backoffMs(attempt));
          continue;
        }
        throw new CanvasError(504, `Canvas request to ${new URL(url).pathname} failed: ${(e as Error).message}`);
      }
      if (res.ok) return res;
      const body = await res.text().catch(() => "");
      const rateLimited = res.status === 429 || (res.status === 403 && /rate limit exceeded/i.test(body));
      if ((rateLimited || res.status >= 500) && attempt < MAX_RETRIES) {
        await sleep(this.backoffMs(attempt) * (rateLimited ? 3 : 1));
        continue;
      }
      throw new CanvasError(res.status, describeStatus(res.status, new URL(url).pathname, body));
    }
  }

  private backoffMs(attempt: number) {
    return this.retryBaseMs * (2 ** attempt + Math.random() / 2);
  }

  /** Canvas uses a leaky bucket (~700 units); back off progressively as it empties. */
  private async pace(res: Response) {
    const header = res.headers.get("x-rate-limit-remaining");
    // Not every Canvas (or proxy in front of it) sends the header; no header means no pacing.
    const remaining = header === null ? NaN : Number(header);
    if (Number.isFinite(remaining) && remaining < 300) {
      await sleep(Math.min(5000, (300 - remaining) * 15));
    }
  }

  /**
   * Download a file from a Canvas download URL. Redirects are followed by hand so the token is
   * only ever sent to the Canvas origin, never to the file storage host it redirects to.
   */
  async download(
    url: string,
    opts: { maxBytes: number; timeoutMs: number },
  ): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    return this.downloadSlots.use(() => this.downloadNow(url, opts));
  }

  private async downloadNow(
    url: string,
    opts: { maxBytes: number; timeoutMs: number },
  ): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const canvasOrigin = this.base;
    let current = this.toCanvasUrl(url);
    const signal = AbortSignal.timeout(opts.timeoutMs);
    try {
      for (let hop = 0; hop < 6; hop++) {
        const headers: Record<string, string> = {};
        if (current.origin === canvasOrigin) headers.Authorization = `Bearer ${this.token}`;
        const res = await fetch(current, { method: "GET", headers, redirect: "manual", signal });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          await res.body?.cancel();
          if (!loc) throw new CanvasError(502, `Redirect without Location from ${current.host}`);
          const next = new URL(loc, current);
          if (next.protocol !== "https:" && next.origin !== canvasOrigin) {
            throw new CanvasError(502, `Refusing non-HTTPS redirect to ${next.origin}`);
          }
          current = next;
          continue;
        }
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new CanvasError(res.status, describeStatus(res.status, `file download (${current.host})`, body));
        }
        const declared = Number(res.headers.get("content-length") ?? "0");
        if (declared > opts.maxBytes) {
          await res.body?.cancel();
          throw new CanvasError(413, `File is ${mb(declared)}, over the ${mb(opts.maxBytes)} limit`);
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          total += chunk.byteLength;
          if (total > opts.maxBytes) throw new CanvasError(413, `File exceeds the ${mb(opts.maxBytes)} limit`);
          chunks.push(chunk);
        }
        return { bytes: Buffer.concat(chunks), contentType: res.headers.get("content-type") };
      }
      throw new CanvasError(508, "Too many redirects while downloading file");
    } catch (e) {
      if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") {
        throw new CanvasError(504, `File download timed out after ${opts.timeoutMs / 1000}s`);
      }
      throw e;
    }
  }

  /** Single GET, parsed JSON. */
  async get<T = any>(path: string, params?: Record<string, unknown>): Promise<T> {
    const res = await this.fetchRaw(this.buildUrl(path, params));
    return (await res.json()) as T;
  }

  /** GET following Canvas Link-header pagination, up to maxItems. */
  async getAll<T = any>(path: string, params?: Record<string, unknown>, maxItems = 500): Promise<T[]> {
    let url: string | null = this.buildUrl(path, { per_page: 100, ...params });
    const out: T[] = [];
    while (url && out.length < maxItems) {
      const res = await this.fetchRaw(url);
      const page = (await res.json()) as T[];
      out.push(...page);
      url = nextLink(res.headers.get("link"));
    }
    return out.slice(0, maxItems);
  }
}

const API_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const toOrigin = (u: string) => new URL(/^https?:\/\//.test(u) ? u : `https://${u}`).origin;

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Turn the status codes students commonly hit into actionable messages. */
function describeStatus(status: number, where: string, body: string): string {
  const hint =
    status === 401
      ? "the Canvas API token is invalid or expired — create a new one and update CANVAS_TOKEN on the server"
      : status === 403
        ? "not authorised — your role in this course can't see this (tab disabled, item locked or hidden, or not visible to your enrollment)"
        : status === 404
          ? "not found — wrong id, deleted, or disabled for this course"
          : "request failed";
  let detail = body.slice(0, 200);
  try {
    const j = JSON.parse(body);
    detail = j.message ?? j.errors?.[0]?.message ?? detail;
  } catch {
    // not JSON; keep the raw snippet
  }
  return `Canvas ${status} on ${where}: ${hint}${detail ? ` (${detail})` : ""}`;
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/** Crude but dependency-free HTML -> readable text. */
export function htmlToText(html: string | null | undefined, maxLen = 20000): string {
  if (!html) return "";
  let s = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr|\/li)[^>]*>/gi, "\n")
    .replace(/<h[1-6][^>]*>/gi, "\n## ")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen) + "\n…[truncated]";
  return s;
}

/** Decode the HTML/XML entities Canvas and Office files actually use. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos|#39);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith("#")) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return ({ nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[k];
  });
}
