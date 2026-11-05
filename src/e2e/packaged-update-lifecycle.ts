import {
  attachCleanupFailure,
  cleanupOwnedApplication,
  observePromiseSettlement,
  type ObservedPromiseSettlement,
  type OwnedApplicationForCleanup,
} from "./packaged-application-update-support.js";

/** Prove the native update before waiting for Playwright's inherited transport. */
export async function completeNativeUpdateTransition<T>(options: {
  readonly observeClose: () => Promise<unknown>;
  readonly requestUpdate: () => Promise<void>;
  readonly waitForOriginalExit: () => Promise<void>;
  readonly waitForUpdatedExecutable: () => Promise<string>;
  readonly updatedExecutable: (path: string) => void;
  readonly waitForRelaunch: (path: string) => Promise<T>;
  readonly trackRelaunch: (process: T | undefined) => void;
  readonly terminateRelaunch: (process: T, path: string) => Promise<void>;
  readonly proveProcessAbsence: () => Promise<void>;
  readonly closeTimeoutMs: number;
}): Promise<string> {
  const oldApplicationClose = observePromiseSettlement(options.observeClose());
  await options.requestUpdate();
  await options.waitForOriginalExit();
  const executable = await options.waitForUpdatedExecutable();
  options.updatedExecutable(executable);
  const relaunch = await options.waitForRelaunch(executable);
  options.trackRelaunch(relaunch);
  await options.terminateRelaunch(relaunch, executable);
  await options.proveProcessAbsence();
  options.trackRelaunch(undefined);
  await requireObservedApplicationClose(oldApplicationClose, options.closeTimeoutMs);
  return executable;
}

export async function requireObservedApplicationClose(
  observation: Promise<ObservedPromiseSettlement<unknown>>,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for the controlled Playwright application connection to close"));
    }, timeoutMs);
    timeout.unref?.();
  });
  try {
    const outcome = await Promise.race([observation, timeoutResult]);
    if (outcome.status === "rejected") {
      throw new Error(`Controlled Playwright application close failed: ${errorMessage(outcome.reason)}`);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function finishPackagedUpdateLaunch<T>(
  application: OwnedApplicationForCleanup,
  initialize: () => Promise<T>,
  cleanupTimeoutMs: number,
  report: (message: string, detail: string) => void = console.error,
): Promise<T> {
  try {
    return await initialize();
  } catch (error) {
    await cleanupOwnedApplication(application, "partially launched", cleanupTimeoutMs).catch((cleanupError) => {
      report("Failed to clean a partially launched application", errorMessage(cleanupError));
      attachCleanupFailure(error, cleanupError);
    });
    throw error;
  }
}

export async function cleanupPackagedUpdate<T>(options: {
  readonly forcedRelaunch: T | undefined;
  readonly terminateRelaunch: (process: T) => Promise<void>;
  readonly applications: readonly (readonly [string, OwnedApplicationForCleanup | undefined])[];
  readonly cleanupTimeoutMs: number;
  readonly terminateRemaining: () => Promise<void>;
  readonly removeTemporaryRoot: () => Promise<void>;
  readonly testFailed: boolean;
  readonly testFailure: unknown;
  readonly report?: (message: string, detail?: string) => void;
}): Promise<void> {
  const report = options.report ?? console.error;
  const cleanupFailures: unknown[] = [];
  // The native relaunch may hold Playwright's inherited transport descriptor.
  if (options.forcedRelaunch) {
    await options.terminateRelaunch(options.forcedRelaunch).catch((error) => {
      report("Failed to terminate the tracked updater relaunch", errorMessage(error));
    });
  }
  for (const [label, application] of options.applications) {
    if (!application) continue;
    await cleanupOwnedApplication(application, label, options.cleanupTimeoutMs).catch((error) => {
      cleanupFailures.push(error);
      report(`Failed to close the controlled ${label} application`, errorMessage(error));
    });
  }
  let processAbsenceProved = false;
  await options.terminateRemaining().then(() => {
    processAbsenceProved = true;
  }).catch((error) => {
    cleanupFailures.push(error);
    report("Failed to terminate every packaged updater application process", errorMessage(error));
  });
  if (!processAbsenceProved) {
    report("Retaining the packaged updater temporary directory because process absence was not proved");
  } else {
    await options.removeTemporaryRoot().catch((error: NodeJS.ErrnoException) => {
      cleanupFailures.push(error);
      report("Failed to clean the packaged updater temporary directory", error.code ?? "unknown");
    });
  }
  if (cleanupFailures.length > 0) {
    const cleanupError = new AggregateError(cleanupFailures, "Packaged updater E2E cleanup failed");
    if (options.testFailed) attachCleanupFailure(options.testFailure, cleanupError);
    else throw cleanupError;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
