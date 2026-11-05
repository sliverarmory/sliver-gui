import { join } from "node:path";

import { cleanupOwnedApplication, type OwnedApplicationForCleanup } from "./packaged-application-update-support.js";

export function packagedMtlsLaunchOptions(
  repositoryRoot: string,
  isolatedHome: string,
  userDataDirectory: string,
  platform: NodeJS.Platform,
  inherited: NodeJS.ProcessEnv = process.env,
): { args: string[]; bypassCSP: false; chromiumSandbox: true; cwd: string; env: Record<string, string> } {
  const cleanEnvironment = Object.fromEntries(
    Object.entries(inherited).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return {
    args: [
      "--enable-sandbox",
      // The isolated HOME has no login keychain. Avoid interactive profile-encryption prompts.
      ...(platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : []),
      `--user-data-dir=${userDataDirectory}`,
    ],
    bypassCSP: false,
    chromiumSandbox: true,
    cwd: repositoryRoot,
    env: {
      ...cleanEnvironment,
      HOME: isolatedHome,
      ...(platform === "darwin" ? { CFFIXED_USER_HOME: isolatedHome } : {}),
      USERPROFILE: isolatedHome,
      XDG_CONFIG_HOME: join(isolatedHome, ".config"),
      // A packaged application must ignore this development-only redirect.
      ELECTRON_RENDERER_URL: "http://127.0.0.1:65535/",
    },
  };
}

export function abortPackagedApplicationOnSignal(
  signal: AbortSignal,
  child: Pick<ReturnType<OwnedApplicationForCleanup["process"]>, "exitCode" | "signalCode" | "kill">,
): () => void {
  const abort = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

export function createPackagedMtlsCleanup(resources: {
  application(): OwnedApplicationForCleanup | undefined;
  closeFixture(): Promise<void>;
  removeTemporaryRoot(): Promise<void>;
  detachAbortListener(): void;
}, platform: NodeJS.Platform = process.platform): () => Promise<void> {
  // Windows can retain the browser inspector socket after the shell process exits.
  // Allow both bounded phases to finish while still requiring Playwright close to settle.
  const applicationCleanupTimeoutMs = platform === "win32" ? 10_000 : 5_000;
  let cleanupPromise: Promise<void> | undefined;
  return () => {
    cleanupPromise ??= (async () => {
      const failures: unknown[] = [];
      try {
        const application = resources.application();
        if (application) {
          await cleanupOwnedApplication(application, "packaged mTLS", applicationCleanupTimeoutMs).catch((error) => failures.push(error));
        }
        await resources.closeFixture().catch((error) => failures.push(error));
        await resources.removeTemporaryRoot().catch((error) => failures.push(error));
      } finally {
        resources.detachAbortListener();
      }
      if (failures.length > 0) throw new AggregateError(failures, "Packaged mTLS E2E cleanup failed");
    })();
    return cleanupPromise;
  };
}

export async function shutdownMtlsFixture(server: {
  shutdown(): Promise<void>;
  forceShutdown(): void;
}, timeoutMs = 5_000): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const graceful = Promise.resolve().then(() => server.shutdown()).then(() => true, () => false);
  const completedGracefully = await Promise.race([
    graceful,
    new Promise<boolean>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(false), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (!completedGracefully) server.forceShutdown();
}
