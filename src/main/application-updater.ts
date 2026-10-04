import electronUpdater, {
  type AppUpdater,
  type ProgressInfo,
  type UpdateCheckResult,
  type UpdateDownloadedEvent,
  type UpdateInfo,
} from "electron-updater";

import {
  initialApplicationUpdateDisabled,
  initialApplicationUpdateIdle,
  parseApplicationUpdateState,
  type ApplicationUpdateState,
} from "../shared/application-update-contracts.js";
import type { OperationResult } from "../shared/contracts.js";
import {
  UpdateCertificateTrustRequiredError,
  type UpdateCertificateTrust,
} from "./update-certificate-trust.js";

const FIRST_CHECK_MINIMUM_DELAY_MS = 30_000;
const FIRST_CHECK_JITTER_MS = 30_000;
const PERIODIC_CHECK_MINIMUM_DELAY_MS = 6 * 60 * 60 * 1_000;
const PERIODIC_CHECK_JITTER_MS = 30 * 60 * 1_000;
const UPDATE_CHECK_ERROR = "Sliver Desktop could not check for updates. Try again later.";
const UPDATE_INSTALL_ERROR = "Sliver Desktop could not restart to install the update. Try again later.";
const UPDATE_TRUST_REQUIRED = "Approve the developer certificate in macOS to enable signed updates. Choose Set up trust to continue.";

export interface ApplicationUpdateBackendEvents {
  readonly checking: () => void;
  readonly available: (version: string) => void;
  readonly notAvailable: () => void;
  readonly progress: (percent: number) => void;
  readonly downloaded: (version: string) => void;
  readonly cancelled: () => void;
  readonly error: () => void;
}

export interface ApplicationUpdateCheckResult {
  readonly isUpdateAvailable: boolean;
  readonly version: string;
}

export interface ApplicationUpdateBackend {
  configure(): void;
  subscribe(events: ApplicationUpdateBackendEvents): () => void;
  checkForUpdates(): Promise<ApplicationUpdateCheckResult | null>;
  quitAndInstall(): void;
}

export interface CreateApplicationUpdaterOptions {
  readonly currentVersion: string;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly portableExecutableFile: string | undefined;
  readonly appImageFile: string | undefined;
  readonly linuxPackageType: string | undefined;
  readonly backend?: ApplicationUpdateBackend;
  readonly certificateTrust?: UpdateCertificateTrust;
  readonly random?: () => number;
  readonly firstCheckMinimumDelayMs?: number;
  readonly firstCheckJitterMs?: number;
  readonly periodicCheckMinimumDelayMs?: number;
  readonly periodicCheckJitterMs?: number;
}

export class ApplicationUpdater {
  readonly #backend: ApplicationUpdateBackend | undefined;
  readonly #certificateTrust: UpdateCertificateTrust | undefined;
  readonly #random: () => number;
  readonly #firstCheckMinimumDelayMs: number;
  readonly #firstCheckJitterMs: number;
  readonly #periodicCheckMinimumDelayMs: number;
  readonly #periodicCheckJitterMs: number;
  readonly #listeners = new Set<(state: ApplicationUpdateState) => void>();
  #state: ApplicationUpdateState;
  #availableVersion: string | undefined;
  #unsubscribeBackend: (() => void) | undefined;
  #scheduledCheck: ReturnType<typeof setTimeout> | undefined;
  #checkPromise: Promise<OperationResult<ApplicationUpdateState>> | undefined;
  #foregroundRetryPromise: Promise<OperationResult<ApplicationUpdateState>> | undefined;
  #checkIsManual = false;
  #installRequested = false;
  #started = false;
  #disposed = false;

  constructor(options: CreateApplicationUpdaterOptions) {
    this.#certificateTrust = options.certificateTrust;
    this.#random = options.random ?? Math.random;
    this.#firstCheckMinimumDelayMs = options.firstCheckMinimumDelayMs ?? FIRST_CHECK_MINIMUM_DELAY_MS;
    this.#firstCheckJitterMs = options.firstCheckJitterMs ?? FIRST_CHECK_JITTER_MS;
    this.#periodicCheckMinimumDelayMs = options.periodicCheckMinimumDelayMs ?? PERIODIC_CHECK_MINIMUM_DELAY_MS;
    this.#periodicCheckJitterMs = options.periodicCheckJitterMs ?? PERIODIC_CHECK_JITTER_MS;

    const disabledReason = applicationUpdateDisabledReason(options);
    if (disabledReason) {
      this.#state = initialApplicationUpdateDisabled(options.currentVersion, disabledReason);
      this.#backend = undefined;
      return;
    }

    this.#state = initialApplicationUpdateIdle(options.currentVersion);
    this.#backend = options.backend ?? new ElectronApplicationUpdateBackend(
      electronUpdater.autoUpdater,
      options.currentVersion,
    );
    this.#backend.configure();
    this.#unsubscribeBackend = this.#backend.subscribe({
      checking: () => {
        if (this.#state.status !== "checking") this.#transition({ status: "checking" });
      },
      available: (version) => this.#setAvailable(version),
      notAvailable: () => {
        this.#availableVersion = undefined;
        this.#transition({ status: "up-to-date" });
      },
      progress: (percent) => this.#setProgress(percent),
      downloaded: (version) => this.#setReady(version),
      cancelled: () => this.#setError(UPDATE_CHECK_ERROR),
      error: () => this.#setError(this.#installRequested ? UPDATE_INSTALL_ERROR : UPDATE_CHECK_ERROR),
    });
  }

  getState(): ApplicationUpdateState {
    return this.#state;
  }

  subscribe(listener: (state: ApplicationUpdateState) => void): () => void {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    if (this.#started || this.#disposed || !this.#backend) return;
    this.#started = true;
    this.#scheduleNextCheck(this.#firstCheckMinimumDelayMs, this.#firstCheckJitterMs);
  }

  checkForUpdates(manual = true): Promise<OperationResult<ApplicationUpdateState>> {
    if (this.#state.status === "disabled") {
      // Disabled updaters have no automatic checks, so publishing the current
      // state here represents an explicit user-requested check. Renderers keep
      // the initial snapshot silent and surface only this manual result.
      this.#publish();
      return Promise.resolve({ ok: false, error: this.#state.disabledReason });
    }
    if (this.#disposed || !this.#backend) {
      return Promise.resolve({ ok: false, error: "Application updates are unavailable." });
    }
    if (
      this.#state.status === "available" ||
      this.#state.status === "downloading" ||
      this.#state.status === "ready"
    ) {
      return Promise.resolve({ ok: true, value: this.#state });
    }
    if (this.#checkPromise) {
      if (!manual || this.#checkIsManual) return this.#checkPromise;
      // A background probe cannot open an authorization panel. Preserve a
      // foreground request arriving during that probe, and coalesce callers
      // into one retry after a trust-required result.
      this.#foregroundRetryPromise ??= this.#checkPromise.then((result) => {
        if (result.ok && result.value?.status === "trust-required") return this.checkForUpdates(true);
        return result;
      }).finally(() => {
        this.#foregroundRetryPromise = undefined;
      });
      return this.#foregroundRetryPromise;
    }

    if (manual || this.#state.status !== "trust-required") this.#transition({ status: "checking" });
    this.#checkIsManual = manual;
    this.#checkPromise = this.#performCheck(this.#backend, manual)
      .catch((): OperationResult<ApplicationUpdateState> => {
        if (!this.#disposed && this.#state.status !== "error") this.#setError(UPDATE_CHECK_ERROR);
        return { ok: false, error: UPDATE_CHECK_ERROR };
      })
      .finally(() => {
        this.#checkPromise = undefined;
      });
    return this.#checkPromise;
  }

  async #performCheck(
    backend: ApplicationUpdateBackend,
    manual: boolean,
  ): Promise<OperationResult<ApplicationUpdateState>> {
    if (this.#certificateTrust) {
      try {
        await this.#certificateTrust.ensureTrusted(manual);
      } catch (error) {
        if (this.#disposed) return { ok: false, error: "Application updates are unavailable." };
        if (!(error instanceof UpdateCertificateTrustRequiredError)) throw error;
        if (this.#state.status !== "trust-required") {
          this.#transition({ status: "trust-required", message: UPDATE_TRUST_REQUIRED });
        }
        return { ok: true, value: this.#state };
      }
    }
    if (this.#disposed) return { ok: false, error: "Application updates are unavailable." };
    if (this.#state.status !== "checking") this.#transition({ status: "checking" });
    // electron-updater downloads automatically once it finds an update, so
    // certificate trust must be established before contacting the backend.
    const result = await backend.checkForUpdates();
    if (this.#disposed) return { ok: false, error: "Application updates are unavailable." };
    if (result === null) {
      this.#setError(UPDATE_CHECK_ERROR);
      return { ok: false, error: UPDATE_CHECK_ERROR };
    }
    if (this.#state.status === "checking") {
      if (result.isUpdateAvailable) this.#setAvailable(result.version);
      else {
        this.#availableVersion = undefined;
        this.#transition({ status: "up-to-date" });
      }
    }
    if (this.#state.status === "error") return { ok: false, error: this.#state.error };
    return { ok: true, value: this.#state };
  }

  restartToApply(): OperationResult {
    if (this.#installRequested) return { ok: true };
    if (this.#state.status !== "ready" || !this.#backend || this.#disposed) {
      return { ok: false, error: "An application update is not ready to install." };
    }
    try {
      this.#installRequested = true;
      this.#backend.quitAndInstall();
      const stateAfterInstallRequest = this.getState();
      if (stateAfterInstallRequest.status === "error") {
        return { ok: false, error: stateAfterInstallRequest.error };
      }
      return { ok: true };
    } catch {
      this.#installRequested = false;
      if (!this.#disposed) this.#setError(UPDATE_INSTALL_ERROR);
      return { ok: false, error: UPDATE_INSTALL_ERROR };
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#scheduledCheck) clearTimeout(this.#scheduledCheck);
    this.#scheduledCheck = undefined;
    this.#unsubscribeBackend?.();
    this.#unsubscribeBackend = undefined;
    this.#listeners.clear();
  }

  #scheduleNextCheck(minimumDelayMs: number, jitterMs: number): void {
    if (this.#disposed || !this.#backend) return;
    const randomValue = Math.min(1, Math.max(0, this.#random()));
    const delay = minimumDelayMs + Math.floor(randomValue * jitterMs);
    this.#scheduledCheck = setTimeout(() => {
      this.#scheduledCheck = undefined;
      void this.checkForUpdates(false).finally(() => {
        this.#scheduleNextCheck(this.#periodicCheckMinimumDelayMs, this.#periodicCheckJitterMs);
      });
    }, delay);
    this.#scheduledCheck.unref?.();
  }

  #setAvailable(version: string): void {
    if (!this.#isValidAvailableVersion(version)) return;
    this.#availableVersion = version;
    this.#transition({ status: "available", availableVersion: version });
  }

  #setProgress(percent: number): void {
    if (!this.#availableVersion || !Number.isFinite(percent)) return;
    const progressPercent = Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10;
    if (
      this.#state.status === "downloading" &&
      this.#state.availableVersion === this.#availableVersion &&
      this.#state.progressPercent === progressPercent
    ) return;
    this.#transition({
      status: "downloading",
      availableVersion: this.#availableVersion,
      progressPercent,
    });
  }

  #setReady(version: string): void {
    if (!this.#isValidAvailableVersion(version)) return;
    this.#availableVersion = version;
    this.#transition({ status: "ready", availableVersion: version });
  }

  #isValidAvailableVersion(version: string): boolean {
    try {
      parseApplicationUpdateState({
        status: "available",
        revision: this.#state.revision + 1,
        currentVersion: this.#state.currentVersion,
        availableVersion: version,
      });
      return true;
    } catch {
      this.#setError(UPDATE_CHECK_ERROR);
      return false;
    }
  }

  #setError(error: string): void {
    this.#installRequested = false;
    this.#availableVersion = undefined;
    this.#transition({ status: "error", error });
  }

  #transition(fields: Readonly<Record<string, unknown>>): void {
    if (this.#disposed) return;
    this.#state = parseApplicationUpdateState({
      ...fields,
      revision: this.#state.revision + 1,
      currentVersion: this.#state.currentVersion,
    });
    this.#publish();
  }

  #publish(): void {
    for (const listener of this.#listeners) {
      try {
        listener(this.#state);
      } catch {
        // A presentation listener must not corrupt updater state or turn a
        // successful backend check into a failed update operation.
      }
    }
  }
}

export function createApplicationUpdater(options: CreateApplicationUpdaterOptions): ApplicationUpdater {
  return new ApplicationUpdater(options);
}

export function applicationUpdateDisabledReason(
  options: Pick<
    CreateApplicationUpdaterOptions,
    "isPackaged" | "platform" | "portableExecutableFile" | "appImageFile" | "linuxPackageType"
  >,
): string | undefined {
  if (!options.isPackaged) return "Automatic updates are available in packaged builds.";
  if (options.platform !== "darwin" && options.platform !== "win32" && options.platform !== "linux") {
    return "Automatic updates are not available on this platform.";
  }
  if (options.platform === "win32" && options.portableExecutableFile) {
    return "Portable builds do not update automatically. Install the Windows Setup build to enable updates.";
  }
  if (options.platform === "linux" && options.linuxPackageType === "deb") {
    return "Debian packages require a manually verified update. Use the AppImage build for automatic updates.";
  }
  if (options.platform === "linux" && !options.appImageFile) {
    return "Automatic Linux updates are available from the AppImage build.";
  }
  return undefined;
}

export function installDownloadedApplicationUpdate(
  updater: Pick<AppUpdater, "quitAndInstall">,
): void {
  // The renderer has already collected explicit confirmation, so avoid a
  // second installer prompt and always relaunch into the newly installed app.
  updater.quitAndInstall(true, true);
}

export function configureApplicationUpdateBackend(
  updater: Pick<
    AppUpdater,
    | "autoDownload"
    | "autoInstallOnAppQuit"
    | "autoRunAppAfterInstall"
    | "allowPrerelease"
    | "allowDowngrade"
    | "disableWebInstaller"
  >,
  currentVersion: string,
): void {
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.autoRunAppAfterInstall = true;
  // A signed prerelease build follows prereleases from its configured feed;
  // stable production builds never opt into them. This lets the private E2E
  // channel remain a GitHub prerelease without introducing a runtime override.
  updater.allowPrerelease = currentVersion.includes("-");
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
}

class ElectronApplicationUpdateBackend implements ApplicationUpdateBackend {
  readonly #updater: AppUpdater;
  readonly #currentVersion: string;

  constructor(updater: AppUpdater, currentVersion: string) {
    this.#updater = updater;
    this.#currentVersion = currentVersion;
  }

  configure(): void {
    configureApplicationUpdateBackend(this.#updater, this.#currentVersion);
  }

  subscribe(events: ApplicationUpdateBackendEvents): () => void {
    const checking = (): void => events.checking();
    const available = (info: UpdateInfo): void => events.available(info.version);
    const notAvailable = (_info: UpdateInfo): void => events.notAvailable();
    const progress = (info: ProgressInfo): void => events.progress(info.percent);
    const downloaded = (info: UpdateDownloadedEvent): void => events.downloaded(info.version);
    const cancelled = (_info: UpdateInfo): void => events.cancelled();
    const error = (_error: Error): void => events.error();
    this.#updater.on("checking-for-update", checking);
    this.#updater.on("update-available", available);
    this.#updater.on("update-not-available", notAvailable);
    this.#updater.on("download-progress", progress);
    this.#updater.on("update-downloaded", downloaded);
    this.#updater.on("update-cancelled", cancelled);
    this.#updater.on("error", error);
    return () => {
      this.#updater.removeListener("checking-for-update", checking);
      this.#updater.removeListener("update-available", available);
      this.#updater.removeListener("update-not-available", notAvailable);
      this.#updater.removeListener("download-progress", progress);
      this.#updater.removeListener("update-downloaded", downloaded);
      this.#updater.removeListener("update-cancelled", cancelled);
      this.#updater.removeListener("error", error);
    };
  }

  async checkForUpdates(): Promise<ApplicationUpdateCheckResult | null> {
    const result: UpdateCheckResult | null = await this.#updater.checkForUpdates();
    if (!result) return null;
    return {
      isUpdateAvailable: result.isUpdateAvailable,
      version: result.updateInfo.version,
    };
  }

  quitAndInstall(): void {
    installDownloadedApplicationUpdate(this.#updater);
  }
}
