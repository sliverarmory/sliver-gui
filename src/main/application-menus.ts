import type { ArmoryTabId } from "../shared/armory-contracts.js";
import type { BaseWindow, MenuItemConstructorOptions } from "electron";
import type { ApplicationUpdateState } from "../shared/application-update-contracts.js";
import {
  DEFAULT_APPLICATION_SETTINGS_VALUES,
  type ApplicationSettingsValues,
} from "../shared/application-settings-contracts.js";
import {
  KEYBOARD_SHORTCUT_DEFINITIONS,
  keyboardShortcutToAccelerator,
  matchesKeyboardShortcut,
  resolveKeyboardShortcut,
  type KeyboardShortcutAction,
} from "../shared/keyboard-shortcuts.js";
import { CONSOLE_MAX_TABS_PER_WINDOW } from "../shared/console-contracts.js";
import type { CloudDeploymentStatus, CloudProvider } from "../shared/cloud-deployment-contracts.js";
import type { CloudDeploymentNavigationRequest } from "../shared/cloud-deployment-ipc.js";
import type { SliverReleaseTarget } from "../shared/release-contracts.js";
import type { NetworkTabId } from "../shared/network-forwarding-contracts.js";

export type ReleaseMenuCatalog =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly version: string;
      readonly targets: readonly SliverReleaseTarget[];
    };

export interface ApplicationMenuActions {
  readonly newWindow: () => void;
  readonly duplicateConnectedWindow: () => void;
  readonly openCloudDeployment: (request?: CloudDeploymentNavigationRequest) => void;
  readonly openArmory: (tab: ArmoryTabId) => void;
  readonly openNetwork: (tab: NetworkTabId, sourceWindow?: BaseWindow) => void;
  readonly openDocumentation: () => void;
  readonly showAboutPanel: () => void;
  readonly downloadRelease: (target: SliverReleaseTarget) => void;
  readonly checkForApplicationUpdates: () => void;
  readonly restartToApplyApplicationUpdate: () => void;
}

export interface CloudMenuDeployment {
  readonly id: string;
  readonly provider: CloudProvider;
  readonly name: string;
  readonly resourceId: string | null;
  readonly status: CloudDeploymentStatus;
  readonly hasSsh: boolean;
  readonly hasFirewall: boolean;
}

export interface ConsoleApplicationMenuActions {
  readonly newTab: () => void;
  readonly closeTab: () => void;
  readonly selectTab: (index: number) => void;
  readonly closeWindow: () => void;
  readonly showSettings: () => void;
}

export interface ConsoleTabShortcutInput {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly isComposing: boolean;
  readonly isAutoRepeat: boolean;
  readonly shift: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

export type ServerRefreshShortcutDisposition = "refresh" | "suppress";
export type CommandPaletteShortcutDisposition = "request" | "suppress";

export function commandPaletteShortcutDispositionForInput(
  platform: NodeJS.Platform,
  shortcut: string,
  input: ConsoleTabShortcutInput,
): CommandPaletteShortcutDisposition | undefined {
  if (!matchesNativeKeyboardShortcut(shortcut, platform, input)) return undefined;
  return input.isAutoRepeat ? "suppress" : "request";
}

export function serverRefreshShortcutDispositionForInput(
  input: ConsoleTabShortcutInput,
  platform: NodeJS.Platform = process.platform,
  settings: ApplicationSettingsValues = DEFAULT_APPLICATION_SETTINGS_VALUES,
): ServerRefreshShortcutDisposition | undefined {
  if (isApplicationShortcutInput("refreshServer", platform, input, settings)) {
    return input.isAutoRepeat ? "suppress" : "refresh";
  }
  // Keep an unassigned F5 from falling through to Chromium's page reload.
  // A different application action may explicitly reuse it after remapping.
  if (
    matchesNativeKeyboardShortcut("f5", platform, input) &&
    !KEYBOARD_SHORTCUT_DEFINITIONS.some(({ id, scope }) => scope !== "terminal" &&
      isApplicationShortcutInput(id, platform, input, settings))
  ) return "suppress";
  return undefined;
}

export function consoleTabShortcutIndexForInput(
  platform: NodeJS.Platform,
  input: ConsoleTabShortcutInput,
  settings: ApplicationSettingsValues = DEFAULT_APPLICATION_SETTINGS_VALUES,
): number | undefined {
  for (let index = 0; index < CONSOLE_MAX_TABS_PER_WINDOW; index += 1) {
    if (isApplicationShortcutInput(`terminalTab${index + 1}` as KeyboardShortcutAction, platform, input, settings)) {
      return index;
    }
  }
  return undefined;
}

export function isConsoleNewTabShortcutInput(
  platform: NodeJS.Platform,
  input: ConsoleTabShortcutInput,
  settings: ApplicationSettingsValues = DEFAULT_APPLICATION_SETTINGS_VALUES,
): boolean {
  return isApplicationShortcutInput("terminalNewTab", platform, input, settings);
}

export function isApplicationShortcutInput(
  action: KeyboardShortcutAction,
  platform: NodeJS.Platform,
  input: ConsoleTabShortcutInput,
  settings: ApplicationSettingsValues = DEFAULT_APPLICATION_SETTINGS_VALUES,
): boolean {
  return matchesNativeKeyboardShortcut(resolveKeyboardShortcut(action, settings, platform === "darwin"), platform, input);
}

function matchesNativeKeyboardShortcut(
  shortcut: string,
  platform: NodeJS.Platform,
  input: ConsoleTabShortcutInput,
): boolean {
  if (input.type !== "keyDown" || input.isComposing) return false;
  return matchesKeyboardShortcut(shortcut, {
    key: input.key,
    code: input.code,
    metaKey: input.meta,
    ctrlKey: input.control,
    altKey: input.alt,
    shiftKey: input.shift,
  }, platform === "darwin");
}

export function buildApplicationMenuTemplate(
  platform: NodeJS.Platform,
  applicationName: string,
  actions: ApplicationMenuActions,
  releaseCatalog: ReleaseMenuCatalog = { status: "loading" },
  applicationUpdateState?: ApplicationUpdateState,
  consoleActions?: ConsoleApplicationMenuActions,
  cloudDeployments: readonly CloudMenuDeployment[] = [],
  networkEnabled = false,
  crackstationReleaseCatalog: ReleaseMenuCatalog = { status: "loading" },
  settings: ApplicationSettingsValues = DEFAULT_APPLICATION_SETTINGS_VALUES,
): MenuItemConstructorOptions[] {
  const accelerator = (action: KeyboardShortcutAction): string =>
    keyboardShortcutToAccelerator(resolveKeyboardShortcut(action, settings, platform === "darwin"));
  const updateItems = applicationUpdateState
    ? buildApplicationUpdateMenuItems(applicationUpdateState, actions)
    : [];
  return [
    ...(platform === "darwin"
      ? [
          {
            label: applicationName,
            submenu: [
              { label: `About ${applicationName}`, role: "about" as const },
              ...updateItems,
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: accelerator("newWindow"),
          click: actions.newWindow,
        },
        {
          label: "Duplicate Connected Window",
          accelerator: accelerator("duplicateWindow"),
          click: actions.duplicateConnectedWindow,
        },
        { type: "separator" },
        platform === "darwin"
          ? consoleActions
            ? {
                label: "Close Window",
                accelerator: accelerator("terminalCloseWindow"),
                click: consoleActions.closeWindow,
              }
            : { role: "close" }
          : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { type: "separator" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Armory",
      submenu: [
        { id: "armory.manage", label: "Manage", click: () => actions.openArmory("manage") },
        { id: "armory.install", label: "Install…", click: () => actions.openArmory("install") },
        { type: "separator" },
        { id: "armory.sources", label: "Sources…", click: () => actions.openArmory("sources") },
      ],
    },
    {
      label: "Cloud",
      submenu: [
        {
          id: "cloud.deployment",
          label: "Deployment",
          click: () => actions.openCloudDeployment(),
        },
        ...(cloudDeployments.length > 0
          ? [
              { type: "separator" as const },
              ...(["aws", "azure"] as const).flatMap((provider) => {
                const deployments = cloudDeployments.filter((deployment) => deployment.provider === provider);
                return deployments.length === 0 ? [] : [{
                  id: `cloud.${provider}`,
                  label: provider === "aws" ? "AWS" : "Azure",
                  submenu: deployments.map((deployment) =>
                    buildCloudDeploymentMenu(deployment, actions.openCloudDeployment)
                  ),
                }];
              }),
            ]
          : []),
      ],
    },
    {
      label: "Network",
      submenu: [
        {
          id: "network.port-forward",
          label: "Port Forward",
          enabled: networkEnabled,
          click: (_item, sourceWindow) => actions.openNetwork("port-forward", sourceWindow),
        },
        {
          id: "network.reverse-port-forward",
          label: "Reverse Port Forward",
          enabled: networkEnabled,
          click: (_item, sourceWindow) => actions.openNetwork("reverse-port-forward", sourceWindow),
        },
        {
          id: "network.socks5",
          label: "SOCKS5 Proxy",
          enabled: networkEnabled,
          click: (_item, sourceWindow) => actions.openNetwork("socks5", sourceWindow),
        },
      ],
    },
    ...(consoleActions
      ? [{
          label: "Terminal",
          submenu: [
            {
              id: "console.new-tab",
              label: "New Tab",
              accelerator: accelerator("terminalNewTab"),
              click: consoleActions.newTab,
            },
            {
              id: "console.close-tab",
              label: "Close Tab",
              accelerator: accelerator("terminalCloseTab"),
              click: consoleActions.closeTab,
            },
            { type: "separator" as const },
            ...Array.from({ length: CONSOLE_MAX_TABS_PER_WINDOW }, (_, index): MenuItemConstructorOptions => {
              const digit = index === 9 ? 0 : index + 1;
              return {
                id: `console.select-tab-${digit}`,
                label: `Select Tab ${index + 1}`,
                accelerator: accelerator(`terminalTab${index + 1}` as KeyboardShortcutAction),
                click: () => consoleActions.selectTab(index),
              };
            }),
            { type: "separator" as const },
            {
              id: "console.settings",
              label: "Terminal Settings…",
              accelerator: accelerator("terminalSettings"),
              click: consoleActions.showSettings,
            },
          ],
        }]
      : []),
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        ...(platform === "darwin" ? [{ role: "zoom" as const }] : []),
        { type: "separator" },
        ...(platform === "darwin"
          ? [{ role: "front" as const }]
          : consoleActions
            ? [{
                label: "Close Window",
                accelerator: accelerator("terminalCloseWindow"),
                click: consoleActions.closeWindow,
              }]
            : [{ role: "close" as const }]),
      ],
    },
    {
      label: "Help",
      role: "help",
      submenu: [
        ...(platform === "darwin" ? [] : updateItems),
        ...(platform !== "darwin" && updateItems.length > 0
          ? [{ type: "separator" as const }]
          : []),
        {
          label: "Sliver Documentation",
          click: actions.openDocumentation,
        },
        { type: "separator" },
        {
          label: "Download Server",
          submenu: buildReleaseDownloadSubmenu("server", releaseCatalog, actions.downloadRelease),
        },
        {
          label: "Download Console Client",
          submenu: buildReleaseDownloadSubmenu("client", releaseCatalog, actions.downloadRelease),
        },
        {
          label: "Download Crackstation",
          submenu: buildReleaseDownloadSubmenu(
            "crackstation",
            crackstationReleaseCatalog,
            actions.downloadRelease,
          ),
        },
        ...(platform === "darwin"
          ? []
          : [
              { type: "separator" as const },
              {
                label: `About ${applicationName}`,
                click: actions.showAboutPanel,
              },
            ]),
      ],
    },
  ];
}

function buildCloudDeploymentMenu(
  deployment: CloudMenuDeployment,
  openCloudDeployment: ApplicationMenuActions["openCloudDeployment"],
): MenuItemConstructorOptions {
  const busy = deployment.status === "provisioning" || deployment.status === "deleting";
  const requestLifecycle = (action: "start" | "stop" | "terminate"): void => {
    openCloudDeployment({ view: "deployments", deploymentId: deployment.id, action });
  };
  return {
    id: `cloud.${deployment.provider}.${deployment.id}`,
    label: deployment.name || deployment.resourceId || deployment.id,
    submenu: [
      {
        id: `cloud.${deployment.provider}.${deployment.id}.start`,
        label: "Start",
        enabled: deployment.status === "stopped",
        click: () => requestLifecycle("start"),
      },
      {
        id: `cloud.${deployment.provider}.${deployment.id}.stop`,
        label: "Stop",
        enabled: deployment.status === "running",
        click: () => requestLifecycle("stop"),
      },
      {
        id: `cloud.${deployment.provider}.${deployment.id}.terminate`,
        label: "Terminate",
        enabled: !busy,
        click: () => requestLifecycle("terminate"),
      },
      { type: "separator" },
      {
        id: `cloud.${deployment.provider}.${deployment.id}.ssh`,
        label: "SSH",
        enabled: deployment.status === "running" && deployment.hasSsh,
        click: () => openCloudDeployment({
          view: "deployments",
          deploymentId: deployment.id,
          action: "ssh",
        }),
      },
      {
        id: `cloud.${deployment.provider}.${deployment.id}.firewall`,
        label: "Firewall",
        enabled: !busy && deployment.hasFirewall,
        click: () => openCloudDeployment({
          view: "firewall",
          deploymentId: deployment.id,
        }),
      },
      {
        id: `cloud.${deployment.provider}.${deployment.id}.operator`,
        label: "Add Operator",
        enabled: deployment.status === "running" && deployment.hasSsh,
        click: () => openCloudDeployment({
          view: "deployments",
          deploymentId: deployment.id,
          action: "operator",
        }),
      },
    ],
  };
}

function buildApplicationUpdateMenuItems(
  state: ApplicationUpdateState,
  actions: ApplicationMenuActions,
): MenuItemConstructorOptions[] {
  switch (state.status) {
    case "disabled":
      return [{
        label: "Check for Updates…",
        click: actions.checkForApplicationUpdates,
      }];
    case "checking":
      return [{ label: "Checking for Updates…", enabled: false }];
    case "available":
      return [{ label: `Downloading Update ${state.availableVersion}…`, enabled: false }];
    case "downloading":
      return [{
        label: `Downloading Update ${state.availableVersion}… ${Math.round(state.progressPercent)}%`,
        enabled: false,
      }];
    case "ready":
      return [{
        label: `Restart to Update to ${state.availableVersion}…`,
        click: actions.restartToApplyApplicationUpdate,
      }];
    case "idle":
    case "up-to-date":
    case "error":
      return [{
        label: "Check for Updates…",
        click: actions.checkForApplicationUpdates,
      }];
  }
}

function buildReleaseDownloadSubmenu(
  artifact: SliverReleaseTarget["artifact"],
  catalog: ReleaseMenuCatalog,
  onDownload: (target: SliverReleaseTarget) => void,
): MenuItemConstructorOptions[] {
  if (catalog.status === "loading") return [{ label: "Checking latest release…", enabled: false }];
  if (catalog.status === "unavailable") return [{ label: "Latest release unavailable", enabled: false }];
  const targets = catalog.targets.filter((target) => target.artifact === artifact);
  if (targets.length === 0) return [{ label: "No binaries in latest release", enabled: false }];
  const byOperatingSystem = new Map<string, SliverReleaseTarget[]>();
  for (const target of targets) {
    const existing = byOperatingSystem.get(target.os) ?? [];
    existing.push(target);
    byOperatingSystem.set(target.os, existing);
  }
  return [
    { label: `Latest release: ${catalog.version}`, enabled: false },
    { type: "separator" },
    ...[...byOperatingSystem.entries()]
      .sort(([left], [right]) => operatingSystemOrder(left) - operatingSystemOrder(right) || left.localeCompare(right))
      .map(([os, osTargets]) => ({
        label: operatingSystemLabel(os),
        submenu: osTargets
          .sort((left, right) => architectureOrder(left.arch) - architectureOrder(right.arch) || left.arch.localeCompare(right.arch))
          .map((target) => ({
            label: architectureLabel(target.arch),
            click: () => onDownload(target),
          })),
      })),
  ];
}

function operatingSystemLabel(value: string): string {
  if (value === "darwin" || value === "macos") return "macOS";
  if (value === "linux") return "Linux";
  if (value === "windows") return "Windows";
  if (value === "freebsd") return "FreeBSD";
  return value;
}

function operatingSystemOrder(value: string): number {
  return ["darwin", "macos", "linux", "windows", "freebsd"].indexOf(value) + 1 || 100;
}

function architectureLabel(value: string): string {
  if (value === "amd64") return "x86_64 (amd64)";
  if (value === "386") return "x86 (386)";
  return value;
}

function architectureOrder(value: string): number {
  return ["amd64", "arm64", "386"].indexOf(value) + 1 || 100;
}
