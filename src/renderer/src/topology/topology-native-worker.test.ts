// @vitest-environment node
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createContext, runInContext } from "node:vm";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import { expect, it } from "vitest";

import { createElkGraph, extractTopologyLayout } from "./topology-layout-input";

it("runs the ELK dispatcher in a native-worker context with self and no document", async () => {
  const require = createRequire(import.meta.url);
  const source = await readFile(require.resolve("elkjs/lib/elk-worker.js"), "utf8");
  const responses: { id: number; data?: ElkNode; error?: unknown }[] = [];
  const workerScope = {
    onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
    postMessage: (message: (typeof responses)[number]) => responses.push(message),
    console,
    setTimeout,
    clearTimeout,
  };
  // A jsdom/in-process test sees document and takes ELK's fake-worker branch.
  // This isolated global checks the actual dispatcher used by Electron Workers.
  const context = createContext(workerScope);
  runInContext(`globalThis.self = globalThis;\n${source}`, context, { timeout: 5_000 });
  expect(workerScope.onmessage).toBeTypeOf("function");
  runInContext('self.onmessage({ data: { id: 1, cmd: "register", algorithms: ["layered"] } });', context, { timeout: 5_000 });
  const request = {
    id: 2,
    cmd: "layout",
    graph: createElkGraph({
      nodes: [{ id: "cloud", role: "group" }, { id: "server", role: "resource", parentId: "cloud" }, { id: "remote", role: "resource" }],
      edges: [{ id: "traffic", source: "server", target: "remote" }],
    }),
    layoutOptions: {},
    options: {},
  };
  // Parsing in the worker realm reproduces structured-clone array prototypes.
  runInContext(`self.onmessage({ data: ${JSON.stringify(request)} });`, context, { timeout: 5_000 });
  const response = responses.find(({ id }) => id === 2);
  expect(response?.error).toBeUndefined();
  expect(response?.data).toBeDefined();
  const nodes = extractTopologyLayout(response!.data!);
  expect(nodes.map(({ id }) => id)).toEqual(["cloud", "server", "remote"]);
  expect(nodes.every((node) => [node.x, node.y, node.width, node.height].every(Number.isFinite))).toBe(true);
  expect(nodes.find(({ id }) => id === "server")?.y).toBeGreaterThanOrEqual(88);
});
