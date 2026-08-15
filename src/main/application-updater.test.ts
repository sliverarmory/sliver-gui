// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ApplicationUpdateBackend,
  ApplicationUpdateBackendEvents,
  ApplicationUpdateCheckResult,
  CreateApplicationUpdaterOptions,
} from "./application-updater.js";

vi.mock("electron-updater", () => ({
  default: { autoUpdater: {} },
}));

import {
  ApplicationUpdater,
  applicationUpdateDisabledReason,
} from "./application-updater.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("application updater", () => {
  it("disables checks in development, unsupported builds, and Windows portable builds", async () => {
    expect(applicationUpdateDisabledReason({
      isPackaged: false,
      platform: "darwin",
      portableExecutableFile: undefined,
      appImageFile: undefined,
      linuxPackageType: undefined,
    })).toMatch(/packaged builds/i);
    expect(applicationUpdateDisabledReason({
      isPackaged: true,
      platform: "freebsd",
      portableExecutableFile: undefined,
      appImageFile: undefined,
      linuxPackageType: undefined,
    })).toMatch(/platform/i);
    expect(applicationUpdateDisabledReason({
      isPackaged: true,
      platform: "win32",
      portableExecutableFile: "Sliver-GUI.exe",
      appImageFile: undefined,
      linuxPackageType: undefined,
    })).toMatch(/portable/i);
    expect(applicationUpdateDisabledReason({
      isPackaged: true,
      platform: "linux",
      portableExecutableFile: undefined,
      appImageFile: "/untrusted/inherited.AppImage",
      linuxPackageType: "deb",
    })).toMatch(/manually verified/i);
    expect(applicationUpdateDisabledReason({
      isPackaged: true,
      platform: "linux",
      portableExecutableFile: undefined,
      appImageFile: "/opt/Sliver-GUI.AppImage",
      linuxPackageType: undefined,
    })).toBeUndefined();

    const backend = new FakeUpdateBackend();
    const updater = createUpdater(backend, { isPackaged: false });
    expect(updater.getState()).toMatchObject({ status: "disabled", currentVersion: "1.2.3" });
    expect(await updater.checkForUpdates()).toMatchObject({ ok: false, error: expect.any(String) });
    expect(backend.configureCalls).toBe(0);
    expect(backend.checkCalls).toBe(0);
  });

  it("configures the backend and publishes bounded download progress through ready", () => {
    const backend = new FakeUpdateBackend();
    const updater = createUpdater(backend);
    const observed: string[] = [];
    updater.subscribe((state) => observed.push(state.status));

    backend.events?.available("1.3.0");
    backend.events?.progress(42.26);
    backend.events?.progress(150);
    backend.events?.progress(150.04);
    backend.events?.downloaded("1.3.0");

    expect(backend.configureCalls).toBe(1);
    expect(observed).toEqual(["available", "downloading", "downloading", "ready"]);
    expect(updater.getState()).toEqual({
      status: "ready",
      revision: 4,
      currentVersion: "1.2.3",
      availableVersion: "1.3.0",
    });
  });

  it("coalesces simultaneous checks and maps a no-update result to up-to-date", async () => {
    const backend = new FakeUpdateBackend();
    let resolveCheck: ((result: ApplicationUpdateCheckResult) => void) | undefined;
    backend.checkImplementation = () => new Promise((resolve) => {
      resolveCheck = resolve;
    });
    const updater = createUpdater(backend);

    const first = updater.checkForUpdates();
    const second = updater.checkForUpdates();
    expect(second).toBe(first);
    expect(updater.getState().status).toBe("checking");
    expect(backend.checkCalls).toBe(1);

    resolveCheck?.({ isUpdateAvailable: false, version: "1.2.3" });
    await expect(first).resolves.toEqual({
      ok: true,
      value: { status: "up-to-date", revision: 2, currentVersion: "1.2.3" },
    });
  });

  it("never exposes backend error text or malformed release versions", async () => {
    const backend = new FakeUpdateBackend();
    backend.checkImplementation = () => Promise.reject(new Error("token at https://example.invalid/private"));
    const updater = createUpdater(backend);

    const result = await updater.checkForUpdates();
    expect(result).toEqual({
      ok: false,
      error: "Sliver Desktop could not check for updates. Try again later.",
    });
    expect(JSON.stringify(updater.getState())).not.toContain("example.invalid");

    backend.events?.available("https://example.invalid/update");
    expect(updater.getState()).toMatchObject({
      status: "error",
      error: "Sliver Desktop could not check for updates. Try again later.",
    });
  });

  it("asks the backend to install without disabling the running app preemptively", () => {
    const backend = new FakeUpdateBackend();
    let updater: ApplicationUpdater;
    backend.quitImplementation = () => {
      backend.events?.error();
    };
    updater = createUpdater(backend);

    expect(updater.restartToApply()).toEqual({
      ok: false,
      error: "An application update is not ready to install.",
    });
    backend.events?.downloaded("1.3.0");
    expect(updater.restartToApply()).toEqual({
      ok: false,
      error: "Sliver Desktop could not restart to install the update. Try again later.",
    });
    expect(updater.getState().status).toBe("error");
  });

  it("coalesces repeated restart requests while the platform installer is preparing", () => {
    const backend = new FakeUpdateBackend();
    let installCalls = 0;
    backend.quitImplementation = () => {
      installCalls += 1;
    };
    const updater = createUpdater(backend);
    backend.events?.downloaded("1.3.0");

    expect(updater.restartToApply()).toEqual({ ok: true });
    expect(updater.restartToApply()).toEqual({ ok: true });
    expect(installCalls).toBe(1);
  });

  it("checks after a jittered startup delay, repeats periodically, and cancels timers on dispose", async () => {
    vi.useFakeTimers();
    const backend = new FakeUpdateBackend();
    const updater = createUpdater(backend, {
      random: () => 0.5,
      firstCheckMinimumDelayMs: 100,
      firstCheckJitterMs: 20,
      periodicCheckMinimumDelayMs: 1_000,
      periodicCheckJitterMs: 200,
    });

    updater.start();
    await vi.advanceTimersByTimeAsync(109);
    expect(backend.checkCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.checkCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(backend.checkCalls).toBe(2);

    updater.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(backend.checkCalls).toBe(2);
    expect(backend.unsubscribeCalls).toBe(1);
  });
});

class FakeUpdateBackend implements ApplicationUpdateBackend {
  events: ApplicationUpdateBackendEvents | undefined;
  configureCalls = 0;
  checkCalls = 0;
  unsubscribeCalls = 0;
  checkImplementation: () => Promise<ApplicationUpdateCheckResult | null> = () =>
    Promise.resolve({ isUpdateAvailable: false, version: "1.2.3" });
  quitImplementation: () => void = () => undefined;

  configure(): void {
    this.configureCalls += 1;
  }

  subscribe(events: ApplicationUpdateBackendEvents): () => void {
    this.events = events;
    return () => {
      this.unsubscribeCalls += 1;
      this.events = undefined;
    };
  }

  checkForUpdates(): Promise<ApplicationUpdateCheckResult | null> {
    this.checkCalls += 1;
    return this.checkImplementation();
  }

  quitAndInstall(): void {
    this.quitImplementation();
  }
}

function createUpdater(
  backend: FakeUpdateBackend,
  overrides: Partial<CreateApplicationUpdaterOptions> = {},
): ApplicationUpdater {
  return new ApplicationUpdater({
    currentVersion: "1.2.3",
    isPackaged: true,
    platform: "darwin",
    portableExecutableFile: undefined,
    appImageFile: undefined,
    linuxPackageType: undefined,
    backend,
    ...overrides,
  });
}
