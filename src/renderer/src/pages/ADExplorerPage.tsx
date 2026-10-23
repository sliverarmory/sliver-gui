import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Breadcrumbs, Button, Card, Chip, Description, Disclosure, Input, Label, ListBox, Select, Switch, Tabs, TextField, toast, Tooltip } from "@heroui/react";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronRight, faCircleNodes, faComputer, faRotate, faSatellite, faUpRightFromSquare } from "@fortawesome/free-solid-svg-icons";
import type { SliverSnapshot, PageSummary } from "../../../shared/contracts";
import { parseAdDomain, RUSTHOUND_ARMORY_COLLECTOR_ID,
  type AdCollectionMethod, type AdCollectorSummary, type AdCollectorRunResult } from "../../../shared/ad-explorer-contracts";
import type { TargetCatalogEntry, TargetMode, TargetRef, TargetSummary } from "../../../shared/target-contracts";

import { ADCollectionsPanel } from "./ADCollectionsPanel";

type CollectionMethod = AdCollectionMethod;
type PageState = { entries: TargetCatalogEntry[]; page?: PageSummary; loading: boolean; error?: string };

interface TargetRow {
  readonly key: string;
  readonly target: TargetSummary;
  readonly ref?: TargetRef;
}

interface DomainGroup {
  readonly name: string;
  readonly rows: TargetRow[];
}

const METHOD_OPTIONS: readonly { id: CollectionMethod; label: string }[] = [
  { id: "LdapOnly", label: "LDAP only" },
  { id: "All", label: "All supported methods" },
  { id: "Default", label: "Default" },
  { id: "DCOnly", label: "Domain controllers" },
  { id: "ComputerOnly", label: "Computers" },
  { id: "Session", label: "Sessions" },
];

const EMPTY_PAGE: PageState = { entries: [], loading: false };
const DOMAIN_STORAGE_KEY = "ad-explorer.domain-assignments.v1";

export function ADExplorerPage({ snapshot }: { snapshot: SliverSnapshot }): React.JSX.Element {
  const connectionIdentity = [snapshot.connection.epoch, snapshot.connection.incarnation].join(":");
  const inventoryIdentity = [connectionIdentity, snapshot.domains.sessions.revision, snapshot.domains.beacons.revision].join(":");
  const domainScope = JSON.stringify([
    snapshot.connection.server,
    snapshot.connection.configName ?? "",
    snapshot.connection.operator ?? "",
  ]);
  const identityRef = useRef(inventoryIdentity);
  identityRef.current = inventoryIdentity;
  const [moreSessions, setMoreSessions] = useState<PageState>(EMPTY_PAGE);
  const [moreBeacons, setMoreBeacons] = useState<PageState>(EMPTY_PAGE);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState("targets");
  const [selectedKey, setSelectedKey] = useState<string>();
  const collectionHeading = useRef<HTMLHeadingElement>(null);
  const targetButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnFocusKey = useRef<string | undefined>(undefined);
  const [domainDraft, setDomainDraft] = useState("");
  const [ldapFqdn, setLdapFqdn] = useState("");
  const [ldaps, setLdaps] = useState(false);
  const [catalog, setCatalog] = useState<AdCollectorSummary[]>([]);
  const [catalogError, setCatalogError] = useState<string>();
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [otherCollectorsOpen, setOtherCollectorsOpen] = useState(false);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [collectorId, setCollectorId] = useState("");
  const [method, setMethod] = useState<CollectionMethod>("Default");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [runningTargetId, setRunningTargetId] = useState<string>();
  const [runResult, setRunResult] = useState<AdCollectorRunResult>();

  useEffect(() => {
    let active = true;
    const expectedIdentity = inventoryIdentity;
    const loadFirstPage = async (mode: TargetMode) => {
      const update = mode === "session" ? setMoreSessions : setMoreBeacons;
      update({ entries: [], loading: true });
      try {
        const result = await window.sliver.listTargets({ mode, limit: 100 });
        if (!active || expectedIdentity !== identityRef.current) return;
        if (!result.ok || !result.value) {
          update({ entries: [], loading: false, error: result.error ?? "Could not load target catalog." });
          return;
        }
        update({ entries: result.value.items, page: result.value.page, loading: false });
      } catch (error) {
        if (active && expectedIdentity === identityRef.current) {
          update({ entries: [], loading: false, error: errorMessage(error) });
        }
      }
    };
    void loadFirstPage("session");
    void loadFirstPage("beacon");
    return () => { active = false; };
  }, [inventoryIdentity]);

  useEffect(() => {
    setAssignments(readDomainAssignments(domainScope));
    setSelectedKey(undefined);
    setRunResult(undefined);
  }, [domainScope]);

  const rows = useMemo(() => targetRows(snapshot, moreSessions.entries, moreBeacons.entries), [
    snapshot, moreSessions.entries, moreBeacons.entries,
  ]);
  const groups = useMemo(() => groupByDomain(rows, assignments), [rows, assignments]);
  const selected = rows.find((row) => row.key === selectedKey);
  const ref = selected?.ref;
  const selectedRef = ref?.backendEpoch === snapshot.connection.epoch ? ref : undefined;
  const selectedIdentity = selectedRef
    ? `${connectionIdentity}:${selectedRef.mode}:${selectedRef.id}:${selectedRef.fingerprint}`
    : "";
  const selectedTargetAvailable = selected?.target.mode !== "session" || selected.target.liveness === "active";
  const running = runningTargetId !== undefined;
  const verifiedCollectors = catalog.filter((item) => item.compatibility === "verified");
  const customCollectors = catalog.filter((item) => item.compatibility === "operator-supplied" &&
    (item.id === "sharphound:custom:file" || item.id === "sharphound:custom:script"));
  const selectedCollector = catalog.find((item) => item.id === collectorId);
  const rustHoundSelected = collectorId === RUSTHOUND_ARMORY_COLLECTOR_ID;
  const supportedMethods = METHOD_OPTIONS.filter((option) => selectedCollector?.collectionMethods.includes(option.id));

  useEffect(() => {
    setDomainDraft(selectedKey ? assignments[selectedKey] ?? "" : "");
    setLdapFqdn("");
    setLdaps(false);
    setUsername("");
    setPassword("");
    setRunResult(undefined);
    setOtherCollectorsOpen(false);
    if (selectedKey) collectionHeading.current?.focus();
    else if (returnFocusKey.current) {
      targetButtons.current.get(returnFocusKey.current)?.focus();
      returnFocusKey.current = undefined;
    }
  }, [selectedKey]);

  useEffect(() => {
    if (!rustHoundSelected) { setUsername(""); setPassword(""); }
  }, [rustHoundSelected]);

  useEffect(() => {
    if (!selectedRef) {
      setCatalog([]);
      setCatalogError(undefined);
      setCatalogLoading(false);
      return;
    }
    let active = true;
    setCatalog([]);
    setCollectorId("");
    setCatalogError(undefined);
    setCatalogLoading(true);
    void window.sliver.listAdCollectors(selectedRef).then((result) => {
      if (!active) return;
      if (!result.ok || !result.value) {
        setCatalogError(result.error ?? "Collector inventory is unavailable.");
        return;
      }
      setCatalog(result.value.collectors);
      setCollectorId(result.value.collectors.find((collector) => collector.compatibility === "verified" && collector.available)?.id ?? "");
    }).catch((error: unknown) => {
      if (active) setCatalogError(errorMessage(error));
    }).finally(() => {
      if (active) setCatalogLoading(false);
    });
    return () => { active = false; };
  }, [selectedIdentity, catalogRevision]);

  useEffect(() => {
    if (selectedCollector && !selectedCollector.collectionMethods.includes(method)) {
      setMethod(selectedCollector.collectionMethods[0] ?? "Default");
    }
  }, [selectedCollector, method]);

  const loadMore = useCallback(async (mode: TargetMode) => {
    const state = mode === "session" ? moreSessions : moreBeacons;
    const cursor = state.page?.nextCursor;
    if (!cursor || state.loading) return;
    const expectedIdentity = identityRef.current;
    const update = mode === "session" ? setMoreSessions : setMoreBeacons;
    update((current) => ({ entries: current.entries, ...(current.page ? { page: current.page } : {}), loading: true }));
    try {
      const result = await window.sliver.listTargets({ mode, cursor, limit: 100 });
      if (expectedIdentity !== identityRef.current) return;
      if (!result.ok || !result.value) {
        update((current) => ({ ...current, loading: false, error: result.error ?? "Could not load more targets." }));
        return;
      }
      update((current) => ({
        entries: appendEntries(current.entries, result.value!.items),
        page: result.value!.page,
        loading: false,
      }));
    } catch (error) {
      if (expectedIdentity === identityRef.current) {
        update((current) => ({ ...current, loading: false, error: errorMessage(error) }));
      }
    }
  }, [moreSessions, moreBeacons]);

  const saveDomain = useCallback(() => {
    if (!selected) return;
    let domain = "";
    if (domainDraft.trim()) {
      try {
        domain = parseAdDomain(domainDraft);
      } catch (error) {
        toast.warning("Invalid domain", { description: errorMessage(error) });
        return;
      }
    }
    const next = { ...assignments };
    if (domain) next[selected.key] = domain;
    else delete next[selected.key];
    setAssignments(next);
    try {
      writeDomainAssignments(domainScope, next);
    } catch {
      toast.warning("Domain assignment not saved", { description: "This workstation could not store the assignment for future visits." });
    }
  }, [assignments, domainDraft, domainScope, selected]);

  const runCollector = useCallback(async () => {
    if (!selectedRef || !selectedTargetAvailable || !selectedCollector?.available ||
        !selectedCollector.collectionMethods.includes(method) || running) return;
    let domain: string;
    try {
      domain = parseAdDomain(domainDraft);
    } catch (error) {
      toast.warning("Domain required", { description: errorMessage(error) });
      return;
    }
    saveDomain();
    setRunResult(undefined);
    setRunningTargetId(selectedRef.id);
    try {
      const result = await window.sliver.runAdCollector({
        target: selectedRef, collectorId, domain, collectionMethod: method,
        ...(rustHoundSelected ? {
          ...(ldapFqdn.trim() ? { ldapFqdn: ldapFqdn.trim() } : {}),
          ...(ldaps ? { ldaps: true } : {}),
          credentials: { username: username.trim(), password },
        } : {}),
      });
      if (!result.ok || !result.value) {
        toast.danger("Collection failed", { description: result.error ?? "The collector could not be started." });
        return;
      }
      setRunResult(result.value);
    } catch (error) {
      toast.danger("Collection failed", { description: errorMessage(error) });
    } finally {
      setPassword("");
      setRunningTargetId(undefined);
    }
  }, [collectorId, domainDraft, ldapFqdn, ldaps, method, password, running, rustHoundSelected, saveDomain, selectedCollector, selectedRef, selectedTargetAvailable, username]);

  const openExplorer = useCallback(async () => {
    try {
      const result = await window.sliver.openBeagleWindow();
      if (!result.ok) toast.danger("Could not open AD Explorer", { description: result.error });
    } catch (error) {
      toast.danger("Could not open AD Explorer", { description: errorMessage(error) });
    }
  }, []);

  const windowsCount = rows.length;
  const inventoryIncomplete = !moreSessions.page || !moreBeacons.page ||
    moreSessions.page.truncated || moreBeacons.page.truncated;
  const hasMoreSessions = moreSessions.page?.nextCursor !== undefined;
  const hasMoreBeacons = moreBeacons.page?.nextCursor !== undefined;

  const backToTargets = () => {
    returnFocusKey.current = selectedKey;
    setSelectedKey(undefined);
  };

  return (
    <section className="page-stack" aria-labelledby="ad-explorer-heading">
      <header className="page-heading">
        <div className="min-w-0">
          <div className="eyebrow"><FontAwesomeIcon aria-hidden icon={faCircleNodes} /> Active Directory</div>
          <h1 id="ad-explorer-heading">AD Explorer</h1>
          <p>Collect Active Directory data from a Windows target, then explore it in the graph.</p>
        </div>
        <Button variant="outline" onPress={() => void openExplorer()}>
          <FontAwesomeIcon aria-hidden icon={faUpRightFromSquare} /> Open Explorer
        </Button>
      </header>

      <Tabs className="mx-auto w-full max-w-5xl" selectedKey={activeTab} onSelectionChange={(key) => setActiveTab(String(key))} variant="secondary">
        <Tabs.ListContainer className="w-fit max-w-full self-start">
          <Tabs.List aria-label="AD Explorer views">
            <Tabs.Tab id="targets" className="whitespace-nowrap">Windows Targets<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="collections" className="whitespace-nowrap">Collections<Tabs.Indicator /></Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id="targets" className="space-y-6 pt-6">
          {selected ? (
            <>
              <nav aria-label="AD Explorer navigation">
                <Breadcrumbs className="min-w-0 flex-wrap">
                  <Breadcrumbs.Item className="no-underline" href="#ad-explorer-targets" onClick={(event) => event.preventDefault()} onPress={backToTargets}>
                    Windows targets
                  </Breadcrumbs.Item>
                  <Breadcrumbs.Item className="min-w-0 max-w-full truncate no-underline">
                    {selected.target.hostname || selected.target.name || selected.target.id}
                  </Breadcrumbs.Item>
                </Breadcrumbs>
              </nav>

              <div className="flex flex-wrap items-center justify-between gap-4" aria-label="Selected target">
                <div className="flex min-w-0 items-center gap-3">
                  <FontAwesomeIcon aria-hidden icon={selected.target.mode === "session" ? faComputer : faSatellite} className="text-muted" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{selected.target.username || "Unknown user"}</p>
                    <p className="truncate text-xs text-muted">
                      {selected.target.name || "Unnamed target"} · {selected.target.mode === "session" ? "Session" : "Beacon"} · <span className="font-mono">{selected.target.id.slice(0, 8)}</span>
                    </p>
                  </div>
                </div>
                <TargetStatus target={selected.target} />
              </div>

              <Card className="gap-6 p-6 sm:p-8">
                <Card.Header className="flex-row items-start justify-between gap-4 p-0">
                  <div className="min-w-0 space-y-2">
                    <h2 ref={collectionHeading} tabIndex={-1} className="text-lg font-semibold text-foreground outline-none">Collect Data</h2>
                    <Card.Description>{rustHoundSelected
                      ? "RustHound collects in memory using the AD credentials you provide."
                      : "Use a domain user context on this target to collect with SharpHound."}</Card.Description>
                  </div>
                  {selectedRef ? (
                    <Tooltip delay={250}>
                      <Button aria-label="Refresh collectors" isIconOnly variant="ghost" isDisabled={catalogLoading || running} onPress={() => setCatalogRevision((revision) => revision + 1)}>
                        <FontAwesomeIcon aria-hidden icon={faRotate} />
                      </Button>
                      <Tooltip.Content>Refresh collectors</Tooltip.Content>
                    </Tooltip>
                  ) : null}
                </Card.Header>
                <Card.Content className="gap-6 p-0">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-end gap-3">
                      <TextField className="min-w-0 flex-1 basis-64" value={domainDraft} variant="secondary" onChange={setDomainDraft}>
                        <Label>Windows domain</Label>
                        <Input autoComplete="off" maxLength={77} placeholder="corp.example.com" aria-describedby="ad-domain-description" />
                      </TextField>
                      <Button variant="outline" isDisabled={domainDraft.trim() === (assignments[selected.key] ?? "")} onPress={saveDomain}>
                        Assign domain
                      </Button>
                    </div>
                    <p id="ad-domain-description" className="text-xs text-muted">Assignments stay on this workstation; the target does not report its AD domain.</p>
                  </div>
                  {selectedRef ? <>
                    <div className="grid items-start gap-5 sm:grid-cols-2">
                      <Select fullWidth isDisabled={catalogLoading || running || !verifiedCollectors.length} value={selectedCollector?.compatibility === "verified" ? collectorId : ""} variant="secondary" onChange={(value) => setCollectorId(value === null ? "" : String(value))}>
                        <Label>Verified collector</Label>
                        <Select.Trigger><Select.Value>{catalogLoading ? "Loading collectors…" : selectedCollector?.compatibility === "verified" ? selectedCollector.name : "Select a verified collector"}</Select.Value><Select.Indicator /></Select.Trigger>
                        <Select.Popover><ListBox>{verifiedCollectors.map((collector) => (
                          <ListBox.Item id={collector.id} key={collector.id} textValue={collector.name} isDisabled={!collector.available}>
                            <span className="min-w-0"><span className="block truncate text-sm font-medium">{collector.name}</span><span className="block truncate text-xs text-muted">{collector.reason ?? collector.description}</span></span>
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}</ListBox></Select.Popover>
                      </Select>
                      <Select fullWidth isDisabled={running || !selectedCollector || !supportedMethods.length} value={method} variant="secondary" onChange={(value) => { if (value !== null) setMethod(String(value) as CollectionMethod); }}>
                        <Label>Collection method</Label>
                        <Select.Trigger><Select.Value>{METHOD_OPTIONS.find((option) => option.id === method)?.label}</Select.Value><Select.Indicator /></Select.Trigger>
                        <Select.Popover><ListBox>{supportedMethods.map((option) => (
                          <ListBox.Item id={option.id} key={option.id} textValue={option.label}>{option.label}<ListBox.ItemIndicator /></ListBox.Item>
                        ))}</ListBox></Select.Popover>
                      </Select>
                    </div>
                    {!verifiedCollectors.some((collector) => collector.available) && !catalogLoading ? (
                      <p className="text-sm text-muted">No verified Beagle-compatible collector is available for this target.</p>
                    ) : null}
                    {rustHoundSelected ? <div className="space-y-5">
                      <div className="grid items-start gap-5 sm:grid-cols-2">
                        <TextField fullWidth value={username} variant="secondary" isDisabled={running} onChange={setUsername}>
                          <Label>AD user</Label>
                          <Input autoComplete="off" maxLength={255} placeholder="user@corp.example.com" />
                          <Description>Use a UPN or bare user name for this run.</Description>
                        </TextField>
                        <TextField fullWidth value={password} variant="secondary" isDisabled={running} onChange={setPassword}>
                          <Label>AD password</Label>
                          <Input autoComplete="off" type="password" />
                        </TextField>
                        <TextField fullWidth value={ldapFqdn} variant="secondary" isDisabled={running} onChange={setLdapFqdn}>
                          <Label>LDAP server FQDN (optional)</Label>
                          <Input autoComplete="off" placeholder="dc.corp.example.com" />
                          <Description>Use a domain controller name if domain lookup fails.</Description>
                        </TextField>
                        <div className="space-y-2">
                          <Switch className="w-full" aria-label="Use LDAPS" isSelected={ldaps} isDisabled={running} onChange={setLdaps}>
                            <Switch.Content className="min-w-0 flex-1"><span className="block text-sm font-medium text-foreground">Use LDAPS</span></Switch.Content>
                            <Switch.Control><Switch.Thumb /></Switch.Control>
                          </Switch>
                          <p className="text-xs text-warning">{ldaps
                            ? "LDAPS encrypts the connection, but this RustHound build does not validate the domain controller certificate."
                            : "LDAP simple bind sends the supplied password to the domain controller on port 389 without TLS. Use LDAPS when available."}</p>
                        </div>
                      </div>
                    </div> : null}
                    {customCollectors.length ? (
                      <Disclosure isExpanded={otherCollectorsOpen} onExpandedChange={setOtherCollectorsOpen}>
                        <Disclosure.Heading>
                          <Button slot="trigger" variant="ghost" className="-ml-3">
                            Other collectors <Disclosure.Indicator />
                          </Button>
                        </Disclosure.Heading>
                        <Disclosure.Content>
                          <Disclosure.Body className="space-y-3 pt-3">
                            <div className="flex flex-wrap gap-2">
                              {customCollectors.map((collector) => (
                                <Button key={collector.id} className="h-auto min-h-10 whitespace-normal text-left" variant={collectorId === collector.id ? "secondary" : "outline"} aria-pressed={collectorId === collector.id} isDisabled={!collector.available || catalogLoading || running} onPress={() => setCollectorId(collector.id)}>
                                  {collector.id === "sharphound:custom:script" ? "Use your own Invoke-BloodHound .ps1" : "Use your own SharpHound-compatible .exe"}
                                </Button>
                              ))}
                            </div>
                            {customCollectors.filter((collector) => !collector.available && collector.reason).map((collector) => (
                              <p key={collector.id} className="text-xs text-muted">{collector.name}: {collector.reason}</p>
                            ))}
                            <p className="text-xs text-muted">Choose a file when you run. It must accept the fixed domain, method, and output path. The saved ZIP is validated during import.</p>
                          </Disclosure.Body>
                        </Disclosure.Content>
                      </Disclosure>
                    ) : null}
                    {selectedCollector?.compatibility === "operator-supplied" ? (
                      <p className="text-sm text-muted">Selected: {selectedCollector.name}. Choose a verified collector above to switch back.</p>
                    ) : null}
                    {catalogError ? <p role="alert" className="text-sm text-danger">{catalogError}</p> : null}
                    {selected.target.mode === "beacon" ? (
                      <p className="text-sm text-muted">{rustHoundSelected
                        ? "Sliver stores beacon task requests and responses on its server, including the credentials supplied for this run. The collector does not save its ZIP on the target."
                        : "Beacon collection ZIPs are limited to 12 MiB and remain on the target. Use an active session for larger collections."}</p>
                    ) : null}
                    {!selectedTargetAvailable ? <p className="text-sm text-muted">This session is no longer active.</p> : null}
                    {running && runningTargetId !== selected.target.id ? <p role="status" className="text-sm text-muted">A collection is running on another target.</p> : null}
                  </> : <p className="text-sm text-muted">This target cannot be selected for collection from the current inventory. Refresh the server snapshot.</p>}
                  {runResult?.targetId === selected.target.id ? <p role="status" className="text-sm text-muted">{runResult.message}</p> : null}
                </Card.Content>
                <Card.Footer className="flex flex-wrap gap-3 p-0">
                  {selectedRef ? (
                    <Button isDisabled={!domainDraft.trim() || !selectedCollector?.available || !selectedCollector.collectionMethods.includes(method) || !selectedTargetAvailable || catalogLoading ||
                      running || (rustHoundSelected && (!username.trim() || !password))} isPending={runningTargetId === selected.target.id} onPress={() => void runCollector()}>
                      {selectedCollector?.compatibility === "operator-supplied" ? "Run user-supplied collector" : "Run collector"}
                    </Button>
                  ) : null}
                  <Button variant="ghost" onPress={backToTargets}>Change target</Button>
                </Card.Footer>
              </Card>
            </>
          ) : (
            <Card className="gap-6 p-6 sm:p-8" id="ad-explorer-targets">
              <Card.Header className="flex-row items-start justify-between gap-4 p-0">
                <div className="min-w-0 space-y-2">
                  <Card.Title>Windows Targets</Card.Title>
                  <Card.Description>Choose a session or beacon to configure a collection.</Card.Description>
                </div>
                <span className="shrink-0 text-sm tabular-nums text-muted">{windowsCount} {windowsCount === 1 ? "target" : "targets"}</span>
              </Card.Header>
              <Card.Content className="gap-6 p-0">
                {inventoryIncomplete ? (
                  <p className="text-sm text-warning" role="status">Target inventory may be incomplete. Load more targets below to see the remaining sessions and beacons.</p>
                ) : null}
                {groups.length ? groups.map((group) => (
                  <section key={group.name} aria-label={`Domain ${group.name}`} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <h2 className="min-w-0 truncate text-sm font-medium text-muted">{group.name}</h2>
                      <span className="text-xs tabular-nums text-muted">{group.rows.length}</span>
                    </div>
                    <div className="space-y-1">
                      {group.rows.map((row) => (
                        <Button
                          key={row.key}
                          ref={(element) => { if (element) targetButtons.current.set(row.key, element); else targetButtons.current.delete(row.key); }}
                          aria-label={`Select ${row.target.mode} ${row.target.hostname || row.target.name || row.target.id} (${row.target.id})`}
                          className="h-auto min-h-18 w-full justify-start gap-3 rounded-xl px-3 py-3 text-left"
                          variant="ghost"
                          onPress={() => setSelectedKey(row.key)}
                        >
                          <FontAwesomeIcon aria-hidden icon={row.target.mode === "session" ? faComputer : faSatellite} className="text-muted" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-foreground">{row.target.hostname || row.target.name || row.target.id}</span>
                            <span className="block truncate text-xs text-muted">{row.target.username || "Unknown user"} · {row.target.name || "Unnamed target"}</span>
                            <span className="block truncate text-xs text-muted">{row.target.mode === "session" ? "Session" : "Beacon"} · <span className="font-mono">{row.target.id.slice(0, 8)}</span></span>
                          </span>
                          <TargetStatus target={row.target} />
                          <FontAwesomeIcon aria-hidden icon={faChevronRight} className="text-xs text-muted" />
                        </Button>
                      ))}
                    </div>
                  </section>
                )) : (
                  <EmptyState>
                    <EmptyState.Header>
                      <EmptyState.Media variant="icon"><FontAwesomeIcon icon={faComputer} className="text-muted" /></EmptyState.Media>
                      <EmptyState.Title>No Windows targets</EmptyState.Title>
                      <EmptyState.Description>Connect a Windows session or beacon to collect Active Directory data.</EmptyState.Description>
                    </EmptyState.Header>
                  </EmptyState>
                )}
                {(hasMoreSessions || hasMoreBeacons) ? (
                  <div className="flex flex-wrap gap-2">
                    {hasMoreSessions ? <Button variant="outline" isPending={moreSessions.loading} onPress={() => void loadMore("session")}>Load more sessions</Button> : null}
                    {hasMoreBeacons ? <Button variant="outline" isPending={moreBeacons.loading} onPress={() => void loadMore("beacon")}>Load more beacons</Button> : null}
                  </div>
                ) : null}
                {moreSessions.error || moreBeacons.error ? <p role="alert" className="text-sm text-danger">{moreSessions.error ?? moreBeacons.error}</p> : null}
              </Card.Content>
            </Card>
          )}
        </Tabs.Panel>
        <Tabs.Panel id="collections" className="pt-6">
          <ADCollectionsPanel onChooseTarget={() => setActiveTab("targets")} />
        </Tabs.Panel>
      </Tabs>
    </section>
  );
}

function TargetStatus({ target }: { target: TargetSummary }): React.JSX.Element {
  const status = target.mode === "session"
    ? target.liveness === "active" ? "Active" : "Dead"
    : target.checkinStatus === "on-time" ? "On time" : target.checkinStatus === "overdue" ? "Overdue" : "Unknown";
  return <Chip className="shrink-0" size="sm" variant="soft" color={status === "Active" || status === "On time" ? "success" : status === "Overdue" ? "warning" : "default"}>{status}</Chip>;
}

function targetRows(snapshot: SliverSnapshot, extraSessions: TargetCatalogEntry[], extraBeacons: TargetCatalogEntry[]): TargetRow[] {
  const refs = new Map(snapshot.targetContext.selectableTargets.map((ref) => [`${ref.mode}:${ref.id}`, ref]));
  const summaries = new Map<string, TargetSummary>();
  for (const target of [...snapshot.domains.sessions.items, ...snapshot.domains.beacons.items]) {
    summaries.set(`${target.mode}:${target.id}`, target);
  }
  for (const entry of [...extraSessions, ...extraBeacons]) {
    summaries.set(`${entry.target.mode}:${entry.target.id}`, entry.target);
    refs.set(`${entry.ref.mode}:${entry.ref.id}`, entry.ref);
  }
  return [...summaries.values()]
    .filter((target) => target.os.toLowerCase().startsWith("windows"))
    .map((target) => {
      const ref = refs.get(`${target.mode}:${target.id}`);
      return { key: `${target.mode}:${target.id}:${ref?.fingerprint ?? "unselectable"}`, target, ...(ref ? { ref } : {}) };
    })
    .sort((left, right) => (left.target.hostname || left.target.name || left.target.id)
      .localeCompare(right.target.hostname || right.target.name || right.target.id) || left.key.localeCompare(right.key));
}

function groupByDomain(rows: TargetRow[], assignments: Record<string, string>): DomainGroup[] {
  const groups = new Map<string, DomainGroup>();
  for (const row of rows) {
    const name = assignments[row.key]?.trim() || "Unknown domain";
    const key = name.toLocaleLowerCase();
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, { name, rows: [row] });
  }
  return [...groups.values()].sort((left, right) =>
    left.name === "Unknown domain" ? 1 : right.name === "Unknown domain" ? -1 : left.name.localeCompare(right.name));
}

function appendEntries(previous: TargetCatalogEntry[], incoming: TargetCatalogEntry[]): TargetCatalogEntry[] {
  const entries = new Map(previous.map((entry) => [`${entry.target.mode}:${entry.target.id}`, entry]));
  for (const entry of incoming) entries.set(`${entry.target.mode}:${entry.target.id}`, entry);
  return [...entries.values()];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
}

function readDomainAssignments(scope: string): Record<string, string> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(DOMAIN_STORAGE_KEY) ?? "{}");
    if (!isRecord(stored) || !isRecord(stored[scope])) return {};
    return Object.fromEntries(Object.entries(stored[scope]).filter(([key, domain]) =>
      key.length <= 400 && typeof domain === "string" && domain.length <= 255 && Boolean(domain.trim()))) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeDomainAssignments(scope: string, assignments: Record<string, string>): void {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DOMAIN_STORAGE_KEY) ?? "{}");
    if (isRecord(parsed)) stored = parsed;
  } catch {
    // Replace malformed local preferences with the current operator assignments.
  }
  stored[scope] = Object.fromEntries(Object.entries(assignments).slice(-1000));
  window.localStorage.setItem(DOMAIN_STORAGE_KEY, JSON.stringify(stored));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
