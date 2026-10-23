import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectedSnapshot, type OperationResult, type SliverSnapshot } from "../../../shared/contracts";
import { RUSTHOUND_ARMORY_COLLECTOR_ID, type AdCollectorSummary, type AdCollectionSummary } from "../../../shared/ad-explorer-contracts";
import type { BeaconSummary, SessionSummary, TargetCatalogEntry, TargetCatalogPage, TargetRef } from "../../../shared/target-contracts";
import { ADExplorerPage } from "./ADExplorerPage";

const session: SessionSummary = {
  mode: "session", id: "session-one", name: "workstation", hostname: "workstation-1", hostId: "host-one",
  username: "CORP\\alice", os: "windows", arch: "amd64", transport: "mtls", remoteAddress: "192.0.2.10:4444",
  activeC2: "mtls://example.test:8888", executable: "client", version: "1.7.6", locale: "en-US",
  integrity: "Medium", burned: false, liveness: "active",
};
const beacon: BeaconSummary = {
  ...session, mode: "beacon", id: "beacon-one", name: "server", hostname: "server-1", hostId: "host-two",
  checkinStatus: "on-time",
};
const sessionRef: TargetRef = { mode: "session", id: session.id, backendEpoch: 7, domainRevision: 1, fingerprint: "a".repeat(64) };
const beaconRef: TargetRef = { mode: "beacon", id: beacon.id, backendEpoch: 7, domainRevision: 1, fingerprint: "b".repeat(64) };
const collector: AdCollectorSummary = {
  id: "sharphound:verified:file", name: "Verified SharpHound CE", description: "Pinned SharpHound CE assembly",
  source: "native-file", compatibility: "verified", collectionMethods: ["Default", "DCOnly", "ComputerOnly", "Session"], available: true,
};
const customCollector: AdCollectorSummary = {
  id: "sharphound:custom:file", name: "User-supplied SharpHound", description: "Choose your own assembly",
  source: "native-file", compatibility: "operator-supplied", collectionMethods: ["Default", "DCOnly", "ComputerOnly", "Session"], available: true,
};
const customScript: AdCollectorSummary = {
  id: "sharphound:custom:script", name: "User-supplied Invoke-BloodHound", description: "Choose your own PowerShell script",
  source: "native-file", compatibility: "operator-supplied", collectionMethods: ["Default", "DCOnly", "ComputerOnly", "Session"], available: true,
};
const rustHound: AdCollectorSummary = {
  id: RUSTHOUND_ARMORY_COLLECTOR_ID, name: "RustHound CE v2.5.27 (in memory)",
  description: "Signed Armory extension", source: "armory", compatibility: "verified",
  collectionMethods: ["LdapOnly", "DCOnly", "All"], available: true,
};

const collections: AdCollectionSummary[] = [
  { id: "11111111-1111-4111-8111-111111111111", name: "AD north.example", createdAt: "2026-10-22T12:00:00.000Z" },
  { id: "22222222-2222-4222-8222-222222222222", name: "AD south.example", createdAt: "2026-10-23T12:00:00.000Z" },
];

function snapshot(): SliverSnapshot {
  const value = disconnectedSnapshot();
  value.connection = { managedServer: null, status: "connected", epoch: 7, incarnation: 1,
    server: "sliver.example.test:31337", operator: "alice", configName: "Production", version: "1.7.6" };
  value.domains.sessions = { status: "ready", revision: 1, items: [session], page: { limit: 500, total: 1, truncated: false } };
  value.domains.beacons = { status: "ready", revision: 1, items: [beacon], page: { limit: 500, total: 1, truncated: false } };
  value.targetContext.selectableTargets = [sessionRef, beaconRef];
  return value;
}

function installAPI() {
  const listTargets = vi.fn(async ({ mode }: { mode: "session" | "beacon"; cursor?: string; limit?: number }): Promise<OperationResult<TargetCatalogPage>> => ({
    ok: true as const,
    value: { items: mode === "session" ? [{ target: session, ref: sessionRef }] : [{ target: beacon, ref: beaconRef }],
      page: { limit: 100, total: 1, truncated: false } },
  }));
  const listAdCollectors = vi.fn(async (target: TargetRef) => ({ ok: true as const, value: { target, collectors: [collector, customCollector, customScript] } }));
  const runAdCollector = vi.fn(async () => ({ ok: true as const, value: {
    state: "imported" as const, collectorId: collector.id, targetId: session.id,
    domain: "corp.example.com", message: "Collection imported into AD Explorer.", projectId: "project-one",
  } }));
  const listAdCollections = vi.fn(async (): Promise<OperationResult<AdCollectionSummary[]>> => ({ ok: true, value: collections }));
  const openBeagleWindow = vi.fn(async (_input?: { projectId: string }): Promise<OperationResult> => ({ ok: true }));
  Object.defineProperty(window, "sliver", { configurable: true, value: { listTargets, listAdCollectors, runAdCollector, listAdCollections, openBeagleWindow } });
  return { listTargets, listAdCollectors, runAdCollector, listAdCollections, openBeagleWindow };
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.unstubAllGlobals();
});

describe("ADExplorerPage", () => {
  it("shows the matching subtitle and opens the clicked collection by its project ID", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    render(<ADExplorerPage snapshot={snapshot()} />);
    expect(screen.getByText("Active Directory")).toHaveClass("eyebrow");
    expect(screen.getByRole("tab", { name: "Windows Targets" })).toHaveAttribute("aria-selected", "true");
    expect(api.listAdCollections).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: "Collections" }));
    expect(screen.queryByRole("button", { name: /Select session/u })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Open collection AD south.example" }));
    expect(api.openBeagleWindow).toHaveBeenCalledExactlyOnceWith({ projectId: collections[1]!.id });
    expect(api.runAdCollector).not.toHaveBeenCalled();
  });

  it("keeps the selected target and draft when switching between tabs", async () => {
    const user = userEvent.setup();
    installAPI();
    render(<ADExplorerPage snapshot={snapshot()} />);
    await user.click(screen.getByRole("button", { name: "Select session workstation-1 (session-one)" }));
    await user.type(screen.getByRole("textbox", { name: "Windows domain" }), "draft.example.com");
    await user.click(screen.getByRole("tab", { name: "Collections" }));
    await screen.findByRole("button", { name: "Open collection AD north.example" });
    await user.click(screen.getByRole("tab", { name: "Windows Targets" }));
    expect(screen.getByRole("textbox", { name: "Windows domain" })).toHaveValue("draft.example.com");
    expect(screen.getByRole("navigation", { name: "AD Explorer navigation" })).toHaveTextContent("workstation-1");
  });

  it("provides a target-selection path when there are no saved collections", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    api.listAdCollections.mockResolvedValue({ ok: true, value: [] });
    render(<ADExplorerPage snapshot={snapshot()} />);
    await user.click(screen.getByRole("tab", { name: "Collections" }));
    expect(await screen.findByText("No collections yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View Windows Targets" }));
    expect(screen.getByRole("tab", { name: "Windows Targets" })).toHaveAttribute("aria-selected", "true");
  });

  it("reports collection loading failures and retries without showing a false empty state", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    api.listAdCollections.mockResolvedValueOnce({ ok: false, error: "Collection storage is unavailable." });
    render(<ADExplorerPage snapshot={snapshot()} />);
    await user.click(screen.getByRole("tab", { name: "Collections" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Collection storage is unavailable.");
    expect(screen.queryByText("No collections yet")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh collections" }));
    expect(await screen.findByRole("button", { name: "Open collection AD north.example" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refreshes collections when returning from an Explorer window", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    api.listAdCollections.mockResolvedValueOnce({ ok: true, value: [collections[0]!] });
    render(<ADExplorerPage snapshot={snapshot()} />);
    await user.click(screen.getByRole("tab", { name: "Collections" }));
    await screen.findByRole("button", { name: "Open collection AD north.example" });
    expect(screen.queryByRole("button", { name: "Open collection AD south.example" })).not.toBeInTheDocument();
    fireEvent.focus(window);
    expect(await screen.findByRole("button", { name: "Open collection AD south.example" })).toBeInTheDocument();
  });

  it("shows an open failure and keeps the collection available to retry", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    api.openBeagleWindow.mockResolvedValueOnce({ ok: false, error: "This collection is no longer available." });
    render(<ADExplorerPage snapshot={snapshot()} />);
    await user.click(screen.getByRole("tab", { name: "Collections" }));
    const collection = await screen.findByRole("button", { name: "Open collection AD north.example" });
    await user.click(collection);
    expect(await screen.findByRole("alert")).toHaveTextContent("This collection is no longer available.");
    expect(collection).toBeEnabled();
  });

  it("drills into a target with breadcrumbs and clears its draft and credentials when returning", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    api.listAdCollectors.mockImplementation(async (target) => ({
      ok: true as const, value: { target, collectors: [rustHound, collector] },
    }));
    render(<ADExplorerPage snapshot={snapshot()} />);

    expect(screen.queryByRole("textbox", { name: "Windows domain" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select session workstation-1 (session-one)" }));
    const back = screen.getByRole("link", { name: "Windows targets" });
    const breadcrumbs = screen.getByRole("navigation", { name: "AD Explorer navigation" });
    expect(within(breadcrumbs).getByText("workstation-1")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Domain Unknown domain" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Select beacon server-1 (beacon-one)" })).not.toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Windows domain" }), "unsaved.example.com");
    await user.type(await screen.findByRole("textbox", { name: "LDAP server FQDN (optional)" }), "dc.example.com");
    await user.click(screen.getByRole("switch", { name: "Use LDAPS" }));
    await user.type(screen.getByRole("textbox", { name: "AD user" }), "alice@example.com");
    await user.type(screen.getByLabelText("AD password"), "discard-this-secret");
    await user.click(back);

    expect(screen.getByRole("region", { name: "Domain Unknown domain" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Windows domain" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select session workstation-1 (session-one)" }));
    expect(screen.getByRole("textbox", { name: "Windows domain" })).toHaveValue("");
    expect(await screen.findByRole("textbox", { name: "LDAP server FQDN (optional)" })).toHaveValue("");
    expect(screen.getByRole("switch", { name: "Use LDAPS" })).not.toBeChecked();
    expect(screen.getByRole("textbox", { name: "AD user" })).toHaveValue("");
    expect(screen.getByLabelText("AD password")).toHaveValue("");
    expect(api.runAdCollector).not.toHaveBeenCalled();
    expect(api.openBeagleWindow).not.toHaveBeenCalled();
  });

  it("groups Windows targets under an honest unknown domain until an operator assigns one", async () => {
    const user = userEvent.setup();
    installAPI();
    const current = snapshot();
    const view = render(<ADExplorerPage snapshot={current} />);

    const unknown = screen.getByRole("region", { name: "Domain Unknown domain" });
    expect(within(unknown).getByRole("button", { name: "Select session workstation-1 (session-one)" })).toBeInTheDocument();
    expect(within(unknown).getByRole("button", { name: "Select beacon server-1 (beacon-one)" })).toBeInTheDocument();
    await user.click(within(unknown).getByRole("button", { name: "Select session workstation-1 (session-one)" }));
    await user.type(screen.getByRole("textbox", { name: "Windows domain" }), "corp.example.com");
    await user.click(screen.getByRole("button", { name: "Assign domain" }));
    await user.click(screen.getByRole("link", { name: "Windows targets" }));

    expect(within(screen.getByRole("region", { name: "Domain corp.example.com" }))
      .getByRole("button", { name: "Select session workstation-1 (session-one)" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Domain Unknown domain" }))
      .getByRole("button", { name: "Select beacon server-1 (beacon-one)" })).toBeInTheDocument();
    view.unmount();
    render(<ADExplorerPage snapshot={current} />);
    expect(within(screen.getByRole("region", { name: "Domain corp.example.com" }))
      .getByRole("button", { name: "Select session workstation-1 (session-one)" })).toBeInTheDocument();
  });

  it("distinguishes same-named beacons by target ID", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    const current = snapshot();
    const second: BeaconSummary = { ...beacon, id: "beacon-two" };
    const secondRef: TargetRef = { ...beaconRef, id: second.id, fingerprint: "c".repeat(64) };
    current.domains.beacons.items = [beacon, second];
    current.targetContext.selectableTargets = [sessionRef, beaconRef, secondRef];
    api.listTargets.mockImplementation(async ({ mode }) => ({
      ok: true as const,
      value: { items: mode === "session" ? [{ target: session, ref: sessionRef }] :
        [{ target: beacon, ref: beaconRef }, { target: second, ref: secondRef }],
      page: { limit: 100, total: mode === "session" ? 1 : 2, truncated: false } },
    }));
    render(<ADExplorerPage snapshot={current} />);

    expect(screen.getByRole("button", { name: "Select beacon server-1 (beacon-one)" })).toHaveTextContent("beacon-o");
    await user.click(screen.getByRole("button", { name: "Select beacon server-1 (beacon-two)" }));
    await waitFor(() => expect(api.listAdCollectors).toHaveBeenCalledWith(secondRef));
  });

  it("uses target catalog cursors, never snapshot cursors, to reveal additional Windows targets", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    const current = snapshot();
    current.domains.sessions.page = { limit: 500, total: 2, truncated: true, nextCursor: "snapshot-cursor" };
    const second: SessionSummary = { ...session, id: "session-two", name: "second", hostname: "workstation-2" };
    const secondRef: TargetRef = { ...sessionRef, id: second.id, fingerprint: "c".repeat(64) };
    api.listTargets.mockImplementation(async ({ mode, cursor }) => ({
      ok: true as const,
      value: cursor
        ? { items: [{ target: second, ref: secondRef }] as TargetCatalogEntry[], page: { limit: 100, total: 2, truncated: false } }
        : { items: mode === "session" ? [{ target: session, ref: sessionRef }] : [{ target: beacon, ref: beaconRef }],
          page: { limit: 100, total: mode === "session" ? 2 : 1, truncated: mode === "session", ...(mode === "session" ? { nextCursor: "catalog-cursor" } : {}) } },
    }));

    render(<ADExplorerPage snapshot={current} />);
    await user.click(await screen.findByRole("button", { name: "Load more sessions" }));
    expect(api.listTargets).toHaveBeenCalledWith({ mode: "session", cursor: "catalog-cursor", limit: 100 });
    expect(api.listTargets).not.toHaveBeenCalledWith(expect.objectContaining({ cursor: "snapshot-cursor" }));
    expect(await screen.findByRole("button", { name: "Select session workstation-2 (session-two)" })).toBeInTheDocument();
  });

  it("passes the assigned DNS domain and main-issued target reference to the collector", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    render(<ADExplorerPage snapshot={snapshot()} />);
    await user.click(screen.getByRole("button", { name: "Select session workstation-1 (session-one)" }));
    await waitFor(() => expect(api.listAdCollectors).toHaveBeenCalledWith(sessionRef));
    await user.type(screen.getByRole("textbox", { name: "Windows domain" }), "corp.example.com");
    await user.click(await screen.findByRole("button", { name: "Run collector" }));

    expect(api.runAdCollector).toHaveBeenCalledExactlyOnceWith({
      target: sessionRef, collectorId: "sharphound:verified:file", domain: "corp.example.com", collectionMethod: "Default",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Collection imported into AD Explorer.");
    expect(api.openBeagleWindow).not.toHaveBeenCalled();
  });

  it("does not show a completed collection under a different selected target", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    let finishRun!: () => void;
    api.runAdCollector.mockImplementation(() => new Promise((resolve) => {
      finishRun = () => resolve({ ok: true as const, value: {
        state: "imported" as const, collectorId: collector.id, targetId: session.id,
        domain: "corp.example.com", message: "Session collection imported.", projectId: "project-one",
      } });
    }));
    render(<ADExplorerPage snapshot={snapshot()} />);
    await user.click(screen.getByRole("button", { name: "Select session workstation-1 (session-one)" }));
    await user.type(screen.getByRole("textbox", { name: "Windows domain" }), "corp.example.com");
    await user.click(await screen.findByRole("button", { name: "Run collector" }));
    await user.click(screen.getByRole("link", { name: "Windows targets" }));
    await user.click(screen.getByRole("button", { name: "Select beacon server-1 (beacon-one)" }));
    expect(screen.getByText("A collection is running on another target.")).toBeInTheDocument();
    finishRun();
    await waitFor(() => expect(screen.queryByText("A collection is running on another target.")).not.toBeInTheDocument());
    expect(screen.queryByText("Session collection imported.")).not.toBeInTheDocument();
  });

  it("keeps custom collectors collapsed until the operator opens Other collectors", async () => {
    const user = userEvent.setup();
    installAPI();
    render(<ADExplorerPage snapshot={snapshot()} />);
    await user.click(screen.getByRole("button", { name: "Select session workstation-1 (session-one)" }));
    const disclosure = await screen.findByRole("button", { name: "Other collectors" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Use your own SharpHound-compatible .exe" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use your own Invoke-BloodHound .ps1" })).not.toBeInTheDocument();

    await user.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Use your own SharpHound-compatible .exe" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Use your own Invoke-BloodHound .ps1" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Run collector" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Windows targets" }));
    await user.click(screen.getByRole("button", { name: "Select beacon server-1 (beacon-one)" }));
    expect(await screen.findByRole("button", { name: "Other collectors" })).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps an operator-supplied executable separate from verified defaults", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    api.listAdCollectors.mockImplementation(async (target) => ({
      ok: true as const,
      value: { target, collectors: [customCollector] },
    }));
    render(<ADExplorerPage snapshot={snapshot()} />);
    await user.click(screen.getByRole("button", { name: "Select session workstation-1 (session-one)" }));
    await user.click(await screen.findByRole("button", { name: "Other collectors" }));
    const advanced = await screen.findByRole("button", { name: "Use your own SharpHound-compatible .exe" });
    expect(screen.getByText("No verified Beagle-compatible collector is available for this target.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run collector" })).toBeDisabled();
    expect(advanced).toHaveAttribute("aria-pressed", "false");
    await user.click(advanced);
    expect(advanced).toHaveAttribute("aria-pressed", "true");
    await user.type(screen.getByRole("textbox", { name: "Windows domain" }), "corp.example.com");
    await user.click(screen.getByRole("button", { name: "Run user-supplied collector" }));
    expect(api.runAdCollector).toHaveBeenCalledExactlyOnceWith({
      target: sessionRef, collectorId: "sharphound:custom:file", domain: "corp.example.com", collectionMethod: "Default",
    });
  });

  it("offers a PowerShell script only through the explicit advanced choice", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    api.listAdCollectors.mockImplementation(async (target) => ({
      ok: true as const,
      value: { target, collectors: [customScript] },
    }));
    render(<ADExplorerPage snapshot={snapshot()} />);
    await user.click(screen.getByRole("button", { name: "Select session workstation-1 (session-one)" }));
    await user.click(await screen.findByRole("button", { name: "Other collectors" }));
    const choice = await screen.findByRole("button", { name: "Use your own Invoke-BloodHound .ps1" });
    expect(screen.getByRole("button", { name: "Run collector" })).toBeDisabled();
    expect(screen.getByText(/must accept the fixed domain, method, and output path/u)).toBeInTheDocument();
    await user.click(choice);
    await user.type(screen.getByRole("textbox", { name: "Windows domain" }), "corp.example.com");
    await user.click(screen.getByRole("button", { name: "Run user-supplied collector" }));
    expect(api.runAdCollector).toHaveBeenCalledExactlyOnceWith({
      target: sessionRef, collectorId: "sharphound:custom:script", domain: "corp.example.com", collectionMethod: "Default",
    });
  });

  it("passes transient RustHound credentials and clears the password after collection", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    api.listAdCollectors.mockImplementation(async (target) => ({
      ok: true as const, value: { target, collectors: [rustHound, collector] },
    }));
    render(<ADExplorerPage snapshot={snapshot()} />);
    await user.click(screen.getByRole("button", { name: "Select session workstation-1 (session-one)" }));
    await waitFor(() => expect(screen.getAllByText("RustHound CE v2.5.27 (in memory)").length).toBeGreaterThan(0));
    await user.type(screen.getByRole("textbox", { name: "Windows domain" }), "corp.example.com");
    await user.type(screen.getByRole("textbox", { name: "LDAP server FQDN (optional)" }), "dc.corp.example.com");
    expect(screen.getByText(/LDAP simple bind sends the supplied password/u)).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Use LDAPS" }));
    expect(screen.getByText(/does not validate the domain controller certificate/u)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "AD user" }), "alice@corp.example.com");
    const password = screen.getByLabelText("AD password") as HTMLInputElement;
    await user.type(password, "one-use-secret");
    await user.click(screen.getByRole("button", { name: "Run collector" }));
    expect(api.runAdCollector).toHaveBeenCalledExactlyOnceWith({
      target: sessionRef, collectorId: RUSTHOUND_ARMORY_COLLECTOR_ID,
      domain: "corp.example.com", ldapFqdn: "dc.corp.example.com", ldaps: true, collectionMethod: "LdapOnly",
      credentials: { username: "alice@corp.example.com", password: "one-use-secret" },
    });
    await waitFor(() => expect(password).toHaveValue(""));
    expect(window.localStorage.getItem("ad-explorer.domain-assignments.v1")).not.toContain("one-use-secret");
  });
});
