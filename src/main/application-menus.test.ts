// @vitest-environment node

import type { BrowserWindow, MenuItem, MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  buildApplicationMenuTemplate,
  commandPaletteShortcutDispositionForInput,
  consoleTabShortcutIndexForInput,
  isApplicationShortcutInput,
  isConsoleNewTabShortcutInput,
  serverRefreshShortcutDispositionForInput,
} from "./application-menus.js";
import { DEFAULT_APPLICATION_SETTINGS_VALUES } from "../shared/application-settings-contracts.js";

const shortcutInput = (overrides: Partial<Parameters<typeof consoleTabShortcutIndexForInput>[1]> = {}) => ({
  type: "keyDown",
  key: "1",
  code: "Digit1",
  isComposing: false,
  isAutoRepeat: false,
  shift: false,
  control: false,
  alt: false,
  meta: true,
  ...overrides,
});

describe("console tab shortcut input", () => {
  it("maps the macOS Command digits to positions one through ten", () => {
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput())).toBe(0);
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ key: "9", code: "Digit9" }))).toBe(8);
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ key: "0", code: "Digit0" }))).toBe(9);
  });

  it("uses Control off macOS and rejects modified or non-keydown terminal input", () => {
    const controlOne = shortcutInput({ meta: false, control: true });
    expect(consoleTabShortcutIndexForInput("win32", controlOne)).toBe(0);
    expect(consoleTabShortcutIndexForInput("linux", controlOne)).toBe(0);
    expect(consoleTabShortcutIndexForInput("darwin", controlOne)).toBeUndefined();
    expect(consoleTabShortcutIndexForInput("win32", shortcutInput())).toBeUndefined();
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ control: true }))).toBeUndefined();
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ shift: true }))).toBeUndefined();
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ alt: true }))).toBeUndefined();
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ type: "keyUp" }))).toBeUndefined();
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ isComposing: true }))).toBeUndefined();
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ key: "a", code: "KeyA" }))).toBeUndefined();
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ code: "Numpad1" }))).toBeUndefined();
  });

  it("recognizes the exact platform new-tab chord", () => {
    const commandT = shortcutInput({ key: "t", code: "KeyT" });
    const controlT = shortcutInput({ key: "t", code: "KeyT", meta: false, control: true });
    expect(isConsoleNewTabShortcutInput("darwin", commandT)).toBe(true);
    expect(isConsoleNewTabShortcutInput("win32", controlT)).toBe(true);
    expect(isConsoleNewTabShortcutInput("linux", controlT)).toBe(true);
    expect(isConsoleNewTabShortcutInput("darwin", controlT)).toBe(false);
    expect(isConsoleNewTabShortcutInput("win32", commandT)).toBe(false);
    expect(isConsoleNewTabShortcutInput("darwin", shortcutInput({ code: "KeyT", control: true }))).toBe(false);
    expect(isConsoleNewTabShortcutInput("darwin", shortcutInput({ code: "KeyT", shift: true }))).toBe(false);
    expect(isConsoleNewTabShortcutInput("darwin", shortcutInput({ code: "KeyT", alt: true }))).toBe(false);
    expect(isConsoleNewTabShortcutInput("darwin", shortcutInput({ code: "KeyT", type: "keyUp" }))).toBe(false);
    expect(isConsoleNewTabShortcutInput("darwin", shortcutInput({ code: "KeyT", isComposing: true }))).toBe(false);
    expect(isConsoleNewTabShortcutInput("darwin", shortcutInput({ code: "KeyR" }))).toBe(false);
  });
});

describe("command palette shortcut input", () => {
  it("matches the exact configured platform chord", () => {
    const commandShiftP = shortcutInput({ key: "P", code: "KeyP", shift: true });
    const controlShiftP = shortcutInput({
      key: "P",
      code: "KeyP",
      shift: true,
      meta: false,
      control: true,
    });
    expect(commandPaletteShortcutDispositionForInput("darwin", "mod+shift+p", commandShiftP))
      .toBe("request");
    expect(commandPaletteShortcutDispositionForInput("linux", "mod+shift+p", controlShiftP))
      .toBe("request");
    expect(commandPaletteShortcutDispositionForInput("win32", "mod+shift+p", commandShiftP))
      .toBeUndefined();
    expect(commandPaletteShortcutDispositionForInput("darwin", "mod+shift+p", controlShiftP))
      .toBeUndefined();
  });

  it("rejects near matches and consumes auto-repeat without another request", () => {
    const controlAltP = shortcutInput({ key: "p", code: "KeyP", meta: false, control: true, alt: true });
    expect(commandPaletteShortcutDispositionForInput("linux", "mod+alt+p", controlAltP)).toBe("request");
    expect(commandPaletteShortcutDispositionForInput("linux", "mod+alt+p", {
      ...controlAltP,
      isAutoRepeat: true,
    })).toBe("suppress");
    expect(commandPaletteShortcutDispositionForInput("linux", "mod+alt+p", { ...controlAltP, key: "o" }))
      .toBeUndefined();
    expect(commandPaletteShortcutDispositionForInput("linux", "mod+alt+p", { ...controlAltP, shift: true }))
      .toBeUndefined();
    expect(commandPaletteShortcutDispositionForInput("linux", "mod+alt+p", { ...controlAltP, type: "keyUp" }))
      .toBeUndefined();
    expect(commandPaletteShortcutDispositionForInput("linux", "mod+alt+p", { ...controlAltP, isComposing: true }))
      .toBeUndefined();
    expect(commandPaletteShortcutDispositionForInput("linux", "mod+n", controlAltP)).toBeUndefined();
  });

  it("matches shifted digits and macOS Option characters by their physical key code", () => {
    expect(commandPaletteShortcutDispositionForInput("linux", "mod+shift+1", shortcutInput({
      code: "Digit1",
      control: true,
      key: "!",
      meta: false,
      shift: true,
    }))).toBe("request");
    expect(commandPaletteShortcutDispositionForInput("darwin", "mod+alt+k", shortcutInput({
      alt: true,
      code: "KeyK",
      key: "˚",
    }))).toBe("request");
  });
});

describe("server refresh shortcut input", () => {
  it("accepts only an exact unmodified F5 keydown", () => {
    const f5 = shortcutInput({ key: "F5", code: "F5", meta: false });
    expect(serverRefreshShortcutDispositionForInput(f5)).toBe("refresh");
    expect(serverRefreshShortcutDispositionForInput({ ...f5, type: "keyUp" })).toBeUndefined();
    expect(serverRefreshShortcutDispositionForInput({ ...f5, key: "r", code: "KeyR" })).toBeUndefined();
    expect(serverRefreshShortcutDispositionForInput({ ...f5, isComposing: true })).toBeUndefined();
    expect(serverRefreshShortcutDispositionForInput({ ...f5, shift: true })).toBeUndefined();
    expect(serverRefreshShortcutDispositionForInput({ ...f5, control: true })).toBeUndefined();
    expect(serverRefreshShortcutDispositionForInput({ ...f5, alt: true })).toBeUndefined();
    expect(serverRefreshShortcutDispositionForInput({ ...f5, meta: true })).toBeUndefined();
  });

  it("suppresses F5 auto-repeat without scheduling another refresh", () => {
    expect(serverRefreshShortcutDispositionForInput(shortcutInput({
      key: "F5",
      code: "F5",
      meta: false,
      isAutoRepeat: true,
    }))).toBe("suppress");
  });

  it("does not treat a text-editor F5 binding as active in a workspace window", () => {
    const f5 = shortcutInput({ key: "F5", code: "F5", meta: false });
    const settings = {
      ...DEFAULT_APPLICATION_SETTINGS_VALUES,
      keyboardShortcuts: {
        refreshServer: "f6",
        textEditorCommandPalette: "f5",
      },
    };
    expect(serverRefreshShortcutDispositionForInput(f5, "darwin", settings)).toBe("suppress");
  });
});

describe("configured native shortcuts", () => {
  const settings = {
    ...DEFAULT_APPLICATION_SETTINGS_VALUES,
    keyboardShortcuts: {
      newWindow: "mod+alt+n",
      duplicateWindow: "mod+alt+shift+n",
      terminalNewTab: "mod+shift+t",
      terminalCloseTab: "mod+alt+w",
      terminalSettings: "mod+shift+,",
      terminalCloseWindow: "mod+alt+shift+w",
      terminalTab1: "mod+alt+1",
      refreshServer: "mod+shift+u",
    },
  };

  it("moves new/select-tab handlers to configured chords and leaves the old chords unclaimed", () => {
    const commandT = shortcutInput({ key: "t", code: "KeyT" });
    expect(isConsoleNewTabShortcutInput("darwin", commandT, settings)).toBe(false);
    expect(isConsoleNewTabShortcutInput("darwin", { ...commandT, shift: true }, settings)).toBe(true);
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput(), settings)).toBeUndefined();
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ alt: true }), settings)).toBe(0);
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ alt: true, isComposing: true }), settings)).toBeUndefined();
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ alt: true, isAutoRepeat: true }), settings)).toBe(0);
  });

  it("moves refresh and terminal settings/close handlers to their configured chords", () => {
    const f5 = shortcutInput({ key: "F5", code: "F5", meta: false });
    expect(serverRefreshShortcutDispositionForInput(f5, "darwin", settings)).toBe("suppress");
    expect(serverRefreshShortcutDispositionForInput(f5, "darwin", {
      ...settings, keyboardShortcuts: { ...settings.keyboardShortcuts, newWindow: "f5" },
    })).toBeUndefined();
    const refresh = shortcutInput({ key: "U", code: "KeyU", shift: true });
    expect(serverRefreshShortcutDispositionForInput(refresh, "darwin", settings)).toBe("refresh");
    expect(serverRefreshShortcutDispositionForInput({ ...refresh, isAutoRepeat: true }, "darwin", settings)).toBe("suppress");
    expect(isApplicationShortcutInput("terminalSettings", "darwin", shortcutInput({ key: ",", code: "Comma" }), settings)).toBe(false);
    expect(isApplicationShortcutInput("terminalSettings", "darwin", shortcutInput({ key: "<", code: "Comma", shift: true }), settings)).toBe(true);
    expect(isApplicationShortcutInput("terminalCloseTab", "darwin", shortcutInput({ key: "w", code: "KeyW", alt: true }), settings)).toBe(true);
    expect(isApplicationShortcutInput("terminalCloseWindow", "darwin", shortcutInput({ key: "w", code: "KeyW", alt: true, shift: true }), settings)).toBe(true);
  });

  it("shows the configured accelerators while preserving trusted menu callbacks", () => {
    const actions = {
      newWindow: vi.fn(), duplicateConnectedWindow: vi.fn(), openCloudDeployment: vi.fn(),
      openNetwork: vi.fn(), openScriptTaskManager: vi.fn(), editScript: vi.fn(), openArmory: vi.fn(), openDocumentation: vi.fn(), showAboutPanel: vi.fn(),
      downloadRelease: vi.fn(), checkForApplicationUpdates: vi.fn(), restartToApplyApplicationUpdate: vi.fn(),
    };
    const terminal = { newTab: vi.fn(), closeTab: vi.fn(), selectTab: vi.fn(), closeWindow: vi.fn(), showSettings: vi.fn() };
    const template = buildApplicationMenuTemplate("darwin", "Sliver GUI", actions, { status: "loading" }, undefined,
      terminal, [], false, { status: "loading" }, settings);
    const file = menuItems(template, "File");
    expect(file[0]?.accelerator).toBe("CmdOrCtrl+Alt+N");
    expect(file[1]?.accelerator).toBe("CmdOrCtrl+Alt+Shift+N");
    expect(file.at(-1)?.accelerator).toBe("CmdOrCtrl+Alt+Shift+W");
    const terminalMenu = menuItems(template, "Terminal");
    expect(terminalMenu.find(({ id }) => id === "console.new-tab")?.accelerator).toBe("CmdOrCtrl+Shift+T");
    expect(terminalMenu.find(({ id }) => id === "console.select-tab-1")?.accelerator).toBe("CmdOrCtrl+Alt+1");
    expect(terminalMenu.find(({ id }) => id === "console.settings")?.accelerator).toBe("CmdOrCtrl+Shift+,");
    clickItem(file[0]);
    clickItem(terminalMenu.find(({ id }) => id === "console.settings"));
    expect(actions.newWindow).toHaveBeenCalledOnce();
    expect(terminal.showSettings).toHaveBeenCalledOnce();
  });
});

describe("application menu templates", () => {
  it("places Scripts after Network and routes task manager/edit actions with the source window", () => {
    const actions = { newWindow: vi.fn(), duplicateConnectedWindow: vi.fn(), openCloudDeployment: vi.fn(), openArmory: vi.fn(),
      openNetwork: vi.fn(), openScriptTaskManager: vi.fn(), editScript: vi.fn(), openDocumentation: vi.fn(), showAboutPanel: vi.fn(),
      downloadRelease: vi.fn(), checkForApplicationUpdates: vi.fn(), restartToApplyApplicationUpdate: vi.fn() };
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const template = buildApplicationMenuTemplate("win32", "Sliver GUI", actions, undefined, undefined, undefined, [], false, undefined, undefined,
      [{ id, name: "Logs & checks" }]);
    const labels = template.map((item) => item.label);
    expect(labels[labels.indexOf("Network") + 1]).toBe("Scripts");
    const items = menuItems(template, "Scripts"); const source = {} as BrowserWindow;
    items[0]!.click!({} as MenuItem, source, {} as Electron.KeyboardEvent);
    expect(actions.openScriptTaskManager).toHaveBeenCalledExactlyOnceWith(source);
    const edit = items[1]!.submenu as MenuItemConstructorOptions[];
    expect(edit[0]).toMatchObject({ id: `scripts.edit.${id}`, label: "Logs && checks" });
    edit[0]!.click!({} as MenuItem, source, {} as Electron.KeyboardEvent);
    expect(actions.editScript).toHaveBeenCalledExactlyOnceWith(id, source);
    const empty = buildApplicationMenuTemplate("darwin", "Sliver GUI", actions);
    expect((menuItems(empty, "Scripts")[1]!.submenu as MenuItemConstructorOptions[])[0]).toEqual({ label: "No saved scripts", enabled: false });
  });
  it("keeps explicit Edit, View, and Help menus with the expected platform actions", () => {
    const actions = {
      newWindow: vi.fn(),
      duplicateConnectedWindow: vi.fn(),
      openCloudDeployment: vi.fn(),
      openNetwork: vi.fn(), openScriptTaskManager: vi.fn(), editScript: vi.fn(),
      openArmory: vi.fn(),
      openDocumentation: vi.fn(),
      showAboutPanel: vi.fn(),
      downloadRelease: vi.fn(),
      checkForApplicationUpdates: vi.fn(),
      restartToApplyApplicationUpdate: vi.fn(),
    };
    const template = buildApplicationMenuTemplate("darwin", "Sliver GUI", actions);

    expect(template.map((item) => item.label)).toEqual([
      "Sliver GUI",
      "File",
      "Edit",
      "View",
      "Armory",
      "Cloud",
      "Network",
      "Scripts",
      "Window",
      "Help",
    ]);
    const armoryItems = menuItems(template, "Armory");
    expect(armoryItems.map((item) => item.id).filter(Boolean)).toEqual(["armory.manage", "armory.install", "armory.sources"]);
    expect(armoryItems[0]).toMatchObject({ label: "Manage" });
    for (const item of armoryItems.filter((item) => item.id)) clickItem(item);
    expect(actions.openArmory.mock.calls).toEqual([["manage"], ["install"], ["sources"]]);
    expect(menuItems(template, "Sliver GUI")[0]).toMatchObject({
      label: "About Sliver GUI",
      role: "about",
    });
    expect(menuRoles(template, "Edit")).toEqual([
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "pasteAndMatchStyle",
      "delete",
      "selectAll",
    ]);
    expect(menuRoles(template, "View")).toEqual([
      "reload",
      "forceReload",
      "resetZoom",
      "zoomIn",
      "zoomOut",
      "togglefullscreen",
      "toggleDevTools",
    ]);
    const cloudDeployment = menuItems(template, "Cloud")[0];
    expect(cloudDeployment).toMatchObject({ id: "cloud.deployment", label: "Deployment" });
    clickItem(cloudDeployment);
    expect(actions.openCloudDeployment).toHaveBeenCalledOnce();
    clickItem(menuItems(template, "Help")[0]);
    expect(actions.openDocumentation).toHaveBeenCalledOnce();
  });

  it("routes each native Network command to its standalone-window tab", () => {
    const openNetwork = vi.fn();
    const actions = {
      newWindow: vi.fn(),
      duplicateConnectedWindow: vi.fn(),
      openCloudDeployment: vi.fn(),
      openNetwork,
      openScriptTaskManager: vi.fn(),
      editScript: vi.fn(),
      openArmory: vi.fn(),
      openDocumentation: vi.fn(),
      showAboutPanel: vi.fn(),
      downloadRelease: vi.fn(),
      checkForApplicationUpdates: vi.fn(),
      restartToApplyApplicationUpdate: vi.fn(),
    };
    const template = buildApplicationMenuTemplate(
      "darwin",
      "Sliver GUI",
      actions,
      { status: "loading" },
      undefined,
      undefined,
      [],
      true,
    );
    const items = menuItems(template, "Network");
    expect(items).toMatchObject([
      { id: "network.port-forward", label: "Port Forward", enabled: true },
      { id: "network.reverse-port-forward", label: "Reverse Port Forward", enabled: true },
      { id: "network.socks5", label: "SOCKS5 Proxy", enabled: true },
    ]);
    const sourceWindow = {} as BrowserWindow;
    for (const item of items) {
      if (!item.click) throw new Error("Expected a clickable Network menu item");
      item.click({} as MenuItem, sourceWindow, {} as Electron.KeyboardEvent);
    }
    expect(openNetwork.mock.calls).toEqual([
      ["port-forward", sourceWindow],
      ["reverse-port-forward", sourceWindow],
      ["socks5", sourceWindow],
    ]);
  });

  it("builds state-aware AWS deployment actions and routes exact navigation requests", () => {
    const openCloudDeployment = vi.fn();
    const actions = {
      newWindow: vi.fn(),
      duplicateConnectedWindow: vi.fn(),
      openCloudDeployment,
      openNetwork: vi.fn(), openScriptTaskManager: vi.fn(), editScript: vi.fn(),
      openArmory: vi.fn(),
      openDocumentation: vi.fn(),
      showAboutPanel: vi.fn(),
      downloadRelease: vi.fn(),
      checkForApplicationUpdates: vi.fn(),
      restartToApplyApplicationUpdate: vi.fn(),
    };
    const runningId = "11111111-1111-4111-8111-111111111111";
    const stoppedId = "22222222-2222-4222-8222-222222222222";
    const busyId = "33333333-3333-4333-8333-333333333333";
    const missingSshId = "44444444-4444-4444-8444-444444444444";
    const azureId = "55555555-5555-4555-8555-555555555555";
    const template = buildApplicationMenuTemplate(
      "darwin",
      "Sliver GUI",
      actions,
      { status: "loading" },
      undefined,
      undefined,
      [
        {
          id: runningId,
          provider: "aws",
          name: "operator-control",
          resourceId: "i-00000000000000001",
          status: "running",
          hasSsh: true,
          hasFirewall: true,
        },
        {
          id: stoppedId,
          provider: "aws",
          name: "",
          resourceId: "i-00000000000000002",
          status: "stopped",
          hasSsh: true,
          hasFirewall: false,
        },
        {
          id: busyId,
          provider: "aws",
          name: "",
          resourceId: null,
          status: "provisioning",
          hasSsh: false,
          hasFirewall: true,
        },
        {
          id: missingSshId,
          provider: "aws",
          name: "firewall-only",
          resourceId: "i-00000000000000004",
          status: "running",
          hasSsh: false,
          hasFirewall: true,
        },
        {
          id: azureId,
          provider: "azure",
          name: "azure-control",
          resourceId: "/subscriptions/example/resourceGroups/sliver/providers/Microsoft.Compute/virtualMachines/azure-control",
          status: "running",
          hasSsh: true,
          hasFirewall: true,
        },
      ],
    );

    const cloud = menuItems(template, "Cloud");
    expect(itemLabels(cloud)).toEqual(["Deployment", "AWS", "Azure"]);
    const aws = nestedMenuItems(cloud, "AWS");
    expect(aws.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: `cloud.aws.${runningId}`, label: "operator-control" },
      { id: `cloud.aws.${stoppedId}`, label: "i-00000000000000002" },
      { id: `cloud.aws.${busyId}`, label: busyId },
      { id: `cloud.aws.${missingSshId}`, label: "firewall-only" },
    ]);
    const azure = nestedMenuItems(cloud, "Azure");
    expect(azure.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: `cloud.azure.${azureId}`, label: "azure-control" },
    ]);
    expect(nestedMenuItems(azure, "azure-control").map(({ id }) => id).filter(Boolean)).toEqual([
      `cloud.azure.${azureId}.start`,
      `cloud.azure.${azureId}.stop`,
      `cloud.azure.${azureId}.terminate`,
      `cloud.azure.${azureId}.ssh`,
      `cloud.azure.${azureId}.firewall`,
      `cloud.azure.${azureId}.operator`,
    ]);

    const running = nestedMenuItems(aws, "operator-control");
    expect(running.map((item) => item.type === "separator"
      ? { type: item.type }
      : { label: item.label, enabled: item.enabled })).toEqual([
      { label: "Start", enabled: false },
      { label: "Stop", enabled: true },
      { label: "Terminate", enabled: true },
      { type: "separator" },
      { label: "SSH", enabled: true },
      { label: "Firewall", enabled: true },
      { label: "Add Operator", enabled: true },
    ]);
    expect(running.find(({ label }) => label === "SSH")).toMatchObject({
      id: `cloud.aws.${runningId}.ssh`,
    });
    clickItem(running.find(({ label }) => label === "Stop"));
    clickItem(running.find(({ label }) => label === "Terminate"));
    clickItem(running.find(({ label }) => label === "SSH"));
    clickItem(running.find(({ label }) => label === "Firewall"));
    const awsOperator = running.find(({ label }) => label === "Add Operator");
    expect(awsOperator).toMatchObject({ id: `cloud.aws.${runningId}.operator` });
    clickItem(awsOperator);
    const azureOperator = nestedMenuItems(azure, "azure-control").find(({ label }) => label === "Add Operator");
    expect(azureOperator).toMatchObject({ id: `cloud.azure.${azureId}.operator`, enabled: true });
    clickItem(azureOperator);

    const stopped = nestedMenuItems(aws, "i-00000000000000002");
    expect(stopped.map((item) => item.type === "separator"
      ? { type: item.type }
      : { label: item.label, enabled: item.enabled })).toEqual([
      { label: "Start", enabled: true },
      { label: "Stop", enabled: false },
      { label: "Terminate", enabled: true },
      { type: "separator" },
      { label: "SSH", enabled: false },
      { label: "Firewall", enabled: false },
      { label: "Add Operator", enabled: false },
    ]);
    clickItem(stopped.find(({ label }) => label === "Start"));

    const busy = nestedMenuItems(aws, busyId);
    expect(busy.filter(({ type }) => type !== "separator").every(({ enabled }) => enabled === false)).toBe(true);
    expect(busy.filter(({ type }) => type === "separator")).toHaveLength(1);
    const missingSsh = nestedMenuItems(aws, "firewall-only");
    expect(missingSsh.find(({ label }) => label === "SSH")).toMatchObject({
      id: `cloud.aws.${missingSshId}.ssh`,
      enabled: false,
    });
    expect(missingSsh.find(({ label }) => label === "Firewall")).toMatchObject({ enabled: true });
    expect(missingSsh.find(({ label }) => label === "Add Operator")).toMatchObject({
      id: `cloud.aws.${missingSshId}.operator`,
      enabled: false,
    });
    expect(openCloudDeployment.mock.calls).toEqual([
      [{ view: "deployments", deploymentId: runningId, action: "stop" }],
      [{ view: "deployments", deploymentId: runningId, action: "terminate" }],
      [{ view: "deployments", deploymentId: runningId, action: "ssh" }],
      [{ view: "firewall", deploymentId: runningId }],
      [{ view: "deployments", deploymentId: runningId, action: "operator" }],
      [{ view: "deployments", deploymentId: azureId, action: "operator" }],
      [{ view: "deployments", deploymentId: stoppedId, action: "start" }],
    ]);
  });

  it("uses the conventional non-macOS close and quit placements", () => {
    const showAboutPanel = vi.fn();
    const template = buildApplicationMenuTemplate("win32", "Sliver GUI", {
      newWindow: vi.fn(),
      duplicateConnectedWindow: vi.fn(),
      openCloudDeployment: vi.fn(),
      openNetwork: vi.fn(), openScriptTaskManager: vi.fn(), editScript: vi.fn(),
      openArmory: vi.fn(),
      openDocumentation: vi.fn(),
      showAboutPanel,
      downloadRelease: vi.fn(),
      checkForApplicationUpdates: vi.fn(),
      restartToApplyApplicationUpdate: vi.fn(),
    });

    expect(template.map((item) => item.label)).toEqual([
      "File", "Edit", "View", "Armory", "Cloud", "Network", "Scripts", "Window", "Help",
    ]);
    expect(menuRoles(template, "File")).toContain("quit");
    expect(menuRoles(template, "Window")).toContain("close");
    const about = menuItems(template, "Help").find((item) => item.label === "About Sliver GUI");
    clickItem(about);
    expect(showAboutPanel).toHaveBeenCalledOnce();
  });

  it("adds terminal commands only for a focused console without colliding with close-window", () => {
    const actions = {
      newWindow: vi.fn(),
      duplicateConnectedWindow: vi.fn(),
      openCloudDeployment: vi.fn(),
      openNetwork: vi.fn(), openScriptTaskManager: vi.fn(), editScript: vi.fn(),
      openArmory: vi.fn(),
      openDocumentation: vi.fn(),
      showAboutPanel: vi.fn(),
      downloadRelease: vi.fn(),
      checkForApplicationUpdates: vi.fn(),
      restartToApplyApplicationUpdate: vi.fn(),
    };
    const consoleActions = {
      newTab: vi.fn(),
      closeTab: vi.fn(),
      selectTab: vi.fn(),
      closeWindow: vi.fn(),
      showSettings: vi.fn(),
    };
    const macTemplate = buildApplicationMenuTemplate(
      "darwin",
      "Sliver GUI",
      actions,
      { status: "loading" },
      undefined,
      consoleActions,
    );

    expect(macTemplate.map((item) => item.label)).toEqual([
      "Sliver GUI",
      "File",
      "Edit",
      "View",
      "Armory",
      "Cloud",
      "Network",
      "Scripts",
      "Terminal",
      "Window",
      "Help",
    ]);
    const terminal = menuItems(macTemplate, "Terminal");
    expect(terminal.slice(0, 3)).toEqual([
      expect.objectContaining({ id: "console.new-tab", label: "New Tab", accelerator: "CmdOrCtrl+T" }),
      expect.objectContaining({ id: "console.close-tab", label: "Close Tab", accelerator: "CmdOrCtrl+W" }),
      expect.objectContaining({ type: "separator" }),
    ]);
    expect(terminal.slice(3, 13).map(({ id, label, accelerator }) => ({ id, label, accelerator }))).toEqual([
      { id: "console.select-tab-1", label: "Select Tab 1", accelerator: "CmdOrCtrl+1" },
      { id: "console.select-tab-2", label: "Select Tab 2", accelerator: "CmdOrCtrl+2" },
      { id: "console.select-tab-3", label: "Select Tab 3", accelerator: "CmdOrCtrl+3" },
      { id: "console.select-tab-4", label: "Select Tab 4", accelerator: "CmdOrCtrl+4" },
      { id: "console.select-tab-5", label: "Select Tab 5", accelerator: "CmdOrCtrl+5" },
      { id: "console.select-tab-6", label: "Select Tab 6", accelerator: "CmdOrCtrl+6" },
      { id: "console.select-tab-7", label: "Select Tab 7", accelerator: "CmdOrCtrl+7" },
      { id: "console.select-tab-8", label: "Select Tab 8", accelerator: "CmdOrCtrl+8" },
      { id: "console.select-tab-9", label: "Select Tab 9", accelerator: "CmdOrCtrl+9" },
      { id: "console.select-tab-0", label: "Select Tab 10", accelerator: "CmdOrCtrl+0" },
    ]);
    expect(terminal.slice(13)).toEqual([
      expect.objectContaining({ type: "separator" }),
      expect.objectContaining({
        id: "console.settings",
        label: "Terminal Settings…",
        accelerator: "CmdOrCtrl+,",
      }),
    ]);
    clickItem(terminal[0]);
    clickItem(terminal[1]);
    clickItem(terminal[3]);
    clickItem(terminal[12]);
    clickItem(terminal[14]);
    expect(consoleActions.newTab).toHaveBeenCalledOnce();
    expect(consoleActions.closeTab).toHaveBeenCalledOnce();
    expect(consoleActions.selectTab.mock.calls).toEqual([[0], [9]]);
    expect(consoleActions.showSettings).toHaveBeenCalledOnce();

    const macCloseWindow = menuItems(macTemplate, "File").at(-1);
    expect(macCloseWindow).toMatchObject({
      label: "Close Window",
      accelerator: "CmdOrCtrl+Shift+W",
    });
    clickItem(macCloseWindow);
    expect(consoleActions.closeWindow).toHaveBeenCalledOnce();

    const windowsTemplate = buildApplicationMenuTemplate(
      "win32",
      "Sliver GUI",
      actions,
      { status: "loading" },
      undefined,
      consoleActions,
    );
    expect(menuItems(windowsTemplate, "File").at(-1)).toMatchObject({ role: "quit" });
    expect(menuItems(windowsTemplate, "Window").at(-1)).toMatchObject({
      label: "Close Window",
      accelerator: "CmdOrCtrl+Shift+W",
    });
  });

  it("builds server and console-client submenus from every latest-release target", () => {
    const downloadRelease = vi.fn();
    const template = buildApplicationMenuTemplate("darwin", "Sliver GUI", {
      newWindow: vi.fn(),
      duplicateConnectedWindow: vi.fn(),
      openCloudDeployment: vi.fn(),
      openNetwork: vi.fn(), openScriptTaskManager: vi.fn(), editScript: vi.fn(),
      openArmory: vi.fn(),
      openDocumentation: vi.fn(),
      showAboutPanel: vi.fn(),
      downloadRelease,
      checkForApplicationUpdates: vi.fn(),
      restartToApplyApplicationUpdate: vi.fn(),
    }, {
      status: "ready",
      version: "v1.7.3",
      targets: [
        { artifact: "server", os: "darwin", arch: "amd64" },
        { artifact: "server", os: "darwin", arch: "arm64" },
        { artifact: "server", os: "linux", arch: "amd64" },
        { artifact: "client", os: "macos", arch: "arm64" },
        { artifact: "client", os: "windows", arch: "386" },
      ],
    }, undefined, undefined, [], false, {
      status: "ready",
      version: "v0.0.4",
      targets: [
        { artifact: "crackstation", os: "windows", arch: "amd64" },
        { artifact: "crackstation", os: "linux", arch: "amd64" },
        { artifact: "crackstation", os: "darwin", arch: "arm64" },
      ],
    });
    const help = menuItems(template, "Help");
    expect(help.map((item) => item.label).filter(Boolean)).toEqual([
      "Sliver Documentation",
      "Download Server",
      "Download Console Client",
      "Download Crackstation",
    ]);

    const server = nestedMenuItems(help, "Download Server");
    expect(server[0]?.label).toBe("Latest release: v1.7.3");
    expect(server.filter((item) => item.submenu).map((item) => item.label)).toEqual(["macOS", "Linux"]);
    const macosServer = nestedMenuItems(server, "macOS");
    expect(macosServer.map((item) => item.label)).toEqual(["x86_64 (amd64)", "arm64"]);
    clickItem(macosServer[1]);
    expect(downloadRelease).toHaveBeenCalledExactlyOnceWith({ artifact: "server", os: "darwin", arch: "arm64" });

    const client = nestedMenuItems(help, "Download Console Client");
    expect(client.filter((item) => item.submenu).map((item) => item.label)).toEqual(["macOS", "Windows"]);
    expect(nestedMenuItems(client, "Windows").map((item) => item.label)).toEqual(["x86 (386)"]);

    const crackstation = nestedMenuItems(help, "Download Crackstation");
    expect(crackstation[0]?.label).toBe("Latest release: v0.0.4");
    expect(crackstation.filter((item) => item.submenu).map((item) => item.label)).toEqual([
      "macOS",
      "Linux",
      "Windows",
    ]);
    expect(nestedMenuItems(crackstation, "macOS").map((item) => item.label)).toEqual(["arm64"]);
    expect(nestedMenuItems(crackstation, "Linux").map((item) => item.label)).toEqual(["x86_64 (amd64)"]);
    const windowsCrackstation = nestedMenuItems(crackstation, "Windows");
    expect(windowsCrackstation.map((item) => item.label)).toEqual(["x86_64 (amd64)"]);
    clickItem(windowsCrackstation[0]);
    expect(downloadRelease).toHaveBeenLastCalledWith({
      artifact: "crackstation",
      os: "windows",
      arch: "amd64",
    });
  });

  it("shows non-actionable release status while the live catalog is loading or unavailable", () => {
    const actions = {
      newWindow: vi.fn(),
      duplicateConnectedWindow: vi.fn(),
      openCloudDeployment: vi.fn(),
      openNetwork: vi.fn(), openScriptTaskManager: vi.fn(), editScript: vi.fn(),
      openArmory: vi.fn(),
      openDocumentation: vi.fn(),
      showAboutPanel: vi.fn(),
      downloadRelease: vi.fn(),
      checkForApplicationUpdates: vi.fn(),
      restartToApplyApplicationUpdate: vi.fn(),
    };
    const loading = menuItems(buildApplicationMenuTemplate("linux", "Sliver GUI", actions), "Help");
    expect(nestedMenuItems(loading, "Download Server")).toEqual([
      expect.objectContaining({ label: "Checking latest release…", enabled: false }),
    ]);
    expect(nestedMenuItems(loading, "Download Crackstation")).toEqual([
      expect.objectContaining({ label: "Checking latest release…", enabled: false }),
    ]);
    const unavailable = menuItems(buildApplicationMenuTemplate(
      "linux",
      "Sliver GUI",
      actions,
      { status: "unavailable" },
    ), "Help");
    expect(nestedMenuItems(unavailable, "Download Console Client")).toEqual([
      expect.objectContaining({ label: "Latest release unavailable", enabled: false }),
    ]);
    expect(nestedMenuItems(unavailable, "Download Crackstation")).toEqual([
      expect.objectContaining({ label: "Checking latest release…", enabled: false }),
    ]);

    const crackstationUnavailable = menuItems(buildApplicationMenuTemplate(
      "linux",
      "Sliver GUI",
      actions,
      { status: "loading" },
      undefined,
      undefined,
      [],
      false,
      { status: "unavailable" },
    ), "Help");
    expect(nestedMenuItems(crackstationUnavailable, "Download Server")).toEqual([
      expect.objectContaining({ label: "Checking latest release…", enabled: false }),
    ]);
    expect(nestedMenuItems(crackstationUnavailable, "Download Crackstation")).toEqual([
      expect.objectContaining({ label: "Latest release unavailable", enabled: false }),
    ]);
  });

  it("places update checks conventionally and exposes restart only when an update is ready", () => {
    const checkForApplicationUpdates = vi.fn();
    const restartToApplyApplicationUpdate = vi.fn();
    const actions = {
      newWindow: vi.fn(),
      duplicateConnectedWindow: vi.fn(),
      openCloudDeployment: vi.fn(),
      openNetwork: vi.fn(), openScriptTaskManager: vi.fn(), editScript: vi.fn(),
      openArmory: vi.fn(),
      openDocumentation: vi.fn(),
      showAboutPanel: vi.fn(),
      downloadRelease: vi.fn(),
      checkForApplicationUpdates,
      restartToApplyApplicationUpdate,
    };
    const disabledTemplate = buildApplicationMenuTemplate(
      "darwin",
      "Sliver GUI",
      actions,
      { status: "loading" },
      {
        status: "disabled",
        revision: 0,
        currentVersion: "1.2.3",
        disabledReason: "Automatic updates are available in packaged builds.",
      },
    );
    const disabledCheck = menuItems(disabledTemplate, "Sliver GUI")
      .find((item) => item.label === "Check for Updates…");
    expect(disabledCheck?.enabled).not.toBe(false);
    clickItem(disabledCheck);
    expect(checkForApplicationUpdates).toHaveBeenCalledOnce();
    checkForApplicationUpdates.mockClear();

    const macTemplate = buildApplicationMenuTemplate(
      "darwin",
      "Sliver GUI",
      actions,
      { status: "loading" },
      { status: "idle", revision: 0, currentVersion: "1.2.3" },
    );
    clickItem(menuItems(macTemplate, "Sliver GUI").find((item) => item.label === "Check for Updates…"));
    expect(checkForApplicationUpdates).toHaveBeenCalledOnce();

    const linuxTemplate = buildApplicationMenuTemplate(
      "linux",
      "Sliver GUI",
      actions,
      { status: "loading" },
      { status: "ready", revision: 3, currentVersion: "1.2.3", availableVersion: "1.3.0" },
    );
    clickItem(menuItems(linuxTemplate, "Help").find((item) => item.label === "Restart to Update to 1.3.0…"));
    expect(restartToApplyApplicationUpdate).toHaveBeenCalledOnce();

    const downloadingTemplate = buildApplicationMenuTemplate(
      "win32",
      "Sliver GUI",
      actions,
      { status: "loading" },
      {
        status: "downloading",
        revision: 2,
        currentVersion: "1.2.3",
        availableVersion: "1.3.0",
        progressPercent: 42.4,
      },
    );
    expect(menuItems(downloadingTemplate, "Help")[0]).toMatchObject({
      label: "Downloading Update 1.3.0… 42%",
      enabled: false,
    });
  });
});

function menuItems(
  template: readonly MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions[] {
  const item = template.find((candidate) => candidate.label === label);
  if (!item || !Array.isArray(item.submenu)) throw new Error(`Missing ${label} submenu`);
  return item.submenu;
}

function menuRoles(template: readonly MenuItemConstructorOptions[], label: string): string[] {
  return menuItems(template, label)
    .map((item) => item.role)
    .filter((role): role is NonNullable<typeof role> => role !== undefined);
}

function nestedMenuItems(
  template: readonly MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions[] {
  const item = template.find((candidate) => candidate.label === label);
  if (!item || !Array.isArray(item.submenu)) throw new Error(`Missing ${label} submenu`);
  return item.submenu;
}

function itemLabels(template: readonly MenuItemConstructorOptions[]): string[] {
  return template
    .filter((item) => item.type !== "separator")
    .map((item) => item.label ?? item.role ?? "");
}

function clickItem(item: MenuItemConstructorOptions | undefined): void {
  if (!item?.click) throw new Error("Expected a clickable menu item");
  item.click({} as MenuItem, undefined, {} as Electron.KeyboardEvent);
}
