import { faArrowLeft, faArrowsRotate, faPen, faTrash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Alert, Button, Description, Input, Label, Modal, Pagination, Spinner, TextArea, TextField, Tooltip } from "@heroui/react";
import { DataGrid, type DataGridColumn, type DataGridProps, type DataGridSortDescriptor } from "@heroui-pro/react/data-grid";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { NativeSelect } from "@heroui-pro/react/native-select";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import type { CloudCredentialSummary } from "../../../shared/cloud-deployment-contracts";
import type { CloudDeploymentAPI } from "../../../shared/cloud-deployment-ipc";
import {
  CLOUD_DNS_RECORD_TYPES,
  parseCloudDnsRecordSpec,
  type CloudDnsRecord,
  type CloudDnsRecordSpec,
  type CloudDnsRecordType,
  type CloudDnsZone,
} from "../../../shared/cloud-dns-contracts";

type DnsAPI = Pick<CloudDeploymentAPI,
  "listDnsZones" | "listDnsRecords" | "createDnsRecord" | "updateDnsRecord" | "deleteDnsRecord">;
type DnsView = { readonly kind: "zones" } | { readonly kind: "all" } | { readonly kind: "zone"; readonly zone: CloudDnsZone };
type RecordEditor = { readonly mode: "create"; readonly zoneId: string } | { readonly mode: "edit"; readonly record: CloudDnsRecord };

type ZonesLoaded = (credentialId: string, zones: readonly CloudDnsZone[] | null) => void;

export function CloudDnsPanel({ api, credentials, onShowCredentials, onZonesLoaded }: {
  readonly api: DnsAPI;
  readonly credentials: readonly CloudCredentialSummary[];
  readonly onShowCredentials: () => void;
  readonly onZonesLoaded?: ZonesLoaded;
}): React.JSX.Element {
  const [credentialId, setCredentialId] = useState(credentials[0]?.id ?? "");
  const credential = credentials.find(({ id }) => id === credentialId) ?? credentials[0];

  if (!credential) return <EmptyState className="py-12">
    <EmptyState.Title>Add a Cloud Account</EmptyState.Title>
    <EmptyState.Description>Add AWS or Azure credentials to browse DNS zones and manage records.</EmptyState.Description>
    <EmptyState.Content><Button onPress={onShowCredentials}>Manage credentials</Button></EmptyState.Content>
  </EmptyState>;

  return <section aria-label="DNS management" className="space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h2 className="text-xl font-semibold">DNS</h2>
        <p className="mt-1 text-sm text-muted">Browse zones and manage records with your cloud account.</p>
      </div>
      <NativeSelect className="w-72 max-w-full">
        <Label>DNS account</Label>
        <NativeSelect.Trigger aria-label="DNS account" value={credential.id} onChange={(event) => setCredentialId(event.target.value)}>
          {credentials.map((item) => <NativeSelect.Option key={item.id} value={item.id}>
            {item.label} · {item.provider === "aws" ? "AWS" : "Azure"}
          </NativeSelect.Option>)}
          <NativeSelect.Indicator />
        </NativeSelect.Trigger>
      </NativeSelect>
    </div>
    <AccountDnsBrowser api={api} credential={credential} key={credential.id} onZonesLoaded={onZonesLoaded} />
  </section>;
}

function AccountDnsBrowser({ api, credential, onZonesLoaded }: { readonly api: DnsAPI; readonly credential: CloudCredentialSummary; readonly onZonesLoaded?: ZonesLoaded | undefined }): React.JSX.Element {
  const [view, setView] = useState<DnsView>({ kind: "zones" });
  const [zones, setZones] = useState<readonly CloudDnsZone[]>([]);
  const [records, setRecords] = useState<readonly CloudDnsRecord[]>([]);
  const [zonesLoading, setZonesLoading] = useState(true);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [zonesError, setZonesError] = useState<string | null>(null);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState<RecordEditor | null>(null);
  const [deleting, setDeleting] = useState<CloudDnsRecord | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const zoneId = view.kind === "zone" ? view.zone.id : null;
  const showsRecords = view.kind !== "zones";

  useEffect(() => {
    let active = true;
    setZonesLoading(true);
    setZonesError(null);
    void (async () => {
      try {
        const result = await api.listDnsZones({ credentialId: credential.id });
        if (!active) return;
        if (!result.ok) throw new Error(result.error);
        setZones(result.value);
        onZonesLoaded?.(credential.id, result.value);
      } catch (error) {
        if (active) { setZones([]); setZonesError(errorMessage(error)); onZonesLoaded?.(credential.id, null); }
      } finally { if (active) setZonesLoading(false); }
    })();
    return () => { active = false; };
  }, [api, credential.id, revision, onZonesLoaded]);

  useEffect(() => {
    let active = true;
    setRecords([]);
    setRecordsError(null);
    setRecordsLoading(showsRecords);
    if (showsRecords) void (async () => {
      try {
        const result = await api.listDnsRecords({ credentialId: credential.id, zoneId });
        if (!active) return;
        if (!result.ok) throw new Error(result.error);
        setRecords(result.value);
      } catch (error) { if (active) setRecordsError(errorMessage(error)); }
      finally { if (active) setRecordsLoading(false); }
    })();
    return () => { active = false; };
  }, [api, credential.id, showsRecords, zoneId, revision]);

  const navigate = (next: DnsView): void => {
    setSearch("");
    setRecords([]);
    setRecordsError(null);
    setRecordsLoading(next.kind !== "zones");
    setNotice(null);
    setView(next);
  };
  const refresh = (): void => { setNotice(null); setRevision((value) => value + 1); };
  const changed = (message: string): void => {
    setEditor(null);
    setDeleting(null);
    setNotice(message);
    setRevision((value) => value + 1);
  };
  const needle = search.trim().toLowerCase();
  const visibleZones = zones.filter((zone) => `${zone.name} ${zone.id} ${zone.resourceGroupName ?? ""}`.toLowerCase().includes(needle));
  const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
  const visibleRecords = records.filter((record) => `${record.name} ${record.type} ${record.zoneName} ${dnsZoneScope(zoneById.get(record.zoneId), record.zoneId)} ${record.values.join(" ")}`.toLowerCase().includes(needle));
  const loading = showsRecords ? recordsLoading : zonesLoading;
  const error = showsRecords ? recordsError : zonesError;
  const zoneColumns: DataGridColumn<CloudDnsZone>[] = [
    { id: "name", header: "Zone", accessorKey: "name", isRowHeader: true, allowsSorting: true, minWidth: 220,
      cell: (zone) => <Button className="h-auto justify-start px-0 py-1 font-mono text-sm" variant="ghost" onPress={() => navigate({ kind: "zone", zone })}>{zone.name}</Button> },
    { id: "visibility", header: "Visibility", cell: (zone) => zone.private ? "Private" : "Public", minWidth: 100 },
    { id: "recordCount", header: "Record sets", accessorKey: "recordCount", align: "end", minWidth: 110,
      cell: (zone) => <span className="tabular-nums">{zone.recordCount ?? "—"}</span> },
    { id: "scope", header: credential.provider === "azure" ? "Resource group" : "Zone ID", minWidth: 180,
      cell: (zone) => <span className="font-mono text-xs text-muted">{zone.resourceGroupName ?? zone.id}</span> },
  ];
  const recordColumns: DataGridColumn<CloudDnsRecord>[] = [
    { id: "name", header: "Name", accessorKey: "name", isRowHeader: true, allowsSorting: true, headerClassName: "w-[22%]",
      cell: (record) => <span className="block min-w-0 break-all font-mono text-xs">{record.name}</span> },
    ...(view.kind === "all" ? [{ id: "zone", header: "Zone", accessorKey: "zoneName" as const, allowsSorting: true, headerClassName: "w-[16%]",
      cell: (record: CloudDnsRecord) => {
        const zone = zoneById.get(record.zoneId);
        return <div className="min-w-0">
          <Button className="h-auto min-w-0 justify-start whitespace-normal break-all px-0 py-1 text-left text-sm" variant="ghost" onPress={() => {
            if (zone) navigate({ kind: "zone", zone });
          }} isDisabled={!zone}>{record.zoneName}</Button>
          <p className="break-all text-xs text-muted">{dnsZoneScope(zone, record.zoneId)}</p>
        </div>;
      } }] : []),
    { id: "type", header: "Type", accessorKey: "type", allowsSorting: true, headerClassName: "w-16" },
    { id: "ttl", header: "TTL (s)", accessorKey: "ttl", align: "end", headerClassName: "w-20",
      cell: (record) => <span className="tabular-nums">{record.ttl ?? "—"}</span> },
    { id: "values", header: "Values",
      cell: (record) => <div className="min-w-0 space-y-1 whitespace-pre-wrap break-all font-mono text-xs">
        {record.values.map((value, index) => <div key={index}>{value}</div>)}
      </div> },
    { id: "actions", header: "Actions", headerClassName: "w-40",
      cell: (record) => record.editable ? <div className="flex items-center justify-end gap-1">
        <Tooltip><Button aria-label={`Edit ${record.name} ${record.type}`} isIconOnly size="sm" variant="ghost" onPress={() => setEditor({ mode: "edit", record })}>
          <FontAwesomeIcon icon={faPen} />
        </Button><Tooltip.Content>Edit record</Tooltip.Content></Tooltip>
        <Tooltip><Button aria-label={`Delete ${record.name} ${record.type}`} isIconOnly size="sm" variant="danger-soft" onPress={() => setDeleting(record)}>
          <FontAwesomeIcon icon={faTrash} />
        </Button><Tooltip.Content>Delete record</Tooltip.Content></Tooltip>
      </div> : <div className="max-w-44 text-xs text-muted"><span className="font-medium">Read only</span><p>{record.readOnlyReason ?? "This record is managed by the provider."}</p></div> },
  ];

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-2">
      <div aria-label="DNS views" className="flex gap-1" role="group">
        <Button aria-pressed={view.kind === "zones"} variant={view.kind === "zones" ? "secondary" : "ghost"} onPress={() => { if (view.kind !== "zones") navigate({ kind: "zones" }); }}>Zones</Button>
        <Button aria-pressed={view.kind === "all"} variant={view.kind === "all" ? "secondary" : "ghost"} onPress={() => { if (view.kind !== "all") navigate({ kind: "all" }); }}>All records</Button>
      </div>
      <div className="ml-auto flex gap-2">
        <Tooltip><Button aria-label="Refresh DNS" isDisabled={loading} isIconOnly variant="outline" onPress={refresh}>
          <FontAwesomeIcon icon={faArrowsRotate} />
        </Button><Tooltip.Content>Refresh DNS</Tooltip.Content></Tooltip>
        {showsRecords ? <Button isDisabled={zonesLoading || zones.length === 0 || loading || error !== null} onPress={() => setEditor({ mode: "create", zoneId: zoneId ?? zones[0]?.id ?? "" })}>Add record</Button> : null}
      </div>
    </div>
    {view.kind === "zone" ? <div className="flex items-center gap-3">
      <Tooltip><Button aria-label="Back to zones" isIconOnly variant="ghost" onPress={() => navigate({ kind: "zones" })}><FontAwesomeIcon icon={faArrowLeft} /></Button><Tooltip.Content>Back to zones</Tooltip.Content></Tooltip>
      <div className="min-w-0"><h3 className="break-all font-semibold">{view.zone.name}</h3><p className="break-all text-xs text-muted">{dnsZoneScope(view.zone, view.zone.id)}</p></div>
    </div> : null}
    <TextField aria-label={showsRecords ? "Search records" : "Search zones"} className="max-w-md" value={search} onChange={setSearch}>
      <Input placeholder={showsRecords ? "Search names, types, zones, or values" : "Search zones"} />
    </TextField>
    {notice ? <p className="text-sm text-success" role="status">{notice}</p> : null}
    {error ? <DnsError title={showsRecords ? "Could not load DNS records" : "Could not load DNS zones"} message={error} /> : null}
    {showsRecords && zonesError ? <DnsError title="Could not refresh DNS zones" message={zonesError} /> : null}
    {loading ? <div className="flex items-center justify-center gap-3 py-16 text-sm text-muted" role="status"><Spinner size="sm" />Loading {showsRecords ? "records" : "zones"}…</div> : !error ? <>
      {showsRecords ? <DnsDataGrid key={`records:${needle}`} aria-label="DNS records" columns={recordColumns} contentClassName={`w-full table-fixed ${view.kind === "all" ? "min-w-[940px]" : "min-w-[780px]"}`} data={[...visibleRecords]} getRowId={(record) => `${record.zoneId}:${record.id}`} renderEmptyState={() => <DnsEmpty title={needle ? "No Matching Records" : "No DNS Records"} description={needle ? "Try a different search." : "Add a record to this zone or choose another zone."} />} />
        : <DnsDataGrid key={`zones:${needle}`} aria-label="DNS zones" columns={zoneColumns} data={[...visibleZones]} getRowId={(zone) => zone.id} onRowAction={(id) => { const zone = zones.find((item) => item.id === id); if (zone) navigate({ kind: "zone", zone }); }} renderEmptyState={() => <DnsEmpty title={needle ? "No Matching Zones" : "No DNS Zones"} description={needle ? "Try a different search." : "No supported DNS zones were found for this account."} />} />}
      <p className="text-xs text-muted tabular-nums">{showsRecords ? `${visibleRecords.length} of ${records.length} record sets${view.kind === "all" ? " across all zones in this account" : ""}` : `${visibleZones.length} of ${zones.length} zones`}</p>
    </> : null}
    {editor ? <DnsRecordEditor api={api} credentialId={credential.id} editor={editor} zones={zones} onCancel={() => setEditor(null)} onSaved={() => changed(editor.mode === "create" ? "Record added. DNS changes may take time to propagate." : "Record updated. DNS changes may take time to propagate.")} /> : null}
    {deleting ? <DeleteDnsRecordModal api={api} credentialId={credential.id} record={deleting} zone={zoneById.get(deleting.zoneId)} onCancel={() => setDeleting(null)} onDeleted={() => changed("Record deleted. DNS changes may take time to propagate.")} /> : null}
  </div>;
}

const DNS_PAGE_SIZE = 50;

function DnsDataGrid<T extends object>(props: DataGridProps<T>): React.JSX.Element {
  const [requestedPage, setPage] = useState(1);
  const [sort, setSort] = useState<DataGridSortDescriptor>({ column: "name", direction: "ascending" });
  const column = props.columns.find(({ id }) => id === sort.column);
  const sorted = [...props.data].sort((left, right) => {
    if (!column?.accessorKey) return 0;
    const compared = String(left[column.accessorKey] ?? "").localeCompare(String(right[column.accessorKey] ?? ""), undefined, { numeric: true });
    return sort.direction === "descending" ? -compared : compared;
  });
  const totalPages = Math.max(1, Math.ceil(sorted.length / DNS_PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  return <>
    <DataGrid {...props} data={sorted.slice((page - 1) * DNS_PAGE_SIZE, page * DNS_PAGE_SIZE)} sortDescriptor={sort} onSortChange={(descriptor) => { setSort(descriptor); setPage(1); }} />
    {totalPages > 1 ? <Pagination aria-label={`${props["aria-label"]} pages`} size="sm">
      <Pagination.Summary><span className="tabular-nums">Page {page} of {totalPages}</span></Pagination.Summary>
      <Pagination.Content>
        <Pagination.Item><Pagination.Previous aria-label="Previous DNS page" isDisabled={page === 1} onPress={() => setPage(page - 1)}><Pagination.PreviousIcon /><span>Previous</span></Pagination.Previous></Pagination.Item>
        <Pagination.Item><Pagination.Next aria-label="Next DNS page" isDisabled={page === totalPages} onPress={() => setPage(page + 1)}><span>Next</span><Pagination.NextIcon /></Pagination.Next></Pagination.Item>
      </Pagination.Content>
    </Pagination> : null}
  </>;
}

function DnsRecordEditor({ api, credentialId, editor, zones, onCancel, onSaved }: {
  readonly api: DnsAPI;
  readonly credentialId: string;
  readonly editor: RecordEditor;
  readonly zones: readonly CloudDnsZone[];
  readonly onCancel: () => void;
  readonly onSaved: () => void;
}): React.JSX.Element {
  const existing = editor.mode === "edit" ? editor.record : null;
  const [zoneId, setZoneId] = useState(existing?.zoneId ?? (editor.mode === "create" ? editor.zoneId : ""));
  const [name, setName] = useState(existing?.name ?? "");
  const [type, setType] = useState<CloudDnsRecordType>((existing?.type as CloudDnsRecordType | undefined) ?? "A");
  const [ttl, setTtl] = useState(String(existing?.ttl ?? 300));
  const [values, setValues] = useState(existing?.values.join("\n") ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const formId = `dns-record-${useId()}`;
  const zone = zones.find((item) => item.id === zoneId);
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending.current) return;
    setError(null);
    let record: CloudDnsRecordSpec;
    try {
      if (!zoneId) throw new Error("Choose a DNS zone.");
      if (!/^\d+$/u.test(ttl.trim())) throw new Error("TTL must be a whole number of seconds.");
      record = parseCloudDnsRecordSpec({ name, type, ttl: Number(ttl), values: values.split("\n").map((value) => value.trim()).filter(Boolean) });
    } catch (caught) { setError(errorMessage(caught)); return; }
    pending.current = true;
    setSaving(true);
    try {
      const result = existing
        ? await api.updateDnsRecord({ credentialId, zoneId, recordId: existing.id, expectedVersion: existing.version, record })
        : await api.createDnsRecord({ credentialId, zoneId, record });
      if (!result.ok) throw new Error(result.error);
      onSaved();
    } catch (caught) { setError(errorMessage(caught)); }
    finally { pending.current = false; setSaving(false); }
  };
  return <Modal.Backdrop isDismissable={!saving} isKeyboardDismissDisabled={saving} isOpen variant="blur" onOpenChange={(open) => { if (!open && !pending.current) onCancel(); }}>
    <Modal.Container placement="center" size="lg"><Modal.Dialog className="sm:max-w-[600px]">
      <Modal.CloseTrigger isDisabled={saving} />
      <Modal.Header className="pr-10"><Modal.Heading>{existing ? "Edit DNS Record" : "Add DNS Record"}</Modal.Heading></Modal.Header>
      <Modal.Body><form className="space-y-4" id={formId} onSubmit={(event) => void submit(event)}>
        {error ? <DnsError title="Could not save record" message={error} /> : null}
        {existing ? <p className="break-all text-sm text-muted">Zone: {existing.zoneName}<span className="mt-1 block text-xs">{dnsZoneScope(zone, existing.zoneId)}</span></p> : <NativeSelect fullWidth>
          <Label>Zone</Label><NativeSelect.Trigger aria-label="Zone" disabled={saving} value={zoneId} onChange={(event) => setZoneId(event.target.value)}>
            {zones.map((item) => <NativeSelect.Option key={item.id} value={item.id}>{item.name} · {dnsZoneScope(item, item.id)}</NativeSelect.Option>)}<NativeSelect.Indicator />
          </NativeSelect.Trigger>
        </NativeSelect>}
        <TextField fullWidth isDisabled={saving} isReadOnly={existing !== null} isRequired value={name} variant="secondary" onChange={setName}>
          <Label>Record name</Label><Input autoComplete="off" autoFocus={!existing} placeholder="www" />
          <Description>{existing ? "The record name and type cannot be changed." : `Use @ for ${zone?.name ?? "the zone apex"}, a relative name, or a full domain name.`}</Description>
        </TextField>
        <div className="grid grid-cols-2 items-start gap-4">
          <NativeSelect fullWidth><Label>Record type</Label><NativeSelect.Trigger aria-label="Record type" disabled={saving || existing !== null} value={type} onChange={(event) => setType(event.target.value as CloudDnsRecordType)}>
            {CLOUD_DNS_RECORD_TYPES.map((item) => <NativeSelect.Option key={item} value={item}>{item}</NativeSelect.Option>)}<NativeSelect.Indicator />
          </NativeSelect.Trigger></NativeSelect>
          <TextField isDisabled={saving} isRequired value={ttl} variant="secondary" onChange={setTtl}>
            <Label>TTL (seconds)</Label><Input inputMode="numeric" /><Description>Cache duration in seconds.</Description>
          </TextField>
        </div>
        <TextField fullWidth isDisabled={saving} isRequired value={values} variant="secondary" onChange={setValues}>
          <Label>Values</Label><TextArea className="min-h-32 font-mono text-sm" autoComplete="off" placeholder={VALUE_HINTS[type]} />
          <Description>One value per line. {VALUE_DESCRIPTIONS[type]}</Description>
        </TextField>
      </form></Modal.Body>
      <Modal.Footer><Button isDisabled={saving} variant="tertiary" onPress={onCancel}>Cancel</Button><Button form={formId} isDisabled={saving} isPending={saving} type="submit">{existing ? "Save changes" : "Add record"}</Button></Modal.Footer>
    </Modal.Dialog></Modal.Container>
  </Modal.Backdrop>;
}

function DeleteDnsRecordModal({ api, credentialId, record, zone, onCancel, onDeleted }: {
  readonly api: DnsAPI;
  readonly credentialId: string;
  readonly record: CloudDnsRecord;
  readonly zone: CloudDnsZone | undefined;
  readonly onCancel: () => void;
  readonly onDeleted: () => void;
}): React.JSX.Element {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const remove = async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await api.deleteDnsRecord({ credentialId, zoneId: record.zoneId, recordId: record.id, expectedVersion: record.version });
      if (!result.ok) throw new Error(result.error);
      onDeleted();
    } catch (caught) { setError(errorMessage(caught)); }
    finally { pending.current = false; setSaving(false); }
  };
  return <Modal.Backdrop isDismissable={!saving} isKeyboardDismissDisabled={saving} isOpen variant="blur" onOpenChange={(open) => { if (!open && !pending.current) onCancel(); }}>
    <Modal.Container placement="center" size="sm"><Modal.Dialog>
      <Modal.CloseTrigger isDisabled={saving} />
      <Modal.Header className="pr-10"><Modal.Heading>Delete DNS Record</Modal.Heading></Modal.Header>
      <Modal.Body className="space-y-4">
        {error ? <DnsError title="Could not delete record" message={error} /> : null}
        <p className="break-all text-sm">Delete all values in the <strong>{record.type}</strong> record set <strong>{record.name}</strong> from {record.zoneName}?</p>
        <p className="break-all text-xs text-muted">{dnsZoneScope(zone, record.zoneId)}</p>
        <p className="text-sm text-muted">This can interrupt services that depend on this record. Cached responses may remain until their TTL expires.</p>
      </Modal.Body>
      <Modal.Footer><Button isDisabled={saving} variant="tertiary" onPress={onCancel}>Cancel</Button><Button isDisabled={saving} isPending={saving} variant="danger-soft" onPress={() => void remove()}>Delete record</Button></Modal.Footer>
    </Modal.Dialog></Modal.Container>
  </Modal.Backdrop>;
}

function DnsEmpty({ title, description }: { readonly title: string; readonly description: string }): React.JSX.Element {
  return <EmptyState className="py-10"><EmptyState.Title>{title}</EmptyState.Title><EmptyState.Description>{description}</EmptyState.Description></EmptyState>;
}

function DnsError({ title, message }: { readonly title: string; readonly message: string }): React.JSX.Element {
  return <Alert role="alert" status="danger"><Alert.Indicator /><Alert.Content><Alert.Title>{title}</Alert.Title><Alert.Description>{message}</Alert.Description></Alert.Content></Alert>;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "The DNS operation failed. Try refreshing and retrying."; }

function dnsZoneScope(zone: CloudDnsZone | undefined, zoneId: string): string {
  return zone ? `${zone.private ? "Private" : "Public"} · ${zone.resourceGroupName ?? zone.id}` : zoneId;
}

const VALUE_HINTS: Record<CloudDnsRecordType, string> = {
  A: "192.0.2.10", AAAA: "2001:db8::10", CNAME: "www.example.com.", MX: "10 mail.example.com.",
  TXT: '"example text"', NS: "ns1.example.com.", PTR: "host.example.com.", SRV: "10 5 443 service.example.com.", CAA: '0 issue "ca.example"',
};
const VALUE_DESCRIPTIONS: Record<CloudDnsRecordType, string> = {
  A: "IPv4 addresses.", AAAA: "IPv6 addresses.", CNAME: "A single target domain name.", MX: "Priority followed by the mail server domain.",
  TXT: 'Quote each text value, for example "example text".', NS: "Name server domain names.", PTR: "Target domain names.",
  SRV: "Priority, weight, port, and target domain.", CAA: 'Flags, tag, and quoted value, for example 0 issue "ca.example".',
};
