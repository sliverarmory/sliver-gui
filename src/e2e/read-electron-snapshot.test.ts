// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import { readElectronSnapshot } from "./read-electron-snapshot.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Electron snapshot reads", () => {
  it("returns successful snapshots without repeating the read", async () => {
    const snapshot = { writes: ["one"] };
    const read = vi.fn().mockResolvedValue(snapshot);

    await expect(readElectronSnapshot(read)).resolves.toBe(snapshot);
    expect(read).toHaveBeenCalledOnce();
  });

  it("recovers a lost inspector reply and reports the retry", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const read = vi.fn()
      .mockRejectedValueOnce(collectedPromise())
      .mockResolvedValue({ writes: ["one"] });

    await expect(readElectronSnapshot(read)).resolves.toEqual({ writes: ["one"] });
    expect(read).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledOnce();
  });

  it("bounds repeated inspector failures and preserves the final error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = collectedPromise();
    const read = vi.fn().mockRejectedValue(error);

    await expect(readElectronSnapshot(read)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each([
    new Error("Execution context was destroyed"),
    new Error("Target page, context or browser has been closed"),
    new Error("Snapshot assertion failed"),
    "Resulting promise was garbage collected.",
  ])("does not retry unrelated failures: %s", async (error) => {
    const read = vi.fn().mockRejectedValue(error);

    await expect(readElectronSnapshot(read)).rejects.toBe(error);
    expect(read).toHaveBeenCalledOnce();
  });
});

function collectedPromise(): Error {
  return new Error("electronApplication.evaluate: Resulting promise was garbage collected.");
}
