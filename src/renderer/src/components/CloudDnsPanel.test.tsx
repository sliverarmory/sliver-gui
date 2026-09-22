import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudCredentialSummary } from "../../../shared/cloud-deployment-contracts";
import type { CloudDeploymentAPI } from "../../../shared/cloud-deployment-ipc";
import type { CloudDnsRecord, CloudDnsZone } from "../../../shared/cloud-dns-contracts";
import type { OperationResult } from "../../../shared/contracts";
import { CloudDnsPanel } from "./CloudDnsPanel";

const credentials: readonly CloudCredentialSummary[] = [
  { id: "aws-account", provider: "aws", label: "Production AWS", persistence: "secure", createdAt: "2026-09-21T00:00:00Z", defaultRegion: "us-east-1", sshUsername: "ubuntu" },
  { id: "azure-account", provider: "azure", label: "Production Azure", persistence: "secure", createdAt: "2026-09-21T00:00:00Z", defaultLocation: "eastus", sshUsername: "azureuser", subscriptionId: "subscription", tenantId: "tenant" },
];
const zones: readonly CloudDnsZone[] = [
  { id: "Z1", name: "example.com.", provider: "aws", private: false, recordCount: 3, resourceGroupName: null },
  { id: "Z2", name: "example.net.", provider: "aws", private: true, recordCount: 1, resourceGroupName: null },
];
const records: readonly CloudDnsRecord[] = [
  { id: "r1", zoneId: "Z1", zoneName: "example.com.", name: "www.example.com.", type: "A", ttl: 300, values: ["192.0.2.10"], editable: true, readOnlyReason: null, version: "v1" },
  { id: "r2", zoneId: "Z2", zoneName: "example.net.", name: "mail.example.net.", type: "MX", ttl: 600, values: ["10 mail.example.net."], editable: true, readOnlyReason: null, version: "v2" },
  { id: "r3", zoneId: "Z1", zoneName: "example.com.", name: "example.com.", type: "NS", ttl: 86400, values: ["ns1.example.com."], editable: false, readOnlyReason: "Apex NS records are managed by the provider.", version: "v3" },
];
const api = {
  listDnsZones: vi.fn<CloudDeploymentAPI["listDnsZones"]>(),
  listDnsRecords: vi.fn<CloudDeploymentAPI["listDnsRecords"]>(),
  createDnsRecord: vi.fn<CloudDeploymentAPI["createDnsRecord"]>(),
  updateDnsRecord: vi.fn<CloudDeploymentAPI["updateDnsRecord"]>(),
  deleteDnsRecord: vi.fn<CloudDeploymentAPI["deleteDnsRecord"]>(),
};
const onShowCredentials = vi.fn();

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
  vi.resetAllMocks();
  api.listDnsZones.mockResolvedValue({ ok: true, value: zones });
  api.listDnsRecords.mockImplementation(async ({ zoneId }) => ({ ok: true, value: zoneId ? records.filter((record) => record.zoneId === zoneId) : records }));
  api.createDnsRecord.mockResolvedValue({ ok: true });
  api.updateDnsRecord.mockResolvedValue({ ok: true });
  api.deleteDnsRecord.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

function setup(): ReturnType<typeof userEvent.setup> {
  render(<CloudDnsPanel api={api} credentials={credentials} onShowCredentials={onShowCredentials} />);
  return userEvent.setup();
}

describe("Cloud DNS management", () => {
  it("starts with zones, drills into a zone, and searches records across all zones", async () => {
    const user = setup();
    await screen.findByRole("grid", { name: "DNS zones" });
    expect(api.listDnsZones).toHaveBeenCalledWith({ credentialId: "aws-account" });
    expect(api.listDnsRecords).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "example.com." }));
    await screen.findByRole("grid", { name: "DNS records" });
    expect(api.listDnsRecords).toHaveBeenLastCalledWith({ credentialId: "aws-account", zoneId: "Z1" });
    expect(screen.getByText("www.example.com.")).toBeInTheDocument();
    expect(screen.queryByText("mail.example.net.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All records" }));
    await screen.findByText("mail.example.net.");
    expect(api.listDnsRecords).toHaveBeenLastCalledWith({ credentialId: "aws-account", zoneId: null });
    expect(screen.getByRole("columnheader", { name: "Zone" })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Search records" }), "example.net");
    expect(screen.queryByText("www.example.com.")).not.toBeInTheDocument();
    expect(screen.getByText("mail.example.net.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Zones" }));
    expect(screen.getByRole("textbox", { name: "Search zones" })).toHaveValue("");
    expect(screen.getByRole("grid", { name: "DNS zones" })).toBeInTheDocument();
  });

  it("discards late responses from a previously selected account", async () => {
    let resolveOld: (result: OperationResult<readonly CloudDnsZone[]>) => void = () => undefined;
    api.listDnsZones.mockImplementation(({ credentialId }) => credentialId === "aws-account"
      ? new Promise((resolve) => { resolveOld = resolve; })
      : Promise.resolve({ ok: true, value: [{ ...zones[1]!, id: "azure-zone", name: "azure.example.", provider: "azure", resourceGroupName: "dns-rg" }] }));
    const user = setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "DNS account" }), "azure-account");
    await screen.findByRole("button", { name: "azure.example." });
    await act(async () => { resolveOld({ ok: true, value: zones }); });
    expect(screen.queryByRole("button", { name: "example.com." })).not.toBeInTheDocument();
    expect(screen.getByText("dns-rg")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "azure.example." }));
    await waitFor(() => expect(api.listDnsRecords).toHaveBeenCalledWith({ credentialId: "azure-account", zoneId: "azure-zone" }));
  });

  it("paginates large record lists and searches and sorts the full result", async () => {
    const manyRecords = Array.from({ length: 60 }, (_, index) => ({ ...records[0]!, id: `r${index}`, name: `host${String(index).padStart(2, "0")}.example.com.` }));
    api.listDnsRecords.mockResolvedValue({ ok: true, value: manyRecords });
    const user = setup();
    await user.click(await screen.findByRole("button", { name: "example.com." }));
    await screen.findByRole("grid", { name: "DNS records" });
    expect(screen.getByText("host00.example.com.")).toBeInTheDocument();
    expect(screen.queryByText("host59.example.com.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next DNS page" }));
    expect(screen.getByText("host59.example.com.")).toBeInTheDocument();
    await user.click(screen.getByRole("columnheader", { name: "Name" }));
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("host59.example.com.")).toBeInTheDocument();
    expect(screen.queryByText("host00.example.com.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next DNS page" }));
    await user.type(screen.getByRole("textbox", { name: "Search records" }), "host59");
    expect(screen.getByText("host59.example.com.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next DNS page" })).not.toBeInTheDocument();
    expect(screen.getByText("1 of 60 record sets")).toBeInTheDocument();
  });

  it("distinguishes records from same-name zones in the list and mutation dialogs", async () => {
    const privateZone = { ...zones[1]!, name: zones[0]!.name };
    const privateRecord = { ...records[0]!, id: "private-record", zoneId: privateZone.id };
    api.listDnsZones.mockResolvedValue({ ok: true, value: [zones[0]!, privateZone] });
    api.listDnsRecords.mockResolvedValue({ ok: true, value: [records[0]!, privateRecord] });
    const user = setup();
    await screen.findByRole("grid", { name: "DNS zones" });
    await user.click(screen.getByRole("button", { name: "All records" }));
    await screen.findByRole("grid", { name: "DNS records" });
    expect(screen.getByText("Public · Z1")).toBeInTheDocument();
    const privateRow = screen.getByText("Private · Z2").closest("tr")!;
    await user.click(within(privateRow).getByRole("button", { name: "Edit www.example.com. A" }));
    expect(within(screen.getByRole("dialog", { name: "Edit DNS Record" })).getByText("Private · Z2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(within(privateRow).getByRole("button", { name: "Delete www.example.com. A" }));
    expect(within(screen.getByRole("dialog", { name: "Delete DNS Record" })).getByText("Private · Z2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.type(screen.getByRole("textbox", { name: "Search records" }), "Z2");
    expect(screen.getByText("1 of 2 record sets across all zones in this account")).toBeInTheDocument();
    expect(screen.queryByText("Public · Z1")).not.toBeInTheDocument();
  });

  it("discards late records after changing the zone view", async () => {
    let resolveOld: (result: OperationResult<readonly CloudDnsRecord[]>) => void = () => undefined;
    api.listDnsRecords.mockImplementation(({ zoneId }) => zoneId === "Z1"
      ? new Promise((resolve) => { resolveOld = resolve; })
      : Promise.resolve({ ok: true, value: [records[1]!] }));
    const user = setup();
    await user.click(await screen.findByRole("button", { name: "example.com." }));
    await waitFor(() => expect(api.listDnsRecords).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "All records" }));
    await screen.findByText("mail.example.net.");
    await act(async () => { resolveOld({ ok: true, value: [records[0]!] }); });
    expect(screen.queryByText("www.example.com.")).not.toBeInTheDocument();
    expect(screen.getByText("mail.example.net.")).toBeInTheDocument();
  });

  it("adds a validated multi-value record to the selected zone from the all-records view", async () => {
    const user = setup();
    await screen.findByRole("grid", { name: "DNS zones" });
    await user.click(screen.getByRole("button", { name: "All records" }));
    await screen.findByRole("grid", { name: "DNS records" });
    await user.click(screen.getByRole("button", { name: "Add record" }));
    const dialog = within(screen.getByRole("dialog", { name: "Add DNS Record" }));
    await user.selectOptions(dialog.getByRole("combobox", { name: "Zone" }), "Z2");
    await user.type(dialog.getByRole("textbox", { name: "Record name" }), "www");
    await user.type(dialog.getByRole("textbox", { name: "Values" }), "not an address");
    await user.click(dialog.getByRole("button", { name: "Add record" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("Enter a valid A record value.");
    expect(api.createDnsRecord).not.toHaveBeenCalled();
    await user.clear(dialog.getByRole("textbox", { name: "Values" }));
    await user.type(dialog.getByRole("textbox", { name: "Values" }), "192.0.2.20\n192.0.2.21");
    await user.click(dialog.getByRole("button", { name: "Add record" }));
    await waitFor(() => expect(api.createDnsRecord).toHaveBeenCalledWith({ credentialId: "aws-account", zoneId: "Z2", record: { name: "www", type: "A", ttl: 300, values: ["192.0.2.20", "192.0.2.21"] } }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.listDnsRecords).toHaveBeenCalledTimes(2);
  });

  it("edits values and TTL with the original record version and immutable identity", async () => {
    const user = setup();
    await user.click(await screen.findByRole("button", { name: "example.com." }));
    await user.click(await screen.findByRole("button", { name: "Edit www.example.com. A" }));
    const dialog = within(screen.getByRole("dialog", { name: "Edit DNS Record" }));
    expect(dialog.getByRole("textbox", { name: "Record name" })).toHaveAttribute("readonly");
    expect(dialog.getByRole("combobox", { name: "Record type" })).toBeDisabled();
    await user.clear(dialog.getByRole("textbox", { name: "TTL (seconds)" }));
    await user.type(dialog.getByRole("textbox", { name: "TTL (seconds)" }), "600");
    await user.clear(dialog.getByRole("textbox", { name: "Values" }));
    await user.type(dialog.getByRole("textbox", { name: "Values" }), "192.0.2.30");
    await user.click(dialog.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.updateDnsRecord).toHaveBeenCalledWith({ credentialId: "aws-account", zoneId: "Z1", recordId: "r1", expectedVersion: "v1", record: { name: "www.example.com.", type: "A", ttl: 600, values: ["192.0.2.30"] } }));
  });

  it("requires deletion confirmation and keeps the dialog open if the provider rejects it", async () => {
    api.deleteDnsRecord.mockResolvedValue({ ok: false, error: "The record changed. Refresh before retrying." });
    const user = setup();
    await user.click(await screen.findByRole("button", { name: "example.com." }));
    await user.click(await screen.findByRole("button", { name: "Delete www.example.com. A" }));
    expect(api.deleteDnsRecord).not.toHaveBeenCalled();
    const dialog = within(screen.getByRole("dialog", { name: "Delete DNS Record" }));
    expect(dialog.getByText(/Delete all values/)).toHaveTextContent("www.example.com.");
    await user.click(dialog.getByRole("button", { name: "Delete record" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("The record changed");
    expect(api.deleteDnsRecord).toHaveBeenCalledWith({ credentialId: "aws-account", zoneId: "Z1", recordId: "r1", expectedVersion: "v1" });
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("explains protected records without offering edit or delete actions", async () => {
    const user = setup();
    await user.click(await screen.findByRole("button", { name: "example.com." }));
    await screen.findByText("Apex NS records are managed by the provider.");
    expect(screen.queryByRole("button", { name: "Edit example.com. NS" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete example.com. NS" })).not.toBeInTheDocument();
  });

  it("shows provider errors and lets the user retry with refresh", async () => {
    api.listDnsZones.mockResolvedValueOnce({ ok: false, error: "DNS read permission denied." });
    const user = setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("DNS read permission denied.");
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh DNS" }));
    await screen.findByRole("grid", { name: "DNS zones" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("links an account-less state to credentials and displays an empty zones result", async () => {
    const { rerender } = render(<CloudDnsPanel api={api} credentials={[]} onShowCredentials={onShowCredentials} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage credentials" }));
    expect(onShowCredentials).toHaveBeenCalledOnce();
    expect(api.listDnsZones).not.toHaveBeenCalled();
    api.listDnsZones.mockResolvedValue({ ok: true, value: [] });
    rerender(<CloudDnsPanel api={api} credentials={credentials} onShowCredentials={onShowCredentials} />);
    await screen.findByText("No DNS Zones");
  });
});
