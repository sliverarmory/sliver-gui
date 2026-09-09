import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../shared/application-settings-contracts";
import type { ArmoryAPI, ArmoryInstalledPackage, ArmoryPackage, ArmorySnapshot, ArmorySource, ArmoryTabId } from "../../shared/armory-contracts";
import type { OperationResult } from "../../shared/contracts";
import { ArmoryWindowApp } from "./ArmoryWindowApp";

const source: ArmorySource = {
  id: "source-1", name: "Team Armory", repoUrl: "https://packages.example/armory.json",
  publicKey: "RWTESTPUBLICKEY", enabled: true, hasAuthorization: true, hasAuthorizationCommand: false,
};
const installed: ArmoryInstalledPackage = {
  id: "alias:inventory", name: "Inventory", commandNames: ["inventory"], kind: "alias", version: "1.0.0",
  description: "A locally installed package.", repoUrl: "https://packages.example/inventory",
  installPath: "/home/operator/.sliver-client/aliases/inventory", packageId: "catalog-inventory", updateAvailable: true,
};
const catalogPackage: ArmoryPackage = {
  id: "catalog-inventory", name: "Inventory", commandName: "inventory", kind: "alias", version: "2.0.0",
  description: "An inventory package.", sourceId: source.id, sourceName: source.name,
  repoUrl: "https://packages.example/inventory", publicKey: "RWPACKAGEPUBLICKEY", installedId: installed.id, updateAvailable: true,
};
const bofPackage: ArmoryPackage = {
  id: "catalog-process-list", name: "Process List", commandName: "process-list", version: "2.0.0",
  description: "A process listing package.", sourceId: source.id, sourceName: source.name,
  repoUrl: "https://packages.example/process-list", publicKey: "RWPACKAGEPUBLICKEY",
  kind: "bof", updateAvailable: false,
};
const baseline: ArmorySnapshot = {
  rootPath: "/home/operator/.sliver-client", sources: [source], installed: [installed],
  packages: [catalogPackage, bofPackage], bundles: [{ id: "bundle-1", name: "Inventory Bundle", sourceId: source.id, sourceName: source.name, packageNames: ["Inventory", "Process List"] }],
  refreshedAt: "2026-09-09T00:00:00.000Z", warnings: [],
};
let currentSnapshot: ArmorySnapshot;
let currentTab: ArmoryTabId;
let changedListener: (() => void) | undefined;
let navigationListener: ((tab: ArmoryTabId) => void) | undefined;
const unsubscribeChanged = vi.fn();
const unsubscribeNavigation = vi.fn();
const success = (): Promise<OperationResult<ArmorySnapshot>> => Promise.resolve({ ok: true, value: currentSnapshot });
const api: ArmoryAPI = {
  getContext: vi.fn(async () => ({ ok: true as const, value: { tab: currentTab } })),
  snapshot: vi.fn(success), refreshCatalog: vi.fn(success), install: vi.fn(success), installBundle: vi.fn(success),
  uninstall: vi.fn(success), saveSource: vi.fn(success), removeSource: vi.fn(success), installLocal: vi.fn(success),
  getApplicationSettings: vi.fn(async () => DEFAULT_APPLICATION_SETTINGS_STATE),
  onChanged: vi.fn((listener) => { changedListener = listener; return unsubscribeChanged; }),
  onNavigationRequested: vi.fn((listener) => { navigationListener = listener; return unsubscribeNavigation; }),
  onApplicationSettingsChanged: vi.fn(() => () => undefined),
};

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  Object.defineProperty(Element.prototype, "setPointerCapture", { configurable: true, value: () => undefined });
  Object.defineProperty(Element.prototype, "releasePointerCapture", { configurable: true, value: () => undefined });
  Object.defineProperty(Element.prototype, "hasPointerCapture", { configurable: true, value: () => false });
});
afterAll(() => {
  vi.unstubAllGlobals();
  for (const key of ["getAnimations", "setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) Reflect.deleteProperty(Element.prototype, key);
});
beforeEach(() => {
  currentSnapshot = baseline;
  currentTab = "manage";
  changedListener = undefined;
  navigationListener = undefined;
  vi.clearAllMocks();
  for (const method of [api.snapshot, api.refreshCatalog, api.install, api.installBundle, api.uninstall, api.saveSource, api.removeSource, api.installLocal]) vi.mocked(method).mockImplementation(success);
  vi.mocked(api.getContext).mockImplementation(async () => ({ ok: true, value: { tab: currentTab } }));
  Object.defineProperty(window, "armory", { configurable: true, value: api });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "armory"); });

describe("ArmoryWindowApp", () => {
  it("loads console-shared packages, honors native navigation, and cleans up subscriptions", async () => {
    const view = render(<ArmoryWindowApp />);
    expect(await screen.findByRole("list", { name: "Installed packages" })).toHaveTextContent("Inventory");
    expect(screen.getByText(baseline.rootPath)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Manage" })).toHaveAttribute("aria-selected", "true");
    expect(api.refreshCatalog).not.toHaveBeenCalled();
    act(() => navigationListener?.("sources"));
    expect(screen.getByRole("tab", { name: "Sources" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("list", { name: "Armory sources" })).toHaveTextContent(source.name);
    view.unmount();
    expect(unsubscribeChanged).toHaveBeenCalledOnce();
    expect(unsubscribeNavigation).toHaveBeenCalledOnce();
  });

  it("reflects console changes on focus and change notifications", async () => {
    render(<ArmoryWindowApp />);
    await screen.findByRole("list", { name: "Installed packages" });
    currentSnapshot = { ...baseline, installed: [] };
    act(() => window.dispatchEvent(new Event("focus")));
    await screen.findByRole("heading", { name: "No Packages Installed" });
    currentSnapshot = baseline;
    act(() => changedListener?.());
    expect(await screen.findByRole("list", { name: "Installed packages" })).toHaveTextContent("Inventory");
  });

  it("requires confirmation before removing a shared package", async () => {
    const user = userEvent.setup();
    render(<ArmoryWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Remove Inventory" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("console's installed inventory");
    expect(api.uninstall).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.uninstall).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remove Inventory" }));
    vi.mocked(api.uninstall).mockImplementation(async () => ({ ok: true, value: { ...baseline, installed: [] } }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    await screen.findByRole("heading", { name: "No Packages Installed" });
    expect(api.uninstall).toHaveBeenCalledWith({ installedId: installed.id });
  });

  it("keeps a failed removal open with the actionable error", async () => {
    const user = userEvent.setup();
    vi.mocked(api.uninstall).mockResolvedValue({ ok: false, error: "Another package depends on inventory" });
    render(<ArmoryWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Remove Inventory" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(dialog).toHaveTextContent("Another package depends on inventory"));
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("filters BOFs and commands, installs by catalog identity, and keeps verification errors visible", async () => {
    currentTab = "install";
    const user = userEvent.setup();
    render(<ArmoryWindowApp />);
    const list = await screen.findByRole("list", { name: "Available packages" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Package type" }), "bof");
    expect(list).toHaveTextContent("Process List");
    expect(list).not.toHaveTextContent("Inventory");
    await user.type(screen.getByRole("searchbox", { name: "Search packages" }), "process-list");
    vi.mocked(api.install).mockResolvedValue({ ok: false, error: "Package signature verification failed" });
    await user.click(screen.getByRole("button", { name: "Install Process List" }));
    expect(api.install).toHaveBeenCalledWith({ packageId: bofPackage.id });
    expect(await screen.findByText("Package signature verification failed")).toBeInTheDocument();
    expect(screen.queryByText("Process List installed.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install Process List" })).toBeEnabled();
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(api.snapshot).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Package signature verification failed")).toBeInTheDocument();
  });

  it("updates an installed package using explicit replacement", async () => {
    const user = userEvent.setup();
    render(<ArmoryWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Update" }));
    expect(api.install).toHaveBeenCalledWith({ packageId: catalogPackage.id, replace: true });
    expect(await screen.findByText("Inventory updated.")).toBeInTheDocument();
  });

  it("installs a bundle and resets bundle filtering when navigating to Manage", async () => {
    currentTab = "install";
    const user = userEvent.setup();
    render(<ArmoryWindowApp />);
    await screen.findByRole("list", { name: "Available packages" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Package type" }), "bundle");
    await user.click(screen.getByRole("button", { name: "Install bundle Inventory Bundle" }));
    expect(api.installBundle).toHaveBeenCalledWith({ bundleId: "bundle-1" });
    await user.click(screen.getByRole("tab", { name: "Manage" }));
    expect(screen.getByRole("list", { name: "Installed packages" })).toHaveTextContent("Inventory");
  });

  it("preserves existing authorization when editing a source", async () => {
    currentTab = "sources";
    const user = userEvent.setup();
    render(<ArmoryWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Edit Team Armory" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Team Packages");
    await user.click(within(dialog).getByRole("button", { name: "Save Source" }));
    expect(api.saveSource).toHaveBeenCalledWith({ id: source.id, name: "Team Packages", repoUrl: source.repoUrl, publicKey: source.publicKey, enabled: true });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("passes only a public key and replace choice to the native signed-import dialog", async () => {
    currentTab = "install";
    const user = userEvent.setup();
    render(<ArmoryWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Import Signed Package" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Trusted Public Key" }), "RWPUBLISHERKEY");
    await user.click(within(dialog).getByRole("switch", { name: "Replace Existing Package" }));
    vi.mocked(api.installLocal).mockResolvedValue({ ok: false, error: "Archive contains an unsafe path" });
    await user.click(within(dialog).getByRole("button", { name: "Choose Archive and Signature" }));
    expect(api.installLocal).toHaveBeenCalledWith({ publicKey: "RWPUBLISHERKEY", replace: true });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Archive contains an unsafe path");
    expect(screen.queryByText("Signed package installed.")).not.toBeInTheDocument();
  });

  it("fetches a missing catalog once when opened from Install", async () => {
    currentTab = "install";
    currentSnapshot = { ...baseline, packages: [], bundles: [], refreshedAt: null };
    vi.mocked(api.refreshCatalog).mockResolvedValue({ ok: false, error: "Source unavailable" });
    render(<ArmoryWindowApp />);
    expect(await screen.findByText("Source unavailable")).toBeInTheDocument();
    expect(api.refreshCatalog).toHaveBeenCalledOnce();
  });

  it("shows source failures directly in the catalog", async () => {
    currentTab = "install";
    currentSnapshot = { ...baseline, packages: [], bundles: [], sources: [{ ...source, error: "Index signature is invalid" }] };
    render(<ArmoryWindowApp />);
    expect(await screen.findByText("Team Armory: Index signature is invalid")).toBeInTheDocument();
    expect(screen.getByText("Some Sources Could Not Be Refreshed")).toBeInTheDocument();
  });

  it("does not overwrite an installation with a stale inventory refresh", async () => {
    let resolveRefresh: ((result: OperationResult<ArmorySnapshot>) => void) | undefined;
    const user = userEvent.setup();
    render(<ArmoryWindowApp />);
    await screen.findByRole("list", { name: "Installed packages" });
    vi.mocked(api.snapshot).mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    act(() => window.dispatchEvent(new Event("focus")));
    vi.mocked(api.install).mockResolvedValue({ ok: true, value: { ...baseline, installed: [{ ...installed, version: "2.0.0", updateAvailable: false }] } });
    await user.click(screen.getByRole("button", { name: "Update" }));
    await screen.findByText("2.0.0");
    act(() => resolveRefresh?.({ ok: true, value: baseline }));
    await waitFor(() => expect(screen.getByRole("list", { name: "Installed packages" })).toHaveTextContent("2.0.0"));
    expect(screen.getByRole("list", { name: "Installed packages" })).not.toHaveTextContent("1.0.0");
  });
});
