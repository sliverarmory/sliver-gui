// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPLICATION_CONTEXT_MENU_IPC,
  parseApplicationContextMenuRequest,
  type ApplicationContextMenuAPI,
} from "../shared/application-context-menu-contracts.js";

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(name: string, api: unknown) => void>(),
  invoke: vi.fn(async () => true),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    send: electronMocks.send,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}));

const requestId = "00000000-0000-4000-8000-000000000001";
const actionId = "00000000-0000-4000-8000-000000000002";
const secondActionId = "00000000-0000-4000-8000-000000000003";
const policyAttribute = "data-application-context-menu-policy";
const action = { type: "action", actionId, kind: "copy", label: "Copy", enabled: true };
const menu = { v: 1, requestId, x: 7, y: 9, items: [action] };

interface TestNode {
  childNodes: TestNode[];
  parentNode: TestNode | null;
  policy: string | null;
  getAttribute(name: string): string | null;
}

describe.each([
  { name: "Armory", bridge: "armory", load: () => import("./armory.js") },
  { name: "Network", bridge: "network", load: () => import("./network.js") },
  { name: "Cloud Deployment", bridge: "cloudDeployment", load: () => import("./cloud-deployment.js") },
])("$name context-menu preload", ({ bridge, load }) => {
  const addEventListener = vi.fn();
  const observe = vi.fn();
  let notifyMutation: ((records: readonly Record<string, unknown>[]) => void) | undefined;
  let restrictedRoot: TestNode;
  let restrictedChild: TestNode;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    notifyMutation = undefined;
    restrictedRoot = node("inspect-only");
    restrictedChild = node(null, restrictedRoot);
    restrictedRoot.childNodes.push(restrictedChild);
    vi.stubGlobal("document", {
      addEventListener,
      querySelectorAll: () => [restrictedRoot],
    });
    vi.stubGlobal("MutationObserver", class {
      public constructor(callback: typeof notifyMutation) {
        notifyMutation = callback;
      }

      public observe(target: unknown, options: unknown): void {
        observe(target, options);
      }
    });
    await load();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds only the frozen context-menu capability beside its window API", () => {
    expect(electronMocks.exposeInMainWorld.mock.calls.map(([name]) => name)).toEqual([
      bridge, "applicationContextMenu",
    ]);
    const api = contextMenuApi();
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api)).toEqual(["onMenuRequested", "executeAction", "setOpen"]);
    expect(() => api.onMenuRequested(null as never)).toThrow(TypeError);
  });

  it("matches shared contract validation and strips native event authority", () => {
    const listener = vi.fn();
    const unsubscribe = contextMenuApi().onMenuRequested(listener);
    const registration = electronMocks.on.mock.calls.find(
      ([channel]) => channel === APPLICATION_CONTEXT_MENU_IPC.menuRequested,
    );
    const handler = registration?.[1] as (event: unknown, ...payload: unknown[]) => void;
    expect(handler).toBeTypeOf("function");
    const samples: unknown[] = [
      menu,
      { ...menu, items: [{ ...action, shortcut: "mod+c", variant: "default" }] },
      { ...menu, items: [action, { type: "separator" }, {
        ...action, actionId: secondActionId, kind: "inspect", label: "Inspect Element",
      }] },
      null,
      [],
      { ...menu, v: 2 },
      { ...menu, requestId: "menu" },
      { ...menu, x: -1 },
      { ...menu, y: 1.5 },
      { ...menu, x: 1_000_001 },
      { ...menu, authority: "extra" },
      { ...menu, items: [] },
      { ...menu, items: [{ type: "separator" }] },
      { ...menu, items: [{ type: "separator" }, action] },
      { ...menu, items: [action, { type: "separator" }] },
      { ...menu, items: [action, action] },
      { ...menu, items: [{ ...action, actionId: "copy" }] },
      { ...menu, items: [{ ...action, kind: "execute" }] },
      { ...menu, items: [{ ...action, label: "" }] },
      { ...menu, items: [{ ...action, label: "Copy\nall" }] },
      { ...menu, items: [{ ...action, label: "x".repeat(201) }] },
      { ...menu, items: [{ ...action, enabled: "true" }] },
      { ...menu, items: [{ ...action, shortcut: "mod+p" }] },
      { ...menu, items: [{ ...action, variant: "execute" }] },
      { ...menu, items: [{ ...action, url: "https://example.test" }] },
    ];
    for (const sample of samples) {
      listener.mockClear();
      let expected;
      try {
        expected = parseApplicationContextMenuRequest(sample);
      } catch {
        // Invalid native payloads must be dropped before reaching the renderer.
      }
      handler({ sender: "private-electron-event" }, sample);
      if (expected) {
        expect(listener).toHaveBeenCalledExactlyOnceWith(expected);
        expect(Object.isFrozen(listener.mock.calls[0]?.[0])).toBe(true);
      } else {
        expect(listener).not.toHaveBeenCalled();
      }
    }
    listener.mockClear();
    handler({});
    handler({}, menu, "extra");
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledExactlyOnceWith(
      APPLICATION_CONTEXT_MENU_IPC.menuRequested, handler,
    );
  });

  it("accepts only opaque action and request tokens on fixed channels", async () => {
    const api = contextMenuApi();
    await api.executeAction({ requestId, actionId });
    await api.setOpen({ requestId, open: true });
    await api.setOpen({ requestId, open: false });
    expect(electronMocks.invoke.mock.calls).toEqual([
      [APPLICATION_CONTEXT_MENU_IPC.executeAction, { requestId, actionId }],
      [APPLICATION_CONTEXT_MENU_IPC.setOpen, { requestId, open: true }],
      [APPLICATION_CONTEXT_MENU_IPC.setOpen, { requestId, open: false }],
    ]);
    for (const invalid of [
      null, { requestId, actionId: "copy" }, { requestId: "menu", actionId },
      { requestId, actionId, text: "clipboard data" },
    ]) {
      expect(() => api.executeAction(invalid as never)).toThrow(TypeError);
    }
    for (const invalid of [
      null, { requestId: "menu", open: true }, { requestId, open: "true" },
      { requestId, open: true, extra: true },
    ]) {
      expect(() => api.setOpen(invalid as never)).toThrow(TypeError);
    }
    expect(electronMocks.invoke).toHaveBeenCalledTimes(3);
  });

  it("keeps restricted descendants protected when moved or policy is removed", () => {
    const registration = addEventListener.mock.calls.find(([type]) => type === "contextmenu");
    expect(registration?.[2]).toBe(true);
    expect(observe).toHaveBeenCalledWith((globalThis as { document?: unknown }).document, {
      attributeFilter: [policyAttribute], attributeOldValue: true, attributes: true,
      childList: true, subtree: true,
    });
    const handler = registration?.[1] as (event: { isTrusted: boolean; target: unknown }) => void;
    const addedChild = node(null, restrictedRoot);
    notifyMutation?.([{ type: "childList", target: restrictedRoot, addedNodes: [addedChild] }]);
    const removedPolicyRoot = node(null);
    notifyMutation?.([{
      type: "attributes", target: removedPolicyRoot, attributeName: policyAttribute,
      oldValue: "inspect-only", addedNodes: [],
    }]);
    restrictedRoot.policy = null;
    restrictedChild.parentNode = node(null);
    addedChild.parentNode = null;
    for (const target of [restrictedRoot, restrictedChild, addedChild, removedPolicyRoot]) {
      handler({ isTrusted: true, target });
    }
    handler({ isTrusted: false, target: restrictedChild });
    handler({ isTrusted: true, target: node(null) });
    expect(electronMocks.send.mock.calls).toEqual(Array.from({ length: 4 }, () => [
      APPLICATION_CONTEXT_MENU_IPC.restrictedTarget,
    ]));
  });
});

function contextMenuApi(): ApplicationContextMenuAPI {
  const call = electronMocks.exposeInMainWorld.mock.calls.find(([name]) => name === "applicationContextMenu");
  if (!call) throw new Error("Expected an application context-menu bridge");
  return call[1] as ApplicationContextMenuAPI;
}

function node(policy: string | null, parentNode: TestNode | null = null): TestNode {
  return {
    childNodes: [], parentNode, policy,
    getAttribute(name): string | null {
      return name === policyAttribute ? this.policy : null;
    },
  };
}
