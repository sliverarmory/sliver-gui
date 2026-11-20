import type { ApplicationOverviewSettings, ApplicationSettingsState } from "../shared/application-settings-contracts.js";
import type { SliverDesktopAPI } from "../shared/contracts.js";

/** Runs in the renderer through page.evaluate and waits for main to acknowledge every queued save. */
export function waitForOverviewSettings({ overview, timeoutMs = 15_000 }: {
  readonly overview: ApplicationOverviewSettings;
  readonly timeoutMs?: number;
}): Promise<void> {
  const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
  return new Promise<void>((resolve, reject) => {
    let unsubscribe = (): void => undefined;
    let finished = false;
    const finish = (settle: () => void): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      unsubscribe();
      settle();
    };
    const accept = (state: ApplicationSettingsState): void => {
      if (JSON.stringify(state.overview) === JSON.stringify(overview)) finish(resolve);
    };
    const timeout = setTimeout(() => finish(() => reject(new Error("Timed out waiting for Overview settings to be saved"))), timeoutMs);
    // Subscribe first so a save completing during the initial read cannot be missed.
    unsubscribe = api.onApplicationSettingsChanged(accept);
    void api.getApplicationSettings().then(accept, (error) => finish(() => reject(error)));
  });
}
