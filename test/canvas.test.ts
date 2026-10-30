import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { CanvasClient, CanvasError } from "../src/canvas.js";
import { json, MockCanvas, startMockCanvas } from "./mock-canvas.js";

describe("CanvasClient", () => {
  let canvas: MockCanvas;
  let client: CanvasClient;
  before(async () => {
    canvas = await startMockCanvas();
    client = new CanvasClient(canvas.base, "secret-token", { retryBaseMs: 5 });
  });
  after(() => canvas.close());

  it("sends only GET with the token and follows Link pagination", async () => {
    canvas.route("/api/v1/things", (_q, res, url) => {
      const page = Number(url.searchParams.get("page") ?? 1);
      const next = page < 3 ? `<${canvas.base}/api/v1/things?page=${page + 1}>; rel="next"` : "";
      json(res, [{ id: page }], 200, next ? { link: next } : {});
    });
    const all = await client.getAll("/api/v1/things");
    assert.deepEqual(
      all.map((t) => t.id),
      [1, 2, 3],
    );
    const reqs = canvas.requests.filter((r) => r.path === "/api/v1/things");
    assert.ok(reqs.every((r) => r.method === "GET" && r.auth === "Bearer secret-token"));
  });

  it("retries 403 Rate Limit Exceeded, 429 and 5xx, then succeeds", async () => {
    const failures = [
      [403, "403 Forbidden (Rate Limit Exceeded)"],
      [429, "slow down"],
      [503, "unavailable"],
    ] as const;
    let calls = 0;
    canvas.route("/api/v1/flaky", (_q, res) => {
      const f = failures[calls++];
      if (f) {
        res.writeHead(f[0]);
        res.end(f[1]);
      } else json(res, { ok: true });
    });
    assert.deepEqual(await client.get("/api/v1/flaky"), { ok: true });
    assert.equal(calls, 4);
  });

  it("does not retry a real 403 and explains it", async () => {
    let calls = 0;
    canvas.route("/api/v1/forbidden", (_q, res) => {
      calls++;
      json(res, { status: "unauthorized", errors: [{ message: "user not authorised to perform that action" }] }, 403);
    });
    await assert.rejects(client.get("/api/v1/forbidden"), (e: CanvasError) => e.status === 403 && /not authorised/.test(e.message));
    assert.equal(calls, 1);
  });

  it("refuses requests to other hosts", async () => {
    await assert.rejects(client.get("https://evil.example.com/api/v1/x"), /foreign host/);
  });

  it("downloads through same-origin redirects and refuses plain-HTTP redirects to other hosts", async () => {
    canvas.route("/files/1/download", (_q, res) => {
      res.writeHead(302, { location: "/storage/1" });
      res.end();
    });
    canvas.route("/storage/1", (_q, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello");
    });
    const { bytes } = await client.download(`${canvas.base}/files/1/download`, { maxBytes: 1000, timeoutMs: 5000 });
    assert.equal(Buffer.from(bytes).toString(), "hello");

    canvas.route("/files/2/download", (_q, res) => {
      res.writeHead(302, { location: "http://other.example.com/x" });
      res.end();
    });
    await assert.rejects(client.download(`${canvas.base}/files/2/download`, { maxBytes: 1000, timeoutMs: 5000 }), /non-HTTPS redirect/);
  });

  it("enforces the download size cap", async () => {
    canvas.route("/files/3/download", (_q, res) => {
      res.writeHead(200);
      res.end("x".repeat(2000));
    });
    await assert.rejects(client.download(`${canvas.base}/files/3/download`, { maxBytes: 1000, timeoutMs: 5000 }), /limit/);
  });
});
