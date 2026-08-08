// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { IPC, type SliverDesktopAPI } from "../shared/contracts.js";

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn((channel: string, ...args: unknown[]) => ({ channel, args })),
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

await import("./index.js");

describe("sandboxed preload bridge", () => {
  it("exposes frozen saved-config methods using only their dedicated IPC channels", async () => {
    expect(electronMocks.exposeInMainWorld).toHaveBeenCalledOnce();
    const [name, exposed] = electronMocks.exposeInMainWorld.mock.calls[0] as [string, SliverDesktopAPI];
    expect(name).toBe("sliver");
    expect(Object.isFrozen(exposed)).toBe(true);

    await exposed.listSavedConfigs();
    await exposed.connectSavedConfig("3f3bfca3-b80a-4cf2-b7e2-a2d86e5a01b2");

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, IPC.listSavedConfigs);
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      2,
      IPC.connectSavedConfig,
      "3f3bfca3-b80a-4cf2-b7e2-a2d86e5a01b2",
    );
  });
});
