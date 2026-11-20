// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APPLICATION_SETTINGS_STATE, type ApplicationSettingsState } from "../shared/application-settings-contracts.js";
import { deferred } from "../tests/renderer-test-helpers.js";
import { waitForOverviewSettings } from "./overview-settings-support.js";

const expected = {
  kinds: ["beacon"], statuses: ["inactive"], lightning: true,
  sidebarDisabled: true, presentation: "list",
} as const;
const saved = { ...DEFAULT_APPLICATION_SETTINGS_STATE, overview: expected };

function settingsApi(initial = DEFAULT_APPLICATION_SETTINGS_STATE) {
  let listener!: (state: ApplicationSettingsState) => void;
  const unsubscribe = vi.fn();
  const getApplicationSettings = vi.fn(async () => initial);
  const onApplicationSettingsChanged = vi.fn((next: typeof listener) => {
    listener = next;
    return unsubscribe;
  });
  vi.stubGlobal("sliver", { getApplicationSettings, onApplicationSettingsChanged });
  return { getApplicationSettings, unsubscribe, emit: (state: ApplicationSettingsState) => listener(state) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Overview persistence wait", () => {
  it("waits through stale and partial settings until the final queued save is acknowledged", async () => {
    vi.useFakeTimers();
    const api = settingsApi();
    let finished = false;
    const waiting = waitForOverviewSettings({ overview: expected }).then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    api.emit({ ...saved, overview: { ...expected, sidebarDisabled: false, presentation: "graph" } });
    await Promise.resolve();
    expect(finished).toBe(false);
    api.emit(saved);
    await waiting;
    expect(finished).toBe(true);
    expect(api.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolved", "rejected"] as const)("keeps a target event settled when the initial read later %s", async (outcome) => {
    vi.useFakeTimers();
    const api = settingsApi();
    const initial = deferred<ApplicationSettingsState>();
    api.getApplicationSettings.mockReturnValueOnce(initial.promise);
    const waiting = waitForOverviewSettings({ overview: expected });
    api.emit(saved);
    await waiting;

    if (outcome === "resolved") initial.resolve(saved);
    else initial.reject(new Error("Late read failure"));
    await Promise.resolve();
    expect(api.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts settings that were saved before subscribing", async () => {
    vi.useFakeTimers();
    const api = settingsApi(saved);
    await waitForOverviewSettings({ overview: expected });
    expect(api.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects missing persistence at the deadline and removes its subscription", async () => {
    vi.useFakeTimers();
    const api = settingsApi();
    const result = expect(waitForOverviewSettings({ overview: expected })).rejects.toThrow("Timed out waiting for Overview settings to be saved");
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(api.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates a failed settings read and removes its subscription", async () => {
    vi.useFakeTimers();
    const api = settingsApi();
    api.getApplicationSettings.mockRejectedValueOnce(new Error("Settings unavailable"));
    await expect(waitForOverviewSettings({ overview: expected })).rejects.toThrow("Settings unavailable");
    expect(api.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
