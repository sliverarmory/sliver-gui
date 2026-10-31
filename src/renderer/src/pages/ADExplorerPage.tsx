import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Breadcrumbs, Button, Card, Chip, Description, Input, Label, ListBox, ProgressBar, Select, Switch, Tabs, TextField, toast, Tooltip } from "@heroui/react";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronRight, faCircleNodes, faComputer, faRotate, faSatellite, faUpRightFromSquare } from "@fortawesome/free-solid-svg-icons";
import type { SliverSnapshot, PageSummary } from "../../../shared/contracts";
import { parseAdDomain, RUSTHOUND_ARMORY_COLLECTOR_ID,
  type AdCollectionArtifact, type AdCollectionMethod, type AdCollectorProgress, type AdCollectorSummary, type AdCollectorRunResult } from "../../../shared/ad-explorer-contracts";
import type { TargetCatalogEntry, TargetMode, TargetRef, TargetSummary } from "../../../shared/target-contracts";

import { ADCollectionsPanel } from "./ADCollectionsPanel";
import { OtherCollectors } from "./OtherCollectors";

type CollectionMethod = AdCollectionMethod;
type AuthenticationMode = "current-user" | "credentials";
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
  const connectionIdentityRef = useRef(connectionIdentity);
  connectionIdentityRef.current = connectionIdentity;
  const [moreSessions, setMoreSessions] = useState<PageState>(EMPTY_PAGE);
  const [moreBeacons, setMoreBeacons] = useState<PageState>(EMPTY_PAGE);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const assignmentsRef = useRef(assignments);
  assignmentsRef.current = assignments;
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
  const [rustHoundSupported, setRustHoundSupported] = useState(false);
  const [otherCollectorsOpen, setOtherCollectorsOpen] = useState(false);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [collectorId, setCollectorId] = useState("");
  const catalogIdentityRef = useRef("");
  const collectorEditedRef = useRef(false);
  const collectorAuthIdentityRef = useRef("");
  const selectedIdentityRef = useRef("");
  const domainEditedRef = useRef(false);
  const [method, setMethod] = useState<CollectionMethod>("Default");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authenticationMode, setAuthenticationMode] = useState<AuthenticationMode>("current-user");
  const [runningTargetId, setRunningTargetId] = useState<string>();
  const [runResult, setRunResult] = useState<AdCollectorRunResult>();
  const [runError, setRunError] = useState<{ targetId: string; message: string }>();
  const [progress, setProgress] = useState<AdCollectorProgress>();
  const [cancelling, setCancelling] = useState(false);
  const [savedArtifacts, setSavedArtifacts] = useState<AdCollectionArtifact[]>([]);
  const [savedArtifactsError, setSavedArtifactsError] = useState<string>();
  const [recoveryBusy, setRecoveryBusy] = useState<string>();
  const progressGeneration = useRef(0);
  const appliedDomainResult = useRef<AdCollectorRunResult | undefined>(undefined);

  useEffect(() => () => { progressGeneration.current += 1; }, []);

  const refreshSavedArtifacts = useCallback(async () => {
    try {
      const result = await window.sliver.listAdCollectionArtifacts();
      if (!result.ok || !result.value) throw new Error(result.error ?? "Saved collections are unavailable.");
      setSavedArtifacts(result.value);
      setSavedArtifactsError(undefined);
    } catch (error) { setSavedArtifactsError(errorMessage(error)); }
  }, []);

  useEffect(() => {
    void refreshSavedArtifacts();
    const onFocus = () => { void refreshSavedArtifacts(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshSavedArtifacts]);

  useEffect(() => {
    let active = true;
    let eventReceived = false;
    const generation = progressGeneration.current;
    const receive = (value: AdCollectorProgress) => {
      if (!active) return;
      eventReceived = true;
      setProgress(value);
      if (isCollectionActive(value)) {
        setRunningTargetId(value.targetId);
        setCancelling(value.phase === "cancelling");
      } else {
        setRunningTargetId(undefined);
        setCancelling(false);
        if (value.result) setRunResult(value.result);
        if (value.phase === "failed") setRunError({ targetId: value.targetId, message: value.message });
        void refreshSavedArtifacts();
      }
    };
    const unsubscribe = window.sliver.onAdCollectorProgress(receive);
    void window.sliver.getAdCollectorProgress().then((result) => {
      if (active && !eventReceived && generation === progressGeneration.current && result.ok && result.value) receive(result.value);
    }).catch(() => undefined);
    return () => { active = false; unsubscribe(); };
  }, [connectionIdentity, refreshSavedArtifacts]);

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
    setPassword("");
    setRunResult(undefined);
    setRunError(undefined);
    setProgress(undefined);
    setRunningTargetId(undefined);
    setCancelling(false);
  }, [domainScope, connectionIdentity]);

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
  selectedIdentityRef.current = selectedIdentity;
  const selectedTargetAvailable = selected?.target.mode !== "session" || selected.target.liveness === "active";
  const running = runningTargetId !== undefined;
  const verifiedCollectors = catalog.filter((item) => item.compatibility === "verified");
  const customCollectors = catalog.filter((item) => item.compatibility === "operator-supplied" &&
    (item.id === "sharphound:custom:file" || item.id === "sharphound:custom:script"));
  const selectedCollector = catalog.find((item) => item.id === collectorId);
  const rustHoundSelected = collectorId === RUSTHOUND_ARMORY_COLLECTOR_ID;
  const explicitCredentials = rustHoundSelected &&
    (!selectedCollector?.supportsCurrentUser || authenticationMode === "credentials");
  const discoverDomain = rustHoundSelected && selectedCollector?.supportsCurrentUser === true && !explicitCredentials;
  const supportedMethods = METHOD_OPTIONS.filter((option) => selectedCollector?.collectionMethods.includes(option.id));

  useEffect(() => {
    domainEditedRef.current = false;
    collectorEditedRef.current = false;
    setDomainDraft(selectedKey ? assignments[selectedKey] ?? suggestedAdDomain(selected?.target.username ?? "") : "");
    setLdapFqdn("");
    setLdaps(false);
    setUsername(suggestedAdUsername(selected?.target.username ?? ""));
    setPassword("");
    setAuthenticationMode("current-user");
    setOtherCollectorsOpen(false);
    if (selectedKey) collectionHeading.current?.focus();
    else if (returnFocusKey.current) {
      targetButtons.current.get(returnFocusKey.current)?.focus();
      returnFocusKey.current = undefined;
    }
  }, [selectedKey]);

  useEffect(() => {
    if (!runResult?.domain || appliedDomainResult.current === runResult) return;
    const matches = rows.filter((row) => row.target.id === runResult.targetId && row.ref);
    if (matches.length !== 1) return;
    const target = matches[0]!;
    appliedDomainResult.current = runResult;
    if (assignmentsRef.current[target.key]) return;
    let domain: string;
    try { domain = parseAdDomain(runResult.domain); }
    catch { return; }
    const next = { ...readDomainAssignments(domainScope), ...assignmentsRef.current, [target.key]: domain };
    assignmentsRef.current = next;
    setAssignments(next);
    try { writeDomainAssignments(domainScope, next); }
    catch { toast.warning("Domain assignment not saved", { description: "This workstation could not store the discovered domain for future visits." }); }
    if (selectedKey === target.key && (!domainDraft.trim() || !domainEditedRef.current)) {
      domainEditedRef.current = true;
      setDomainDraft(domain);
    }
  }, [domainDraft, domainScope, rows, runResult, selectedKey]);

  useEffect(() => window.sliver.onAdCollectorsChanged(() => {
    setCatalogRevision((revision) => revision + 1);
  }), []);

  useEffect(() => {
    if (!selectedRef || !selected || (selected.target.mode === "session" && selected.target.liveness !== "active") ||
        selected.target.os !== "windows" || assignments[selected.key]) return;
    const expectedIdentity = selectedIdentity;
    let active = true;
    void window.sliver.getAdTargetDomain(selectedRef).then((result) => {
      if (!active || selectedIdentityRef.current !== expectedIdentity || domainEditedRef.current ||
          !result.ok || !result.value?.domain) return;
      setDomainDraft(result.value.domain);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [selectedIdentity]);

  useEffect(() => {
    const authIdentity = `${collectorId}:${selectedCollector?.name ?? ""}:${selectedCollector?.supportsCurrentUser ?? false}`;
    if (collectorAuthIdentityRef.current !== authIdentity) {
      collectorAuthIdentityRef.current = authIdentity;
      setPassword("");
    }
  }, [collectorId, selectedCollector?.name, selectedCollector?.supportsCurrentUser]);

  useEffect(() => {
    const targetChanged = catalogIdentityRef.current !== selectedIdentity;
    catalogIdentityRef.current = selectedIdentity;
    if (!selectedRef) {
      setCatalog([]);
      setCollectorId("");
      setRustHoundSupported(false);
      setCatalogError(undefined);
      setCatalogLoading(false);
      return;
    }
    let active = true;
    if (targetChanged) {
      setCatalog([]);
      setCollectorId("");
      setRustHoundSupported(false);
    }
    setCatalogError(undefined);
    setCatalogLoading(true);
    void window.sliver.listAdCollectors(selectedRef).then((result) => {
      if (!active) return;
      if (!result.ok || !result.value) {
        setCatalogError(result.error ?? "Collector inventory is unavailable.");
        return;
      }
      setCatalog(result.value.collectors);
      setRustHoundSupported(result.value.rustHoundSupported === true);
      setCollectorId((current) => {
        const available = result.value!.collectors.filter((collector) => collector.available);
        if (collectorEditedRef.current && available.some((collector) => collector.id === current)) return current;
        return available.find((collector) => collector.id === RUSTHOUND_ARMORY_COLLECTOR_ID)?.id ??
          available.find((collector) => collector.compatibility === "verified")?.id ?? "";
      });
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
    domainEditedRef.current = true;
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
    if (!selectedRef || !selectedTargetAvailable || !selectedCollector?.available || catalogError ||
        !selectedCollector.collectionMethods.includes(method) || running || recoveryBusy) return;
    let domain: string | undefined;
    try {
      domain = domainDraft.trim() || !discoverDomain ? parseAdDomain(domainDraft) : undefined;
    } catch (error) {
      toast.warning("Domain required", { description: errorMessage(error) });
      return;
    }
    saveDomain();
    const expectedConnection = connectionIdentity;
    const generation = ++progressGeneration.current;
    setRunResult(undefined);
    setRunError(undefined);
    setProgress(undefined);
    setRunningTargetId(selectedRef.id);
    try {
      const result = await window.sliver.runAdCollector({
        target: selectedRef, collectorId, ...(domain ? { domain } : {}), collectionMethod: method,
        ...(rustHoundSelected ? {
          ...(ldapFqdn.trim() ? { ldapFqdn: ldapFqdn.trim() } : {}),
          ...(ldaps ? { ldaps: true } : {}),
          ...(explicitCredentials ? { credentials: { username: username.trim(), password } } : {}),
        } : {}),
      });
      if (connectionIdentityRef.current !== expectedConnection || progressGeneration.current !== generation) return;
      if (!result.ok || !result.value) {
        const message = result.error ?? "The collector could not be started.";
        setRunError({ targetId: selectedRef.id, message });
        toast.danger("Collection failed", { description: message });
        return;
      }
      setRunResult(result.value);
    } catch (error) {
      if (connectionIdentityRef.current !== expectedConnection || progressGeneration.current !== generation) return;
      const message = errorMessage(error);
      setRunError({ targetId: selectedRef.id, message });
      toast.danger("Collection failed", { description: message });
    } finally {
      if (connectionIdentityRef.current === expectedConnection && progressGeneration.current === generation) {
        setPassword("");
        setRunningTargetId(undefined);
        setProgress(undefined);
        setCancelling(false);
        void refreshSavedArtifacts();
      }
    }
  }, [catalogError, collectorId, connectionIdentity, discoverDomain, domainDraft, explicitCredentials, ldapFqdn, ldaps, method, password, recoveryBusy, refreshSavedArtifacts, running, rustHoundSelected, saveDomain, selectedCollector, selectedRef, selectedTargetAvailable, username]);

  const cancelCollection = useCallback(async () => {
    if (!progress?.cancellable || cancelling) return;
    setCancelling(true);
    try {
      const result = await window.sliver.cancelAdCollector({ runId: progress.runId });
      if (!result.ok) throw new Error(result.error ?? "The collection could not be cancelled.");
    } catch (error) {
      setCancelling(false);
      toast.danger("Could not cancel collection", { description: errorMessage(error) });
    }
  }, [cancelling, progress]);

  const retryImport = useCallback(async (collectionId: string) => {
    if (running || recoveryBusy) return;
    setRecoveryBusy(collectionId);
    setRunError(undefined);
    progressGeneration.current += 1;
    try {
      const result = await window.sliver.retryAdCollectionImport({ collectionId });
      if (!result.ok || !result.value) throw new Error(result.error ?? "The saved collection could not be imported.");
      setRunResult(result.value);
    } catch (error) {
      toast.danger("Import failed", { description: errorMessage(error) });
    } finally {
      setRecoveryBusy(undefined);
      void refreshSavedArtifacts();
    }
  }, [recoveryBusy, refreshSavedArtifacts, running]);

  const revealCollection = useCallback(async (collectionId: string) => {
    try {
      const result = await window.sliver.revealAdCollection({ collectionId });
      if (!result.ok) throw new Error(result.error ?? "The saved collection could not be shown.");
    } catch (error) { toast.danger("Could not show collection", { description: errorMessage(error) }); }
  }, []);

  const chooseCollector = useCallback((id: string) => {
    collectorEditedRef.current = true;
    setCollectorId(id);
  }, []);

  const openExplorer = useCallback(async () => {
    try {
      const result = await window.sliver.openBeagleWindow();
      if (!result.ok) toast.danger("Could not open AD Explorer", { description: result.error });
    } catch (error) {
      toast.danger("Could not open AD Explorer", { description: errorMessage(error) });
    }
  }, []);

  const openCollectorArmory = useCallback(async () => {
    try {
      const result = await window.sliver.openAdCollectorArmory();
      if (!result.ok) toast.danger("Could not open Armory", { description: result.error });
    } catch (error) {
      toast.danger("Could not open Armory", { description: errorMessage(error) });
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

      {progress && isCollectionActive(progress) ? (
        <section aria-label="Active AD collection" className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-4">
          <ProgressBar className="min-w-64 flex-1" aria-label="AD collection progress"
            isIndeterminate={!progress.totalBytes || progress.phase !== "transferring"}
            value={progress.transferredBytes} maxValue={progress.totalBytes || 1}
            valueLabel={progress.totalBytes ? `${progress.transferredBytes.toLocaleString()} of ${progress.totalBytes.toLocaleString()} bytes` : undefined}>
            <Label>{progress.message}</Label>
            {progress.totalBytes && progress.phase === "transferring" ? <ProgressBar.Output className="text-xs tabular-nums text-muted" /> : null}
            <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
          </ProgressBar>
          <span className="text-sm text-muted">{rows.find((row) => row.target.id === progress.targetId)?.target.hostname ?? progress.targetId.slice(0, 8)}</span>
          {progress.cancellable || cancelling ? (
            <Button variant="outline" isDisabled={cancelling} isPending={cancelling} onPress={() => void cancelCollection()}>
              {cancelling ? "Cancelling…" : "Cancel collection"}
            </Button>
          ) : null}
        </section>
      ) : null}

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
                    <p className="truncate text-sm font-medium text-foreground">
                      {selected.target.mode === "session" ? "Session identity" : "Beacon identity"}: {selected.target.username || "Unknown user"}
                    </p>
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
                      ? selectedCollector?.supportsCurrentUser
                        ? "Use the target's current Windows identity, or provide AD credentials for this run."
                        : "This installed RustHound build requires AD credentials. Update it in Armory for current-user authentication."
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
                      <TextField className="min-w-0 flex-1 basis-64" value={domainDraft} variant="secondary" isDisabled={running} onChange={(value) => { domainEditedRef.current = true; setDomainDraft(value); }}>
                        <Label>Windows domain</Label>
                        <Input autoComplete="off" maxLength={77} placeholder="corp.example.com" aria-describedby="ad-domain-description" />
                      </TextField>
                      <Button variant="outline" isDisabled={running || domainDraft.trim() === (assignments[selected.key] ?? "")} onPress={saveDomain}>
                        Assign domain
                      </Button>
                    </div>
                    <p id="ad-domain-description" className="text-xs text-muted">{discoverDomain
                      ? "Suggested from the selected target when available. Leave empty to discover its AD domain during collection."
                      : "Suggested from the selected session when available. Confirm the AD DNS domain before running."}</p>
                  </div>
                  {selectedRef ? <>
                    <div className="grid items-start gap-5 sm:grid-cols-2">
                      <Select fullWidth isDisabled={catalogLoading || running || !verifiedCollectors.length} value={selectedCollector?.compatibility === "verified" ? collectorId : ""} variant="secondary" onChange={(value) => chooseCollector(value === null ? "" : String(value))}>
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
                    {rustHoundSupported && !catalogLoading && !catalogError && !catalog.some((collector) => collector.id === RUSTHOUND_ARMORY_COLLECTOR_ID && collector.supportsCurrentUser) ? (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-surface-secondary px-4 py-3">
                        <p className="min-w-0 flex-1 text-sm text-muted">RustHound CE 2.5.30 adds current-user authentication. Install or update it in Armory; this list refreshes automatically.</p>
                        <Button size="sm" variant="outline" onPress={() => void openCollectorArmory()}>Open Armory</Button>
                      </div>
                    ) : null}
                    {rustHoundSelected ? <div className="space-y-5">
                      {selectedCollector?.supportsCurrentUser ? (
                        <Select className="min-w-56 max-w-sm" value={authenticationMode} variant="secondary" isDisabled={running}
                          onChange={(value) => {
                            if (value !== "current-user" && value !== "credentials") return;
                            setAuthenticationMode(value);
                            if (value === "current-user") setPassword("");
                          }}>
                          <Label>Authentication</Label>
                          <Select.Trigger><Select.Value>{authenticationMode === "current-user" ? "Current user" : "AD credentials"}</Select.Value><Select.Indicator /></Select.Trigger>
                          <Select.Popover><ListBox>
                            <ListBox.Item id="current-user" textValue="Current user">Current user<ListBox.ItemIndicator /></ListBox.Item>
                            <ListBox.Item id="credentials" textValue="AD credentials">AD credentials<ListBox.ItemIndicator /></ListBox.Item>
                          </ListBox></Select.Popover>
                        </Select>
                      ) : null}
                      {selectedCollector?.supportsCurrentUser && !explicitCredentials ? (
                        <p className="text-sm text-muted">Uses the selected target's Windows domain logon. It needs usable Kerberos credentials; a domain user name alone does not establish them.</p>
                      ) : null}
                      <div className="grid items-start gap-5 sm:grid-cols-2">
                        {explicitCredentials ? <>
                          <TextField fullWidth value={username} variant="secondary" isDisabled={running} onChange={setUsername}>
                            <Label>AD user</Label>
                            <Input autoComplete="off" maxLength={255} placeholder="user@corp.example.com" />
                            <Description>Suggested from the reported target user. Edit it if needed.</Description>
                          </TextField>
                          <TextField fullWidth value={password} variant="secondary" isDisabled={running} onChange={setPassword}>
                            <Label>AD password</Label>
                            <Input autoComplete="off" type="password" />
                          </TextField>
                        </> : null}
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
                            : explicitCredentials
                              ? "LDAP simple bind sends the supplied password to the domain controller on port 389 without TLS. Use LDAPS when available."
                              : "Current-user authentication uses the target's Windows logon. Enable LDAPS if your directory requires encrypted LDAP transport."}</p>
                        </div>
                      </div>
                    </div> : null}
                    <OtherCollectors collectors={customCollectors} selectedCollectorId={collectorId} isExpanded={otherCollectorsOpen}
                      isBusy={catalogLoading || running} onExpandedChange={setOtherCollectorsOpen} onSelect={chooseCollector} />
                    {catalogError ? <p role="alert" className="text-sm text-danger">{catalogError}</p> : null}
                    {selected.target.mode === "beacon" ? (
                      <p className="text-sm text-muted">{rustHoundSelected
                        ? explicitCredentials
                          ? "Sliver stores beacon task requests and responses on its server, including the credentials supplied for this run. The collector does not save its ZIP on the target."
                          : "Sliver stores beacon task requests and responses on its server. The collector does not save its ZIP on the target."
                        : "Beacon collection ZIPs are limited to 12 MiB and remain on the target. Use an active session for larger collections."}</p>
                    ) : null}
                    {!selectedTargetAvailable ? <p className="text-sm text-muted">This session is no longer active.</p> : null}
                    {running && runningTargetId !== selected.target.id ? <p role="status" className="text-sm text-muted">A collection is running on another target.</p> : null}
                  </> : <p className="text-sm text-muted">This target cannot be selected for collection from the current inventory. Refresh the server snapshot.</p>}
                  {runError?.targetId === selected.target.id ? <p role="alert" className="text-sm text-danger">{runError.message}</p> : null}
                  {runResult?.targetId === selected.target.id ? <div className="space-y-3">
                    <p role="status" className="text-sm text-muted">{runResult.message}</p>
                    {runResult.state === "saved" && runResult.collectionId ? <div className="flex flex-wrap gap-3">
                      <Button variant="secondary" isDisabled={running || Boolean(recoveryBusy)} isPending={recoveryBusy === runResult.collectionId}
                        onPress={() => void retryImport(runResult.collectionId!)}>Retry import</Button>
                      <Button variant="outline" onPress={() => void revealCollection(runResult.collectionId!)}>Show saved collection</Button>
                    </div> : null}
                  </div> : null}
                </Card.Content>
                <Card.Footer className="flex flex-wrap gap-3 p-0">
                  {selectedRef ? (
                    <Button isDisabled={(!domainDraft.trim() && !discoverDomain) || !selectedCollector?.available || !selectedCollector.collectionMethods.includes(method) || !selectedTargetAvailable || catalogLoading || !!catalogError ||
                      running || Boolean(recoveryBusy) || (explicitCredentials && (!username.trim() || !password))} isPending={runningTargetId === selected.target.id} onPress={() => void runCollector()}>
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
        <Tabs.Panel id="collections" className="space-y-6 pt-6">
          {savedArtifacts.length || savedArtifactsError ? <Card className="gap-4 p-6 sm:p-8">
            <Card.Header className="p-0">
              <Card.Title>Saved collections awaiting import</Card.Title>
              <Card.Description>These ZIPs are saved on this workstation and can be imported without collecting again.</Card.Description>
            </Card.Header>
            <Card.Content className="gap-4 p-0">
              {savedArtifactsError ? <div className="space-y-3">
                <p role="alert" className="text-sm text-danger">{savedArtifactsError}</p>
                <Button variant="outline" onPress={() => void refreshSavedArtifacts()}>Refresh saved collections</Button>
              </div> : null}
              {savedArtifacts.length ? <ul aria-label="Saved collections awaiting import" className="divide-y divide-separator">
                {savedArtifacts.map((artifact) => <li key={artifact.collectionId} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1 basis-64">
                    <p className="truncate text-sm font-medium">{artifact.domain}</p>
                    <p className="text-xs text-muted">{new Date(artifact.createdAt).toLocaleString()}</p>
                  </div>
                  <Button variant="secondary" isDisabled={running || Boolean(recoveryBusy)} isPending={recoveryBusy === artifact.collectionId}
                    onPress={() => void retryImport(artifact.collectionId)}>Retry import</Button>
                  <Button variant="outline" onPress={() => void revealCollection(artifact.collectionId)}>Show saved collection</Button>
                </li>)}
              </ul> : null}
            </Card.Content>
          </Card> : null}
          <ADCollectionsPanel key={runResult?.projectId ?? "collections"} onChooseTarget={() => setActiveTab("targets")} />
        </Tabs.Panel>
      </Tabs>
    </section>
  );
}

function isCollectionActive(progress: AdCollectorProgress): boolean {
  return progress.phase !== "complete" && progress.phase !== "failed" && progress.phase !== "cancelled";
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

function suggestedAdUsername(reportedUsername: string): string {
  const username = reportedUsername.trim();
  const separator = username.lastIndexOf("\\");
  return separator < 0 ? username : username.slice(separator + 1).trim();
}

function suggestedAdDomain(reportedUsername: string): string {
  const username = reportedUsername.trim();
  const separator = username.lastIndexOf("@");
  if (separator <= 0 || username.includes("\\")) return "";
  try { return parseAdDomain(username.slice(separator + 1)); }
  catch { return ""; }
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
