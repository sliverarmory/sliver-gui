import { EmptyState } from "@heroui-pro/react/empty-state";
import { NativeSelect } from "@heroui-pro/react/native-select";
import {
  Alert,
  Button,
  Chip,
  Input,
  Label,
  Link,
  Modal,
  ScrollShadow,
  SearchField,
  Spinner,
  Switch,
  Tabs,
  TextField,
  toast,
} from "@heroui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBoxOpen,
  faCodeBranch,
  faFolderOpen,
  faGlobe,
  faKey,
  faMagnifyingGlass,
  faShieldHalved,
  faTerminal,
  faUser,
  faUserPen,
} from "@fortawesome/free-solid-svg-icons";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  ArmoryBundle,
  ArmoryInstalledPackage,
  ArmoryPackage,
  ArmoryPackageKind,
  ArmorySaveSourceInput,
  ArmorySnapshot,
  ArmorySource,
  ArmoryTabId,
} from "../../shared/armory-contracts";
import { isArmoryTab } from "../../shared/armory-contracts";
import type { OperationResult } from "../../shared/contracts";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Field } from "./components/FormControls";
import { AuxiliaryWindowFrame } from "./components/AuxiliaryWindowFrame";

type PackageFilter = "all" | ArmoryPackageKind | "bundle";
type Removal = { kind: "package"; value: ArmoryInstalledPackage } | { kind: "source"; value: ArmorySource };
type Detail = { kind: "installed"; value: ArmoryInstalledPackage } | { kind: "catalog"; value: ArmoryPackage };
type Operation = () => Promise<OperationResult<ArmorySnapshot>>;
const ARMORY_SUCCESS_TOAST_TIMEOUT_MS = 20_000;
const DETAIL_FIELD_ICONS = {
  Commands: faTerminal,
  "Original Author": faUser,
  "Extension Author": faUserPen,
  Repository: faCodeBranch,
  "Installed Directory": faFolderOpen,
  Source: faGlobe,
  "Package Public Key": faKey,
} as const;

export function ArmoryWindowApp(): React.JSX.Element {
  const api = window.armory;
  const [tab, setTab] = useState<ArmoryTabId>("manage");
  const [snapshot, setSnapshot] = useState<ArmorySnapshot>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PackageFilter>("all");
  const [sourceEditor, setSourceEditor] = useState<ArmorySource | "new">();
  const [localImport, setLocalImport] = useState(false);
  const [removal, setRemoval] = useState<Removal>();
  const [detail, setDetail] = useState<Detail>();
  const loadGeneration = useRef(0);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  const refreshAfterOperation = useRef(false);
  const autoRefreshed = useRef(false);
  const successToastIds = useRef(new Set<string>());

  useEffect(() => {
    const activeToastIds = successToastIds.current;
    return () => {
      for (const toastId of activeToastIds) toast.close(toastId);
      activeToastIds.clear();
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!api) return;
    if (busyRef.current) {
      refreshAfterOperation.current = true;
      return;
    }
    const generation = ++loadGeneration.current;
    try {
      const result = await api.snapshot();
      if (!mounted.current || generation !== loadGeneration.current) return;
      if (!result.ok || !result.value) throw new Error(result.error ?? "The local package inventory is unavailable.");
      setSnapshot(result.value);
      setLoadError(undefined);
    } catch (caught) {
      if (mounted.current && generation === loadGeneration.current) setLoadError(errorMessage(caught));
    } finally {
      if (mounted.current && generation === loadGeneration.current) setLoading(false);
    }
  }, [api]);

  const perform = useCallback(async (label: string, operation: Operation, success?: string): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    ++loadGeneration.current;
    setBusy(label);
    setError(undefined);
    try {
      const result = await operation();
      if (!result.ok) throw new Error(result.error ?? "The Armory operation could not be completed.");
      // Cancelling the main-owned file chooser returns success without a snapshot.
      if (mounted.current && result.value) {
        setSnapshot(result.value);
        if (success) {
          const toastId = toast.success(success, {
            timeout: ARMORY_SUCCESS_TOAST_TIMEOUT_MS,
            onClose: () => { successToastIds.current.delete(toastId); },
          });
          successToastIds.current.add(toastId);
        }
      }
      return true;
    } catch (caught) {
      if (mounted.current) setError(errorMessage(caught));
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        setBusy(undefined);
        setLoading(false);
        if (refreshAfterOperation.current) {
          refreshAfterOperation.current = false;
          void refresh();
        }
      }
    }
  }, [refresh]);

  useEffect(() => {
    mounted.current = true;
    if (!api) {
      setLoading(false);
      setLoadError("The Armory bridge is unavailable in this window.");
      return () => { mounted.current = false; };
    }
    let disposed = false;
    let navigationReceived = false;
    const unsubscribeNavigation = api.onNavigationRequested((next) => {
      navigationReceived = true;
      setTab(next);
    });
    const unsubscribeChanged = api.onChanged(() => { void refresh(); });
    const onFocus = (): void => { void refresh(); };
    window.addEventListener("focus", onFocus);
    // The console writes these directories independently of this process.
    // Poll only local state while this window is visible; catalog downloads stay explicit.
    const localRefreshTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5_000);
    void api.getContext().then((result) => {
      if (disposed) return;
      if (!result.ok || !result.value) {
        setLoadError(result.error ?? "The Armory window context is unavailable.");
      } else if (!navigationReceived) setTab(result.value.tab);
    }).catch((caught: unknown) => { if (!disposed) setLoadError(errorMessage(caught)); });
    void refresh();
    return () => {
      disposed = true;
      mounted.current = false;
      ++loadGeneration.current;
      unsubscribeNavigation();
      unsubscribeChanged();
      window.removeEventListener("focus", onFocus);
      window.clearInterval(localRefreshTimer);
    };
  }, [api, refresh]);

  useEffect(() => {
    if (!api || tab !== "install" || !snapshot || snapshot.refreshedAt || autoRefreshed.current || busyRef.current) return;
    autoRefreshed.current = true;
    void perform("Refreshing Catalog", () => api.refreshCatalog());
  }, [api, perform, snapshot, tab]);

  const installed = useMemo(() => (snapshot?.installed ?? []).filter((item) =>
    matches(item, query, filter === "bundle" ? "all" : filter, item.commandNames.join(" "))), [snapshot, query, filter]);
  const packages = useMemo(() => (snapshot?.packages ?? []).filter((item) =>
    matches(item, query, filter, `${item.commandName} ${item.sourceName}`)), [snapshot, query, filter]);
  const bundles = useMemo(() => (snapshot?.bundles ?? []).filter((item) =>
    (filter === "all" || filter === "bundle") && searchMatches(query, item.name, item.sourceName, ...item.packageNames)), [snapshot, query, filter]);
  // ScrollShadow observes its viewport size, but result changes can alter only scrollHeight.
  // Remount changed result sets so its initial overflow check and shadow state stay current.
  const installedResultsKey = useMemo(() => JSON.stringify([
    loading && !snapshot, query, filter === "bundle" ? "all" : filter,
    ...installed.map((item) => [item.id, item.name, item.version, item.description, item.commandNames, item.updateAvailable]),
  ]), [filter, installed, loading, query, snapshot]);
  const availableResultsKey = useMemo(() => JSON.stringify([
    loading && !snapshot, query, filter,
    ...packages.map((item) => [item.id, item.name, item.version, item.description, item.commandName, item.sourceName, item.error, item.installedId, item.updateAvailable]),
    ...bundles.map((item) => [item.id, item.name, item.packageNames]),
  ]), [bundles, filter, loading, packages, query, snapshot]);

  const install = (item: ArmoryPackage): void => {
    if (!api) return;
    const updating = Boolean(item.installedId);
    void perform(updating ? `Updating ${item.name}` : `Installing ${item.name}`,
      () => api.install({ packageId: item.id, ...(updating ? { replace: true } : {}) }),
      `${item.name} ${updating ? "updated" : "installed"}.`);
  };

  const confirmRemoval = async (): Promise<boolean> => {
    if (!api || !removal) return false;
    const result = await perform(`Removing ${removal.value.name}`,
      () => removal.kind === "package"
        ? api.uninstall({ installedId: removal.value.id })
        : api.removeSource({ sourceId: removal.value.id }),
      `${removal.value.name} removed.`);
    if (result) setRemoval(undefined);
    return result;
  };
  const removalDescription = removal?.kind === "source"
    ? "This removes the source from the shared Armory configuration. Its installed packages remain available locally."
    : "This removes the package files from the shared local directory. The package will also be removed from the console's installed inventory.";

  return (
    <AuxiliaryWindowFrame className="overflow-hidden bg-background">
      <div className="auxiliary-window-content mx-auto flex h-full min-h-0 w-full max-w-[1240px] flex-col gap-3 px-5 pb-8 sm:px-8">
        <header className="flex shrink-0 flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent-soft-foreground">
              <FontAwesomeIcon aria-hidden icon={faBoxOpen} className="size-5" />
            </span>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Armory</h1>
              <p className="mt-1 text-sm text-muted">Local packages shared with the Sliver console.</p>
            </div>
          </div>
          <Button variant="outline" isDisabled={!api || Boolean(busy)} isPending={loading} onPress={() => { setLoading(true); void refresh(); }}>
            Refresh Installed
          </Button>
        </header>

        {error || loadError ? <Notice tone="danger" title="Armory Could Not Complete the Request">{error ?? loadError}</Notice> : null}
        {snapshot?.warnings.length ? (
          <Notice tone="warning" title="Some Armory Data Is Unavailable">
            {snapshot.warnings.length === 1 ? snapshot.warnings[0] : (
              <ul className="list-inside list-disc space-y-1">{snapshot.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
            )}
          </Notice>
        ) : null}

        <Tabs className="flex min-h-0 flex-1 flex-col gap-0" selectedKey={tab} variant="secondary" onSelectionChange={(key) => { if (isArmoryTab(key)) setTab(key); }}>
          <Tabs.ListContainer className="w-fit max-w-full shrink-0">
            <Tabs.List aria-label="Armory features">
              <Tabs.Tab id="manage">Manage<Tabs.Indicator /></Tabs.Tab>
              <Tabs.Tab id="install">Install<Tabs.Indicator /></Tabs.Tab>
              <Tabs.Tab id="sources">Sources<Tabs.Indicator /></Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>

          <Tabs.Panel id="manage" className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden pt-0">
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="shrink-0 space-y-2" data-testid="armory-manage-controls">
                <SectionHeading title="Installed Packages" description="Aliases, extensions, and BOFs in your console's local package directories.">
                  <Button variant="outline" isDisabled={!api || Boolean(busy) || !snapshot} onPress={() => { if (api) void perform("Checking for Updates", () => api.refreshCatalog(), "Package catalog refreshed."); }}>
                    Check for Updates
                  </Button>
                </SectionHeading>
                <PackageFilters query={query} filter={filter === "bundle" ? "all" : filter} onQuery={setQuery} onFilter={setFilter} />
              </div>
              <ScrollShadow key={installedResultsKey} aria-label="Installed package results" className="-mx-1 h-0 max-h-full min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-1" data-testid="armory-manage-scroll" role="region" tabIndex={0}>
                {loading && !snapshot ? <Loading /> : installed.length > 0 ? (
                  <ul aria-label="Installed packages" className="divide-y divide-separator">
                    {installed.map((item) => (
                      <PackageRow key={item.id} name={item.name} kind={item.kind} version={item.version} description={item.description} secondary={item.commandNames.join(", ")}>
                        {item.updateAvailable && item.packageId ? (
                          <Button variant="outline" isDisabled={Boolean(busy)} onPress={() => {
                            const available = snapshot?.packages.find((pkg) => pkg.id === item.packageId);
                            if (available) install(available);
                          }}>Update</Button>
                        ) : null}
                        <Button variant="ghost" onPress={() => setDetail({ kind: "installed", value: item })}>Details</Button>
                        <Button aria-label={`Remove ${item.name}`} variant="danger-soft" isDisabled={Boolean(busy)} onPress={() => { setError(undefined); setRemoval({ kind: "package", value: item }); }}>Remove</Button>
                      </PackageRow>
                    ))}
                  </ul>
                ) : (
                  <PackageEmpty title={snapshot?.installed.length ? "No Matching Packages" : "No Packages Installed"} description={snapshot?.installed.length ? "Try another search or package type." : "Browse the catalog or import a signed package to get started."}>
                    {!snapshot?.installed.length ? <Button onPress={() => setTab("install")}>Browse Packages</Button> : null}
                  </PackageEmpty>
                )}
              </ScrollShadow>
            </div>
          </Tabs.Panel>

          <Tabs.Panel id="install" className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden pt-0">
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="shrink-0 space-y-2" data-testid="armory-install-controls">
                <SectionHeading title="Package Catalog" description={snapshot?.refreshedAt ? `Last refreshed ${formatDate(snapshot.refreshedAt)}.` : "Browse packages from your enabled Armory sources."}>
                  <Button variant="ghost" isDisabled={!api || Boolean(busy)} onPress={() => { setError(undefined); setLocalImport(true); }}>Import Signed Package</Button>
                  <Button variant="outline" isDisabled={!api || Boolean(busy)} onPress={() => { if (api) void perform("Refreshing Catalog", () => api.refreshCatalog(), "Package catalog refreshed."); }}>Refresh Catalog</Button>
                </SectionHeading>
                <PackageFilters query={query} filter={filter} onQuery={setQuery} onFilter={setFilter} includeBundles />
                {snapshot?.sources.some((source) => source.error) ? <Notice tone="warning" title="Some Sources Could Not Be Refreshed">
                  <ul className="space-y-1">{snapshot.sources.filter((source) => source.error).map((source) => <li key={source.id}>{source.name}: {source.error}</li>)}</ul>
                  <Button className="mt-3" size="sm" variant="outline" onPress={() => setTab("sources")}>Manage Sources</Button>
                </Notice> : null}
                <p className="flex items-center gap-2 text-xs text-muted"><FontAwesomeIcon aria-hidden icon={faShieldHalved} className="text-success" />Package signatures are verified before installation.</p>
              </div>
              <ScrollShadow key={availableResultsKey} aria-label="Available package results" className="-mx-1 h-0 max-h-full min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-1" data-testid="armory-install-scroll" role="region" tabIndex={0}>
                {loading && !snapshot ? <Loading /> : packages.length + bundles.length > 0 ? (
                  <ul aria-label="Available packages" className="divide-y divide-separator">
                    {packages.map((item) => (
                      <PackageRow key={item.id} name={item.name} kind={item.kind} version={item.version} description={item.description} secondary={item.sourceName}>
                        {item.error ? <span className="max-w-56 break-words text-xs text-danger">{item.error}</span> : null}
                        <Button variant="ghost" onPress={() => setDetail({ kind: "catalog", value: item })}>Details</Button>
                        <Button aria-label={`${item.installedId ? item.updateAvailable ? "Update" : "Installed" : "Install"} ${item.name}`} variant={item.installedId ? "outline" : "primary"} isDisabled={Boolean(busy) || Boolean(item.error) || Boolean(item.installedId && !item.updateAvailable)} onPress={() => install(item)}>
                          {item.installedId ? item.updateAvailable ? "Update" : "Installed" : "Install"}
                        </Button>
                      </PackageRow>
                    ))}
                    {bundles.map((item) => <BundleRow key={item.id} item={item} disabled={Boolean(busy)} onInstall={() => { if (api) void perform(`Installing ${item.name}`, () => api.installBundle({ bundleId: item.id }), `${item.name} installed.`); }} />)}
                  </ul>
                ) : (
                  <PackageEmpty title={busy ? "Refreshing Package Catalog" : "No Packages Found"} description={busy ? "Fetching package information from your enabled sources." : query || filter !== "all" ? "Try another search or package type." : "Refresh the catalog or add an Armory source."}>
                    {!busy && !query && filter === "all" ? <Button variant="outline" onPress={() => setTab("sources")}>Manage Sources</Button> : null}
                  </PackageEmpty>
                )}
              </ScrollShadow>
            </div>
          </Tabs.Panel>

          <Tabs.Panel id="sources" className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain pt-0">
            <div className="space-y-6">
              <SectionHeading title="Armory Sources" description="Repository URLs and trusted public keys shared with the console's Armory configuration.">
                <Button isDisabled={!api || Boolean(busy)} onPress={() => { setError(undefined); setSourceEditor("new"); }}>Add Source</Button>
              </SectionHeading>
              {loading && !snapshot ? <Loading /> : snapshot?.sources.length ? (
                <ul aria-label="Armory sources" className="divide-y divide-separator">
                  {snapshot.sources.map((source) => (
                    <li key={source.id} className="flex flex-col gap-4 py-5 first:pt-0 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1 space-y-2">
                        <h3 className="font-medium">{source.name}</h3>
                        <p className="break-all text-sm text-muted">{source.repoUrl}</p>
                        <p className="break-all font-mono text-xs text-muted" aria-label={`${source.name} public key`}>{source.publicKey}</p>
                        {source.hasAuthorization || source.hasAuthorizationCommand ? <p className="text-xs text-muted">{source.hasAuthorization ? "Saved authorization" : "Console authorization command configured"}</p> : null}
                        {source.error ? <p className="text-sm text-danger">{source.error}</p> : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button variant="ghost" aria-label={`${source.name === "Default" ? "View" : "Edit"} ${source.name}`} isDisabled={Boolean(busy)} onPress={() => { setError(undefined); setSourceEditor(source); }}>{source.name === "Default" ? "Details" : "Edit"}</Button>
                        <Button variant="danger-soft" aria-label={`Remove source ${source.name}`} isDisabled={Boolean(busy)} onPress={() => { setError(undefined); setRemoval({ kind: "source", value: source }); }}>Remove</Button>
                        <Switch aria-label={`Enable ${source.name}`} className="ml-2" isSelected={source.enabled} isDisabled={Boolean(busy) || source.name === "Default"} onChange={(enabled) => {
                          if (api) void perform(`Saving ${source.name}`, () => api.saveSource({ id: source.id, name: source.name, repoUrl: source.repoUrl, publicKey: source.publicKey, enabled }), `${source.name} ${enabled ? "enabled" : "disabled"}.`);
                        }}><Switch.Control><Switch.Thumb /></Switch.Control></Switch>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <PackageEmpty title="No Armory Sources" description="Add a repository and its trusted public key to browse signed packages." />}
            </div>
          </Tabs.Panel>
        </Tabs>

        {snapshot ? <footer className="shrink-0 truncate text-xs text-muted" title={snapshot.rootPath}>Shared directory: <span className="font-mono">{snapshot.rootPath}</span></footer> : null}
      </div>

      {busy ? <div role="status" className="fixed bottom-5 left-1/2 z-40 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-full bg-overlay px-5 py-3 text-sm text-overlay-foreground shadow-overlay"><Spinner size="sm" /><span className="truncate">{busy}…</span></div> : null}
      {sourceEditor && api ? <SourceEditor key={sourceEditor === "new" ? "new" : sourceEditor.id} source={sourceEditor === "new" ? undefined : sourceEditor} busy={Boolean(busy)} error={error} onClose={() => setSourceEditor(undefined)} onSave={async (input) => {
        const saved = await perform("Saving Source", () => api.saveSource(input), "Armory source saved.");
        if (saved) setSourceEditor(undefined);
        return saved;
      }} /> : null}
      {localImport && api ? <LocalImportDialog busy={Boolean(busy)} error={error} onClose={() => setLocalImport(false)} onImport={async (publicKey, replace) => {
        const imported = await perform("Importing Signed Package", () => api.installLocal({ publicKey, replace }), "Signed package installed.");
        if (imported) setLocalImport(false);
        return imported;
      }} /> : null}
      {detail ? <PackageDetails detail={detail} onClose={() => setDetail(undefined)} /> : null}
      <ConfirmDialog isOpen={Boolean(removal)} title={`Remove ${removal?.value.name ?? "package"}?`} description={`${removalDescription}${error ? ` ${error}` : ""}`} confirmLabel="Remove" isPending={Boolean(busy)} onOpenChange={(open) => { if (!open && !busyRef.current) setRemoval(undefined); }} onConfirm={confirmRemoval} />
    </AuxiliaryWindowFrame>
  );
}

function PackageFilters({ query, filter, onQuery, onFilter, includeBundles = false }: { query: string; filter: PackageFilter; onQuery: (value: string) => void; onFilter: (value: PackageFilter) => void; includeBundles?: boolean }): React.JSX.Element {
  return <div className="flex flex-wrap items-center gap-3">
    <SearchField aria-label="Search packages" className="min-w-56 flex-1" value={query} onChange={onQuery}>
      <SearchField.Group><SearchField.SearchIcon><FontAwesomeIcon aria-hidden icon={faMagnifyingGlass} /></SearchField.SearchIcon><SearchField.Input placeholder="Search packages or commands…" /></SearchField.Group>
    </SearchField>
    <NativeSelect className="w-44 shrink-0"><NativeSelect.Trigger aria-label="Package type" value={filter} onChange={(event) => onFilter(event.target.value as PackageFilter)}>
      <NativeSelect.Option value="all">All Types</NativeSelect.Option><NativeSelect.Option value="alias">Aliases</NativeSelect.Option><NativeSelect.Option value="extension">Extensions</NativeSelect.Option><NativeSelect.Option value="bof">BOFs</NativeSelect.Option>
      {includeBundles ? <NativeSelect.Option value="bundle">Bundles</NativeSelect.Option> : null}<NativeSelect.Indicator />
    </NativeSelect.Trigger></NativeSelect>
  </div>;
}

function SectionHeading({ title, description, children }: { title: string; description: string; children?: ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0 max-w-xl"><h2 className="text-lg font-semibold">{title}</h2><p className="mt-1 text-sm leading-5 text-muted">{description}</p></div><div className="flex flex-wrap items-center gap-2">{children}</div></div>;
}

function PackageRow({ name, kind, version, description, secondary, children }: { name: string; kind: ArmoryPackageKind | "bundle"; version: string; description: string; secondary: string; children: ReactNode }): React.JSX.Element {
  return <li className="flex flex-col gap-4 py-5 first:pt-0 sm:flex-row sm:items-center sm:justify-between">
    <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="break-words font-medium">{name}</h3><Chip size="sm" variant="soft">{kindLabel(kind)}</Chip>{version ? <span className="text-xs tabular-nums text-muted">{version}</span> : null}</div>{description ? <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted">{description}</p> : null}{secondary ? <p className="mt-1 truncate text-xs text-muted">{secondary}</p> : null}</div>
    <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
  </li>;
}

function BundleRow({ item, disabled, onInstall }: { item: ArmoryBundle; disabled: boolean; onInstall: () => void }): React.JSX.Element {
  return <PackageRow name={item.name} kind="bundle" version="" description={item.packageNames.join(", ")} secondary={`${item.sourceName} · ${item.packageNames.length} packages`}><Button aria-label={`Install bundle ${item.name}`} isDisabled={disabled} onPress={onInstall}>Install Bundle</Button></PackageRow>;
}

function PackageEmpty({ title, description, children }: { title: string; description: string; children?: ReactNode }): React.JSX.Element {
  return <EmptyState className="py-12"><EmptyState.Header><EmptyState.Title>{title}</EmptyState.Title><EmptyState.Description className="max-w-md">{description}</EmptyState.Description></EmptyState.Header>{children ? <EmptyState.Content>{children}</EmptyState.Content> : null}</EmptyState>;
}

function Loading(): React.JSX.Element {
  return <div role="status" className="flex min-h-48 items-center justify-center gap-3 text-sm text-muted"><Spinner size="sm" />Loading local packages…</div>;
}

function Notice({ tone, title, children }: { tone: "danger" | "warning"; title: string; children: ReactNode }): React.JSX.Element {
  return <Alert className="shrink-0" status={tone}><Alert.Indicator /><Alert.Content><Alert.Title>{title}</Alert.Title><Alert.Description className="break-words">{children}</Alert.Description></Alert.Content></Alert>;
}

function SourceEditor({ source, busy, error, onClose, onSave }: { source: ArmorySource | undefined; busy: boolean; error: string | undefined; onClose: () => void; onSave: (input: ArmorySaveSourceInput) => Promise<boolean> }): React.JSX.Element {
  const [name, setName] = useState(source?.name ?? "");
  const [repoUrl, setRepoUrl] = useState(source?.repoUrl ?? "");
  const [publicKey, setPublicKey] = useState(source?.publicKey ?? "");
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [authorization, setAuthorization] = useState("");
  const [authorizationChanged, setAuthorizationChanged] = useState(false);
  const pinned = source?.name === "Default";
  return <Modal.Backdrop isOpen variant="blur" isDismissable={!busy} isKeyboardDismissDisabled={busy} onOpenChange={(open) => { if (!open && !busy) onClose(); }}><Modal.Container size="md"><Modal.Dialog>
    <form onSubmit={(event) => { event.preventDefault(); void onSave({ ...(source ? { id: source.id } : {}), name: name.trim(), repoUrl: repoUrl.trim(), publicKey: publicKey.trim(), enabled, ...(authorizationChanged ? { authorization } : {}) }); }}>
      <Modal.Header><Modal.Heading>{pinned ? "Default Armory Source" : source ? "Edit Armory Source" : "Add Armory Source"}</Modal.Heading></Modal.Header>
      <Modal.Body className="space-y-4">
        <Field label="Name" value={name} onChange={setName} required disabled={busy || pinned} />
        <Field label="Repository URL" value={repoUrl} onChange={setRepoUrl} placeholder="https://example.com/armory.json" required disabled={busy || pinned} />
        <Field label="Trusted Public Key" value={publicKey} onChange={setPublicKey} description="The source's minisign public key, obtained from its publisher." required disabled={busy || pinned} mono />
        {!pinned ? <Field label="Authorization" value={authorization} onChange={(value) => { setAuthorization(value); setAuthorizationChanged(true); }} type="password" disabled={busy} description={source?.hasAuthorization ? "Leave unchanged to keep the saved authorization header." : "Optional HTTP Authorization header for this source."} /> : null}
        {!pinned && source?.hasAuthorization ? <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => { setAuthorization(""); setAuthorizationChanged(true); }}>{authorizationChanged && !authorization ? "Saved Authorization Will Be Cleared" : "Clear Saved Authorization"}</Button> : null}
        {!pinned && source?.hasAuthorizationCommand ? <p className="text-sm text-muted">This source uses a console authorization command. Enter an authorization header to access it here.</p> : null}
        <Switch className="flex w-full flex-row-reverse justify-between" isSelected={enabled} isDisabled={busy || pinned} onChange={setEnabled}><Switch.Control><Switch.Thumb /></Switch.Control><Switch.Content><Label>Enable Source</Label></Switch.Content></Switch>
        {pinned ? <p className="text-xs text-muted">The console fixes the default source's settings. Add a separate source to use a custom repository or authorization.</p> : null}
        {error ? <p role="alert" className="break-words text-sm text-danger">{error}</p> : null}
      </Modal.Body>
      <Modal.Footer><Button variant="tertiary" isDisabled={busy} onPress={onClose}>{pinned ? "Close" : "Cancel"}</Button>{!pinned ? <Button type="submit" isPending={busy} isDisabled={!name.trim() || !repoUrl.trim() || !publicKey.trim()}>Save Source</Button> : null}</Modal.Footer>
    </form>
  </Modal.Dialog></Modal.Container></Modal.Backdrop>;
}

function LocalImportDialog({ busy, error, onClose, onImport }: { busy: boolean; error: string | undefined; onClose: () => void; onImport: (publicKey: string, replace: boolean) => Promise<boolean> }): React.JSX.Element {
  const [publicKey, setPublicKey] = useState("");
  const [replace, setReplace] = useState(false);
  return <Modal.Backdrop isOpen variant="blur" isDismissable={!busy} isKeyboardDismissDisabled={busy} onOpenChange={(open) => { if (!open && !busy) onClose(); }}><Modal.Container size="md"><Modal.Dialog>
    <form onSubmit={(event) => { event.preventDefault(); void onImport(publicKey.trim(), replace); }}>
      <Modal.Header><Modal.Heading>Import Signed Package</Modal.Heading></Modal.Header>
      <Modal.Body className="space-y-4"><p className="text-sm leading-6 text-muted">Choose a package archive and its minisign signature. The package is verified with the publisher's public key before installation.</p>
        <TextField fullWidth isRequired variant="secondary" value={publicKey} onChange={setPublicKey} isDisabled={busy}><Label>Trusted Public Key</Label><Input className="font-mono text-xs" /></TextField>
        <Switch className="flex w-full flex-row-reverse justify-between" isSelected={replace} isDisabled={busy} onChange={setReplace}><Switch.Control><Switch.Thumb /></Switch.Control><Switch.Content><Label>Replace Existing Package</Label></Switch.Content></Switch>
        {error ? <p role="alert" className="break-words text-sm text-danger">{error}</p> : null}
      </Modal.Body><Modal.Footer><Button variant="tertiary" isDisabled={busy} onPress={onClose}>Cancel</Button><Button type="submit" isPending={busy} isDisabled={!publicKey.trim()}>Choose Archive and Signature</Button></Modal.Footer>
    </form>
  </Modal.Dialog></Modal.Container></Modal.Backdrop>;
}

function PackageDetails({ detail, onClose }: { detail: Detail; onClose: () => void }): React.JSX.Element {
  const item = detail.value;
  const repositoryHref = safeRepositoryHref(item.repoUrl);
  const [repositoryError, setRepositoryError] = useState<string>();
  const openRepository = async (): Promise<void> => {
    if (!repositoryHref) return;
    setRepositoryError(undefined);
    try {
      if (!window.armory) throw new Error("The Armory bridge is unavailable in this window.");
      const result = await window.armory.openRepository({ url: repositoryHref });
      if (!result.ok) throw new Error(result.error ?? "The repository could not be opened in your browser.");
    } catch (caught) {
      setRepositoryError(errorMessage(caught));
    }
  };
  return <Modal.Backdrop isOpen variant="blur" onOpenChange={(open) => { if (!open) onClose(); }}><Modal.Container size="md"><Modal.Dialog>
    <Modal.Header><Modal.Heading>{item.name}</Modal.Heading></Modal.Header>
    <Modal.Body className="space-y-5"><div className="flex items-center gap-3"><Chip variant="soft">{kindLabel(item.kind)}</Chip><span className="text-sm tabular-nums text-muted">{item.version || "Version unspecified"}</span></div>
      <p className="whitespace-pre-wrap break-words text-sm leading-6 text-muted">{item.description || "No description provided."}</p>
      <dl className="space-y-4 text-sm"><DetailField label="Commands" value={detail.kind === "installed" ? detail.value.commandNames.join(", ") : detail.value.commandName} />
        {item.originalAuthor ? <DetailField label="Original Author" value={item.originalAuthor} /> : null}
        {item.kind !== "alias" && item.extensionAuthor ? <DetailField label="Extension Author" value={item.extensionAuthor} /> : null}
        <DetailField label="Repository" value={repositoryHref ? (
          <Link
            aria-label={`${item.repoUrl} (opens in browser)`}
            className="break-all"
            href={repositoryHref}
            rel="noopener noreferrer"
            onClickCapture={(event) => event.preventDefault()}
            onAuxClick={(event) => event.preventDefault()}
            onPress={() => { void openRepository(); }}
          >{item.repoUrl}</Link>
        ) : item.repoUrl || "Not recorded"} />
        {detail.kind === "installed" ? <DetailField label="Installed Directory" value={detail.value.installPath} /> : <><DetailField label="Source" value={detail.value.sourceName} /><DetailField label="Package Public Key" value={<CopyablePublicKey publicKey={detail.value.publicKey} />} /></>}
      </dl>
      {repositoryError ? <p role="alert" className="break-words text-sm text-danger">{repositoryError}</p> : null}
    </Modal.Body><Modal.Footer><Button variant="outline" onPress={onClose}>Close</Button></Modal.Footer>
  </Modal.Dialog></Modal.Container></Modal.Backdrop>;
}

function DetailField({ label, value }: { label: keyof typeof DETAIL_FIELD_ICONS; value: ReactNode }): React.JSX.Element {
  return <div><dt className="flex items-center gap-2 font-medium"><FontAwesomeIcon aria-hidden icon={DETAIL_FIELD_ICONS[label]} className="size-3.5 shrink-0 text-muted" /><span>{label}</span></dt><dd className="mt-1 select-text break-all text-muted">{value}</dd></div>;
}

function CopyablePublicKey({ publicKey }: { publicKey: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string>();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const copy = async (): Promise<void> => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setCopied(false);
    setCopyError(undefined);
    try {
      if (!window.armory) throw new Error("The Armory bridge is unavailable in this window.");
      const result = await window.armory.copyPublicKey({ publicKey });
      if (!result.ok) throw new Error(result.error ?? "The public key could not be copied.");
      setCopied(true);
    } catch (caught) {
      setCopyError(errorMessage(caught));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  return <div>
    <Button
      aria-label="Copy package public key"
      className="h-auto min-h-0 justify-start whitespace-normal px-3 py-2 text-left"
      fullWidth
      isPending={pending}
      variant="secondary"
      onPress={() => { void copy(); }}
    >
      <code className="min-w-0 whitespace-normal break-all font-mono text-xs leading-5">{publicKey}</code>
    </Button>
    <p aria-atomic="true" aria-live={copyError ? "assertive" : "polite"} className={`mt-1 min-h-4 text-xs ${copyError ? "text-danger" : copied ? "text-success" : "text-muted"}`} role={copyError ? "alert" : "status"}>
      {copyError ?? (copied ? "Copied to clipboard." : "Click to copy.")}
    </p>
  </div>;
}

function safeRepositoryHref(value: string): string | undefined {
  try {
    const input = value.trim();
    const authority = /^https?:\/\/([^/?#]+)/iu.exec(input)?.[1];
    if (!authority || authority.includes("@") || /[\\\x00-\x20\x7f]/u.test(input)) return undefined;
    const url = new URL(input);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password) return undefined;
    return url.href.length <= 2048 ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function matches(item: { name: string; kind: ArmoryPackageKind; description: string }, query: string, filter: PackageFilter, extra: string): boolean {
  return (filter === "all" || filter === item.kind) && searchMatches(query, item.name, item.description, extra);
}

function searchMatches(query: string, ...values: readonly string[]): boolean {
  const text = values.join(" ").toLocaleLowerCase();
  return query.toLocaleLowerCase().trim().split(/\s+/u).every((word) => text.includes(word));
}

function kindLabel(kind: ArmoryPackageKind | "bundle"): string {
  return kind === "bof" ? "BOF" : kind === "alias" ? "Alias" : kind === "bundle" ? "Bundle" : "Extension";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
