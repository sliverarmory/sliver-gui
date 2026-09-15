import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toast, toast } from "@heroui/react";
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
  openRepository: vi.fn(async () => ({ ok: true as const })),
  copyPublicKey: vi.fn(async () => ({ ok: true as const })),
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
  toast.clear();
  for (const method of [api.snapshot, api.refreshCatalog, api.install, api.installBundle, api.uninstall, api.saveSource, api.removeSource, api.installLocal]) vi.mocked(method).mockImplementation(success);
  vi.mocked(api.openRepository).mockResolvedValue({ ok: true });
  vi.mocked(api.copyPublicKey).mockResolvedValue({ ok: true });
  vi.mocked(api.getContext).mockImplementation(async () => ({ ok: true, value: { tab: currentTab } }));
  Object.defineProperty(window, "armory", { configurable: true, value: api });
});
afterEach(() => {
  cleanup();
  toast.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "armory");
});

function renderArmoryApp(): ReturnType<typeof render> {
  return render(<><ArmoryWindowApp /><Toast.Provider placement="bottom" maxVisibleToasts={4} /></>);
}

describe("ArmoryWindowApp", () => {
  it.each([
    { tab: "manage", list: "Installed packages" },
    { tab: "install", list: "Available packages" },
  ] as const)("shows declared OS and architecture pairs in $tab listings", async ({ tab, list }) => {
    currentTab = tab;
    const targets = [
      { os: "darwin", arch: "arm64" },
      { os: "windows", arch: "386" },
      { os: "linux", arch: "riscv64" },
      { os: "windows", arch: "amd64" },
      { os: "windows", arch: "amd64" },
      { os: "plan9", arch: "mips" },
    ];
    currentSnapshot = {
      ...baseline,
      installed: [{ ...installed, targets }],
      packages: [{ ...catalogPackage, targets }],
    };
    renderArmoryApp();
    const packages = await screen.findByRole("list", { name: list });
    const row = within(packages).getByRole("heading", { name: "Inventory" }).closest("li")!;
    const platforms = within(row).getByRole("group", { name: "Supported platforms" });
    expect(platforms).toHaveTextContent("Windows · x64, x86");
    expect(platforms).toHaveTextContent("Linux · riscv64");
    expect(platforms).toHaveTextContent("macOS · ARM64");
    expect(platforms).toHaveTextContent("plan9 · mips");
    expect(within(platforms).getByTitle("windows/amd64, windows/386")).toHaveTextContent("Windows · x64, x86");
    expect(within(platforms).getByTitle("darwin/arm64")).toHaveTextContent("macOS · ARM64");
    expect(platforms.querySelector('[data-icon="windows"]')).toHaveAttribute("aria-hidden", "true");
    expect(platforms.querySelector('[data-icon="linux"]')).toHaveAttribute("aria-hidden", "true");
    expect(platforms.querySelector('[data-icon="apple"]')).toHaveAttribute("aria-hidden", "true");
    expect(within(platforms).getByTitle("plan9/mips").querySelector('[data-icon="desktop"]')).toBeInTheDocument();
    if (tab === "install") {
      const bundle = within(packages).getByRole("heading", { name: "Inventory Bundle" }).closest("li")!;
      expect(within(bundle).queryByRole("group", { name: "Supported platforms" })).not.toBeInTheDocument();
    }
  });

  it.each([
    { tab: "manage", list: "Installed packages", targets: undefined },
    { tab: "install", list: "Available packages", targets: [] },
  ] as const)("labels missing support metadata as unknown in $tab listings", async ({ tab, list, targets }) => {
    currentTab = tab;
    currentSnapshot = { ...baseline, packages: [{ ...catalogPackage, ...(targets ? { targets } : {}) }] };
    renderArmoryApp();
    const packages = await screen.findByRole("list", { name: list });
    const platforms = within(packages).getByRole("group", { name: "Supported platforms" });
    expect(platforms).toHaveTextContent("OS/Arch unknown");
    expect(platforms.querySelector("svg")).not.toBeInTheDocument();
  });

  it.each([
    { tab: "manage", list: "Installed packages" },
    { tab: "install", list: "Available packages" },
  ] as const)("combines platform pairs with search and package type in $tab listings", async ({ tab, list }) => {
    currentTab = tab;
    const entries: Pick<ArmoryInstalledPackage, "id" | "name" | "kind" | "targets">[] = [
      { id: "mixed", name: "Inventory", kind: "alias", targets: [{ os: "windows", arch: "amd64" }, { os: "linux", arch: "arm64" }] },
      { id: "native", name: "Native Inventory", kind: "alias", targets: [{ os: "windows", arch: "arm64" }] },
      { id: "extension", name: "Inventory Extension", kind: "extension", targets: [{ os: "windows", arch: "arm64" }] },
      { id: "other", name: "Other Package", kind: "alias", targets: [{ os: "windows", arch: "arm64" }] },
      { id: "legacy", name: "Legacy Inventory", kind: "alias", targets: [{ os: "darwin", arch: "386" }, { os: "plan9", arch: "riscv64" }] },
      { id: "unknown", name: "Unknown Support", kind: "alias" },
      { id: "empty", name: "Empty Support", kind: "alias", targets: [] },
    ];
    currentSnapshot = {
      ...baseline,
      installed: entries.map((entry) => ({ ...installed, ...entry, description: "", commandNames: [entry.id] })),
      packages: entries.map((entry) => ({ ...catalogPackage, ...entry, description: "", commandName: entry.id })),
    };
    const user = userEvent.setup();
    renderArmoryApp();
    await screen.findByRole("list", { name: list });
    const os = screen.getByRole("combobox", { name: "Operating system" });
    const arch = screen.getByRole("combobox", { name: "Architecture" });
    const type = screen.getByRole("combobox", { name: "Package type" });
    const search = screen.getByRole("searchbox", { name: "Search packages" });
    const titles = (): string[] => within(screen.getByRole("list", { name: list })).getAllByRole("heading").map((heading) => heading.textContent!);

    await user.selectOptions(os, "windows");
    expect(titles()).toEqual(["Inventory", "Native Inventory", "Inventory Extension", "Other Package"]);
    await user.selectOptions(arch, "arm64");
    expect(titles()).toEqual(["Native Inventory", "Inventory Extension", "Other Package"]);
    await user.selectOptions(type, "alias");
    expect(titles()).toEqual(["Native Inventory", "Other Package"]);
    await user.type(search, "inventory");
    expect(titles()).toEqual(["Native Inventory"]);

    // Filtering results must not remove choices from the current tab's inventory.
    for (const [value, label] of [["windows", "Windows"], ["linux", "Linux"], ["darwin", "macOS"], ["plan9", "plan9"]] as const) {
      expect(within(os).getByRole("option", { name: label })).toHaveValue(value);
    }
    for (const [value, label] of [["amd64", "x64"], ["386", "x86"], ["arm64", "ARM64"], ["riscv64", "riscv64"]] as const) {
      expect(within(arch).getByRole("option", { name: label })).toHaveValue(value);
    }

    await user.clear(search);
    await user.selectOptions(type, "all");
    await user.selectOptions(os, "");
    expect(titles()).toEqual(["Inventory", "Native Inventory", "Inventory Extension", "Other Package"]);
    await user.selectOptions(arch, "");
    expect(titles()).toEqual([...entries.map((entry) => entry.name), ...(tab === "install" ? ["Inventory Bundle"] : [])]);
  });

  it("retains platform selections across tabs and refreshes while updating inventory choices", async () => {
    currentSnapshot = {
      ...baseline,
      installed: [{ ...installed, targets: [{ os: "plan9", arch: "mips" }, { os: "darwin", arch: "386" }] }],
      packages: [{ ...catalogPackage, targets: [{ os: "linux", arch: "arm64" }] }],
    };
    const user = userEvent.setup();
    renderArmoryApp();
    await screen.findByRole("list", { name: "Installed packages" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Operating system" }), "plan9");
    await user.selectOptions(screen.getByRole("combobox", { name: "Architecture" }), "mips");
    await user.click(screen.getByRole("tab", { name: "Install" }));
    const os = screen.getByRole("combobox", { name: "Operating system" });
    const arch = screen.getByRole("combobox", { name: "Architecture" });
    expect(os).toHaveValue("plan9");
    expect(arch).toHaveValue("mips");
    expect(within(os).getByRole("option", { name: "Linux" })).toHaveValue("linux");
    expect(within(os).queryByRole("option", { name: "macOS" })).not.toBeInTheDocument();
    expect(within(arch).getByRole("option", { name: "ARM64" })).toHaveValue("arm64");
    expect(within(arch).queryByRole("option", { name: "x86" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No Packages Found" })).toBeInTheDocument();

    currentSnapshot = { ...currentSnapshot, packages: [{ ...catalogPackage, targets: [{ os: "windows", arch: "amd64" }] }] };
    act(() => changedListener?.());
    await waitFor(() => expect(within(os).getByRole("option", { name: "Windows" })).toHaveValue("windows"));
    expect(os).toHaveValue("plan9");
    expect(arch).toHaveValue("mips");
    expect(within(os).queryByRole("option", { name: "Linux" })).not.toBeInTheDocument();
    expect(within(arch).getByRole("option", { name: "x64" })).toHaveValue("amd64");
    expect(within(arch).queryByRole("option", { name: "ARM64" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No Packages Found" })).toBeInTheDocument();
    await user.selectOptions(os, "");
    await user.selectOptions(arch, "");
    expect(await screen.findByRole("list", { name: "Available packages" })).toHaveTextContent("Inventory");
    expect(within(os).queryByRole("option", { name: "plan9" })).not.toBeInTheDocument();
    expect(within(arch).queryByRole("option", { name: "mips" })).not.toBeInTheDocument();
  });

  it.each([
    { tab: "manage", list: "Installed packages", title: "Installed Packages" },
    { tab: "install", list: "Available packages", title: "Package Catalog" },
  ] as const)("keeps $tab controls outside its bounded HeroUI package scroll region", async ({ tab, list, title }) => {
    currentTab = tab;
    const user = userEvent.setup();
    renderArmoryApp();
    const packages = await screen.findByRole("list", { name: list });
    const scroll = screen.getByTestId(`armory-${tab}-scroll`);
    const controls = screen.getByTestId(`armory-${tab}-controls`);
    expect(scroll).toHaveClass("scroll-shadow", "overflow-y-auto", "flex-1");
    expect(scroll).toHaveAttribute("role", "region");
    expect(scroll).toHaveAttribute("tabindex", "0");
    expect(scroll).toContainElement(packages);
    expect(scroll).not.toContainElement(controls);
    expect(controls).toHaveClass("shrink-0");
    expect(controls).toContainElement(screen.getByRole("heading", { name: title }));
    expect(controls).toContainElement(screen.getByRole("searchbox", { name: "Search packages" }));
    expect(controls).toContainElement(screen.getByRole("combobox", { name: "Operating system" }));
    expect(controls).toContainElement(screen.getByRole("combobox", { name: "Architecture" }));
    expect(scroll).not.toContainElement(screen.getByRole("tablist", { name: "Armory features" }));
    expect(scroll).not.toContainElement(screen.getByRole("heading", { name: "Armory" }));
    expect(scroll).not.toContainElement(screen.getByText(baseline.rootPath));
    expect(screen.getByRole("main")).toHaveClass("min-h-0", "flex-1", "overflow-hidden");
    expect(screen.getByRole("main").parentElement).toHaveClass("h-screen", "overflow-hidden");
    await user.selectOptions(screen.getByRole("combobox", { name: "Package type" }), tab === "manage" ? "alias" : "bof");
    expect(screen.getByTestId(`armory-${tab}-scroll`)).not.toBe(scroll);
  });

  it("loads console-shared packages, honors native navigation, and cleans up subscriptions", async () => {
    const view = renderArmoryApp();
    expect(await screen.findByRole("list", { name: "Installed packages" })).toHaveTextContent("Inventory");
    expect(screen.getByText(baseline.rootPath)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Manage" })).toHaveAttribute("aria-selected", "true");
    expect(api.refreshCatalog).not.toHaveBeenCalled();
    act(() => navigationListener?.("sources"));
    expect(screen.getByRole("tab", { name: "Armories" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("list", { name: "Armory sources" })).toHaveTextContent(source.name);
    view.unmount();
    expect(unsubscribeChanged).toHaveBeenCalledOnce();
    expect(unsubscribeNavigation).toHaveBeenCalledOnce();
  });

  it("reflects console changes on focus and change notifications", async () => {
    renderArmoryApp();
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
    renderArmoryApp();
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
    renderArmoryApp();
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
    renderArmoryApp();
    await screen.findByRole("list", { name: "Available packages" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Package type" }), "bof");
    expect(screen.getByRole("list", { name: "Available packages" })).toHaveTextContent("Process List");
    expect(screen.getByRole("list", { name: "Available packages" })).not.toHaveTextContent("Inventory");
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
    renderArmoryApp();
    await user.click(await screen.findByRole("button", { name: "Update" }));
    expect(api.install).toHaveBeenCalledWith({ packageId: catalogPackage.id, replace: true });
    expect(await screen.findByText("Inventory updated.")).toBeInTheDocument();
  });

  it("shows operation success in a toast that expires after 20 seconds without moving the page layout", async () => {
    renderArmoryApp();
    await screen.findByRole("list", { name: "Installed packages" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const showSuccess = vi.spyOn(toast, "success");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check for Updates" })); });
    expect(showSuccess).toHaveBeenCalledWith("Package catalog refreshed.", expect.objectContaining({ timeout: 20_000 }));
    const feedback = screen.getByText("Package catalog refreshed.");
    expect(screen.getByRole("main")).not.toContainElement(feedback);
    await act(async () => { await vi.advanceTimersByTimeAsync(19_999); });
    expect(screen.getByText("Package catalog refreshed.")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.queryByText("Package catalog refreshed.")).not.toBeInTheDocument();
  });

  it("cleans up only the Armory success toasts when its window unmounts", async () => {
    const user = userEvent.setup();
    const view = renderArmoryApp();
    await screen.findByRole("list", { name: "Installed packages" });
    const showSuccess = vi.spyOn(toast, "success");
    await user.click(screen.getByRole("button", { name: "Check for Updates" }));
    await screen.findByText("Package catalog refreshed.");
    const ownToastId = showSuccess.mock.results[0]?.value;
    act(() => { toast.info("Unrelated notification", { timeout: 0 }); });
    const closeToast = vi.spyOn(toast, "close");
    view.rerender(<Toast.Provider placement="bottom" maxVisibleToasts={4} />);
    expect(closeToast).toHaveBeenCalledExactlyOnceWith(ownToastId);
    expect(screen.queryByText("Package catalog refreshed.")).not.toBeInTheDocument();
    expect(screen.getByText("Unrelated notification")).toBeInTheDocument();
  });

  it.each([
    { tab: "manage", list: "Installed packages" },
    { tab: "install", list: "Available packages" },
  ] as const)("shows available author attribution in $tab package details and supports older manifests", async ({ tab, list }) => {
    currentTab = tab;
    const authors = { originalAuthor: "Ada Example", extensionAuthor: "Armory Maintainer" };
    currentSnapshot = {
      ...baseline,
      installed: [{ ...installed, id: "extensions/inventory", kind: "bof", installPath: "/home/operator/.sliver-client/extensions/inventory", ...authors }],
      packages: [{ ...catalogPackage, kind: "bof", ...authors }],
    };
    const user = userEvent.setup();
    renderArmoryApp();
    const packages = await screen.findByRole("list", { name: list });
    await user.click(within(packages).getByRole("button", { name: "Details" }));
    const dialog = await screen.findByRole("dialog", { name: "Inventory" });
    expect(within(dialog).getByText("Original Author").closest("dt")?.nextElementSibling).toHaveTextContent("Ada Example");
    expect(within(dialog).getByText("Extension Author").closest("dt")?.nextElementSibling).toHaveTextContent("Armory Maintainer");
    const expectedIcons: ReadonlyArray<readonly [string, string]> = [
      ["Commands", "terminal"],
      ["Original Author", "user"],
      ["Extension Author", "user-pen"],
      ["Repository", "code-branch"],
      ...(tab === "manage"
        ? [["Installed Directory", "folder-open"]] as const
        : [["Source", "globe"], ["Package Public Key", "key"]] as const),
    ];
    for (const [label, iconName] of expectedIcons) {
      const icon = within(dialog).getByText(label).closest("dt")?.querySelector("svg");
      expect(icon).toHaveAttribute("aria-hidden", "true");
      expect(icon).toHaveAttribute("data-icon", iconName);
      expect(icon).toHaveClass("size-3.5", "shrink-0", "text-muted");
    }
    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    currentSnapshot = { ...baseline, packages: [catalogPackage] };
    act(() => changedListener?.());
    await waitFor(() => expect(api.snapshot).toHaveBeenCalledTimes(2));
    await user.click(within(screen.getByRole("list", { name: list })).getByRole("button", { name: "Details" }));
    const legacyDialog = await screen.findByRole("dialog", { name: "Inventory" });
    expect(within(legacyDialog).queryByText("Original Author")).not.toBeInTheDocument();
    expect(within(legacyDialog).queryByText("Extension Author")).not.toBeInTheDocument();
    expect(within(legacyDialog).getByText("Repository")).toBeInTheDocument();
  });

  it.each([
    { tab: "manage", repoUrl: "https://packages.example/inventory", href: "https://packages.example/inventory" },
    { tab: "install", repoUrl: "http://packages.example/inventory", href: "http://packages.example/inventory" },
    { tab: "manage", repoUrl: "HTTPS://PACKAGES.EXAMPLE/inventory", href: "https://packages.example/inventory" },
    { tab: "install", repoUrl: "  https://packages.example/inventory  ", href: "https://packages.example/inventory" },
  ] as const)("opens $repoUrl through IPC without navigating Armory", async ({ tab, repoUrl, href }) => {
    currentTab = tab;
    currentSnapshot = { ...baseline, installed: [{ ...installed, repoUrl }], packages: [{ ...catalogPackage, repoUrl }], bundles: [] };
    const user = userEvent.setup();
    renderArmoryApp();
    await user.click(await screen.findByRole("button", { name: "Details" }));
    const dialog = await screen.findByRole("dialog", { name: "Inventory" });
    const link = within(dialog).getByRole("link", { name: /opens in browser/ });
    expect(link.textContent).toBe(repoUrl);
    expect(link).toHaveAttribute("href", href);
    expect(link).not.toHaveAttribute("target");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    const armoryUrl = window.location.href;
    await user.click(link);
    expect(api.openRepository).toHaveBeenCalledExactlyOnceWith({ url: href });
    expect(window.location.href).toBe(armoryUrl);
    expect(dialog).toBeInTheDocument();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,example",
    "file:///tmp/package",
    "ftp://packages.example/inventory",
    "not a URL",
    "/relative/package",
    "//packages.example/inventory",
    "https://user:secret@packages.example/inventory",
    "https:packages.example/inventory",
    "https:///packages.example/inventory",
    "https://@packages.example/inventory",
    "https://packages.example\\inventory",
    "https://packa\nges.example/inventory",
    "https://packages.example/a b",
    "https://packages.example/a\u0001b",
  ])("keeps unsafe or non-absolute repository value %s as plain text", async (repoUrl) => {
    currentSnapshot = { ...baseline, installed: [{ ...installed, repoUrl }] };
    const user = userEvent.setup();
    renderArmoryApp();
    await user.click(await screen.findByRole("button", { name: "Details" }));
    const dialog = await screen.findByRole("dialog", { name: "Inventory" });
    const repositoryValue = within(dialog).getByText("Repository").closest("dt")?.nextElementSibling;
    expect(repositoryValue?.textContent).toBe(repoUrl);
    expect(within(dialog).queryByRole("link")).not.toBeInTheDocument();
    expect(dialog.querySelector("[href]")).toBeNull();
    await user.click(repositoryValue!);
    expect(api.openRepository).not.toHaveBeenCalled();
  });

  it("opens a repository from the keyboard and keeps browser failures in its details dialog", async () => {
    const user = userEvent.setup();
    vi.mocked(api.openRepository).mockResolvedValue({ ok: false, error: "Your browser could not be opened" });
    renderArmoryApp();
    await user.click(await screen.findByRole("button", { name: "Details" }));
    const dialog = await screen.findByRole("dialog", { name: "Inventory" });
    const link = within(dialog).getByRole("link", { name: /opens in browser/ });
    const armoryUrl = window.location.href;
    link.focus();
    await user.keyboard("{Enter}");
    expect(api.openRepository).toHaveBeenCalledExactlyOnceWith({ url: installed.repoUrl });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Your browser could not be opened");
    expect(window.location.href).toBe(armoryUrl);
    expect(dialog).toBeInTheDocument();
  });

  it.each(["click", "Enter", "Space"] as const)("copies the catalog public key exactly once through IPC using %s", async (activation) => {
    currentTab = "install";
    const publicKey = "RW" + "a".repeat(120);
    currentSnapshot = { ...baseline, packages: [{ ...catalogPackage, publicKey }], bundles: [] };
    const user = userEvent.setup();
    renderArmoryApp();
    await user.click(await screen.findByRole("button", { name: "Details" }));
    const dialog = await screen.findByRole("dialog", { name: "Inventory" });
    const copy = within(dialog).getByRole("button", { name: "Copy package public key" });
    expect(copy).toHaveClass("button--full-width", "whitespace-normal");
    expect(copy.querySelector("code")).toHaveClass("font-mono", "text-xs", "break-all");
    expect(copy).toHaveTextContent(publicKey);
    if (activation === "click") await user.click(copy);
    else {
      copy.focus();
      await user.keyboard(activation === "Enter" ? "{Enter}" : " ");
    }
    expect(api.copyPublicKey).toHaveBeenCalledExactlyOnceWith({ publicKey });
    expect(await within(dialog).findByRole("status")).toHaveTextContent("Copied to clipboard.");
    expect(within(dialog).getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(dialog).toBeInTheDocument();
    expect(api.openRepository).not.toHaveBeenCalled();
  });

  it("shows a public-key copy failure locally without copied feedback", async () => {
    currentTab = "install";
    currentSnapshot = { ...baseline, packages: [catalogPackage], bundles: [] };
    vi.mocked(api.copyPublicKey).mockResolvedValue({ ok: false, error: "The clipboard is unavailable" });
    const user = userEvent.setup();
    renderArmoryApp();
    await user.click(await screen.findByRole("button", { name: "Details" }));
    const dialog = await screen.findByRole("dialog", { name: "Inventory" });
    await user.click(within(dialog).getByRole("button", { name: "Copy package public key" }));
    expect(api.copyPublicKey).toHaveBeenCalledExactlyOnceWith({ publicKey: catalogPackage.publicKey });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The clipboard is unavailable");
    expect(within(dialog).queryByText("Copied to clipboard.")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Copy package public key" })).toBeEnabled();
  });

  it("installs a bundle and resets bundle filtering when navigating to Manage", async () => {
    currentTab = "install";
    const user = userEvent.setup();
    renderArmoryApp();
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
    renderArmoryApp();
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
    renderArmoryApp();
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
    renderArmoryApp();
    expect(await screen.findByText("Source unavailable")).toBeInTheDocument();
    expect(api.refreshCatalog).toHaveBeenCalledOnce();
  });

  it("shows source failures directly in the catalog", async () => {
    currentTab = "install";
    currentSnapshot = { ...baseline, packages: [], bundles: [], sources: [{ ...source, error: "Index signature is invalid" }] };
    renderArmoryApp();
    expect(await screen.findByText("Team Armory: Index signature is invalid")).toBeInTheDocument();
    expect(screen.getByText("Some Sources Could Not Be Refreshed")).toBeInTheDocument();
  });

  it("does not overwrite an installation with a stale inventory refresh", async () => {
    let resolveRefresh: ((result: OperationResult<ArmorySnapshot>) => void) | undefined;
    const user = userEvent.setup();
    renderArmoryApp();
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
