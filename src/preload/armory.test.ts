// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../shared/application-settings-contracts.js";
import {
  ARMORY_IPC_EVENTS,
  ARMORY_IPC_INVOKE,
  type ArmoryAPI,
} from "../shared/armory-contracts.js";

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(name: string, api: ArmoryAPI) => void>(),
  invoke: vi.fn(async (channel: string, ...args: unknown[]) => ({ channel, args })),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  await import("./armory.js");
});

describe("Armory preload", () => {
  it("exposes one frozen package-management API with no execution or raw transport", () => {
    const api = exposedApi();
    expect(electronMocks.exposeInMainWorld).toHaveBeenCalledExactlyOnceWith("armory", api);
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api)).toEqual([
      "getContext", "snapshot", "refreshCatalog", "install", "installBundle", "uninstall", "saveSource",
      "removeSource", "installLocal", "getApplicationSettings", "onChanged", "onNavigationRequested", "onApplicationSettingsChanged",
    ]);
    for (const key of ["ipcRenderer", "invoke", "send", "rpc", "execute", "session", "beacon", "readFile", "writeFile"]) {
      expect(api).not.toHaveProperty(key);
    }
  });

  it("maps package operations to fixed channels without adding local filesystem paths", async () => {
    const api = exposedApi();
    const install = { packageId: "package", replace: false };
    const bundle = { bundleId: "bundle", replace: true };
    const uninstall = { installedId: "installed" };
    const source = { name: "Example", repoUrl: "https://example.test/index", publicKey: "key", enabled: true };
    const remove = { sourceId: "source" };
    const local = { publicKey: "key" };
    await api.getContext();
    await api.snapshot();
    await api.refreshCatalog();
    await api.install(install);
    await api.installBundle(bundle);
    await api.uninstall(uninstall);
    await api.saveSource(source);
    await api.removeSource(remove);
    await api.installLocal(local);
    await api.getApplicationSettings();
    expect(electronMocks.invoke.mock.calls).toEqual([
      [ARMORY_IPC_INVOKE.getContext], [ARMORY_IPC_INVOKE.snapshot], [ARMORY_IPC_INVOKE.refreshCatalog],
      [ARMORY_IPC_INVOKE.install, install], [ARMORY_IPC_INVOKE.installBundle, bundle], [ARMORY_IPC_INVOKE.uninstall, uninstall],
      [ARMORY_IPC_INVOKE.saveSource, source], [ARMORY_IPC_INVOKE.removeSource, remove],
      [ARMORY_IPC_INVOKE.installLocal, local], [ARMORY_IPC_INVOKE.getApplicationSettings],
    ]);
  });

  it("buffers the latest valid native tab until React subscribes", async () => {
    const navigate = eventHandler(ARMORY_IPC_EVENTS.navigationRequested);
    navigate({}, "manage");
    navigate({}, "install");
    navigate({}, "sessions");
    navigate({}, "sources", "extra");
    const listener = vi.fn();
    const unsubscribe = exposedApi().onNavigationRequested(listener);
    expect(listener).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledExactlyOnceWith("install");
    navigate({}, "sources");
    expect(listener).toHaveBeenLastCalledWith("sources");
    unsubscribe();
    navigate({}, "manage");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not replay stale navigation after unsubscribe or a newer navigation event", async () => {
    const navigate = eventHandler(ARMORY_IPC_EVENTS.navigationRequested);
    navigate({}, "install");
    const canceled = vi.fn();
    exposedApi().onNavigationRequested(canceled)();
    await Promise.resolve();
    expect(canceled).not.toHaveBeenCalled();
    const active = vi.fn();
    exposedApi().onNavigationRequested(active);
    navigate({}, "sources");
    await Promise.resolve();
    expect(active).toHaveBeenCalledExactlyOnceWith("sources");
  });

  it("does not replay consumed native navigation to later subscribers", async () => {
    eventHandler(ARMORY_IPC_EVENTS.navigationRequested)({}, "install");
    const first = vi.fn();
    exposedApi().onNavigationRequested(first);
    await Promise.resolve();
    const second = vi.fn();
    exposedApi().onNavigationRequested(second);
    await Promise.resolve();
    expect(first).toHaveBeenCalledExactlyOnceWith("install");
    expect(second).not.toHaveBeenCalled();
  });

  it("owns and removes subscriptions without exposing Electron events", () => {
    const change = vi.fn();
    const unsubscribeChange = exposedApi().onChanged(change);
    const changed = eventHandler(ARMORY_IPC_EVENTS.changed);
    changed({ secret: "event" }, "untrusted-payload");
    expect(change).toHaveBeenCalledExactlyOnceWith();
    unsubscribeChange();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(ARMORY_IPC_EVENTS.changed, changed);

    const settings = vi.fn();
    const unsubscribeSettings = exposedApi().onApplicationSettingsChanged(settings);
    const settingsChanged = eventHandler("sliver:application-settings:changed");
    settingsChanged({}, null);
    settingsChanged({}, "invalid");
    settingsChanged({}, DEFAULT_APPLICATION_SETTINGS_STATE, "extra");
    expect(settings).not.toHaveBeenCalled();
    settingsChanged({ secret: "event" }, DEFAULT_APPLICATION_SETTINGS_STATE);
    expect(settings).toHaveBeenCalledExactlyOnceWith(DEFAULT_APPLICATION_SETTINGS_STATE);
    unsubscribeSettings();
    expect(electronMocks.removeListener).toHaveBeenCalledWith("sliver:application-settings:changed", settingsChanged);
  });

  it("rejects non-function subscription arguments", () => {
    const api = exposedApi();
    for (const subscribe of [api.onChanged, api.onNavigationRequested, api.onApplicationSettingsChanged]) {
      expect(() => (subscribe as (listener: unknown) => unknown)(null)).toThrow(TypeError);
    }
  });
});

function exposedApi(): ArmoryAPI {
  const match = electronMocks.exposeInMainWorld.mock.calls.find(([name]) => name === "armory");
  if (!match?.[1]) throw new Error("Armory API was not exposed");
  return match[1];
}

function eventHandler(channel: string): (event: unknown, ...payload: unknown[]) => void {
  const match = electronMocks.on.mock.calls.find(([registered]) => registered === channel);
  if (typeof match?.[1] !== "function") throw new Error(`Missing event handler ${channel}`);
  return match[1] as (event: unknown, ...payload: unknown[]) => void;
}
