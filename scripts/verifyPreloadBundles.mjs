import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Script, createContext } from "node:vm";

const PRELOAD_BRIDGES = Object.freeze({
  "index.cjs": ["sliver", "applicationZoom", "applicationContextMenu", "ghosttySettings"],
  "navigation.cjs": [],
  "cloud-deployment.cjs": ["cloudDeployment", "applicationContextMenu"],
  "network.cjs": ["network", "applicationContextMenu"],
  "armory.cjs": ["armory", "applicationContextMenu"],
  "ssh.cjs": ["ssh", "applicationContextMenu", "ghosttySettings"],
  "rdp.cjs": ["rdp", "applicationContextMenu"],
  "text-editor.cjs": ["textEditor", "applicationContextMenu"],
});

/**
 * Execute a trusted build artifact with only the APIs used during preload
 * initialization. This checks bundler output, not hostile JavaScript: Electron
 * E2E tests remain responsible for the actual sandbox and renderer behavior.
 */
export function verifyPreloadBundle(filename, source) {
  assert.ok(Object.hasOwn(PRELOAD_BRIDGES, filename), `Unexpected preload bundle: ${filename}`);
  const bridges = new Map();
  const rejectedOperations = [];
  const documentListeners = new Map();
  const navigationListeners = new Map();

  function reject(operation) {
    rejectedOperations.push(operation);
    throw new Error(`${filename}: unavailable during sandboxed preload initialization: ${operation}`);
  }

  function addListener(listeners, type, listener) {
    assert.equal(typeof listener, "function", `${filename}: ${type} listener must be a function`);
    const registered = listeners.get(type) ?? [];
    registered.push(listener);
    listeners.set(type, registered);
  }

  const ipcRenderer = Object.freeze({
    on: (_channel, listener) => {
      assert.equal(typeof listener, "function");
      return ipcRenderer;
    },
    removeListener: () => ipcRenderer,
    invoke: () => reject("ipcRenderer.invoke"),
    send: () => reject("ipcRenderer.send"),
    postMessage: () => reject("ipcRenderer.postMessage"),
  });
  const electron = Object.freeze({
    contextBridge: Object.freeze({
      exposeInMainWorld: (name, bridge) => {
        assert.ok(!bridges.has(name), `${filename}: duplicate exposed bridge ${name}`);
        assert.ok(bridge && typeof bridge === "object", `${filename}: ${name} must expose an object`);
        assert.ok(Object.isFrozen(bridge), `${filename}: ${name} must be frozen`);
        assert.ok(Object.values(bridge).some((value) => typeof value === "function"),
          `${filename}: ${name} must expose methods`);
        bridges.set(name, bridge);
      },
    }),
    ipcRenderer,
    webFrame: Object.freeze({
      getZoomFactor: () => 1,
      setZoomFactor: () => reject("webFrame.setZoomFactor"),
    }),
    webUtils: Object.freeze({ getPathForFile: () => reject("webUtils.getPathForFile") }),
  });
  const document = {
    addEventListener: (type, listener) => addListener(documentListeners, type, listener),
    querySelectorAll: () => [],
  };
  const windowListeners = new Map();
  const exports = {};
  const context = createContext({
    exports,
    module: { exports },
    require: (specifier) => specifier === "electron" ? electron : reject(`require(${JSON.stringify(specifier)})`),
    URL,
    document,
    window: {
      addEventListener: (type, listener) => addListener(windowListeners, type, listener),
      removeEventListener: () => undefined,
    },
    location: { protocol: "sliver:" },
    navigation: {
      addEventListener: (type, listener) => addListener(navigationListeners, type, listener),
    },
    MutationObserver: class {
      observe(target) {
        assert.equal(target, document, `${filename}: unexpected mutation observation target`);
      }
    },
  }, { codeGeneration: { strings: false, wasm: false } });

  try {
    new Script(source, { filename }).runInContext(context, { timeout: 1_000 });
    assert.deepEqual(rejectedOperations, [], `${filename}: attempted unavailable operations`);
    assert.deepEqual([...bridges.keys()].sort(), [...PRELOAD_BRIDGES[filename]].sort(),
      `${filename}: exposed bridge names changed`);
    if (filename === "navigation.cjs") {
      assert.equal(navigationListeners.get("navigate")?.length, 1, "Navigation guard was not installed");
      // An empty or broken bundle must not pass just because it exposes no API.
      context.verifyNavigation = (url) => {
        let prevented = false;
        navigationListeners.get("navigate")[0]({
          destination: { url },
          preventDefault: () => { prevented = true; },
        });
        return prevented;
      };
      assert.equal(new Script('verifyNavigation("sliver://app/index.html?surface=network")')
        .runInContext(context, { timeout: 1_000 }), false, "Navigation guard rejected an application URL");
      assert.equal(new Script('verifyNavigation("about:blank")')
        .runInContext(context, { timeout: 1_000 }), true, "Navigation guard allowed an external document");
    } else {
      assert.equal(documentListeners.get("contextmenu")?.length, 1,
        "Restricted context menu listener was not installed");
    }
  } catch (error) {
    throw new Error(`${filename}: preload bundle verification failed: ${error.message}`, { cause: error });
  }
  return { filename, bridges: [...bridges.keys()].sort() };
}

export async function verifyPreloadBundles(directory = resolve(import.meta.dirname, "../dist/preload")) {
  const expected = Object.keys(PRELOAD_BRIDGES).sort();
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const actual = entries.filter((entry) => entry.isFile() && /\.(?:cjs|mjs|js)$/u.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
  assert.deepEqual(actual.sort(), expected.map((filename) => join(directory, filename)).sort(),
    "Preload output must contain exactly the expected standalone CommonJS bundles; shared chunks are unsupported");
  const results = [];
  for (const filename of expected) {
    results.push(verifyPreloadBundle(filename, await readFile(join(directory, filename), "utf8")));
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyPreloadBundles().then((results) => {
    console.log(`Verified ${results.length} standalone sandboxed preload bundles and their frozen bridges.`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
