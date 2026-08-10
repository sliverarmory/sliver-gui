// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  IPC,
  IPC_INVOKE,
  type IpcInvokeArgs,
  type SliverDesktopAPI,
} from "../shared/contracts.js";
import { defaultGenerateInput } from "../shared/generate-defaults.js";

type InvokeArgumentsByMethod = {
  [Method in keyof typeof IPC_INVOKE]: IpcInvokeArgs<(typeof IPC_INVOKE)[Method]>;
};

const invokeArguments = {
  chooseConfig: [],
  importConfig: [{ displayName: "local test" }],
  listSavedConfigs: [],
  connectSavedConfig: ["3f3bfca3-b80a-4cf2-b7e2-a2d86e5a01b2"],
  removeSavedConfig: [{ id: "3f3bfca3-b80a-4cf2-b7e2-a2d86e5a01b2" }],
  disconnect: [],
  getSnapshot: [],
  refresh: [],
  openWindow: [{ inheritConnection: true }],
  chooseCertificatePair: [],
  startListener: [{ kind: "mtls", host: "127.0.0.1", port: 8888 }],
  prepareStopJob: [7],
  prepareStopAllJobs: [],
  executeStopPlan: ["8e577480-5dc2-4dde-aa58-23c8f1770627"],
  generate: [defaultGenerateInput],
  generateFromProfile: [{ profileName: "default", name: "test" }],
  downloadBuild: ["existing-build"],
  deleteBuild: ["existing-build"],
  setStagedBuilds: [["existing-build"]],
  saveProfile: [{ profileName: "default", config: defaultGenerateInput, overwrite: false }],
  deleteProfile: ["default"],
  listTargets: [{ mode: "session", limit: 100, query: "prod-mac" }],
  selectTarget: [{
    mode: "session",
    id: "session_1",
    backendEpoch: 1,
    domainRevision: 1,
    fingerprint: "a".repeat(64),
  }],
  backgroundTarget: [],
  setBeaconWatch: [{ enabled: true }],
  submitTargetOperation: [{ operationId: "target.ping" }],
  listTargetOperations: [{}],
  getTargetOperation: [{ requestId: "request_1" }],
  cancelTargetOperation: [{ requestId: "request_1" }],
  prepareTargetAction: [{ actionId: "target.kill" }],
  executeTargetActionPlan: [{ token: "8e577480-5dc2-4dde-aa58-23c8f1770627" }],
  listBeaconTasks: [{}],
  getBeaconTask: [{ taskId: "task_1" }],
  cancelBeaconTask: [{ taskId: "task_1" }],
} satisfies InvokeArgumentsByMethod;

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(name: string, api: SliverDesktopAPI) => void>(),
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
    const call = electronMocks.exposeInMainWorld.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error("Expected the preload API to be exposed");
    const [name, exposed] = call;
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

  it("routes every invoke method through its same-named shared channel", async () => {
    const call = electronMocks.exposeInMainWorld.mock.calls[0];
    if (!call) throw new Error("Expected the preload API to be exposed");
    const [, exposed] = call;

    expect(Object.keys(exposed).sort()).toEqual([
      ...Object.keys(IPC_INVOKE),
      "onSnapshotChanged",
      "onOperationChanged",
      "onBeaconTasksInvalidated",
    ].sort());
    for (const method of Object.keys(IPC_INVOKE) as Array<keyof typeof IPC_INVOKE>) {
      electronMocks.invoke.mockClear();
      const args: readonly unknown[] = invokeArguments[method];
      await Reflect.apply(exposed[method], exposed, args);
      expect(electronMocks.invoke).toHaveBeenCalledExactlyOnceWith(IPC_INVOKE[method], ...args);
    }
  });
});
