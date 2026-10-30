// Tiny Canvas stand-in for tests: route handlers keyed by "path?query" or path, with request log.

import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

export type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

export interface MockCanvas {
  base: string;
  requests: { method: string; path: string; auth?: string }[];
  route(path: string, handler: Handler): void;
  /** Serve a fixed JSON body. */
  routeJson(path: string, body: unknown, headers?: Record<string, string>): void;
  close(): Promise<void>;
}

export const json = (res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

export async function startMockCanvas(): Promise<MockCanvas> {
  const routes = new Map<string, Handler>();
  const requests: MockCanvas["requests"] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push({ method: req.method ?? "", path: url.pathname, auth: req.headers.authorization });
    const handler = routes.get(url.pathname + url.search) ?? routes.get(url.pathname);
    if (!handler) return json(res, { errors: [{ message: "The specified resource does not exist." }] }, 404);
    handler(req, res, url);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    route(path, handler) {
      routes.set(path, handler);
    },
    routeJson(path, body, headers = {}) {
      routes.set(path, (_q, res) => json(res, body, 200, headers));
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
