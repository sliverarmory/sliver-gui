import type { ScriptWorkerEvent, ScriptWorkerRequest } from "../../../shared/script-runtime-protocol";
import { evaluateScript } from "./quickjs-runtime";

// This module is a trusted, packaged worker. User text never becomes worker code.
const port = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ScriptWorkerRequest>) => void) | null;
  postMessage(value: ScriptWorkerEvent): void;
};
port.onmessage = (event) => {
  port.onmessage = null; // Single-use worker, including during asynchronous loading.
  const request = event.data;
  if (!request || typeof request.runId !== "string") return;
  void evaluateScript(request, {
    ready: () => port.postMessage({ runId: request.runId, type: "ready" }),
    output: (records) => port.postMessage({ runId: request.runId, type: "output", records }),
  }).then((state) => port.postMessage({ runId: request.runId, type: "complete", state }))
    .catch(() => port.postMessage({
      runId: request.runId, type: "complete",
      state: { status: "failed", elapsedMs: 0, message: "Script runtime failed and was discarded." },
    }));
};
