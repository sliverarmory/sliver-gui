// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApplicationUpdateState } from "../shared/application-update-contracts.js";
import type {
  ApplicationUpdateBackend,
  ApplicationUpdateBackendEvents,
  ApplicationUpdateCheckResult,
  CreateApplicationUpdaterOptions,
} from "./application-updater.js";
import { UpdateCertificateTrustRequiredError } from "./update-certificate-trust.js";

vi.mock("electron-updater", () => ({
  default: { autoUpdater: {} },
}));

import {
  ApplicationUpdater,
  applicationUpdateDisabledReason,
  configureApplicationUpdateBackend,
  installDownloadedApplicationUpdate,
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
    const ensureTrusted = vi.fn();
    const updater = createUpdater(backend, { isPackaged: false, certificateTrust: { ensureTrusted } });
    const observed: ApplicationUpdateState[] = [];
    updater.subscribe((state) => observed.push(state));
    expect(updater.getState()).toMatchObject({ status: "disabled", currentVersion: "1.2.3" });
    updater.start();
    expect(observed).toEqual([]);
    expect(await updater.checkForUpdates()).toMatchObject({ ok: false, error: expect.any(String) });
    expect(observed).toEqual([updater.getState()]);
    expect(backend.configureCalls).toBe(0);
    expect(backend.checkCalls).toBe(0);
    expect(ensureTrusted).not.toHaveBeenCalled();
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

  it("waits for foreground certificate trust before checking or automatically downloading", async () => {
    const backend = new FakeUpdateBackend();
    const trust = deferred<void>();
    const ensureTrusted = vi.fn(() => trust.promise);
    const updater = createUpdater(backend, { certificateTrust: { ensureTrusted } });

    const first = updater.checkForUpdates();
    const second = updater.checkForUpdates();
    expect(first).toBe(second);
    expect(ensureTrusted).toHaveBeenCalledExactlyOnceWith(true);
    expect(backend.checkCalls).toBe(0);

    trust.resolve();
    await expect(first).resolves.toMatchObject({ ok: true, value: { status: "up-to-date" } });
    expect(backend.checkCalls).toBe(1);
  });

  it("runs scheduled trust probes without prompting and resumes after foreground approval", async () => {
    vi.useFakeTimers();
    const backend = new FakeUpdateBackend();
    const ensureTrusted = vi.fn(async (manual: boolean) => {
      if (!manual) throw new UpdateCertificateTrustRequiredError("required");
    });
    const updater = createUpdater(backend, {
      certificateTrust: { ensureTrusted },
      firstCheckMinimumDelayMs: 100,
      firstCheckJitterMs: 0,
      periodicCheckMinimumDelayMs: 1_000,
      periodicCheckJitterMs: 0,
    });

    updater.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(ensureTrusted).toHaveBeenCalledExactlyOnceWith(false);
    expect(backend.checkCalls).toBe(0);
    expect(updater.getState()).toMatchObject({ status: "trust-required", message: expect.stringContaining("macOS") });
    const requiredRevision = updater.getState().revision;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ensureTrusted).toHaveBeenLastCalledWith(false);
    expect(backend.checkCalls).toBe(0);
    expect(updater.getState().revision).toBe(requiredRevision);

    await expect(updater.checkForUpdates()).resolves.toMatchObject({ ok: true, value: { status: "up-to-date" } });
    expect(ensureTrusted).toHaveBeenLastCalledWith(true);
    expect(backend.checkCalls).toBe(1);
    updater.dispose();
  });

  it("coalesces a foreground retry arriving while a background trust probe is pending", async () => {
    const backend = new FakeUpdateBackend();
    const backgroundTrust = deferred<void>();
    const ensureTrusted = vi.fn((manual: boolean) => manual ? Promise.resolve() : backgroundTrust.promise);
    const updater = createUpdater(backend, { certificateTrust: { ensureTrusted } });

    const background = updater.checkForUpdates(false);
    const foreground = updater.checkForUpdates();
    expect(updater.checkForUpdates()).toBe(foreground);
    expect(ensureTrusted).toHaveBeenCalledExactlyOnceWith(false);
    expect(backend.checkCalls).toBe(0);

    backgroundTrust.reject(new UpdateCertificateTrustRequiredError("required"));
    await expect(background).resolves.toMatchObject({ ok: true, value: { status: "trust-required" } });
    await expect(foreground).resolves.toMatchObject({ ok: true, value: { status: "up-to-date" } });
    expect(ensureTrusted.mock.calls).toEqual([[false], [true]]);
    expect(backend.checkCalls).toBe(1);
  });

  it.each(["required", "cancelled"] as const)("keeps %s trust actionable without checking or leaking helper errors", async (kind) => {
    const backend = new FakeUpdateBackend();
    const ensureTrusted = vi.fn(async () => {
      const error = new UpdateCertificateTrustRequiredError(kind);
      error.message = "private certificate at /private/test and https://example.invalid";
      throw error;
    });
    const updater = createUpdater(backend, { certificateTrust: { ensureTrusted } });

    await expect(updater.checkForUpdates()).resolves.toMatchObject({ ok: true, value: { status: "trust-required" } });
    expect(backend.checkCalls).toBe(0);
    expect(JSON.stringify(updater.getState())).not.toContain("private");
    expect(JSON.stringify(updater.getState())).not.toContain("example.invalid");
  });

  it("fails closed and sanitizes unexpected certificate validation errors", async () => {
    const backend = new FakeUpdateBackend();
    const updater = createUpdater(backend, {
      certificateTrust: {
        ensureTrusted: async () => { throw new Error("Mismatched certificate at /private/test"); },
      },
    });

    await expect(updater.checkForUpdates()).resolves.toEqual({
      ok: false,
      error: "Sliver Desktop could not check for updates. Try again later.",
    });
    expect(updater.getState()).toMatchObject({ status: "error" });
    expect(backend.checkCalls).toBe(0);
    expect(JSON.stringify(updater.getState())).not.toContain("private");
  });

  it("does not start a backend check after disposal while awaiting trust", async () => {
    const backend = new FakeUpdateBackend();
    const trust = deferred<void>();
    const updater = createUpdater(backend, { certificateTrust: { ensureTrusted: () => trust.promise } });

    const pending = updater.checkForUpdates();
    updater.dispose();
    trust.resolve();

    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(backend.checkCalls).toBe(0);
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

  it("silently installs and forces a relaunch after the renderer confirms restart", () => {
    const quitAndInstall = vi.fn();

    installDownloadedApplicationUpdate({ quitAndInstall });

    expect(quitAndInstall).toHaveBeenCalledOnce();
    expect(quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("follows prereleases only from an immutable prerelease build", () => {
    const backend = {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      autoRunAppAfterInstall: false,
      allowPrerelease: false,
      allowDowngrade: true,
      disableWebInstaller: false,
    };

    configureApplicationUpdateBackend(backend, "0.1.0-e2e.42.0");
    expect(backend).toEqual({
      autoDownload: true,
      autoInstallOnAppQuit: true,
      autoRunAppAfterInstall: true,
      allowPrerelease: true,
      allowDowngrade: false,
      disableWebInstaller: true,
    });

    configureApplicationUpdateBackend(backend, "0.1.0");
    expect(backend.allowPrerelease).toBe(false);
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}
