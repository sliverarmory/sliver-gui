import type { ApplicationSettingsState } from "./application-settings-contracts.js";
import type { OperationResult } from "./contracts.js";

export type ArmoryTabId = "manage" | "install" | "sources";
export type ArmoryPackageKind = "alias" | "extension" | "bof";

export interface ArmorySource {
  readonly id: string;
  readonly name: string;
  readonly repoUrl: string;
  readonly publicKey: string;
  readonly enabled: boolean;
  readonly hasAuthorization: boolean;
  readonly hasAuthorizationCommand: boolean;
  readonly error?: string;
}

export interface ArmoryInstalledPackage {
  readonly id: string;
  readonly name: string;
  readonly commandNames: readonly string[];
  readonly kind: ArmoryPackageKind;
  readonly version: string;
  readonly description: string;
  readonly originalAuthor?: string;
  readonly extensionAuthor?: string;
  readonly repoUrl: string;
  readonly installPath: string;
  readonly packageId?: string;
  readonly updateAvailable?: boolean;
}

export interface ArmoryPackage {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly name: string;
  readonly commandName: string;
  readonly kind: ArmoryPackageKind;
  readonly version: string;
  readonly description: string;
  readonly originalAuthor?: string;
  readonly extensionAuthor?: string;
  readonly repoUrl: string;
  readonly publicKey: string;
  readonly installedId?: string;
  readonly updateAvailable: boolean;
  readonly error?: string;
}

export interface ArmoryBundle {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly name: string;
  readonly packageNames: readonly string[];
}

export interface ArmorySnapshot {
  readonly rootPath: string;
  readonly sources: readonly ArmorySource[];
  readonly installed: readonly ArmoryInstalledPackage[];
  readonly packages: readonly ArmoryPackage[];
  readonly bundles: readonly ArmoryBundle[];
  readonly refreshedAt: string | null;
  readonly warnings: readonly string[];
}

export interface ArmoryInstallInput {
  readonly packageId: string;
  readonly replace?: boolean;
}
export interface ArmoryInstallBundleInput {
  readonly bundleId: string;
  readonly replace?: boolean;
}
export interface ArmoryUninstallInput { readonly installedId: string }
export interface ArmoryRemoveSourceInput { readonly sourceId: string }
export interface ArmorySaveSourceInput {
  readonly id?: string;
  readonly name: string;
  readonly repoUrl: string;
  readonly publicKey: string;
  readonly enabled: boolean;
  /** Omitted preserves the console's existing credential; empty clears it. */
  readonly authorization?: string;
}
export interface ArmoryChooseLocalInput {
  readonly publicKey: string;
  readonly replace?: boolean;
}
/** Main-owned native dialog paths; never accepted from a renderer. */
export interface ArmoryInstallLocalInput extends ArmoryChooseLocalInput {
  readonly archivePath: string;
  readonly signaturePath: string;
}
export interface ArmoryCopyPublicKeyInput { readonly publicKey: string }
export interface ArmoryOpenRepositoryInput { readonly url: string }

export interface ArmoryAPI {
  getContext(): Promise<OperationResult<{ readonly tab: ArmoryTabId }>>;
  snapshot(): Promise<OperationResult<ArmorySnapshot>>;
  refreshCatalog(): Promise<OperationResult<ArmorySnapshot>>;
  install(input: ArmoryInstallInput): Promise<OperationResult<ArmorySnapshot>>;
  installBundle(input: ArmoryInstallBundleInput): Promise<OperationResult<ArmorySnapshot>>;
  uninstall(input: ArmoryUninstallInput): Promise<OperationResult<ArmorySnapshot>>;
  saveSource(input: ArmorySaveSourceInput): Promise<OperationResult<ArmorySnapshot>>;
  removeSource(input: ArmoryRemoveSourceInput): Promise<OperationResult<ArmorySnapshot>>;
  installLocal(input: ArmoryChooseLocalInput): Promise<OperationResult<ArmorySnapshot>>;
  copyPublicKey(input: ArmoryCopyPublicKeyInput): Promise<OperationResult>;
  openRepository(input: ArmoryOpenRepositoryInput): Promise<OperationResult>;
  getApplicationSettings(): Promise<ApplicationSettingsState>;
  onChanged(listener: () => void): () => void;
  onNavigationRequested(listener: (tab: ArmoryTabId) => void): () => void;
  onApplicationSettingsChanged(listener: (state: ApplicationSettingsState) => void): () => void;
}

export const ARMORY_IPC_INVOKE = Object.freeze({
  getContext: "sliver:armory:context:get",
  snapshot: "sliver:armory:snapshot",
  refreshCatalog: "sliver:armory:catalog:refresh",
  install: "sliver:armory:install",
  installBundle: "sliver:armory:bundle:install",
  uninstall: "sliver:armory:uninstall",
  saveSource: "sliver:armory:source:save",
  removeSource: "sliver:armory:source:remove",
  installLocal: "sliver:armory:local:install",
  copyPublicKey: "sliver:armory:public-key:copy",
  openRepository: "sliver:armory:repository:open",
  getApplicationSettings: "sliver:armory:application-settings:get",
});
export const ARMORY_IPC_EVENTS = Object.freeze({
  changed: "sliver:armory:changed",
  navigationRequested: "sliver:armory:navigation-requested",
});

export function isArmoryTab(value: unknown): value is ArmoryTabId {
  return value === "manage" || value === "install" || value === "sources";
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).some((key) => !fields.includes(key))) {
    throw new TypeError("Invalid Armory request");
  }
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new TypeError("Invalid Armory value");
  }
  return value;
}
function replace(value: unknown): { replace?: boolean } {
  if (value === undefined) return {};
  if (typeof value !== "boolean") throw new TypeError("Invalid replacement option");
  return { replace: value };
}
export function parseArmoryInstallInput(value: unknown): ArmoryInstallInput {
  const input = record(value, ["packageId", "replace"]);
  return { packageId: string(input["packageId"]), ...replace(input["replace"]) };
}
export function parseArmoryInstallBundleInput(value: unknown): ArmoryInstallBundleInput {
  const input = record(value, ["bundleId", "replace"]);
  return { bundleId: string(input["bundleId"]), ...replace(input["replace"]) };
}
export function parseArmoryUninstallInput(value: unknown): ArmoryUninstallInput {
  const input = record(value, ["installedId"]);
  return { installedId: string(input["installedId"]) };
}
export function parseArmoryRemoveSourceInput(value: unknown): ArmoryRemoveSourceInput {
  const input = record(value, ["sourceId"]);
  return { sourceId: string(input["sourceId"]) };
}
export function parseArmoryChooseLocalInput(value: unknown): ArmoryChooseLocalInput {
  const input = record(value, ["publicKey", "replace"]);
  return { publicKey: string(input["publicKey"]), ...replace(input["replace"]) };
}
export function parseArmoryCopyPublicKeyInput(value: unknown): ArmoryCopyPublicKeyInput {
  const input = record(value, ["publicKey"]);
  return { publicKey: string(input["publicKey"]) };
}
export function parseArmoryOpenRepositoryInput(value: unknown): ArmoryOpenRepositoryInput {
  const input = record(value, ["url"]);
  return { url: string(input["url"], 2048) };
}
export function parseArmorySaveSourceInput(value: unknown): ArmorySaveSourceInput {
  const input = record(value, ["id", "name", "repoUrl", "publicKey", "enabled", "authorization"]);
  if (typeof input["enabled"] !== "boolean") throw new TypeError("Invalid source state");
  const authorization = input["authorization"];
  if (authorization !== undefined && (typeof authorization !== "string" || authorization.length > 8192 || /[\x00-\x1f\x7f]/u.test(authorization))) {
    throw new TypeError("Invalid source authorization");
  }
  return {
    ...(input["id"] === undefined ? {} : { id: string(input["id"]) }),
    name: string(input["name"], 128),
    repoUrl: string(input["repoUrl"], 2048),
    publicKey: string(input["publicKey"]),
    enabled: input["enabled"],
    ...(authorization === undefined ? {} : { authorization }),
  };
}
