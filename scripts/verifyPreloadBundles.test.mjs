import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyPreloadBundle, verifyPreloadBundles } from "./verifyPreloadBundles.mjs";

const networkFixture = `
  const { contextBridge } = require("electron");
  document.addEventListener("contextmenu", () => {});
  contextBridge.exposeInMainWorld("network", Object.freeze({ getContext() {} }));
  contextBridge.exposeInMainWorld("applicationContextMenu", Object.freeze({ onMenuRequested() {} }));
`;

test("executes a standalone CommonJS bundle and verifies its frozen bridges", () => {
  assert.deepEqual(verifyPreloadBundle("network.cjs", networkFixture), {
    filename: "network.cjs", bridges: ["applicationContextMenu", "network"],
  });
});

for (const specifier of ["./shared.cjs", "../main/index.js", "node:fs", "some-package"]) {
  test(`rejects an emitted dependency on ${specifier}`, () => {
    assert.throws(() => verifyPreloadBundle("network.cjs",
      `require(${JSON.stringify(specifier)});\n${networkFixture}`), /unavailable.*require/u);
  });
}

test("does not hide unsupported dependencies that a bundle catches", () => {
  assert.throws(() => verifyPreloadBundle("network.cjs",
    `try { require("./shared.cjs"); } catch {}\n${networkFixture}`), /attempted unavailable operations/u);
});

test("rejects changed, missing, duplicate, or mutable renderer bridges", () => {
  assert.throws(() => verifyPreloadBundle("network.cjs", networkFixture.replace('"network"', '"unexpected"')),
    /bridge names changed/u);
  assert.throws(() => verifyPreloadBundle("network.cjs", ""), /bridge names changed/u);
  assert.throws(() => verifyPreloadBundle("network.cjs", `${networkFixture}
    contextBridge.exposeInMainWorld("network", Object.freeze({ getContext() {} }));`), /duplicate exposed bridge/u);
  assert.throws(() => verifyPreloadBundle("network.cjs",
    networkFixture.replace("Object.freeze({ getContext() {} })", "{ getContext() {} }")), /must be frozen/u);
});

test("rejects initialization that invokes a native operation", () => {
  assert.throws(() => verifyPreloadBundle("network.cjs",
    `require("electron").ipcRenderer.invoke("sliver:mutation");\n${networkFixture}`), /unavailable.*invoke/u);
});

test("rejects code generation incompatible with renderer CSP", () => {
  assert.throws(() => verifyPreloadBundle("network.cjs", `eval("1");\n${networkFixture}`), /Code generation/u);
});

test("checks the emitted navigation guard even though it exposes no bridge", () => {
  const guard = `navigation.addEventListener("navigate", (event) => {
    if (!event.destination.url.startsWith("sliver://app/index.html")) event.preventDefault();
  });`;
  assert.deepEqual(verifyPreloadBundle("navigation.cjs", guard), { filename: "navigation.cjs", bridges: [] });
  assert.throws(() => verifyPreloadBundle("navigation.cjs", ""), /Navigation guard was not installed/u);
  assert.throws(() => verifyPreloadBundle("navigation.cjs",
    'navigation.addEventListener("navigate", () => {});'), /allowed an external document/u);
});

test("checks all eight outputs and rejects missing bundles or extracted shared chunks", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "sliver-preload-bundles-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(verifyPreloadBundles(directory), /exactly the expected standalone/u);
  const expectedBridges = {
    "index.cjs": ["sliver", "applicationZoom", "applicationContextMenu", "ghosttySettings"],
    "cloud-deployment.cjs": ["cloudDeployment", "applicationContextMenu"],
    "network.cjs": ["network", "applicationContextMenu"],
    "armory.cjs": ["armory", "applicationContextMenu"],
    "ssh.cjs": ["ssh", "applicationContextMenu", "ghosttySettings"],
    "rdp.cjs": ["rdp", "applicationContextMenu"],
    "text-editor.cjs": ["textEditor", "applicationContextMenu"],
  };
  for (const [filename, bridges] of Object.entries(expectedBridges)) {
    await writeFile(join(directory, filename), `
      const { contextBridge } = require("electron");
      document.addEventListener("contextmenu", () => {});
      for (const name of ${JSON.stringify(bridges)}) {
        contextBridge.exposeInMainWorld(name, Object.freeze({ method() {} }));
      }
    `);
  }
  await writeFile(join(directory, "navigation.cjs"), `
    navigation.addEventListener("navigate", (event) => {
      if (event.destination.url === "about:blank") event.preventDefault();
    });
  `);
  assert.equal((await verifyPreloadBundles(directory)).length, 8);
  await mkdir(join(directory, "chunks"));
  await writeFile(join(directory, "chunks", "shared.cjs"), "module.exports = {};");
  await assert.rejects(verifyPreloadBundles(directory), /shared chunks are unsupported/u);
});
