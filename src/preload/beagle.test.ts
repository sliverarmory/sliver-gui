// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { BEAGLE_IPC_EVENTS, BEAGLE_IPC_INVOKE, type BeagleAPI } from "../shared/beagle-contracts.js";

const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener } }));

describe("Beagle sandbox bridge", () => {
  it("exposes only frozen typed operations and mirrors the main channel contract", async () => {
    await import("./beagle.js");
    const api = mocks.expose.mock.calls.find(([name]) => name === "beagle")?.[1] as BeagleAPI;
    expect(api).toBeDefined();
    expect(Object.isFrozen(api)).toBe(true);
    expect(mocks.expose.mock.calls.map(([name]) => name)).toEqual(["beagle", "applicationContextMenu"]);
    for (const [method, channel] of Object.entries(BEAGLE_IPC_INVOKE)) {
      mocks.invoke.mockClear();
      const invoke = api[method as keyof BeagleAPI] as (...args: unknown[]) => unknown;
      invoke({ example: true });
      expect(mocks.invoke.mock.calls[0]?.[0]).toBe(channel);
    }
    const listener = vi.fn();
    const off = api.onApplicationSettingsChanged(listener);
    const [channel, handler] = mocks.on.mock.calls.at(-1)!;
    handler({}, null);
    expect(listener).not.toHaveBeenCalled();
    off();
    expect(mocks.removeListener).toHaveBeenCalledWith(channel, handler);
    const imported = vi.fn();
    const stopImported = api.onCollectionImported(imported);
    const [importChannel, importHandler] = mocks.on.mock.calls.at(-1)!;
    expect(importChannel).toBe(BEAGLE_IPC_EVENTS.collectionImported);
    importHandler({}, "unexpected data");
    expect(imported).not.toHaveBeenCalled();
    importHandler({});
    expect(imported).toHaveBeenCalledOnce();
    stopImported();
    expect(mocks.removeListener).toHaveBeenCalledWith(importChannel, importHandler);
  });
});
