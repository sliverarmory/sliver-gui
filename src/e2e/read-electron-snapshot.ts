import { setTimeout as delay } from "node:timers/promises";

/** Retry only side-effect-free snapshots when Electron loses the inspector reply. */
export async function readElectronSnapshot<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      // Playwright can lose its internal evaluation promise even for synchronous
      // reads: https://github.com/microsoft/playwright/issues/33737.
      // Do not retry other errors or use this around actions: their effects may
      // already have happened before the inspector loses the response.
      if (
        attempt >= 3 ||
        !(error instanceof Error) ||
        !error.message.endsWith("Resulting promise was garbage collected.")
      ) throw error;
      console.warn(`Retrying Electron snapshot after inspector garbage collection (${attempt}/2)`);
      await delay(50);
    }
  }
}
