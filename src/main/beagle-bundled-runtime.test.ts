// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BEAGLE_RUNTIME_MAX_REQUEST_BYTES, BEAGLE_RUNTIME_MAX_RESPONSE_BYTES, BEAGLE_RUNTIME_OPERATIONS } from "../shared/beagle-runtime-contracts.js";
import type { BeagleRuntimeClient } from "./beagle-runtime.js";
import type { BeagleExecutableVerifier } from "./beagle-runtime-loader.js";
import { BeagleService } from "./beagle-service.js";

const digest = "a".repeat(64);
const bundledIdentity = { path: "/application/resources/beagle/beagle", sha256: digest, size: 42 };
const stats = { nodes: 0, edges: 0, labels: {}, relationships: {} };
const capabilities = { schema_version: 1, features: Object.fromEntries([
  "parameters", "shortest_path", "variable_length_paths", "named_paths", "optional_match", "with_where", "call_subquery",
  "union", "existential_subquery_full", "list_comprehension", "quantifiers",
].map((name) => [name, true])) };

describe("Beagle bundled runtime discovery", () => {
  let root: string;
  const services: BeagleService[] = [];
  const resolveBundledRuntime = vi.fn(async () => bundledIdentity);
  const verify = vi.fn<BeagleExecutableVerifier["verify"]>(async (path, sha256) => ({ path, sha256, size: 42 }));
  const capture = vi.fn<BeagleExecutableVerifier["capture"]>(async (path) => ({ path, sha256: digest, size: 42 }));
  const createRuntime = vi.fn((): BeagleRuntimeClient => {
    let closed = false;
    return {
      get closed() { return closed; },
      ready: Promise.resolve({ type: "ready", name: "beagle", protocol: 1, version: "0.1.0", operations: BEAGLE_RUNTIME_OPERATIONS,
        limits: { requestBytes: BEAGLE_RUNTIME_MAX_REQUEST_BYTES, responseBytes: BEAGLE_RUNTIME_MAX_RESPONSE_BYTES } }),
      request: vi.fn(async (command) => command.type === "stats" ? { ...stats, capabilities } : null),
      stop: vi.fn(async () => { closed = true; }),
    };
  });
  function service(environment: NodeJS.ProcessEnv = {}) {
    const instance = new BeagleService({ userDataPath: root, createRuntime, verifier: { verify, capture }, resolveBundledRuntime,
      environment: { SLIVER_BEAGLE_BINARY: undefined, SLIVER_BEAGLE_SHA256: undefined, ...environment } });
    services.push(instance);
    return instance;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "beagle-bundled-service-"));
    vi.clearAllMocks();
    resolveBundledRuntime.mockResolvedValue(bundledIdentity);
    verify.mockImplementation(async (path, sha256) => ({ path, sha256, size: 42 }));
  });
  afterEach(async () => {
    await Promise.all(services.splice(0).map((entry) => entry.dispose()));
    await rm(root, { recursive: true, force: true });
  });

  it("starts the bundled runtime on first use without storing its path as a custom selection", async () => {
    const state = await service().getState();
    expect(state.runtime).toMatchObject({ available: true, version: "beagle 0.1.0", source: "Bundled Beagle" });
    expect(resolveBundledRuntime).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledTimes(2); // Compatibility probe and project owner each recheck the installed bytes.
    expect(verify).toHaveBeenNthCalledWith(1, bundledIdentity.path, bundledIdentity.sha256);
    expect(verify).toHaveBeenNthCalledWith(2, bundledIdentity.path, bundledIdentity.sha256);
    expect(capture).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(root, "beagle/projects.json"), "utf8"))).toMatchObject({ binaryPath: null, binarySha256: null });
  });

  it("retains explicit environment overrides", async () => {
    const state = await service({ SLIVER_BEAGLE_BINARY: "/custom/beagle", SLIVER_BEAGLE_SHA256: digest }).getState();
    expect(state.runtime).toMatchObject({ available: true, source: "SLIVER_BEAGLE_BINARY" });
    expect(resolveBundledRuntime).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledWith("/custom/beagle", digest);
  });

  it.each([
    { SLIVER_BEAGLE_BINARY: "/custom/beagle" },
    { SLIVER_BEAGLE_SHA256: digest },
  ])("does not silently ignore incomplete environment overrides: %j", async (environment) => {
    const state = await service(environment).getState();
    expect(state.runtime.available).toBe(false);
    expect(resolveBundledRuntime).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("does not fall back to bundled bytes when an explicit override fails verification", async () => {
    verify.mockRejectedValue(new Error("mismatched executable"));
    const state = await service({ SLIVER_BEAGLE_BINARY: "/custom/beagle", SLIVER_BEAGLE_SHA256: digest }).getState();
    expect(state.runtime.available).toBe(false);
    expect(resolveBundledRuntime).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("preserves a saved operator selection across startup and prefers it over environment overrides", async () => {
    const configured = service();
    await configured.configureBinary("/selected/beagle");
    await configured.dispose();
    const state = await service({ SLIVER_BEAGLE_BINARY: "/environment/beagle", SLIVER_BEAGLE_SHA256: "b".repeat(64) }).getState();
    expect(state.runtime).toMatchObject({ available: true, source: "Selected executable" });
    expect(resolveBundledRuntime).not.toHaveBeenCalled();
    expect(verify.mock.calls.every(([path, sha256]) => path === "/selected/beagle" && sha256 === digest)).toBe(true);
  });

  it("reports a failed bundled verification without asking the operator to configure an executable", async () => {
    resolveBundledRuntime.mockRejectedValue(new Error("private installation path"));
    const state = await service().getState();
    expect(state.runtime).toMatchObject({ available: false, source: null,
      error: "The bundled Beagle runtime could not be verified or started. Rebuild or reinstall Sliver GUI." });
    expect(createRuntime).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });
});
