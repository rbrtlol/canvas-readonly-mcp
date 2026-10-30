// Worker-thread entry for extractInWorker(): extracts one file and posts the result back.

import { parentPort, workerData } from "node:worker_threads";
import { CanvasError } from "./canvas.js";
import { extract } from "./extract.js";

const { bytes, contentType, name, opts } = workerData as {
  bytes: Uint8Array;
  contentType: string;
  name: string;
  opts: { maxPages?: number };
};

extract(bytes, contentType, name, opts).then(
  (result) => parentPort!.postMessage({ ok: true, result }),
  (e: Error) => parentPort!.postMessage({ ok: false, status: e instanceof CanvasError ? e.status : 500, message: e.message }),
);
