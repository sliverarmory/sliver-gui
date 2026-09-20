import { describe, expect, it } from "vitest";
import { create } from "monaco-editor/languages/features/typescript/tsWorker";

import { SCRIPT_WORKER_DATA } from "./script-language-config";

describe("script analysis profile", () => {
  it("accepts ECMAScript/console and independently scoped models while rejecting browser/Node globals", async () => {
    const first = "inmemory://test/one.js";
    const second = "inmemory://test/two.js";
    const sources = {
      [first]: "const message = [3, 1].toSorted(); console.log(message);\nwindow; fetch; process; require;",
      [second]: "const message = 42; console.error(message);",
    };
    const analysis = create({
      getMirrorModels: () => Object.entries(sources).map(([uri, source]) => ({
        uri: { toString: () => uri, path: new URL(uri).pathname },
        getValue: () => source,
        version: 1,
      })),
    }, SCRIPT_WORKER_DATA);
    const diagnostics = await analysis.getSemanticDiagnostics(first);
    expect(diagnostics).toHaveLength(4);
    for (const identifier of ["window", "fetch", "process", "require"]) {
      expect(diagnostics.some((diagnostic) => String(diagnostic.messageText).includes(`'${identifier}'`))).toBe(true);
    }
    expect(await analysis.getSemanticDiagnostics(second)).toEqual([]);
    expect(await analysis.getSyntacticDiagnostics(second)).toEqual([]);
  });
});
