// @vitest-environment node
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { SCRIPT_LIMITS, type ScriptConsoleRecord } from "../../../shared/script-runtime-protocol";
import { evaluateScript } from "./quickjs-runtime";

const require = createRequire(import.meta.url);
const wasmBytes = Uint8Array.from(await readFile(require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm")));
async function run(source: string) {
  const records: ScriptConsoleRecord[] = [];
  let ready = false;
  const state = await evaluateScript({ runId: randomUUID(), scriptId: randomUUID(), source, wasmBytes }, {
    ready: () => { ready = true; }, output: (batch) => records.push(...batch),
  });
  return { state, records, ready };
}

describe("the real console-only QuickJS interpreter", () => {
  it("prints Hello World and supports console levels, interpolation and readable values", async () => {
    const result = await run('console.log("Hello, world!"); console.info("%s %d %%", "answer", 42); console.warn({ok:true}, [1,2]); console.error(new Error("oops")); console.debug(undefined, 12n);');
    expect(result.ready).toBe(true);
    expect(result.state.status).toBe("completed");
    expect(result.records.map((record) => record.level)).toEqual(["log", "info", "warn", "error", "debug"]);
    expect(result.records[0]?.text).toBe("Hello, world!");
    expect(result.records[1]?.text).toBe("answer 42 %");
    expect(result.records[2]?.text).toContain("ok: true");
    expect(result.records[3]?.text).toContain("oops");
    expect(result.records[4]?.text).toBe("undefined 12n");
  });

  it("exposes no browser, Node, application bridge or module-loading capabilities", async () => {
    const result = await run('console.log(typeof window, typeof document, typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof process, typeof require, typeof sliver, typeof postMessage, typeof setTimeout);');
    expect(result.records[0]?.text).toBe(Array(10).fill("undefined").join(" "));
    const imported = await run('import("node:fs")');
    expect(imported.state.status).toBe("failed");
  });

  it("does not invoke getters or toJSON during console inspection and bounds cyclic values", async () => {
    const result = await run('const a = { get secret() { throw new Error("getter was called"); }, toJSON() { throw new Error("toJSON was called"); } }; a.self = a; console.log(a);');
    expect(result.state.status).toBe("completed");
    expect(result.records[0]?.text).toContain("[Getter/Setter]");
    expect(result.records[0]?.text).toContain("[Circular]");
  });

  it("recognizes accessor descriptors by their own fields even when a prototype has a value field", async () => {
    const result = await run('Object.prototype.value = "inherited descriptor field"; const item = { get answer() { throw new Error("getter was called"); } }; console.log(item); console.log("%j", item);');
    expect(result.state.status).toBe("completed");
    expect(result.records[0]?.text).toContain("answer: [Getter/Setter]");
    expect(result.records[1]?.text).toBe('{"answer":"[Getter/Setter]"}');
  });

  it("formats primitive numeric placeholders with Node-style integer and float parsing", async () => {
    const result = await run('console.log("%i %f %d", "12.5tail", "12.5tail", "12.5tail"); console.log("%i %f %d", 12.75, 12.75, -0); console.log("%i %f %d", 12n, 12n, 12n); console.log("%i %f %d", null, true, Symbol("label"));');
    expect(result.state.status).toBe("completed");
    expect(result.records.map(({ text }) => text)).toEqual(["12 12.5 NaN", "12 12.75 -0", "12n 12 12n", "NaN NaN NaN"]);
  });

  it("formats bounded JSON from data descriptors without invoking conversion hooks", async () => {
    const result = await run('const item = { answer: 42, label: "hello", values: [true, null, undefined], omitted: undefined, get hidden() { throw new Error("getter was called"); }, toJSON() { throw new Error("toJSON was called"); } }; console.log("%j", item); const circular = {}; circular.self = circular; console.log("%j", circular); console.log("%j", 12n); console.log("%j", Array(100).fill(1));');
    expect(result.state.status).toBe("completed");
    expect(JSON.parse(result.records[0]!.text)).toEqual({ answer: 42, label: "hello", values: [true, null, null], hidden: "[Getter/Setter]" });
    expect(JSON.parse(result.records[1]!.text)).toEqual({ self: "[Circular]" });
    expect(JSON.parse(result.records[2]!.text)).toBe("12n");
    expect(JSON.parse(result.records[3]!.text)).toBe("[Inspection limit]");
  });

  it("renders HTML as text and escapes terminal controls while retaining Unicode", async () => {
    const result = await run('console.log("<b>hello</b> 🌎\\n\\x1b[2J\\x1b]52;c;untrusted\\x07");');
    expect(result.records[0]?.text).toContain("<b>hello</b> 🌎\n\\u001b[2J");
    expect(result.records[0]?.text).not.toMatch(/[\x1b\x07]/u);
  });

  it("reports syntax/runtime errors and rejected or pending completion promises", async () => {
    expect((await run("const = ;")).state.status).toBe("failed");
    expect((await run('throw new Error("test failure")')).state.message).toContain("test failure");
    expect((await run('Promise.reject(new Error("rejected"))')).state.message).toContain("rejected");
    expect((await run("new Promise(() => {})")).state.message).toContain("pending promise");
    expect((await run('Promise.resolve().then(() => console.log("microtask"))')).records[0]?.text).toBe("microtask");
  });

  it("discards guest globals between runs", async () => {
    await run("globalThis.previousRun = 42;");
    expect((await run("console.log(typeof previousRun)")).records[0]?.text).toBe("undefined");
  });

  it("stops output flooding with bounded records and bytes, then runs cleanly", async () => {
    const result = await run('for (let i = 0; i < 100000; i++) console.log("line", i);');
    expect(result.state.status).toBe("output-limit");
    expect(result.records.length).toBeLessThanOrEqual(SCRIPT_LIMITS.outputRecords);
    expect(result.records.reduce((n, r) => n + new TextEncoder().encode(r.text).length + 1, 0)).toBeLessThanOrEqual(SCRIPT_LIMITS.outputBytes);
    expect((await run('console.log("after limit")')).state.status).toBe("completed");
  });

  it("enforces memory and stack limits", async () => {
    expect((await run('const values=[]; for(let i=0;i<10000;i++) values.push(new Array(10000).fill(i));')).state.status).toBe("failed");
    expect((await run('function recurse(){return recurse()+1} recurse();')).state.status).toBe("failed");
  });

  it("interrupts synchronous and promise-job loops under the same deadline", async () => {
    expect((await run("while (true) {} ")).state.status).toBe("timed-out");
    expect((await run("function loop(){Promise.resolve().then(loop)} loop();")).state.status).toBe("timed-out");
  }, 15_000);
});
