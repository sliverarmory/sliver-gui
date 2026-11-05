// @vitest-environment node

import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  abortPackagedApplicationOnSignal,
  createPackagedMtlsCleanup,
  packagedMtlsLaunchOptions,
  shutdownMtlsFixture,
} from "./packaged-mtls-support.js";

afterEach(() => vi.useRealTimers());

describe("packaged mTLS launch", () => {
  it.each(["darwin", "linux", "win32"] as const)("isolates the %s profile without weakening sandbox or CSP", (platform) => {
    const inherited = { HOME: "/original", USERPROFILE: "/original", PATH: "/bin", UNDEFINED: undefined };
    const options = packagedMtlsLaunchOptions("/repository", "/isolated", "/profile", platform, inherited);
    expect(options).toMatchObject({ cwd: "/repository", bypassCSP: false, chromiumSandbox: true });
    expect(options.args).toEqual([
      "--enable-sandbox",
      ...(platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : []),
      "--user-data-dir=/profile",
    ]);
    expect(options.env).toEqual({
      PATH: "/bin", HOME: "/isolated", USERPROFILE: "/isolated",
      XDG_CONFIG_HOME: join("/isolated", ".config"),
      ELECTRON_RENDERER_URL: "http://127.0.0.1:65535/",
      ...(platform === "darwin" ? { CFFIXED_USER_HOME: "/isolated" } : {}),
    });
    expect(inherited.HOME).toBe("/original");
  });

  it.each([false, true])("kills the owned live process on abort (already aborted=%s)", (aborted) => {
    const controller = new AbortController();
    if (aborted) controller.abort();
    const child = { exitCode: null, signalCode: null, kill: vi.fn(() => true) };
    const detach = abortPackagedApplicationOnSignal(controller.signal, child);
    controller.abort();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    detach();
  });

  it("does not kill exited, signaled, or detached processes", () => {
    for (const state of [{ exitCode: 0, signalCode: null }, { exitCode: null, signalCode: "SIGTERM" }, { exitCode: null, signalCode: null }]) {
      const controller = new AbortController();
      const child = { ...state, kill: vi.fn(() => true) };
      const detach = abortPackagedApplicationOnSignal(controller.signal, child);
      if (child.exitCode === null && child.signalCode === null) detach();
      controller.abort();
      expect(child.kill).not.toHaveBeenCalled();
    }
  });
});

describe("packaged mTLS cleanup", () => {
  it("closes the application, fixture and directory once, then detaches the abort listener", async () => {
    const steps: string[] = [];
    const cleanup = createPackagedMtlsCleanup({
      application: () => ({
        close: async () => { steps.push("application"); },
        process: () => ({ exitCode: 0, signalCode: null, stdio: [], kill: vi.fn(() => true) }),
      }),
      closeFixture: async () => { steps.push("fixture"); },
      removeTemporaryRoot: async () => { steps.push("directory"); },
      detachAbortListener: () => { steps.push("detach"); },
    });
    const first = cleanup();
    expect(cleanup()).toBe(first);
    await first;
    await cleanup();
    expect(steps).toEqual(["application", "fixture", "directory", "detach"]);
  });

  it("attempts remaining cleanup and detaches after application and fixture failures", async () => {
    const closeFixture = vi.fn(async () => { throw new Error("fixture failed"); });
    const removeTemporaryRoot = vi.fn(async () => undefined);
    const detachAbortListener = vi.fn();
    const cleanup = createPackagedMtlsCleanup({
      application: () => ({
        close: async () => { throw new Error("application failed"); },
        process: () => ({ exitCode: 0, signalCode: null, stdio: [], kill: vi.fn(() => true) }),
      }),
      closeFixture, removeTemporaryRoot, detachAbortListener,
    });
    await expect(cleanup()).rejects.toMatchObject({
      message: "Packaged mTLS E2E cleanup failed",
      errors: [expect.objectContaining({ message: expect.stringContaining("application failed") }), expect.objectContaining({ message: "fixture failed" })],
    });
    expect(closeFixture).toHaveBeenCalledOnce();
    expect(removeTemporaryRoot).toHaveBeenCalledOnce();
    expect(detachAbortListener).toHaveBeenCalledOnce();
  });

  it("cleans partial launches and retains directory-removal failures", async () => {
    const removeTemporaryRoot = vi.fn(async () => { throw new Error("directory failed"); });
    const closeFixture = vi.fn(async () => undefined);
    const detachAbortListener = vi.fn();
    const cleanup = createPackagedMtlsCleanup({ application: () => undefined, closeFixture, removeTemporaryRoot, detachAbortListener });
    await expect(cleanup()).rejects.toMatchObject({ errors: [expect.objectContaining({ message: "directory failed" })] });
    expect(closeFixture).toHaveBeenCalledOnce();
    expect(detachAbortListener).toHaveBeenCalledOnce();
  });

  it("cancels the deadline after a graceful fixture shutdown", async () => {
    vi.useFakeTimers();
    const server = { shutdown: vi.fn(async () => undefined), forceShutdown: vi.fn() };
    await shutdownMtlsFixture(server);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.shutdown).toHaveBeenCalledOnce();
    expect(server.forceShutdown).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forces shutdown at the deadline when graceful shutdown stalls", async () => {
    vi.useFakeTimers();
    const server = { shutdown: vi.fn(() => new Promise<void>(() => undefined)), forceShutdown: vi.fn() };
    const closing = shutdownMtlsFixture(server);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(server.forceShutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(server.forceShutdown).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("forces shutdown after graceful failure (synchronous=%s)", async (synchronous) => {
    const server = {
      shutdown: vi.fn(() => { if (synchronous) throw new Error("shutdown failed"); return Promise.reject(new Error("shutdown failed")); }),
      forceShutdown: vi.fn(),
    };
    await shutdownMtlsFixture(server);
    expect(server.forceShutdown).toHaveBeenCalledOnce();
  });
});
