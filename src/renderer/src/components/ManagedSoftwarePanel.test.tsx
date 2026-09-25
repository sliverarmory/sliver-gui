import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CloudDeploymentAPI, CloudProvisioningTranscript } from "../../../shared/cloud-deployment-ipc";
import type { CloudDnsRecord, CloudDnsZone } from "../../../shared/cloud-dns-contracts";
import type { OperationResult } from "../../../shared/contracts";
import type { LocalRedirectorRecord, SoftwareDeploymentState, SoftwareInstallProgress, SoftwareInstallProgressSnapshot } from "../../../shared/software-deployment-contracts";
import { ManagedSoftwarePanel } from "./ManagedSoftwarePanel";

vi.mock("./CloudProvisioningTerminal", () => ({
  CloudProvisioningTerminal: ({ transcript }: { transcript: CloudProvisioningTranscript }) =>
    <pre aria-label="SSH installation output" data-sequences={transcript.chunks.map(({ sequence }) => sequence).join(",")}>{transcript.chunks.map(({ bytes }) => new TextDecoder().decode(bytes)).join("")}</pre>,
}));

const deploymentId = "11111111-1111-4111-8111-111111111111";
const credentialId = "22222222-2222-4222-8222-222222222222";
const zone: CloudDnsZone = {
  id: "zone-1", name: "example.com.", provider: "aws", private: false, recordCount: 1, resourceGroupName: null,
};
const otherZone: CloudDnsZone = { ...zone, id: "zone-2", name: "other.test.", recordCount: 0 };
const record: CloudDnsRecord = {
  id: "record-1", zoneId: zone.id, zoneName: zone.name, name: "beacon", type: "A", ttl: 300,
  values: ["198.51.100.12"], editable: true, readOnlyReason: null, version: "1",
};
const otherIpRecord: CloudDnsRecord = { ...record, id: "record-2", name: "other", values: ["198.51.100.13"] };
const ipv6Record: CloudDnsRecord = { ...record, id: "record-3", name: "ipv6", type: "AAAA", values: ["2001:db8::12"] };
const installed: LocalRedirectorRecord = {
  id: "33333333-3333-4333-8333-333333333333", deploymentId, recipeId: "caddy",
  category: "HTTP Redirectors", subcategory: "local", status: "active", publicIp: "198.51.100.12",
  domains: [], publicUrl: "http://198.51.100.12", frontendPorts: [80], ingressPortsOwned: [80],
  listener: { ownership: "managed", kind: "http", host: "127.0.0.1", port: 8000, jobId: 42, domain: "" },
  serviceName: "sliver-gui-caddy-33333333-3333-4333-8333-333333333333.service",
  createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z", lastCheckedAt: null, lastError: null,
};

type PanelAPI = Pick<CloudDeploymentAPI,
  "getSoftwareState" | "getSoftwareInstallProgress" | "onSoftwareInstallProgress" | "getTerminalRuntime" |
  "listSoftwareListeners" | "installLocalRedirector" | "removeLocalRedirector" | "listDnsZones" | "listDnsRecords" | "createDnsRecord" | "onChanged">;

const api: PanelAPI = {
  getSoftwareState: vi.fn(async (): Promise<OperationResult<SoftwareDeploymentState>> => ({ ok: true, value: { v: 1, revision: 7, records: [] } })),
  getSoftwareInstallProgress: vi.fn(async () => ({ ok: true as const, value: null })),
  onSoftwareInstallProgress: vi.fn(() => () => undefined),
  getTerminalRuntime: vi.fn(async () => ({ ok: false as const, error: "Not used by this test" })),
  listSoftwareListeners: vi.fn(async () => ({ ok: true as const, value: [
    { jobId: 42, kind: "http" as const, port: 9000, domain: "", eligible: true, reason: null },
    { jobId: 43, kind: "http" as const, port: 9001, domain: "", eligible: false, reason: "Bound to 0.0.0.0" },
  ] })),
  installLocalRedirector: vi.fn(async () => ({ ok: false as const, error: "Stopped before remote mutation in this test." })),
  removeLocalRedirector: vi.fn(async () => ({ ok: false as const, error: "No record in this test." })),
  listDnsZones: vi.fn(async () => ({ ok: true as const, value: [zone] })),
  listDnsRecords: vi.fn(async () => ({ ok: true as const, value: [record, otherIpRecord, ipv6Record] })),
  createDnsRecord: vi.fn(async () => ({ ok: true as const })),
  onChanged: vi.fn(() => () => undefined),
};

function showPanel(): void {
  render(<ManagedSoftwarePanel api={api} credentialId={credentialId} deploymentId={deploymentId} publicIp="198.51.100.12" serverRunning />);
}

async function openForm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await waitFor(() => expect(screen.getByRole("button", { name: "Add software" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Add software" }));
}

async function openCreateDns(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("tab", { name: "Cloud DNS" }));
  await screen.findByRole("combobox", { name: "Public zone" });
  await user.selectOptions(screen.getByRole("combobox", { name: "DNS record setup" }), "create");
}

describe("ManagedSoftwarePanel", () => {
  beforeAll(() => {
    vi.stubGlobal("ResizeObserver", class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: () => [],
    });
  });
  afterEach(() => cleanup());
  beforeEach(() => {
    vi.mocked(api.getSoftwareState).mockClear();
    vi.mocked(api.getSoftwareInstallProgress).mockReset();
    vi.mocked(api.getSoftwareInstallProgress).mockResolvedValue({ ok: true, value: null });
    vi.mocked(api.onSoftwareInstallProgress).mockClear();
    vi.mocked(api.getTerminalRuntime).mockClear();
    vi.mocked(api.listSoftwareListeners).mockClear();
    vi.mocked(api.installLocalRedirector).mockClear();
    vi.mocked(api.removeLocalRedirector).mockClear();
    vi.mocked(api.listDnsZones).mockClear();
    vi.mocked(api.listDnsRecords).mockClear();
    vi.mocked(api.createDnsRecord).mockClear();
    vi.mocked(api.onChanged).mockClear();
  });

  it("defaults to a new loopback listener and IP-only HTTP", async () => {
    const user = userEvent.setup();
    showPanel();
    await openForm(user);
    expect(screen.getByRole("combobox", { name: "Sliver listener" })).toHaveValue("create");
    expect(screen.getByRole("textbox", { name: "Local listener port" })).toHaveValue("8000");
    await user.click(screen.getByRole("button", { name: "Review deployment" }));
    expect(screen.getByText(/new HTTP listener on 127\.0\.0\.1:8000/u)).toBeInTheDocument();
    expect(screen.getByText(/http:\/\/198\.51\.100\.12/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Install Caddy" }));
    await waitFor(() => expect(api.installLocalRedirector).toHaveBeenCalledWith({
      deploymentId, expectedRevision: 7, recipeId: "caddy", publicIp: "198.51.100.12", domains: [], listener: { mode: "create", port: 8000 },
    }));
  });

  it("opens a progress screen and streams DNS, SSH output, and completion", async () => {
    const user = userEvent.setup();
    let progress: SoftwareInstallProgressSnapshot | null = null;
    let finishInstall: ((result: OperationResult<LocalRedirectorRecord>) => void) | undefined;
    vi.mocked(api.getSoftwareInstallProgress).mockImplementation(async () => ({ ok: true, value: progress }));
    vi.mocked(api.installLocalRedirector).mockImplementationOnce(() => new Promise((resolve) => { finishInstall = resolve; }));
    showPanel();
    await openForm(user);
    await user.click(screen.getByRole("button", { name: "Review deployment" }));
    await user.click(screen.getByRole("button", { name: "Install Caddy" }));

    expect(screen.getByRole("heading", { name: "Installing Caddy" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Caddy installation progress" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Installation steps" })).toHaveTextContent("Prepare public DNS");
    expect(screen.getByRole("list", { name: "Installation steps" })).toHaveTextContent("Install software over SSH");

    const listener = vi.mocked(api.onSoftwareInstallProgress).mock.calls[0]?.[0];
    expect(listener).toBeDefined();
    const dnsEvent: SoftwareInstallProgress = { deploymentId, step: "dns", status: "running", message: "Creating c2.example.com" };
    progress = { deploymentId, recipeId: "caddy", status: "running", truncated: false, outputSequenceStart: 0, events: [dnsEvent] };
    act(() => listener?.(dnsEvent));
    await waitFor(() => expect(screen.getByText("Creating c2.example.com")).toBeInTheDocument());

    const outputEvent: SoftwareInstallProgress = { deploymentId, step: "ssh", status: "running", output: { stream: "stdout", chunk: new TextEncoder().encode("Installing Caddy package\n") } };
    progress = { ...progress, events: [dnsEvent, { deploymentId, step: "dns", status: "complete", message: "DNS ready" }, outputEvent] };
    act(() => listener?.(outputEvent));
    await waitFor(() => expect(screen.getByLabelText("SSH installation output")).toHaveTextContent("Installing Caddy package"));
    expect(screen.getByLabelText("SSH installation output")).toHaveAttribute("data-sequences", "0");

    const newerOutput: SoftwareInstallProgress = { deploymentId, step: "ssh", status: "running", output: { stream: "stderr", chunk: new TextEncoder().encode("Certificate check running\n") } };
    progress = { ...progress, truncated: true, outputSequenceStart: 1, events: [
      { deploymentId, step: "dns", status: "complete", message: "DNS ready" }, newerOutput,
    ] };
    act(() => listener?.(newerOutput));
    await waitFor(() => expect(screen.getByLabelText("SSH installation output")).toHaveAttribute("data-sequences", "1"));
    expect(screen.getByLabelText("SSH installation output")).toHaveTextContent("Certificate check running");

    const finished: SoftwareInstallProgress = { deploymentId, step: "verify", status: "complete", message: "Public endpoint verified" };
    progress = { ...progress, status: "complete", events: [
      ...progress.events,
      { deploymentId, step: "listener", status: "complete", message: "Listener ready" },
      { deploymentId, step: "firewall", status: "complete", message: "Firewall ready" },
      { deploymentId, step: "ssh", status: "complete", message: "Caddy installed" },
      finished,
    ] };
    act(() => listener?.(finished));
    await act(async () => finishInstall?.({ ok: true, value: installed }));
    await waitFor(() => expect(screen.getByText("Caddy is installed. The managed software view has the public endpoint and removal controls.")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Back to software" }));
    expect(screen.getByRole("button", { name: "View last install log" })).toBeInTheDocument();
  });

  it("resumes a running installation and lets the user reopen its progress", async () => {
    let progress: SoftwareInstallProgressSnapshot = {
      deploymentId, recipeId: "nginx", status: "running", truncated: false, outputSequenceStart: 0,
      events: [{ deploymentId, step: "dns", status: "complete", message: "DNS ready" },
        { deploymentId, step: "listener", status: "running", message: "Starting localhost listener" }],
    };
    vi.mocked(api.getSoftwareInstallProgress).mockImplementation(async () => ({ ok: true, value: progress }));
    const user = userEvent.setup();
    showPanel();
    expect(await screen.findByRole("heading", { name: "Installing Nginx" })).toBeInTheDocument();
    expect(screen.getByText("Starting localhost listener")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to software" }));
    expect(screen.getByRole("button", { name: "View install progress" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View install progress" }));
    expect(screen.getByRole("heading", { name: "Installing Nginx" })).toBeInTheDocument();
    progress = { ...progress, status: "complete", events: [...progress.events,
      { deploymentId, step: "listener", status: "complete", message: "Listener ready" },
      { deploymentId, step: "verify", status: "complete", message: "Public endpoint verified" }] };
    await waitFor(() => expect(screen.getByText("Nginx is installed. The managed software view has the public endpoint and removal controls.")).toBeInTheDocument(), { timeout: 2_500 });
  });

  it("offers only eligible existing loopback listeners", async () => {
    const user = userEvent.setup();
    showPanel();
    await openForm(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "Sliver listener" }), "existing");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Eligible listener" })).toHaveValue("42"));
    expect(screen.getByText(/#43 unavailable: Bound to 0\.0\.0\.0/u)).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /#43/u })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review deployment" }));
    await user.click(screen.getByRole("button", { name: "Install Caddy" }));
    await waitFor(() => expect(api.installLocalRedirector).toHaveBeenCalledWith(expect.objectContaining({ listener: { mode: "existing", jobId: 42 } })));
  });

  it("uses automatic HTTPS with a domain for Nginx", async () => {
    const user = userEvent.setup();
    showPanel();
    await openForm(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "Software" }), "nginx");
    await user.type(screen.getByRole("textbox", { name: "Public domains" }), "beacon.example.com");
    await user.click(screen.getByRole("button", { name: "Review deployment" }));
    expect(screen.getByText("https://beacon.example.com")).toBeInTheDocument();
    expect(screen.getByText(/with automatic HTTPS/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Install Nginx" }));
    await waitFor(() => expect(api.installLocalRedirector).toHaveBeenCalledWith(expect.objectContaining({
      recipeId: "nginx", publicIp: "198.51.100.12", domains: ["beacon.example.com"],
    })));
  });

  it("starts with Manual DNS and reveals Cloud DNS only when selected", async () => {
    const user = userEvent.setup();
    showPanel();
    await openForm(user);

    expect(screen.getByRole("tab", { name: "Manual DNS" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("textbox", { name: "Public domains" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Public zone" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "DNS record" })).not.toBeInTheDocument();
    expect(api.listDnsZones).not.toHaveBeenCalled();

    await user.click(screen.getByRole("tab", { name: "Cloud DNS" }));
    expect(screen.getByRole("tab", { name: "Cloud DNS" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("textbox", { name: "Public domains" })).not.toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "Public zone" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "DNS record" })).toBeInTheDocument();
  });

  it("combines manual and Cloud DNS domains across tabs and keeps them in deployment review", async () => {
    const user = userEvent.setup();
    showPanel();
    await openForm(user);
    await user.type(screen.getByRole("textbox", { name: "Public domains" }), "manual.example.com");
    await user.click(screen.getByRole("tab", { name: "Cloud DNS" }));
    await screen.findByRole("option", { name: /beacon\.example\.com · A/u });
    expect(screen.queryByRole("option", { name: /other\.example\.com/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /ipv6\.example\.com/u })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "DNS record" }), "beacon.example.com");
    await user.click(screen.getByRole("tab", { name: "Manual DNS" }));
    expect(screen.getByRole("textbox", { name: "Public domains" })).toHaveValue("manual.example.com\nbeacon.example.com");
    await user.click(screen.getByRole("button", { name: "Review deployment" }));
    expect(screen.getByText("https://manual.example.com")).toBeInTheDocument();
    expect(screen.getByText(/Before deploying, point manual\.example\.com, beacon\.example\.com to this server/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Install Caddy" }));
    await waitFor(() => expect(api.installLocalRedirector).toHaveBeenCalledWith(expect.objectContaining({
      domains: ["manual.example.com", "beacon.example.com"],
    })));
    expect(api.listDnsZones).toHaveBeenCalledWith({ credentialId });
    expect(api.listDnsRecords).toHaveBeenCalledWith({ credentialId, zoneId: zone.id });
  });

  it("reviews multiple A records with automatic HTTPS and creates them only during installation", async () => {
    const user = userEvent.setup();
    showPanel();
    await openForm(user);
    await openCreateDns(user);

    expect(screen.getByRole("combobox", { name: "DNS record setup" })).toHaveValue("create");
    expect(screen.queryByRole("combobox", { name: "DNS record" })).not.toBeInTheDocument();
    expect(screen.queryByText(/No A records in this zone currently point to this server’s public IPv4/u)).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Subdomains to create" }), "c2, edge.c2\n@");
    expect(screen.getByText("c2.example.com → 198.51.100.12")).toBeInTheDocument();
    expect(screen.getByText("edge.c2.example.com → 198.51.100.12")).toBeInTheDocument();
    expect(screen.getByText("example.com → 198.51.100.12")).toBeInTheDocument();
    expect(api.createDnsRecord).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Review deployment" }));
    expect(screen.getByText("https://c2.example.com")).toBeInTheDocument();
    expect(screen.getByText(/Cloud DNS will create missing A records for c2\.example\.com, edge\.c2\.example\.com, example\.com pointing to 198\.51\.100\.12 \(TTL 300 seconds\), then wait up to 2 minutes for DNS propagation/u)).toBeInTheDocument();
    expect(screen.getByText(/Records created during deployment stay in Cloud DNS if installation fails or this redirector is removed/u)).toBeInTheDocument();
    expect(api.createDnsRecord).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Install Caddy" }));
    await waitFor(() => expect(api.installLocalRedirector).toHaveBeenCalledWith(expect.objectContaining({
      domains: ["c2.example.com", "edge.c2.example.com", "example.com"],
      dnsRecords: { zoneId: zone.id, names: ["c2", "edge.c2", "@"] },
    })));
    expect(api.createDnsRecord).not.toHaveBeenCalled();
  });

  it("combines manual domains with planned Cloud DNS names across tab switches", async () => {
    const user = userEvent.setup();
    showPanel();
    await openForm(user);
    await user.type(screen.getByRole("textbox", { name: "Public domains" }), "manual.example.com");
    await openCreateDns(user);
    await user.type(screen.getByRole("textbox", { name: "Subdomains to create" }), "c2");
    await user.click(screen.getByRole("tab", { name: "Manual DNS" }));
    expect(screen.getByRole("textbox", { name: "Public domains" })).toHaveValue("manual.example.com");

    await user.click(screen.getByRole("button", { name: "Review deployment" }));
    expect(screen.getByText("https://manual.example.com")).toBeInTheDocument();
    expect(screen.getByText(/Before deploying, point manual\.example\.com to this server/u)).toBeInTheDocument();
    expect(screen.getByText(/Cloud DNS will create missing A records for c2\.example\.com/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Install Caddy" }));
    await waitFor(() => expect(api.installLocalRedirector).toHaveBeenCalledWith(expect.objectContaining({
      domains: ["manual.example.com", "c2.example.com"],
      dnsRecords: { zoneId: zone.id, names: ["c2"] },
    })));
  });

  it("validates missing, invalid, duplicate, and excessive planned DNS names", async () => {
    const user = userEvent.setup();
    showPanel();
    await openForm(user);
    await openCreateDns(user);
    const input = screen.getByRole("textbox", { name: "Subdomains to create" });

    await user.click(screen.getByRole("button", { name: "Review deployment" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter at least one subdomain to create");
    await user.type(input, "bad_name");
    await user.click(screen.getByRole("button", { name: "Review deployment" }));
    expect(screen.getByRole("alert")).toHaveTextContent("DNS record names must be relative subdomains");
    await user.clear(input);
    await user.type(input, "c2, c2.example.com");
    await user.click(screen.getByRole("button", { name: "Review deployment" }));
    expect(screen.getByRole("alert")).toHaveTextContent("duplicate public DNS record names");
    await user.clear(input);
    await user.type(input, "a,b,c,d,e,f,g,h");
    await user.click(screen.getByRole("tab", { name: "Manual DNS" }));
    await user.type(screen.getByRole("textbox", { name: "Public domains" }), "manual.example.com");
    await user.click(screen.getByRole("button", { name: "Review deployment" }));
    expect(screen.getByRole("alert")).toHaveTextContent("at most eight domains in total");
    expect(api.installLocalRedirector).not.toHaveBeenCalled();
  });

  it("re-resolves planned names and invalidates review when the public zone changes", async () => {
    vi.mocked(api.listDnsZones).mockResolvedValueOnce({ ok: true, value: [zone, otherZone] });
    const user = userEvent.setup();
    showPanel();
    await openForm(user);
    await openCreateDns(user);
    await user.type(screen.getByRole("textbox", { name: "Subdomains to create" }), "edge.c2");
    await user.click(screen.getByRole("button", { name: "Review deployment" }));
    expect(screen.getByText("https://edge.c2.example.com")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Public zone" }), otherZone.id);
    expect(screen.queryByRole("button", { name: "Install Caddy" })).not.toBeInTheDocument();
    expect(screen.getByText("edge.c2.other.test → 198.51.100.12")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review deployment" }));
    expect(screen.getByText("https://edge.c2.other.test")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Install Caddy" }));
    await waitFor(() => expect(api.installLocalRedirector).toHaveBeenCalledWith(expect.objectContaining({
      domains: ["edge.c2.other.test"], dnsRecords: { zoneId: otherZone.id, names: ["edge.c2"] },
    })));
  });

  it("drops the planned DNS action when switching back to existing records", async () => {
    const user = userEvent.setup();
    showPanel();
    await openForm(user);
    await openCreateDns(user);
    await user.type(screen.getByRole("textbox", { name: "Subdomains to create" }), "c2");
    await user.click(screen.getByRole("button", { name: "Review deployment" }));
    expect(screen.getByText("https://c2.example.com")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "DNS record setup" }), "existing");
    expect(screen.queryByRole("button", { name: "Install Caddy" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review deployment" }));
    expect(screen.getByText(/http:\/\/198\.51\.100\.12/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Install Caddy" }));
    await waitFor(() => expect(api.installLocalRedirector).toHaveBeenCalledWith({
      deploymentId, expectedRevision: 7, recipeId: "caddy", publicIp: "198.51.100.12", domains: [], listener: { mode: "create", port: 8000 },
    }));
  });

  it("refreshes software state when another window changes the cloud snapshot", async () => {
    showPanel();
    await waitFor(() => expect(api.getSoftwareState).toHaveBeenCalledTimes(1));
    const listener = vi.mocked(api.onChanged).mock.calls[0]?.[0];
    expect(listener).toBeDefined();
    act(() => listener?.("snapshot"));
    await waitFor(() => expect(api.getSoftwareState).toHaveBeenCalledTimes(2));
  });

  it("updates the public IP and clears form choices when the selected server changes", async () => {
    const user = userEvent.setup();
    const view = render(<ManagedSoftwarePanel api={api} credentialId={credentialId} deploymentId={deploymentId} publicIp="198.51.100.12" serverRunning />);
    await openForm(user);
    expect(screen.getByRole("textbox", { name: "Public IP" })).toHaveValue("198.51.100.12");
    await user.type(screen.getByRole("textbox", { name: "Public domains" }), "old.example.com");

    view.rerender(<ManagedSoftwarePanel api={api} credentialId={credentialId} deploymentId={deploymentId} publicIp="198.51.100.13" serverRunning />);
    expect(screen.getByRole("textbox", { name: "Public IP" })).toHaveValue("198.51.100.13");

    const otherDeploymentId = "44444444-4444-4444-8444-444444444444";
    view.rerender(<ManagedSoftwarePanel api={api} credentialId={credentialId} deploymentId={otherDeploymentId} publicIp="198.51.100.14" serverRunning />);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Public domains" })).not.toBeInTheDocument());
    await openForm(user);
    expect(screen.getByRole("textbox", { name: "Public IP" })).toHaveValue("198.51.100.14");
    expect(screen.getByRole("textbox", { name: "Public domains" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Sliver listener" })).toHaveValue("create");
  });

  it("keeps a newer software revision when an initial fetch finishes after a change event", async () => {
    let resolveInitial: ((value: OperationResult<SoftwareDeploymentState>) => void) | undefined;
    vi.mocked(api.getSoftwareState)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }))
      .mockResolvedValueOnce({ ok: true, value: { v: 1, revision: 9, records: [installed] } });
    showPanel();
    await waitFor(() => expect(api.getSoftwareState).toHaveBeenCalledTimes(1));
    const listener = vi.mocked(api.onChanged).mock.calls[0]?.[0];
    act(() => listener?.("snapshot"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add software" })).toBeDisabled());
    expect(screen.getByText(installed.publicUrl)).toBeInTheDocument();

    await act(async () => resolveInitial?.({ ok: true, value: { v: 1, revision: 7, records: [] } }));
    expect(screen.getByText(installed.publicUrl)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add software" })).toBeDisabled();
  });

  it("does not apply an older removal response after a newer snapshot", async () => {
    const user = userEvent.setup();
    const latestRecord: LocalRedirectorRecord = { ...installed, status: "degraded" };
    let resolveRemove: ((value: OperationResult<SoftwareDeploymentState>) => void) | undefined;
    vi.mocked(api.getSoftwareState)
      .mockResolvedValueOnce({ ok: true, value: { v: 1, revision: 8, records: [installed] } })
      .mockResolvedValueOnce({ ok: true, value: { v: 1, revision: 10, records: [latestRecord] } });
    vi.mocked(api.removeLocalRedirector).mockImplementationOnce(() => new Promise((resolve) => { resolveRemove = resolve; }));
    showPanel();
    await screen.findByText(installed.publicUrl);
    await user.click(screen.getByRole("button", { name: `Remove Caddy from ${installed.publicUrl}` }));
    await user.click(screen.getByRole("button", { name: "Remove redirector" }));
    await waitFor(() => expect(api.removeLocalRedirector).toHaveBeenCalledOnce());

    const listener = vi.mocked(api.onChanged).mock.calls[0]?.[0];
    act(() => listener?.("snapshot"));
    await screen.findByText("Degraded");
    await act(async () => resolveRemove?.({ ok: true, value: { v: 1, revision: 9, records: [] } }));
    expect(screen.getByText(installed.publicUrl)).toBeInTheDocument();
    expect(screen.getByText("Degraded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add software" })).toBeDisabled();
  });

  it("rejects a public IP different from the managed VM", async () => {
    const user = userEvent.setup();
    showPanel();
    await openForm(user);
    const input = screen.getByRole("textbox", { name: "Public IP" });
    await user.clear(input);
    await user.type(input, "198.51.100.13");
    await user.click(screen.getByRole("button", { name: "Review deployment" }));
    expect(screen.getByRole("alert")).toHaveTextContent("must match this server’s assigned public IPv4");
    expect(api.installLocalRedirector).not.toHaveBeenCalled();
  });

  it("reserves ports 80 and 443 for the public frontend", async () => {
    const user = userEvent.setup();
    showPanel();
    await openForm(user);
    for (const port of ["80", "443"]) {
      const input = screen.getByRole("textbox", { name: "Local listener port" });
      await user.clear(input);
      await user.type(input, port);
      await user.click(screen.getByRole("button", { name: "Review deployment" }));
      expect(screen.getByRole("alert")).toHaveTextContent("redirector reserves those public ports");
    }
    expect(api.installLocalRedirector).not.toHaveBeenCalled();
  });

  it("allows only one redirector per managed server", async () => {
    vi.mocked(api.getSoftwareState).mockResolvedValueOnce({ ok: true, value: { v: 1, revision: 8, records: [installed] } });
    showPanel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add software" })).toBeDisabled());
    expect(screen.getByText(/One local HTTP redirector can run on this server/u)).toBeInTheDocument();
    expect(screen.getByText("http://198.51.100.12")).toBeInTheDocument();
  });
});
