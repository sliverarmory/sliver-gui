import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertDialog,
  Breadcrumbs,
  Button,
  Chip,
  Description,
  Dropdown,
  Input,
  Label,
  ListBox,
  SearchField,
  Select,
  Spinner,
  Switch,
  TextArea,
  TextField,
  Tooltip,
  toast,
} from "@heroui/react";
import { Segment, Sheet } from "@heroui-pro/react";
import { DataGrid } from "@heroui-pro/react/data-grid";
import type { DataGridColumn } from "@heroui-pro/react/data-grid";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowRight,
  faCamera,
  faChevronDown,
  faClock,
  faCopy,
  faDownload,
  faEllipsisVertical,
  faEye,
  faFile,
  faFolder,
  faFolderPlus,
  faFloppyDisk,
  faKey,
  faMagnifyingGlass,
  faMemory,
  faMicrochip,
  faNetworkWired,
  faPen,
  faPlay,
  faRotate,
  faShieldHalved,
  faStop,
  faTerminal,
  faTrash,
  faTriangleExclamation,
  faUpload,
} from "@fortawesome/free-solid-svg-icons";

import {
  SESSION_WORKBENCH_MAX_ARTIFACT_BYTES,
  SESSION_EDITOR_MAX_BYTES,
  sessionOperationSupportsPlatform,
  type PrepareSessionDestructiveActionInput,
  type SessionBoundedPage,
  type SessionCapturedArtifactResult,
  type SessionDestructiveActionOutcome,
  type SessionDestructiveActionPlan,
  type SessionDirectoryListing,
  type SessionEnvironmentEntry,
  type SessionEnvironmentRevealResult,
  type SessionFileEntry,
  type SessionGrepMatch,
  type SessionHexFileView,
  type SessionIdentityDetail,
  type SessionMemoryFile,
  type SessionMount,
  type SessionNetworkConnection,
  type SessionNetworkInterface,
  type SessionPageSummary,
  type SessionProcess,
  type SessionRegistryHive,
  type SessionRegistryReadResult,
  type SessionRegistryWriteValue,
  type SessionService,
  type SessionTextFileView,
  type SessionWorkbenchInput,
  type SessionWorkbenchResultFor,
} from "../../../shared/session-contracts";
import type {
  SessionWorkspacePanelContext,
  SessionWorkspacePanels,
} from "./SessionWorkspacePage";
import { DateTimePickerField } from "../components/FormControls";

type LoadState<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; error: string };

interface RegistryEntry {
  id: string;
  kind: "key" | "value";
  name: string;
}

interface RegistryListing {
  entries: RegistryEntry[];
  subkeysPage: SessionPageSummary;
  valuesPage: SessionPageSummary;
}

type RegistryEditorMode = "create-key" | "write-value";

const REGISTRY_HIVES: readonly SessionRegistryHive[] = ["HKCU", "HKLM", "HKCR", "HKU", "HKCC"];

export const defaultSessionWorkspacePanels: SessionWorkspacePanels = {
  overview: (context) => <SessionOverviewPanel key={workspaceRouteKey(context.route)} {...context} />,
  files: (context) => <SessionFilesPanel key={workspaceRouteKey(context.route)} {...context} />,
  processes: (context) => <SessionProcessesPanel key={workspaceRouteKey(context.route)} {...context} />,
  network: (context) => <SessionNetworkPanel key={workspaceRouteKey(context.route)} {...context} />,
  environment: (context) => <SessionEnvironmentPanel key={workspaceRouteKey(context.route)} {...context} />,
  registry: (context) => <SessionRegistryPanel key={workspaceRouteKey(context.route)} {...context} />,
};

export function SessionOverviewPanel({ route, session }: SessionWorkspacePanelContext): React.JSX.Element {
  const routeKey = workspaceRouteKey(route);
  const platform = normalizedPlatform(session.os);
  const [identity, setIdentity] = useState<LoadState<SessionIdentityDetail | undefined>>(
    platform === "windows" ? { status: "loading" } : { status: "ready", value: undefined },
  );
  const [screenshot, setScreenshot] = useState<SessionCapturedArtifactResult>();
  const [isScreenshotSaved, setIsScreenshotSaved] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isSavingScreenshot, setIsSavingScreenshot] = useState(false);
  const identityRequestSequence = useRef(0);
  const isCurrent = useLatestIdentity(routeKey);

  const loadIdentity = useCallback(async () => {
    if (platform !== "windows") {
      setIdentity({ status: "ready", value: undefined });
      return;
    }
    const expected = routeKey;
    const sequence = ++identityRequestSequence.current;
    setIdentity({ status: "loading" });
    try {
      const result = await runWorkbench({ operationId: "session.identity.current-token-owner" });
      if (isCurrent(expected) && sequence === identityRequestSequence.current) setIdentity({ status: "ready", value: result });
    } catch (error) {
      if (isCurrent(expected) && sequence === identityRequestSequence.current) setIdentity({ status: "error", error: errorMessage(error) });
    }
  }, [isCurrent, platform, routeKey]);

  useEffect(() => {
    identityRequestSequence.current += 1;
    setIdentity(platform === "windows" ? { status: "loading" } : { status: "ready", value: undefined });
    setScreenshot(undefined);
    setIsScreenshotSaved(false);
    void loadIdentity();
  }, [loadIdentity, platform, routeKey]);

  useEffect(() => {
    if (!screenshot) return;
    const remaining = Date.parse(screenshot.artifact.expiresAt) - Date.now();
    if (remaining <= 0) {
      setScreenshot(undefined);
      setIsScreenshotSaved(false);
      return;
    }
    const timer = setTimeout(() => {
      setScreenshot(undefined);
      setIsScreenshotSaved(false);
    }, Math.min(remaining, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [screenshot]);

  const captureScreenshot = useCallback(async () => {
    const expected = routeKey;
    setIsCapturing(true);
    try {
      const captured = await runWorkbench({ operationId: "session.screenshot.capture" });
      if (!isCurrent(expected)) return;
      setScreenshot(captured);
      setIsScreenshotSaved(false);
      toast.success("Screenshot captured", { description: captured.artifact.suggestedBasename });
    } catch (error) {
      if (isCurrent(expected)) toast.danger("Screenshot failed", { description: errorMessage(error) });
    } finally {
      if (isCurrent(expected)) setIsCapturing(false);
    }
  }, [isCurrent, routeKey]);

  const saveScreenshot = useCallback(async () => {
    if (!screenshot) return;
    const expected = routeKey;
    setIsSavingScreenshot(true);
    try {
      const result = await runWorkbench({
        operationId: "session.artifact.save",
        handle: screenshot.artifact.handle,
      });
      if (!isCurrent(expected)) return;
      if (result.status === "saved") {
        toast.success("Screenshot saved", { description: result.suggestedBasename });
        setIsScreenshotSaved(true);
      } else {
        toast.info("Save canceled");
      }
    } catch (error) {
      if (isCurrent(expected)) toast.danger("Could not save screenshot", { description: errorMessage(error) });
    } finally {
      if (isCurrent(expected)) setIsSavingScreenshot(false);
    }
  }, [isCurrent, routeKey, screenshot]);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PanelShell
        icon={faShieldHalved}
        title="Identity"
        description="Read-only session identity reported by the active implant."
        action={platform === "windows" ? <RefreshButton label="Refresh identity" pending={identity.status === "loading"} onPress={() => void loadIdentity()} /> : undefined}
      >
        {identity.status === "loading" ? <p className="mb-4 text-xs text-muted" aria-live="polite">Loading enhanced Windows identity…</p> : null}
        {identity.status === "error" ? <div className="mb-5"><PanelError message={identity.error} onRetry={() => void loadIdentity()} /></div> : null}
        <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
          <Detail label="Session" value={session.name || "Unnamed session"} />
          <Detail label="Session ID" value={session.id} mono />
          <Detail label="Liveness" value={session.liveness === "active" ? "Active" : "Dead"} />
          <Detail label="Host" value={identity.status === "ready" ? identity.value?.hostname || session.hostname || "Not reported" : session.hostname || "Not reported"} />
          <Detail label="Host ID" value={session.hostId || "Not reported"} mono />
          <Detail label="User" value={identity.status === "ready" ? identity.value?.username || session.username || "Not reported" : session.username || "Not reported"} />
          <Detail label="UID / GID" value={[
            identity.status === "ready" ? identity.value?.uid ?? session.uid : session.uid,
            identity.status === "ready" ? identity.value?.gid ?? session.gid : session.gid,
          ].filter(Boolean).join(" / ") || "Not reported"} mono />
          <Detail label="Token owner" value={identity.status === "ready" ? identity.value?.tokenOwner || (platform === "windows" ? "Not reported" : "Windows only") : platform === "windows" ? "Unavailable" : "Windows only"} />
          <Detail label="Executable" value={identity.status === "ready" ? identity.value?.executable || session.executable || "Not reported" : session.executable || "Not reported"} mono />
          <Detail label="PID" value={String(identity.status === "ready" ? identity.value?.pid ?? session.pid ?? "Not reported" : session.pid ?? "Not reported")} mono />
          <Detail label="Platform" value={`${identity.status === "ready" ? identity.value?.os || session.os || "unknown" : session.os || "unknown"} / ${identity.status === "ready" ? identity.value?.arch || session.arch || "unknown" : session.arch || "unknown"}`} />
          <Detail label="Version" value={session.version || "Not reported"} />
          <Detail label="Locale" value={session.locale || "Not reported"} />
          <Detail label="Integrity" value={session.integrity || "Not reported"} />
          <Detail label="Transport" value={session.transport} />
          <Detail label="Remote address" value={session.remoteAddress || "Not reported"} mono />
          <Detail label="Active C2" value={session.activeC2 || "Not reported"} mono />
          <Detail label="Burned" value={session.burned ? "Yes" : "No"} />
          <Detail label="First contact" value={session.firstContactAt ? formatDate(session.firstContactAt) : "Not reported"} />
          <Detail label="Last check-in" value={session.lastCheckinAt ? formatDate(session.lastCheckinAt) : "Not reported"} />
          <Detail label="Reconnect interval" value={session.reconnectIntervalMs === undefined ? "Not reported" : formatDuration(session.reconnectIntervalMs)} />
        </dl>
      </PanelShell>

      <PanelShell
        icon={faCamera}
        title="Screenshot"
        description="Capture a bounded image preview, then explicitly save it with a native dialog."
        action={sessionOperationSupportsPlatform("session.screenshot.capture", platform) ? (
          <Button isPending={isCapturing} size="sm" variant="secondary" onPress={() => void captureScreenshot()}>
            <FontAwesomeIcon aria-hidden icon={faCamera} /> Capture
          </Button>
        ) : null}
      >
        {!sessionOperationSupportsPlatform("session.screenshot.capture", platform) ? (
          <PanelUnavailable title="Screenshot unavailable" description="Screenshot capture is supported for Windows and Linux sessions." />
        ) : screenshot ? (
          <div className="overflow-hidden rounded-xl border border-separator bg-default">
            <img
              alt={`Screenshot from ${session.name || session.hostname || session.id}`}
              className="max-h-[420px] w-full object-contain"
              src={screenshot.preview.dataUrl}
            />
            <div className="flex flex-col gap-3 border-t border-separator px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{screenshot.artifact.suggestedBasename}</p>
                <p className="text-xs text-muted">{formatBytes(screenshot.artifact.size)} · expires {formatTime(screenshot.artifact.expiresAt)}</p>
              </div>
              <Button isDisabled={isScreenshotSaved} isPending={isSavingScreenshot} size="sm" variant="secondary" onPress={() => void saveScreenshot()}>
                <FontAwesomeIcon aria-hidden icon={faFloppyDisk} /> {isScreenshotSaved ? "Saved" : "Save as…"}
              </Button>
            </div>
          </div>
        ) : (
          <PanelEmpty icon={faCamera} title="No screenshot captured" description="Capture is explicit and the preview remains bound to this window and session." />
        )}
      </PanelShell>
    </div>
  );
}

export function SessionNetworkPanel({ route }: SessionWorkspacePanelContext): React.JSX.Element {
  const routeKey = workspaceRouteKey(route);
  const [interfaces, setInterfaces] = useState<LoadState<SessionBoundedPage<SessionNetworkInterface>>>({ status: "loading" });
  const [connections, setConnections] = useState<LoadState<SessionBoundedPage<SessionNetworkConnection>>>({ status: "loading" });
  const [isLoadingMoreInterfaces, setIsLoadingMoreInterfaces] = useState(false);
  const [isLoadingMoreConnections, setIsLoadingMoreConnections] = useState(false);
  const interfaceRequestSequence = useRef(0);
  const connectionRequestSequence = useRef(0);
  const isCurrent = useLatestIdentity(routeKey);

  const loadInterfaces = useCallback(async (cursor?: string) => {
    const expected = routeKey;
    const sequence = ++interfaceRequestSequence.current;
    if (cursor) setIsLoadingMoreInterfaces(true);
    else setInterfaces({ status: "loading" });
    try {
      const result = await runWorkbench({ operationId: "session.network.interfaces", limit: 100, ...(cursor ? { cursor } : {}) });
      if (!isCurrent(expected) || sequence !== interfaceRequestSequence.current) return;
      setInterfaces((current) => cursor && current.status === "ready"
        ? { status: "ready", value: mergePagedResult(result, uniqueNetworkInterfaces([...current.value.items, ...result.items])) }
        : { status: "ready", value: result });
    } catch (error) {
      if (!isCurrent(expected) || sequence !== interfaceRequestSequence.current) return;
      if (cursor) toast.danger("Could not load more interfaces", { description: errorMessage(error) });
      else setInterfaces({ status: "error", error: errorMessage(error) });
    } finally {
      if (isCurrent(expected) && sequence === interfaceRequestSequence.current) setIsLoadingMoreInterfaces(false);
    }
  }, [isCurrent, routeKey]);

  const loadConnections = useCallback(async (cursor?: string) => {
    const expected = routeKey;
    const sequence = ++connectionRequestSequence.current;
    if (cursor) setIsLoadingMoreConnections(true);
    else setConnections({ status: "loading" });
    try {
      const result = await runWorkbench({
        operationId: "session.network.connections",
        tcp: true,
        udp: true,
        ip4: true,
        ip6: true,
        listening: false,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!isCurrent(expected) || sequence !== connectionRequestSequence.current) return;
      setConnections((current) => cursor && current.status === "ready"
        ? { status: "ready", value: mergePagedResult(result, uniqueNetworkConnections([...current.value.items, ...result.items])) }
        : { status: "ready", value: result });
    } catch (error) {
      if (!isCurrent(expected) || sequence !== connectionRequestSequence.current) return;
      if (cursor) toast.danger("Could not load more connections", { description: errorMessage(error) });
      else setConnections({ status: "error", error: errorMessage(error) });
    } finally {
      if (isCurrent(expected) && sequence === connectionRequestSequence.current) setIsLoadingMoreConnections(false);
    }
  }, [isCurrent, routeKey]);

  useEffect(() => {
    interfaceRequestSequence.current += 1;
    connectionRequestSequence.current += 1;
    setInterfaces({ status: "loading" });
    setConnections({ status: "loading" });
    setIsLoadingMoreInterfaces(false);
    setIsLoadingMoreConnections(false);
    void loadInterfaces();
    void loadConnections();
  }, [loadConnections, loadInterfaces, routeKey]);

  const connectionRows = useMemo(
    () => connections.status === "ready"
      ? connections.value.items.map((connection, index) => ({ connection, id: networkConnectionKey(connection, index) }))
      : [],
    [connections],
  );
  const connectionColumns = useMemo<DataGridColumn<(typeof connectionRows)[number]>[]>(() => [
    {
      id: "protocol",
      header: "Protocol",
      isRowHeader: true,
      minWidth: 100,
      cell: ({ connection }) => <span className="font-mono text-xs uppercase">{connection.protocol}</span>,
    },
    {
      id: "local",
      header: "Local",
      minWidth: 200,
      cell: ({ connection }) => <Address value={connection.local} />,
    },
    {
      id: "remote",
      header: "Remote",
      minWidth: 200,
      cell: ({ connection }) => <Address value={connection.remote} />,
    },
    {
      id: "state",
      header: "State",
      minWidth: 120,
      cell: ({ connection }) => <Chip size="sm" variant="soft">{connection.state || "Unknown"}</Chip>,
    },
    {
      id: "process",
      header: "Process",
      minWidth: 180,
      cell: ({ connection }) => (
        <span className="text-xs text-muted">
          {connection.process ? `${connection.process.executable || "Process"} (${connection.process.pid})` : "Not reported"}
        </span>
      ),
    },
  ], []);

  return (
    <PanelShell
      icon={faNetworkWired}
      title="Network"
      description="Bounded interfaces and current socket inventory."
      action={<RefreshButton label="Refresh network" pending={interfaces.status === "loading" || connections.status === "loading"} onPress={() => { void loadInterfaces(); void loadConnections(); }} />}
    >
      <div className="flex min-w-0 flex-col gap-6">
        <section className="flex min-w-0 flex-col gap-3" aria-labelledby="network-interfaces-heading">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground" id="network-interfaces-heading">Interfaces</h3>
              {interfaces.status === "ready" ? <InventoryCount loaded={interfaces.value.items.length} noun="interfaces" page={interfaces.value.page} /> : null}
            </div>
          </div>
          {interfaces.status === "loading" ? <PanelLoading label="Loading network interfaces" /> : null}
          {interfaces.status === "error" ? <PanelError message={interfaces.error} onRetry={() => void loadInterfaces()} /> : null}
          {interfaces.status === "ready" ? (
            <>
              {interfaces.value.page.truncated ? <BoundedNotice nextCursor={interfaces.value.page.nextCursor} noun="interfaces" /> : null}
              {interfaces.value.items.length > 0 ? (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {interfaces.value.items.map((item) => (
                    <article className="rounded-xl border border-separator bg-default px-4 py-3" key={`${item.index}:${item.name}`}>
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate text-sm font-medium text-foreground">{item.name || `Interface ${item.index}`}</p>
                        <span className="font-mono text-[11px] text-muted">#{item.index}</span>
                      </div>
                      <p className="mt-2 truncate font-mono text-xs text-muted">{item.macAddress || "No MAC address"}</p>
                      <ul className="mt-2 space-y-1">
                        {item.addresses.map((address) => <li className="truncate font-mono text-xs" key={address}>{address}</li>)}
                      </ul>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted">No network interfaces were reported.</p>
              )}
              {interfaces.value.page.nextCursor ? (
                <div className="flex justify-center"><Button isPending={isLoadingMoreInterfaces} size="sm" variant="tertiary" onPress={() => void loadInterfaces(interfaces.value.page.nextCursor)}>Load more interfaces</Button></div>
              ) : null}
            </>
          ) : null}
        </section>
        <section className="flex min-w-0 flex-col gap-3 border-t border-separator pt-5" aria-labelledby="network-connections-heading">
          <div>
            <h3 className="text-sm font-semibold text-foreground" id="network-connections-heading">Connections</h3>
            {connections.status === "ready" ? <InventoryCount loaded={connections.value.items.length} noun="connections" page={connections.value.page} /> : null}
          </div>
          {connections.status === "loading" ? <PanelLoading label="Loading network connections" /> : null}
          {connections.status === "error" ? <PanelError message={connections.error} onRetry={() => void loadConnections()} /> : null}
          {connections.status === "ready" ? (
            <>
              {connections.value.page.truncated ? <BoundedNotice nextCursor={connections.value.page.nextCursor} noun="connections" /> : null}
              <DataGrid
                aria-label="Session network connections"
                columns={connectionColumns}
                contentClassName="min-w-[820px]"
                data={connectionRows}
                getRowId={(row) => row.id}
                scrollContainerClassName="max-h-[360px] overflow-auto"
                variant="secondary"
                renderEmptyState={() => <GridEmpty label="No network connections were reported." />}
              />
              {connections.value.page.nextCursor ? (
                <div className="flex justify-center"><Button isPending={isLoadingMoreConnections} size="sm" variant="tertiary" onPress={() => void loadConnections(connections.value.page.nextCursor)}>Load more connections</Button></div>
              ) : null}
            </>
          ) : null}
        </section>
      </div>
    </PanelShell>
  );
}

export function SessionFilesPanel({ route, session }: SessionWorkspacePanelContext): React.JSX.Element {
  const routeKey = workspaceRouteKey(route);
  const platform = normalizedPlatform(session.os);
  const isWindows = platform === "windows";
  const [mode, setMode] = useState<FileWorkbenchMode>("browser");
  const [state, setState] = useState<LoadState<SessionDirectoryListing>>({ status: "loading" });
  const [stateRouteKey, setStateRouteKey] = useState(routeKey);
  const [currentPath, setCurrentPath] = useState("");
  const [requestedPath, setRequestedPath] = useState("");
  const [pathDraft, setPathDraft] = useState("");
  const [folderName, setFolderName] = useState("");
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isNavigating, setIsNavigating] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [busyFile, setBusyFile] = useState<string>();
  const [inspector, setInspector] = useState<FileInspectorSelection>();
  const [destructiveRefreshToken, setDestructiveRefreshToken] = useState(0);
  const navigationRequestSequence = useRef(0);
  const isCurrent = useLatestIdentity(routeKey);
  const destructive = useDestructiveAction(routeKey, () => {
    setInspector(undefined);
    setDestructiveRefreshToken((current) => current + 1);
    if (currentPath) void loadPath(currentPath);
  });
  const visibleState: LoadState<SessionDirectoryListing> = stateRouteKey === routeKey ? state : { status: "loading" };
  const visibleCurrentPath = stateRouteKey === routeKey ? currentPath : "";
  const visiblePathDraft = stateRouteKey === routeKey ? pathDraft : "";
  const visibleRequestedPath = stateRouteKey === routeKey ? requestedPath : "";
  const locationActionsAvailable = visibleState.status === "ready" &&
    visibleState.value.exists === true &&
    visibleState.value.path === currentPath &&
    !isNavigating;

  const loadPath = useCallback(async (path: string, cursor?: string) => {
    const expected = routeKey;
    const requestSequence = ++navigationRequestSequence.current;
    if (cursor) setIsLoadingMore(true);
    else {
      setIsLoadingMore(false);
      setRequestedPath(path);
      setIsNavigating(true);
    }
    setState((current) => cursor && current.status === "ready" ? current : { status: "loading" });
    try {
      const listing = await runWorkbench({
        operationId: "session.filesystem.ls",
        path,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!isCurrent(expected) || requestSequence !== navigationRequestSequence.current) return;
      if (!listing.exists) {
        if (cursor) {
          toast.danger("Could not load more files", { description: `${path} no longer exists` });
          return;
        }
        setRequestedPath(path);
        setPathDraft(path);
        setState({ status: "ready", value: listing });
        return;
      }
      setCurrentPath(listing.path);
      setRequestedPath(listing.path);
      setPathDraft(listing.path);
      setState((current) => cursor && current.status === "ready"
        ? { status: "ready", value: mergePagedResult(listing, uniqueFiles([...current.value.items, ...listing.items])) }
        : { status: "ready", value: listing });
    } catch (error) {
      if (!isCurrent(expected) || requestSequence !== navigationRequestSequence.current) return;
      if (cursor) toast.danger("Could not load more files", { description: errorMessage(error) });
      else setState({ status: "error", error: errorMessage(error) });
    } finally {
      if (isCurrent(expected) && requestSequence === navigationRequestSequence.current) {
        if (cursor) setIsLoadingMore(false);
        else setIsNavigating(false);
      }
    }
  }, [isCurrent, routeKey]);

  const initializeFiles = useCallback(async () => {
    const expected = routeKey;
    const requestSequence = ++navigationRequestSequence.current;
    setStateRouteKey(routeKey);
    setCurrentPath("");
    setRequestedPath("");
    setPathDraft("");
    setIsNavigating(true);
    setIsLoadingMore(false);
    setState({ status: "loading" });
    try {
      const result = await runWorkbench({ operationId: "session.filesystem.pwd" });
      if (!isCurrent(expected) || requestSequence !== navigationRequestSequence.current) return;
      await loadPath(result.path);
    } catch (error) {
      if (!isCurrent(expected) || requestSequence !== navigationRequestSequence.current) return;
      setState({ status: "error", error: errorMessage(error) });
      setIsNavigating(false);
    }
  }, [isCurrent, loadPath, routeKey]);

  useEffect(() => {
    setMode("browser");
    setInspector(undefined);
    setBusyFile(undefined);
    void initializeFiles();
    return () => {
      navigationRequestSequence.current += 1;
    };
  }, [initializeFiles, routeKey]);

  const createFolder = useCallback(async () => {
    const name = folderName.trim();
    if (!name || !currentPath || !locationActionsAvailable) return;
    const expected = routeKey;
    setIsCreatingFolder(true);
    try {
      const result = await runWorkbench({
        operationId: "session.filesystem.mkdir",
        path: joinRemotePath(currentPath, name, isWindows),
      });
      if (!isCurrent(expected)) return;
      toast.success("Folder created", { description: result.path ?? result.message });
      setFolderName("");
      await loadPath(currentPath);
    } catch (error) {
      if (isCurrent(expected)) notifyWorkbenchFailure("Could not create folder", "Folder outcome unknown", error);
    } finally {
      if (isCurrent(expected)) setIsCreatingFolder(false);
    }
  }, [currentPath, folderName, isCurrent, isWindows, loadPath, locationActionsAvailable, routeKey]);

  const upload = useCallback(async () => {
    if (!currentPath || !locationActionsAvailable) return;
    const expected = routeKey;
    setIsUploading(true);
    try {
      const result = await runWorkbench({
        operationId: "session.filesystem.upload-open",
        remotePath: currentPath,
        isIOC: false,
        isDirectory: false,
        overwrite: false,
      });
      if (!isCurrent(expected)) return;
      if (result.status === "uploaded") {
        toast.success("Upload complete", { description: result.suggestedBasename });
        await loadPath(currentPath);
      } else {
        toast.info("Upload canceled");
      }
    } catch (error) {
      if (isCurrent(expected)) notifyWorkbenchFailure("Upload failed", "Upload outcome unknown", error);
    } finally {
      if (isCurrent(expected)) setIsUploading(false);
    }
  }, [currentPath, isCurrent, loadPath, locationActionsAvailable, routeKey]);

  const download = useCallback(async (file: SessionFileEntry) => {
    const expected = routeKey;
    setBusyFile(file.path);
    try {
      const result = await runWorkbench({
        operationId: "session.filesystem.download",
        path: file.path,
        maxBytes: SESSION_WORKBENCH_MAX_ARTIFACT_BYTES,
      });
      if (!isCurrent(expected)) return;
      if (result.status === "saved") toast.success("File saved", { description: result.suggestedBasename });
      else toast.info("Download canceled");
    } catch (error) {
      if (isCurrent(expected)) toast.danger("Download failed", { description: errorMessage(error) });
    } finally {
      if (isCurrent(expected)) setBusyFile(undefined);
    }
  }, [isCurrent, routeKey]);

  const openInspector = useCallback((file: SessionFileEntry, section: FileInspectorSection = "view") => {
    if (file.isDirectory && section === "view") {
      void loadPath(file.path);
      return;
    }
    setInspector({ file, routeKey, section });
  }, [loadPath, routeKey]);

  const handleFileAction = useCallback((file: SessionFileEntry, action: FileRowAction) => {
    if (!locationActionsAvailable || destructive.isPreparing || destructive.isExecuting) return;
    switch (action) {
      case "open":
        if (file.isDirectory) void loadPath(file.path);
        else openInspector(file);
        return;
      case "download":
        if (!file.isDirectory) void download(file);
        return;
      case "copy":
      case "move":
      case "permissions":
      case "times":
        openInspector(file, action);
        return;
      case "upload-overwrite":
        if (!file.isDirectory) {
          void destructive.prepare({
            actionId: "session.filesystem.upload-overwrite",
            remotePath: file.path,
            isIOC: false,
            isDirectory: false,
            overwrite: true,
          });
        }
        return;
      case "delete":
        void destructive.prepare({
          actionId: "session.filesystem.rm",
          path: file.path,
          recursive: file.isDirectory,
          force: false,
        });
    }
  }, [destructive, download, loadPath, locationActionsAvailable, openInspector]);

  const columns = useMemo<DataGridColumn<SessionFileEntry>[]>(() => [
    {
      id: "name",
      header: "Name",
      accessorKey: "name",
      allowsSorting: true,
      isRowHeader: true,
      minWidth: 260,
      cell: (file) => (
        <div className="flex min-w-0 items-center gap-2 py-1">
          <FontAwesomeIcon aria-hidden className={file.isDirectory ? "text-accent" : "text-muted"} icon={file.isDirectory ? faFolder : faFile} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{file.name}</p>
            {file.linkTarget ? <p className="truncate font-mono text-[11px] text-muted">→ {file.linkTarget}</p> : null}
          </div>
        </div>
      ),
    },
    {
      id: "size",
      header: "Size",
      minWidth: 110,
      cell: (file) => <span className="font-mono text-xs text-muted">{file.isDirectory ? "—" : formatByteString(file.sizeBytes)}</span>,
    },
    {
      id: "mode",
      header: "Mode",
      accessorKey: "mode",
      minWidth: 120,
      cell: (file) => <span className="font-mono text-xs text-muted">{file.mode || "—"}</span>,
    },
    {
      id: "modified",
      header: "Modified",
      accessorKey: "modifiedAt",
      allowsSorting: true,
      minWidth: 180,
      cell: (file) => <span className="text-xs text-muted">{file.modifiedAt ? formatDate(file.modifiedAt) : "Not reported"}</span>,
    },
    {
      id: "actions",
      header: "Actions",
      align: "end",
      minWidth: 90,
      cell: (file) => (
        <div className="flex justify-end gap-1">
          <FileMoreActions
            canManagePermissions={sessionOperationSupportsPlatform("session.filesystem.chmod", platform)}
            file={file}
            isDisabled={!locationActionsAvailable || destructive.isPreparing || destructive.isExecuting}
            isPending={busyFile === file.path}
            onAction={(action) => handleFileAction(file, action)}
          />
        </div>
      ),
    },
  ], [busyFile, destructive.isExecuting, destructive.isPreparing, handleFileAction, locationActionsAvailable, platform]);

  const crumbs = pathBreadcrumbs(visibleCurrentPath, isWindows);

  return (
    <>
      <PanelShell
        icon={faFolder}
        title="Files"
        description="Browse, search, and inspect bounded remote filesystem results. Native file dialogs remain owned by the main process."
        action={mode === "browser" ? (
          <div className="flex items-center gap-2">
            <Button isDisabled={!locationActionsAvailable} isPending={isUploading} size="sm" variant="secondary" onPress={() => void upload()}>
              <FontAwesomeIcon aria-hidden icon={faUpload} /> Upload
            </Button>
            <RefreshButton
              disabled={!locationActionsAvailable}
              label="Refresh directory"
              pending={isNavigating}
              onPress={() => currentPath && void loadPath(currentPath)}
            />
          </div>
        ) : null}
      >
        <div className="flex min-w-0 flex-col gap-5">
          <Segment aria-label="Filesystem mode" selectedKey={mode} size="sm" onSelectionChange={(key) => setMode(String(key) as FileWorkbenchMode)}>
            <Segment.Item id="browser">Browser</Segment.Item>
            <Segment.Item id="search">Search</Segment.Item>
            <Segment.Item id="storage">Storage</Segment.Item>
          </Segment>
          {mode === "browser" ? (
          <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <TextField className="min-w-0 flex-1" value={visiblePathDraft} variant="secondary" onChange={setPathDraft}>
              <Label>Remote path</Label>
              <Input className="font-mono text-xs" placeholder={isWindows ? "C:\\" : "/"} />
            </TextField>
            <Button isDisabled={!pathDraft.trim() || isNavigating} isPending={isNavigating} size="sm" onPress={() => void loadPath(pathDraft.trim())}>Go</Button>
          </div>
          {crumbs.length > 0 ? (
            <Breadcrumbs aria-label="Remote filesystem path" onAction={(key) => {
              if (locationActionsAvailable) void loadPath(String(key));
            }}>
              {crumbs.map((crumb) => <Breadcrumbs.Item className="no-underline" id={crumb.path} isDisabled={!locationActionsAvailable} key={crumb.path}>{crumb.label}</Breadcrumbs.Item>)}
            </Breadcrumbs>
          ) : null}
          <div className="flex flex-col gap-3 rounded-xl border border-separator bg-default p-3 sm:flex-row sm:items-end">
            <TextField className="min-w-0 flex-1" value={folderName} variant="secondary" onChange={setFolderName}>
              <Label>New folder name</Label>
              <Input placeholder="Folder name" />
            </TextField>
            <Button isDisabled={!locationActionsAvailable || !folderName.trim()} isPending={isCreatingFolder} size="sm" variant="secondary" onPress={() => void createFolder()}>
              <FontAwesomeIcon aria-hidden icon={faFolderPlus} /> New folder
            </Button>
          </div>
          {visibleState.status === "loading" ? <PanelLoading label={visibleRequestedPath ? `Loading ${visibleRequestedPath}` : "Loading directory"} /> : null}
          {visibleState.status === "error" ? (
            <PanelError
              message={visibleState.error}
              onRetry={() => visibleRequestedPath ? void loadPath(visibleRequestedPath) : void initializeFiles()}
            />
          ) : null}
          {visibleState.status === "ready" && !visibleState.value.exists ? (
            <PanelError
              message={`Remote path ${visibleRequestedPath || visibleState.value.path} does not exist.`}
              onRetry={() => visibleRequestedPath && void loadPath(visibleRequestedPath)}
            />
          ) : null}
          {visibleState.status === "ready" && visibleState.value.exists ? (
            <>
              <DataGrid
                aria-label={`Files in ${visibleState.value.path}`}
                columns={columns}
                contentClassName="min-w-[900px]"
                data={visibleState.value.items}
                getRowId={(file) => file.path}
                scrollContainerClassName="max-h-[560px] overflow-auto"
                variant="secondary"
                onRowAction={(key) => {
                  const file = visibleState.value.items.find((candidate) => candidate.path === String(key));
                  if (file) openInspector(file);
                }}
                renderEmptyState={() => <GridEmpty label="This directory is empty." />}
              />
              {visibleState.value.page.nextCursor ? (
                <div className="flex justify-center">
                  <Button isPending={isLoadingMore} size="sm" variant="tertiary" onPress={() => void loadPath(visibleState.value.path, visibleState.value.page.nextCursor)}>Load more</Button>
                </div>
              ) : null}
            </>
          ) : null}
          </div>
          ) : mode === "search" ? (
            <SessionFileSearch currentPath={visibleCurrentPath} key={`${routeKey}:search`} routeKey={routeKey} />
          ) : (
            <SessionFileStorage
              destructive={destructive}
              key={`${routeKey}:storage`}
              platform={platform}
              refreshToken={destructiveRefreshToken}
              routeKey={routeKey}
            />
          )}
        </div>
      </PanelShell>
      <SessionFileInspector
        destructive={destructive}
        platform={platform}
        routeKey={routeKey}
        selection={inspector?.routeKey === routeKey ? inspector : undefined}
        onClose={() => setInspector(undefined)}
        onDirectMutation={() => currentPath && void loadPath(currentPath)}
      />
      <DestructiveActionDialog action={destructive} />
    </>
  );
}

type FileWorkbenchMode = "browser" | "search" | "storage";
type FileInspectorSection = "view" | "copy" | "move" | "permissions" | "times";
type FileViewMode = "cat" | "head" | "tail" | "hex";
type FileViewResult = SessionTextFileView | SessionHexFileView;
type FileRowAction = "open" | "download" | "copy" | "move" | "upload-overwrite" | "permissions" | "times" | "delete";

interface FileInspectorSelection {
  file: SessionFileEntry;
  section: FileInspectorSection;
  routeKey: string;
}

function FileMoreActions({
  file,
  canManagePermissions,
  isDisabled,
  isPending,
  onAction,
}: {
  file: SessionFileEntry;
  canManagePermissions: boolean;
  isDisabled: boolean;
  isPending: boolean;
  onAction: (action: FileRowAction) => void;
}): React.JSX.Element {
  return (
    <Dropdown>
      <Button
        aria-label={`More actions for ${file.name}`}
        isDisabled={isDisabled}
        isIconOnly
        isPending={isPending}
        size="sm"
        variant="ghost"
      >
        <FontAwesomeIcon aria-hidden icon={faEllipsisVertical} />
      </Button>
      <Dropdown.Popover className="min-w-56" placement="bottom end">
        <Dropdown.Menu aria-label={`Actions for ${file.name}`} onAction={(key) => onAction(String(key) as FileRowAction)}>
          <Dropdown.Item id="open" textValue={file.isDirectory ? "Open folder" : "Inspect file"}>
            <FontAwesomeIcon aria-hidden className="size-3.5 text-muted" icon={file.isDirectory ? faFolder : faEye} />
            <Label>{file.isDirectory ? "Open folder" : "Inspect file"}</Label>
          </Dropdown.Item>
          {!file.isDirectory ? (
            <Dropdown.Item id="download" textValue="Download">
              <FontAwesomeIcon aria-hidden className="size-3.5 text-muted" icon={faDownload} />
              <Label>Download</Label>
            </Dropdown.Item>
          ) : null}
          <Dropdown.Item id="copy" textValue="Copy">
            <FontAwesomeIcon aria-hidden className="size-3.5 text-muted" icon={faCopy} />
            <Label>Copy…</Label>
          </Dropdown.Item>
          <Dropdown.Item id="move" textValue="Move">
            <FontAwesomeIcon aria-hidden className="size-3.5 text-muted" icon={faArrowRight} />
            <Label>Move…</Label>
          </Dropdown.Item>
          {!file.isDirectory ? (
            <Dropdown.Item id="upload-overwrite" textValue="Upload replacement">
              <FontAwesomeIcon aria-hidden className="size-3.5 text-muted" icon={faUpload} />
              <Label>Upload replacement…</Label>
            </Dropdown.Item>
          ) : null}
          {canManagePermissions ? (
            <Dropdown.Item id="permissions" textValue="Permissions and owner">
              <FontAwesomeIcon aria-hidden className="size-3.5 text-muted" icon={faShieldHalved} />
              <Label>Permissions and owner…</Label>
            </Dropdown.Item>
          ) : null}
          <Dropdown.Item id="times" textValue="Timestamps">
            <FontAwesomeIcon aria-hidden className="size-3.5 text-muted" icon={faClock} />
            <Label>Timestamps…</Label>
          </Dropdown.Item>
          <Dropdown.Item id="delete" textValue="Delete" variant="danger">
            <FontAwesomeIcon aria-hidden className="size-3.5" icon={faTrash} />
            <Label>Delete…</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

interface GrepRow extends SessionGrepMatch {
  id: string;
}

function SessionFileSearch({ currentPath, routeKey }: { currentPath: string; routeKey: string }): React.JSX.Element {
  const [path, setPath] = useState(currentPath || "/");
  const [pattern, setPattern] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [linesBefore, setLinesBefore] = useState("0");
  const [linesAfter, setLinesAfter] = useState("0");
  const [state, setState] = useState<LoadState<SessionBoundedPage<GrepRow>> | { status: "idle" }>({ status: "idle" });
  const [requestedSearch, setRequestedSearch] = useState<FileSearchRequest>();
  const [committedSearch, setCommittedSearch] = useState<FileSearchRequest>();
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const requestSequence = useRef(0);
  const isCurrent = useLatestIdentity(routeKey);

  useEffect(() => {
    requestSequence.current += 1;
    setPath(currentPath || "/");
    setPattern("");
    setRecursive(false);
    setLinesBefore("0");
    setLinesAfter("0");
    setState({ status: "idle" });
    setRequestedSearch(undefined);
    setCommittedSearch(undefined);
    setIsLoadingMore(false);
  }, [currentPath, routeKey]);

  const search = useCallback(async (cursor?: string, retry?: FileSearchRequest) => {
    const request = cursor
      ? committedSearch
      : retry ?? {
          path: path.trim(),
          pattern: pattern.trim(),
          recursive,
          linesBefore: boundedContext(linesBefore),
          linesAfter: boundedContext(linesAfter),
        };
    if (!request?.path || !request.pattern) return;
    const expected = routeKey;
    const sequence = ++requestSequence.current;
    if (cursor) setIsLoadingMore(true);
    else {
      setRequestedSearch(request);
      setState({ status: "loading" });
    }
    try {
      const result = await runWorkbench({
        operationId: "session.filesystem.grep",
        ...request,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!isCurrent(expected) || sequence !== requestSequence.current) return;
      const rows = result.items.map((match, index) => ({
        ...match,
        id: `${match.path}:${match.lineNumber}:${cursor ?? "0"}:${index}`,
      }));
      setCommittedSearch(request);
      setState((current) => {
        const items = cursor && current.status === "ready" ? [...current.value.items, ...rows] : rows;
        return {
          status: "ready",
          value: { ...result, items, page: cursor ? combinedPageSummary(result.page, items.length) : result.page },
        };
      });
    } catch (error) {
      if (!isCurrent(expected) || sequence !== requestSequence.current) return;
      if (cursor) toast.danger("Could not load more matches", { description: errorMessage(error) });
      else setState({ status: "error", error: errorMessage(error) });
    } finally {
      if (isCurrent(expected) && sequence === requestSequence.current) setIsLoadingMore(false);
    }
  }, [committedSearch, isCurrent, linesAfter, linesBefore, path, pattern, recursive, routeKey]);

  const columns = useMemo<DataGridColumn<GrepRow>[]>(() => [
    {
      id: "path",
      header: "Path",
      isRowHeader: true,
      minWidth: 240,
      cell: (match) => (
        <div className="min-w-0 py-1">
          <p className="truncate font-mono text-xs text-foreground">{match.path}</p>
          <p className="mt-0.5 font-mono text-[11px] text-muted">Line {match.lineNumber}</p>
        </div>
      ),
    },
    {
      id: "match",
      header: "Match and context",
      minWidth: 420,
      cell: (match) => (
        <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all py-1 font-mono text-xs leading-relaxed text-foreground">
          {[...match.linesBefore, match.line, ...match.linesAfter].join("\n")}
        </pre>
      ),
    },
    {
      id: "kind",
      header: "Kind",
      minWidth: 100,
      cell: (match) => <Chip color={match.binary ? "warning" : "default"} size="sm" variant="soft">{match.binary ? "Binary" : "Text"}</Chip>,
    },
  ], []);

  return (
    <section className="flex min-w-0 flex-col gap-4" aria-labelledby="file-search-heading">
      <div>
        <h3 className="text-sm font-semibold text-foreground" id="file-search-heading">Search file contents</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted">Results are bounded and context is limited to 100 lines on either side.</p>
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(180px,1fr)_minmax(180px,1fr)_110px_110px_auto] lg:items-end">
        <TextField value={path} variant="secondary" onChange={setPath}>
          <Label>Search path</Label>
          <Input className="font-mono text-xs" />
        </TextField>
        <TextField value={pattern} variant="secondary" onChange={setPattern}>
          <Label>Pattern</Label>
          <Input placeholder="Text or regular expression" />
        </TextField>
        <TextField value={linesBefore} variant="secondary" onChange={setLinesBefore}>
          <Label>Before</Label>
          <Input max={100} min={0} type="number" />
        </TextField>
        <TextField value={linesAfter} variant="secondary" onChange={setLinesAfter}>
          <Label>After</Label>
          <Input max={100} min={0} type="number" />
        </TextField>
        <Button isDisabled={!path.trim() || !pattern.trim()} isPending={state.status === "loading"} size="sm" onPress={() => void search()}>
          <FontAwesomeIcon aria-hidden icon={faMagnifyingGlass} /> Search
        </Button>
      </div>
      <Switch isSelected={recursive} onChange={setRecursive}>
        <Switch.Control><Switch.Thumb /></Switch.Control>
        <Switch.Content>
          <Label>Search recursively</Label>
          <Description>Include descendant directories beneath the selected path.</Description>
        </Switch.Content>
      </Switch>
      {state.status === "idle" ? <PanelEmpty icon={faMagnifyingGlass} title="No search run" description="Enter a path and pattern to inspect bounded remote matches." /> : null}
      {state.status === "loading" ? <PanelLoading label={`Searching ${requestedSearch?.path ?? path}`} /> : null}
      {state.status === "error" ? <PanelError message={state.error} onRetry={() => requestedSearch && void search(undefined, requestedSearch)} /> : null}
      {state.status === "ready" ? (
        <div className="flex min-w-0 flex-col gap-3">
          {state.value.page.truncated ? (
            <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground" role="status">
              Results are bounded. {state.value.page.nextCursor ? "Load the next page to continue." : "The server returned a truncated result set."}
            </p>
          ) : null}
          <DataGrid
            aria-label="Filesystem search results"
            columns={columns}
            contentClassName="min-w-[820px]"
            data={state.value.items}
            getRowId={(row) => row.id}
            scrollContainerClassName="max-h-[560px] overflow-auto"
            variant="secondary"
            renderEmptyState={() => <GridEmpty label="No files matched this search." />}
          />
          {state.value.page.nextCursor ? (
            <div className="flex justify-center">
              <Button isPending={isLoadingMore} size="sm" variant="tertiary" onPress={() => void search(state.value.page.nextCursor)}>Load more matches</Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

interface FileSearchRequest {
  path: string;
  pattern: string;
  recursive: boolean;
  linesBefore: number;
  linesAfter: number;
}

function SessionFileStorage({
  routeKey,
  platform,
  refreshToken,
  destructive,
}: {
  routeKey: string;
  platform: string;
  refreshToken: number;
  destructive: DestructiveActionState;
}): React.JSX.Element {
  const isLinux = platform === "linux";
  const [mounts, setMounts] = useState<LoadState<SessionBoundedPage<SessionMount>>>({ status: "loading" });
  const [memoryFiles, setMemoryFiles] = useState<LoadState<SessionBoundedPage<SessionMemoryFile>>>({ status: "loading" });
  const [isLoadingMoreMounts, setIsLoadingMoreMounts] = useState(false);
  const [isLoadingMoreMemoryFiles, setIsLoadingMoreMemoryFiles] = useState(false);
  const [isAddingMemoryFile, setIsAddingMemoryFile] = useState(false);
  const mountRequestSequence = useRef(0);
  const memoryRequestSequence = useRef(0);
  const mutationRequestSequence = useRef(0);
  const isCurrent = useLatestIdentity(routeKey);

  const loadMounts = useCallback(async (cursor?: string) => {
    const expected = routeKey;
    const sequence = ++mountRequestSequence.current;
    if (cursor) setIsLoadingMoreMounts(true);
    else setMounts({ status: "loading" });
    try {
      const result = await runWorkbench({ operationId: "session.filesystem.mounts", limit: 100, ...(cursor ? { cursor } : {}) });
      if (!isCurrent(expected) || sequence !== mountRequestSequence.current) return;
      setMounts((current) => cursor && current.status === "ready"
        ? { status: "ready", value: mergePagedResult(result, uniqueMounts([...current.value.items, ...result.items])) }
        : { status: "ready", value: result });
    } catch (error) {
      if (!isCurrent(expected) || sequence !== mountRequestSequence.current) return;
      if (cursor) toast.danger("Could not load more mounts", { description: errorMessage(error) });
      else setMounts({ status: "error", error: errorMessage(error) });
    } finally {
      if (isCurrent(expected) && sequence === mountRequestSequence.current) setIsLoadingMoreMounts(false);
    }
  }, [isCurrent, routeKey]);

  const loadMemoryFiles = useCallback(async (cursor?: string) => {
    if (!isLinux) return;
    const expected = routeKey;
    const sequence = ++memoryRequestSequence.current;
    if (cursor) setIsLoadingMoreMemoryFiles(true);
    else setMemoryFiles({ status: "loading" });
    try {
      const result = await runWorkbench({ operationId: "session.filesystem.memfiles.list", limit: 100, ...(cursor ? { cursor } : {}) });
      if (!isCurrent(expected) || sequence !== memoryRequestSequence.current) return;
      setMemoryFiles((current) => cursor && current.status === "ready"
        ? { status: "ready", value: mergePagedResult(result, uniqueMemoryFiles([...current.value.items, ...result.items])) }
        : { status: "ready", value: result });
    } catch (error) {
      if (!isCurrent(expected) || sequence !== memoryRequestSequence.current) return;
      if (cursor) toast.danger("Could not load more memory files", { description: errorMessage(error) });
      else setMemoryFiles({ status: "error", error: errorMessage(error) });
    } finally {
      if (isCurrent(expected) && sequence === memoryRequestSequence.current) setIsLoadingMoreMemoryFiles(false);
    }
  }, [isCurrent, isLinux, routeKey]);

  useEffect(() => {
    mountRequestSequence.current += 1;
    memoryRequestSequence.current += 1;
    mutationRequestSequence.current += 1;
    setIsAddingMemoryFile(false);
    void loadMounts();
    if (isLinux) void loadMemoryFiles();
  }, [isLinux, loadMemoryFiles, loadMounts, refreshToken, routeKey]);

  const addMemoryFile = useCallback(async () => {
    if (!isLinux || isAddingMemoryFile) return;
    const expected = routeKey;
    const sequence = ++mutationRequestSequence.current;
    setIsAddingMemoryFile(true);
    try {
      const result = await runWorkbench({ operationId: "session.filesystem.memfiles.add" });
      if (!isCurrent(expected) || sequence !== mutationRequestSequence.current) return;
      toast.success("Memory file added", { description: result.message });
      await loadMemoryFiles();
    } catch (error) {
      if (isCurrent(expected) && sequence === mutationRequestSequence.current) {
        notifyWorkbenchFailure("Could not add memory file", "Memory-file outcome unknown", error);
      }
    } finally {
      if (isCurrent(expected) && sequence === mutationRequestSequence.current) setIsAddingMemoryFile(false);
    }
  }, [isAddingMemoryFile, isCurrent, isLinux, loadMemoryFiles, routeKey]);

  const mountColumns = useMemo<DataGridColumn<SessionMount>[]>(() => [
    {
      id: "mount",
      header: "Mount point",
      isRowHeader: true,
      minWidth: 220,
      cell: (mount) => (
        <div className="min-w-0 py-1">
          <p className="truncate font-mono text-xs text-foreground">{mount.mountPoint || "Not reported"}</p>
          <p className="mt-0.5 truncate text-[11px] text-muted">{mount.label || mount.volumeName || "Unnamed volume"}</p>
        </div>
      ),
    },
    { id: "filesystem", header: "Filesystem", accessorKey: "filesystem", minWidth: 130 },
    {
      id: "used",
      header: "Used / total",
      minWidth: 180,
      cell: (mount) => <span className="font-mono text-xs text-muted">{formatByteString(mount.usedBytes)} / {formatByteString(mount.totalBytes)}</span>,
    },
    {
      id: "free",
      header: "Free",
      minWidth: 120,
      cell: (mount) => <span className="font-mono text-xs text-muted">{formatByteString(mount.freeBytes)}</span>,
    },
    { id: "options", header: "Options", accessorKey: "options", minWidth: 180 },
  ], []);

  const memoryColumns = useMemo<DataGridColumn<SessionMemoryFile>[]>(() => [
    {
      id: "name",
      header: "Name",
      isRowHeader: true,
      minWidth: 240,
      cell: (file) => (
        <div className="min-w-0 py-1">
          <p className="truncate text-sm font-medium text-foreground">{file.name || "Unnamed memory file"}</p>
          <p className="mt-0.5 font-mono text-[11px] text-muted">FD {file.fd}</p>
        </div>
      ),
    },
    {
      id: "size",
      header: "Size",
      minWidth: 120,
      cell: (file) => <span className="font-mono text-xs text-muted">{formatByteString(file.sizeBytes)}</span>,
    },
    {
      id: "action",
      header: "Action",
      align: "end",
      minWidth: 90,
      cell: (file) => (
        <IconButton
          danger
          isDisabled={destructive.isPreparing || destructive.isExecuting}
          label={`Remove memory file ${file.name || file.fd}`}
          icon={faTrash}
          onPress={() => void destructive.prepare({ actionId: "session.filesystem.memfiles.rm", fd: file.fd })}
        />
      ),
    },
  ], [destructive]);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section className="overflow-hidden rounded-xl border border-separator bg-default" aria-labelledby="mounts-heading">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground" id="mounts-heading">Mounted storage</h3>
            <p className="mt-0.5 text-xs text-muted">Bounded volume and capacity details reported by this session.</p>
          </div>
          <RefreshButton disabled={mounts.status === "loading"} label="Refresh mounts" pending={mounts.status === "loading"} onPress={() => void loadMounts()} />
        </div>
        <div className="border-t border-separator">
          {mounts.status === "loading" ? <PanelLoading label="Loading mounted storage" /> : null}
          {mounts.status === "error" ? <div className="p-4"><PanelError message={mounts.error} onRetry={() => void loadMounts()} /></div> : null}
          {mounts.status === "ready" ? (
            <>
              {mounts.value.page.truncated ? <BoundedNotice nextCursor={mounts.value.page.nextCursor} noun="mounts" /> : null}
              <DataGrid
                aria-label="Session mounts"
                columns={mountColumns}
                contentClassName="min-w-[860px]"
                data={mounts.value.items}
                getRowId={(mount) => mountKey(mount)}
                scrollContainerClassName="max-h-[360px] overflow-auto"
                variant="secondary"
                renderEmptyState={() => <GridEmpty label="No mounted storage was reported." />}
              />
              {mounts.value.page.nextCursor ? (
                <div className="flex justify-center px-4 py-3">
                  <Button isPending={isLoadingMoreMounts} size="sm" variant="tertiary" onPress={() => void loadMounts(mounts.value.page.nextCursor)}>Load more mounts</Button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </section>

      {isLinux ? (
        <section className="overflow-hidden rounded-xl border border-separator bg-default" aria-labelledby="memory-files-heading">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground" id="memory-files-heading">Linux memory files</h3>
              <p className="mt-0.5 text-xs text-muted">Add through a main-owned file picker; removal always requires review.</p>
            </div>
            <div className="flex items-center gap-2">
              <Button isPending={isAddingMemoryFile} size="sm" variant="secondary" onPress={() => void addMemoryFile()}>
                <FontAwesomeIcon aria-hidden icon={faMemory} /> Add file
              </Button>
              <RefreshButton disabled={memoryFiles.status === "loading"} label="Refresh memory files" pending={memoryFiles.status === "loading"} onPress={() => void loadMemoryFiles()} />
            </div>
          </div>
          <div className="border-t border-separator">
            {memoryFiles.status === "loading" ? <PanelLoading label="Loading memory files" /> : null}
            {memoryFiles.status === "error" ? <div className="p-4"><PanelError message={memoryFiles.error} onRetry={() => void loadMemoryFiles()} /></div> : null}
            {memoryFiles.status === "ready" ? (
              <>
                {memoryFiles.value.page.truncated ? <BoundedNotice nextCursor={memoryFiles.value.page.nextCursor} noun="memory files" /> : null}
                <DataGrid
                  aria-label="Linux memory files"
                  columns={memoryColumns}
                  contentClassName="min-w-[520px]"
                  data={memoryFiles.value.items}
                  getRowId={(file) => file.fd}
                  scrollContainerClassName="max-h-[320px] overflow-auto"
                  variant="secondary"
                  renderEmptyState={() => <GridEmpty label="No Linux memory files were reported." />}
                />
                {memoryFiles.value.page.nextCursor ? (
                  <div className="flex justify-center px-4 py-3">
                    <Button isPending={isLoadingMoreMemoryFiles} size="sm" variant="tertiary" onPress={() => void loadMemoryFiles(memoryFiles.value.page.nextCursor)}>Load more memory files</Button>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </section>
      ) : (
        <PanelEmpty icon={faMemory} title="Memory files unavailable" description="In-memory file management is available only for Linux sessions." />
      )}
    </div>
  );
}

function SessionFileInspector({
  routeKey,
  platform,
  selection,
  destructive,
  onClose,
  onDirectMutation,
}: {
  routeKey: string;
  platform: string;
  selection: FileInspectorSelection | undefined;
  destructive: DestructiveActionState;
  onClose: () => void;
  onDirectMutation: () => void;
}): React.JSX.Element {
  const file = selection?.file;
  const canManagePermissions = sessionOperationSupportsPlatform("session.filesystem.chmod", platform);
  const [section, setSection] = useState<FileInspectorSection>(selection?.section ?? "view");
  const [viewMode, setViewMode] = useState<FileViewMode>("cat");
  const [viewState, setViewState] = useState<LoadState<FileViewResult> | { status: "idle" }>({ status: "idle" });
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [destination, setDestination] = useState("");
  const [fileMode, setFileMode] = useState("0600");
  const [uid, setUid] = useState("");
  const [gid, setGid] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [accessTime, setAccessTime] = useState("");
  const [modificationTime, setModificationTime] = useState("");
  const [busyAction, setBusyAction] = useState<"save" | "chmod" | "chown" | "chtimes">();
  const viewRequestSequence = useRef(0);
  const actionRequestSequence = useRef(0);
  const isCurrent = useLatestIdentity(routeKey);
  const selectionIdentity = file ? `${routeKey}:${file.path}:${selection?.section ?? "view"}` : `${routeKey}:closed`;
  const activeIntent = `${selectionIdentity}:${section}:${viewMode}`;
  const activeIntentRef = useRef(activeIntent);
  activeIntentRef.current = activeIntent;

  const loadView = useCallback(async () => {
    if (!file || file.isDirectory || section !== "view") return;
    const expected = routeKey;
    const expectedIntent = `${selectionIdentity}:view:${viewMode}`;
    const sequence = ++viewRequestSequence.current;
    setViewState({ status: "loading" });
    setIsEditing(false);
    setEditDraft("");
    try {
      let result: FileViewResult;
      switch (viewMode) {
        case "cat":
          result = await runWorkbench({ operationId: "session.filesystem.cat", path: file.path, maxBytes: SESSION_EDITOR_MAX_BYTES });
          break;
        case "head":
          result = await runWorkbench({ operationId: "session.filesystem.head", path: file.path, maxBytes: SESSION_EDITOR_MAX_BYTES });
          break;
        case "tail":
          result = await runWorkbench({ operationId: "session.filesystem.tail", path: file.path, maxBytes: SESSION_EDITOR_MAX_BYTES });
          break;
        case "hex":
          result = await runWorkbench({ operationId: "session.filesystem.read-hex", path: file.path, maxBytes: SESSION_EDITOR_MAX_BYTES });
      }
      if (
        !isCurrent(expected) ||
        sequence !== viewRequestSequence.current ||
        expectedIntent !== activeIntentRef.current
      ) return;
      setViewState({ status: "ready", value: result });
      setEditDraft(fileViewContent(result));
    } catch (error) {
      if (
        isCurrent(expected) &&
        sequence === viewRequestSequence.current &&
        expectedIntent === activeIntentRef.current
      ) setViewState({ status: "error", error: errorMessage(error) });
    }
  }, [file, isCurrent, routeKey, section, selectionIdentity, viewMode]);

  useEffect(() => {
    viewRequestSequence.current += 1;
    actionRequestSequence.current += 1;
    setSection(selection?.section ?? (selection?.file.isDirectory ? "copy" : "view"));
    setViewMode("cat");
    setViewState({ status: "idle" });
    setIsEditing(false);
    setEditDraft("");
    setDestination("");
    setFileMode("0600");
    setUid(selection?.file.uid ?? "");
    setGid(selection?.file.gid ?? "");
    setRecursive(false);
    const defaultTime = selection?.file.modifiedAt ?? "";
    setAccessTime(defaultTime);
    setModificationTime(defaultTime);
    setBusyAction(undefined);
  }, [selectionIdentity]);

  useEffect(() => {
    if (file && !file.isDirectory && section === "view") void loadView();
  }, [file, loadView, section, viewMode]);

  const stageAndReview = useCallback(async () => {
    if (!file || viewState.status !== "ready" || !fileViewIsEditable(viewState.value)) return;
    const expected = routeKey;
    const expectedIntent = activeIntentRef.current;
    const expectedSha256 = viewState.value.sha256;
    if (!expectedSha256) return;
    const sequence = ++actionRequestSequence.current;
    setBusyAction("save");
    try {
      if (isHexFileView(viewState.value)) {
        const staged = await runWorkbench({ operationId: "session.filesystem.stage-hex", hex: editDraft });
        if (!isCurrent(expected) || sequence !== actionRequestSequence.current || expectedIntent !== activeIntentRef.current) return;
        await destructive.prepare({
          actionId: "session.filesystem.patch-hex",
          patchHandle: staged.artifact.handle,
          remotePath: file.path,
          expectedSha256,
        });
      } else {
        const staged = await runWorkbench({ operationId: "session.filesystem.stage-text", content: editDraft, encoding: "utf-8" });
        if (!isCurrent(expected) || sequence !== actionRequestSequence.current || expectedIntent !== activeIntentRef.current) return;
        await destructive.prepare({
          actionId: "session.filesystem.edit-text-overwrite",
          contentHandle: staged.artifact.handle,
          remotePath: file.path,
          encoding: "utf-8",
          expectedSha256,
        });
      }
    } catch (error) {
      if (isCurrent(expected) && sequence === actionRequestSequence.current && expectedIntent === activeIntentRef.current) {
        toast.danger("Could not stage file changes", { description: errorMessage(error) });
      }
    } finally {
      if (isCurrent(expected) && sequence === actionRequestSequence.current && expectedIntent === activeIntentRef.current) setBusyAction(undefined);
    }
  }, [destructive, editDraft, file, isCurrent, routeKey, viewState]);

  const applyMode = useCallback(async () => {
    if (!file || !canManagePermissions || !fileMode.trim()) return;
    if (recursive) {
      await destructive.prepare({ actionId: "session.filesystem.chmod-recursive", path: file.path, fileMode: fileMode.trim(), recursive: true });
      return;
    }
    const expected = routeKey;
    const sequence = ++actionRequestSequence.current;
    setBusyAction("chmod");
    try {
      const result = await runWorkbench({ operationId: "session.filesystem.chmod", path: file.path, fileMode: fileMode.trim(), recursive: false });
      if (!isCurrent(expected) || sequence !== actionRequestSequence.current) return;
      toast.success("Permissions updated", { description: result.message });
      onDirectMutation();
    } catch (error) {
      if (isCurrent(expected) && sequence === actionRequestSequence.current) notifyWorkbenchFailure("Could not update permissions", "Permission outcome unknown", error);
    } finally {
      if (isCurrent(expected) && sequence === actionRequestSequence.current) setBusyAction(undefined);
    }
  }, [canManagePermissions, destructive, file, fileMode, isCurrent, onDirectMutation, recursive, routeKey]);

  const applyOwner = useCallback(async () => {
    if (!file || !canManagePermissions || !uid.trim() || !gid.trim()) return;
    if (recursive) {
      await destructive.prepare({ actionId: "session.filesystem.chown-recursive", path: file.path, uid: uid.trim(), gid: gid.trim(), recursive: true });
      return;
    }
    const expected = routeKey;
    const sequence = ++actionRequestSequence.current;
    setBusyAction("chown");
    try {
      const result = await runWorkbench({ operationId: "session.filesystem.chown", path: file.path, uid: uid.trim(), gid: gid.trim(), recursive: false });
      if (!isCurrent(expected) || sequence !== actionRequestSequence.current) return;
      toast.success("Owner updated", { description: result.message });
      onDirectMutation();
    } catch (error) {
      if (isCurrent(expected) && sequence === actionRequestSequence.current) notifyWorkbenchFailure("Could not update owner", "Owner outcome unknown", error);
    } finally {
      if (isCurrent(expected) && sequence === actionRequestSequence.current) setBusyAction(undefined);
    }
  }, [canManagePermissions, destructive, file, gid, isCurrent, onDirectMutation, recursive, routeKey, uid]);

  const applyTimes = useCallback(async () => {
    if (!file || !accessTime.trim() || !modificationTime.trim()) return;
    const expected = routeKey;
    const sequence = ++actionRequestSequence.current;
    setBusyAction("chtimes");
    try {
      const result = await runWorkbench({
        operationId: "session.filesystem.chtimes",
        path: file.path,
        accessTime: accessTime.trim(),
        modificationTime: modificationTime.trim(),
      });
      if (!isCurrent(expected) || sequence !== actionRequestSequence.current) return;
      toast.success("Timestamps updated", { description: result.message });
      onDirectMutation();
    } catch (error) {
      if (isCurrent(expected) && sequence === actionRequestSequence.current) notifyWorkbenchFailure("Could not update timestamps", "Timestamp outcome unknown", error);
    } finally {
      if (isCurrent(expected) && sequence === actionRequestSequence.current) setBusyAction(undefined);
    }
  }, [accessTime, file, isCurrent, modificationTime, onDirectMutation, routeKey]);

  const viewEditable = viewState.status === "ready" && fileViewIsEditable(viewState.value);
  const editValid = viewState.status === "ready" && editorDraftIsValid(viewState.value, editDraft);
  const actionLocked = busyAction !== undefined || destructive.isPreparing || destructive.isExecuting;

  return (
    <Sheet
      isDismissable={!actionLocked}
      isOpen={selection !== undefined}
      placement="right"
      onOpenChange={(open) => {
        if (!open && !actionLocked) onClose();
      }}
    >
      <Sheet.Backdrop variant="blur">
        <Sheet.Content className="h-full w-full max-w-2xl">
          <Sheet.Dialog className="h-full">
            <Sheet.CloseTrigger />
            <Sheet.Header>
              <Sheet.Heading>{file?.name || "File inspector"}</Sheet.Heading>
              {file ? <p className="truncate font-mono text-xs text-muted">{file.path}</p> : null}
            </Sheet.Header>
            <Sheet.Body className="min-h-0 overflow-auto">
              {file ? (
                <div className="flex min-w-0 flex-col gap-5 py-1">
                  <Segment aria-label="File inspector section" selectedKey={section} size="sm" onSelectionChange={(key) => setSection(String(key) as FileInspectorSection)}>
                    {!file.isDirectory ? <Segment.Item id="view">View</Segment.Item> : null}
                    <Segment.Item id="copy">Copy</Segment.Item>
                    <Segment.Item id="move">Move</Segment.Item>
                    {canManagePermissions ? <Segment.Item id="permissions">Permissions</Segment.Item> : null}
                    <Segment.Item id="times">Timestamps</Segment.Item>
                  </Segment>

                  {section === "view" && !file.isDirectory ? (
                    <div className="flex min-w-0 flex-col gap-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <Segment aria-label="File view" selectedKey={viewMode} size="sm" onSelectionChange={(key) => setViewMode(String(key) as FileViewMode)}>
                          <Segment.Item id="cat">Cat</Segment.Item>
                          <Segment.Item id="head">Head</Segment.Item>
                          <Segment.Item id="tail">Tail</Segment.Item>
                          <Segment.Item id="hex">Hex</Segment.Item>
                        </Segment>
                        <div className="flex items-center gap-2">
                          {viewEditable ? (
                            <Button size="sm" variant="secondary" onPress={() => setIsEditing((current) => !current)}>
                              <FontAwesomeIcon aria-hidden icon={faPen} /> {isEditing ? "Cancel edit" : "Edit"}
                            </Button>
                          ) : null}
                          {isEditing ? (
                            <Button isDisabled={!editValid || actionLocked} isPending={busyAction === "save"} size="sm" onPress={() => void stageAndReview()}>
                              Review save
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      {viewState.status === "loading" || viewState.status === "idle" ? <PanelLoading label={`Loading ${viewMode} view`} /> : null}
                      {viewState.status === "error" ? <PanelError message={viewState.error} onRetry={() => void loadView()} /> : null}
                      {viewState.status === "ready" ? (
                        <div className="flex min-w-0 flex-col gap-3">
                          <FileViewSummary value={viewState.value} />
                          {isEditing ? (
                            <div className="flex flex-col gap-2">
                              <Label htmlFor="session-file-editor">{isHexFileView(viewState.value) ? "Hex bytes" : "UTF-8 text"}</Label>
                              <TextArea
                                aria-label={isHexFileView(viewState.value) ? "Hex bytes" : "UTF-8 text"}
                                className="min-h-80 w-full font-mono text-xs"
                                id="session-file-editor"
                                spellCheck={false}
                                value={editDraft}
                                variant="secondary"
                                onChange={(event) => setEditDraft(event.target.value)}
                              />
                              {!editValid ? <p className="text-xs text-danger">Content must fit within 64 KiB; hex must be contiguous even-length hexadecimal.</p> : null}
                            </div>
                          ) : (
                            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-xl border border-separator bg-default p-4 font-mono text-xs leading-relaxed text-foreground">
                              {fileViewContent(viewState.value) || "(empty file)"}
                            </pre>
                          )}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {section === "copy" || section === "move" ? (
                    <div className="flex flex-col gap-4">
                      <div>
                        <h3 className="text-sm font-semibold text-foreground">{section === "copy" ? "Copy remote item" : "Move remote item"}</h3>
                        <p className="mt-1 text-xs text-muted">The exact source and destination are reviewed before execution.</p>
                      </div>
                      <TextField value={destination} variant="secondary" onChange={setDestination}>
                        <Label>Destination path</Label>
                        <Input className="font-mono text-xs" placeholder={file.path} />
                      </TextField>
                      <Button
                        className="self-start"
                        isDisabled={!destination.trim() || actionLocked}
                        isPending={destructive.isPreparing}
                        size="sm"
                        onPress={() => void destructive.prepare(section === "copy"
                          ? { actionId: "session.filesystem.cp", source: file.path, destination: destination.trim() }
                          : { actionId: "session.filesystem.mv", source: file.path, destination: destination.trim() })}
                      >
                        Review {section}
                      </Button>
                    </div>
                  ) : null}

                  {section === "permissions" ? (
                    canManagePermissions ? (
                      <div className="flex flex-col gap-5">
                        <div>
                          <h3 className="text-sm font-semibold text-foreground">Permissions and owner</h3>
                          <p className="mt-1 text-xs text-muted">Nonrecursive changes run directly. Recursive changes always require review.</p>
                        </div>
                        <Switch isSelected={recursive} onChange={setRecursive}>
                          <Switch.Control><Switch.Thumb /></Switch.Control>
                          <Switch.Content>
                            <Label>Apply recursively</Label>
                            <Description>Include all descendants beneath this path.</Description>
                          </Switch.Content>
                        </Switch>
                        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                          <TextField value={fileMode} variant="secondary" onChange={setFileMode}>
                            <Label>File mode</Label>
                            <Input className="font-mono text-xs" placeholder="0600" />
                          </TextField>
                          <Button isDisabled={!fileMode.trim() || actionLocked} isPending={busyAction === "chmod" || destructive.isPreparing} size="sm" onPress={() => void applyMode()}>
                            {recursive ? "Review mode change" : "Apply mode"}
                          </Button>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                          <TextField value={uid} variant="secondary" onChange={setUid}>
                            <Label>UID</Label>
                            <Input className="font-mono text-xs" />
                          </TextField>
                          <TextField value={gid} variant="secondary" onChange={setGid}>
                            <Label>GID</Label>
                            <Input className="font-mono text-xs" />
                          </TextField>
                          <Button isDisabled={!uid.trim() || !gid.trim() || actionLocked} isPending={busyAction === "chown" || destructive.isPreparing} size="sm" onPress={() => void applyOwner()}>
                            {recursive ? "Review owner change" : "Apply owner"}
                          </Button>
                        </div>
                      </div>
                    ) : <PanelUnavailable title="Permissions unavailable" description="Remote chmod and chown are available only for Linux sessions." />
                  ) : null}

                  {section === "times" ? (
                    <div className="flex flex-col gap-4">
                      <div>
                        <h3 className="text-sm font-semibold text-foreground">Remote timestamps</h3>
                        <p className="mt-1 text-xs text-muted">Choose access and modification times in your local time zone.</p>
                      </div>
                      <DateTimePickerField label="Access time" value={accessTime} onChange={setAccessTime} />
                      <DateTimePickerField label="Modification time" value={modificationTime} onChange={setModificationTime} />
                      <Button className="self-start" isDisabled={!accessTime.trim() || !modificationTime.trim() || actionLocked} isPending={busyAction === "chtimes"} size="sm" onPress={() => void applyTimes()}>
                        Apply timestamps
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </Sheet.Body>
            <Sheet.Footer>
              <Button isDisabled={actionLocked} size="sm" variant="secondary" onPress={onClose}>Close</Button>
            </Sheet.Footer>
          </Sheet.Dialog>
        </Sheet.Content>
      </Sheet.Backdrop>
    </Sheet>
  );
}

function FileViewSummary({ value }: { value: FileViewResult }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-default px-3 py-2" aria-live="polite">
      <Chip color={value.truncated ? "warning" : "success"} size="sm" variant="soft">
        {value.truncated ? "Truncated at 64 KiB" : "Complete file"}
      </Chip>
      <span className="text-xs tabular-nums text-muted">{formatBytes(value.bytesRead)} read</span>
      <span className="min-w-0 truncate font-mono text-[11px] text-muted">
        {value.sha256 ? `SHA-256 ${value.sha256}` : "Digest unavailable for a partial view"}
      </span>
    </div>
  );
}

export function SessionProcessesPanel({ route, session }: SessionWorkspacePanelContext): React.JSX.Element {
  const routeKey = workspaceRouteKey(route);
  const platform = normalizedPlatform(session.os);
  const isWindows = platform === "windows";
  const canDumpProcesses = sessionOperationSupportsPlatform("session.process.dump", platform);
  const [section, setSection] = useState<"processes" | "services">("processes");
  const [processView, setProcessView] = useState<"list" | "tree">("list");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [processes, setProcesses] = useState<LoadState<SessionBoundedPage<SessionProcess>>>({ status: "loading" });
  const [services, setServices] = useState<LoadState<SessionBoundedPage<SessionService>>>({ status: "loading" });
  const [isLoadingMoreProcesses, setIsLoadingMoreProcesses] = useState(false);
  const [isLoadingMoreServices, setIsLoadingMoreServices] = useState(false);
  const [selectedProcess, setSelectedProcess] = useState<SessionProcess>();
  const [selectedService, setSelectedService] = useState<SessionService>();
  const [busyProcess, setBusyProcess] = useState<number>();
  const [readingServiceName, setReadingServiceName] = useState<string>();
  const [startingServiceName, setStartingServiceName] = useState<string>();
  const processRequestSequence = useRef(0);
  const serviceRequestSequence = useRef(0);
  const serviceDetailRequestSequence = useRef(0);
  const isCurrent = useLatestIdentity(routeKey);

  const loadProcesses = useCallback(async (cursor?: string, requestedQuery = debouncedQuery) => {
    const expected = routeKey;
    const sequence = ++processRequestSequence.current;
    setSelectedProcess(undefined);
    if (cursor) setIsLoadingMoreProcesses(true);
    else setProcesses({ status: "loading" });
    try {
      const result = await runWorkbench({
        operationId: "session.process.list",
        fullInfo: true,
        limit: 100,
        ...(requestedQuery ? { query: requestedQuery } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (!isCurrent(expected) || sequence !== processRequestSequence.current) return;
      setProcesses((current) => cursor && current.status === "ready"
        ? { status: "ready", value: mergePagedResult(result, uniqueProcesses([...current.value.items, ...result.items])) }
        : { status: "ready", value: result });
    } catch (error) {
      if (!isCurrent(expected) || sequence !== processRequestSequence.current) return;
      if (cursor) toast.danger("Could not load more processes", { description: errorMessage(error) });
      else setProcesses({ status: "error", error: errorMessage(error) });
    } finally {
      if (isCurrent(expected) && sequence === processRequestSequence.current) setIsLoadingMoreProcesses(false);
    }
  }, [debouncedQuery, isCurrent, routeKey]);

  const loadServices = useCallback(async (cursor?: string, requestedQuery = debouncedQuery) => {
    if (!isWindows) return;
    const expected = routeKey;
    const sequence = ++serviceRequestSequence.current;
    serviceDetailRequestSequence.current += 1;
    setSelectedService(undefined);
    setReadingServiceName(undefined);
    if (cursor) setIsLoadingMoreServices(true);
    else setServices({ status: "loading" });
    try {
      const result = await runWorkbench({
        operationId: "session.service.list",
        limit: 100,
        ...(requestedQuery ? { query: requestedQuery } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (!isCurrent(expected) || sequence !== serviceRequestSequence.current) return;
      setServices((current) => cursor && current.status === "ready"
        ? { status: "ready", value: mergePagedResult(result, uniqueServices([...current.value.items, ...result.items])) }
        : { status: "ready", value: result });
    } catch (error) {
      if (!isCurrent(expected) || sequence !== serviceRequestSequence.current) return;
      if (cursor) toast.danger("Could not load more services", { description: errorMessage(error) });
      else setServices({ status: "error", error: errorMessage(error) });
    } finally {
      if (isCurrent(expected) && sequence === serviceRequestSequence.current) setIsLoadingMoreServices(false);
    }
  }, [debouncedQuery, isCurrent, isWindows, routeKey]);

  useEffect(() => {
    processRequestSequence.current += 1;
    serviceRequestSequence.current += 1;
    serviceDetailRequestSequence.current += 1;
    setSection("processes");
    setProcessView("list");
    setQuery("");
    setDebouncedQuery("");
    setProcesses({ status: "loading" });
    setServices({ status: "loading" });
    setIsLoadingMoreProcesses(false);
    setIsLoadingMoreServices(false);
    setSelectedProcess(undefined);
    setSelectedService(undefined);
    setReadingServiceName(undefined);
    setStartingServiceName(undefined);
  }, [routeKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query, routeKey]);

  useEffect(() => {
    setSelectedProcess(undefined);
    setSelectedService(undefined);
    serviceDetailRequestSequence.current += 1;
    if (section === "services") {
      if (isWindows) void loadServices(undefined, debouncedQuery);
    } else {
      void loadProcesses(undefined, debouncedQuery);
    }
  }, [debouncedQuery, isWindows, loadProcesses, loadServices, routeKey, section]);

  const destructive = useDestructiveAction(routeKey, () => {
    if (section === "services") void loadServices(undefined, debouncedQuery);
    else void loadProcesses(undefined, debouncedQuery);
  });

  const dumpProcess = useCallback(async (process: SessionProcess) => {
    const expected = routeKey;
    setBusyProcess(process.pid);
    try {
      const result = await runWorkbench({
        operationId: "session.process.dump",
        pid: process.pid,
        dumpTimeoutSeconds: 120,
      });
      if (!isCurrent(expected)) return;
      if (result.status === "saved") toast.success("Process dump saved", { description: result.suggestedBasename });
      else toast.info("Process dump canceled");
    } catch (error) {
      if (isCurrent(expected)) toast.danger("Process dump failed", { description: errorMessage(error) });
    } finally {
      if (isCurrent(expected)) setBusyProcess(undefined);
    }
  }, [isCurrent, routeKey]);

  const openService = useCallback(async (service: SessionService) => {
    const expected = routeKey;
    const requestSequence = ++serviceDetailRequestSequence.current;
    setReadingServiceName(service.name);
    try {
      const detail = await runWorkbench({ operationId: "session.service.detail", name: service.name });
      if (isCurrent(expected) && requestSequence === serviceDetailRequestSequence.current) setSelectedService(detail);
    } catch (error) {
      if (isCurrent(expected) && requestSequence === serviceDetailRequestSequence.current) {
        toast.danger("Could not load service", { description: errorMessage(error) });
      }
    } finally {
      if (isCurrent(expected) && requestSequence === serviceDetailRequestSequence.current) setReadingServiceName(undefined);
    }
  }, [isCurrent, routeKey]);

  const startService = useCallback(async (service: SessionService) => {
    const expected = routeKey;
    if (!serviceCanStart(service.status)) return;
    setStartingServiceName(service.name);
    try {
      const result = await runWorkbench({ operationId: "session.service.start", name: service.name });
      if (!isCurrent(expected)) return;
      toast.success("Service start requested", { description: result.displayName || result.name });
      await loadServices(undefined, debouncedQuery);
    } catch (error) {
      if (isCurrent(expected)) notifyWorkbenchFailure("Could not start service", "Service outcome unknown", error);
    } finally {
      if (isCurrent(expected)) setStartingServiceName(undefined);
    }
  }, [debouncedQuery, isCurrent, loadServices, routeKey]);

  const processRows = useMemo(
    () => processes.status === "ready"
      ? processView === "tree" ? orderProcessesAsTree(processes.value.items) : processes.value.items
      : [],
    [processView, processes],
  );
  const processDepth = useMemo(() => processView === "tree" ? processTreeDepths(processRows) : new Map<number, number>(), [processRows, processView]);

  const processColumns = useMemo<DataGridColumn<SessionProcess>[]>(() => [
    {
      id: "process",
      header: "Process",
      isRowHeader: true,
      minWidth: 240,
      cell: (process) => (
        <div className="min-w-0 py-1" style={{ paddingInlineStart: `${(processDepth.get(process.pid) ?? 0) * 16}px` }}>
          <p className="truncate text-sm font-medium text-foreground">{process.executable || "Unnamed process"}</p>
          <p className="truncate font-mono text-[11px] text-muted">PID {process.pid}</p>
        </div>
      ),
    },
    { id: "owner", header: "Owner", accessorKey: "owner", allowsSorting: true, minWidth: 160 },
    {
      id: "parent",
      header: "Parent PID",
      accessorKey: "parentPid",
      allowsSorting: true,
      minWidth: 110,
      cell: (process) => <span className="font-mono text-xs text-muted">{process.parentPid}</span>,
    },
    { id: "arch", header: "Architecture", accessorKey: "architecture", minWidth: 130 },
    {
      id: "actions",
      header: "Actions",
      align: "end",
      minWidth: canDumpProcesses ? 140 : 90,
      cell: (process) => (
        <div className="flex justify-end gap-1">
          {canDumpProcesses ? (
            <IconButton isPending={busyProcess === process.pid} label={`Dump process ${process.pid}`} icon={faDownload} onPress={() => void dumpProcess(process)} />
          ) : null}
          <IconButton
            danger
            isDisabled={destructive.isPreparing || destructive.isExecuting}
            label={`Terminate process ${process.pid}`}
            icon={faStop}
            onPress={() => void destructive.prepare({ actionId: "session.process.terminate", pid: process.pid, force: false })}
          />
        </div>
      ),
    },
  ], [busyProcess, canDumpProcesses, destructive, dumpProcess, processDepth]);

  const serviceColumns = useMemo<DataGridColumn<SessionService>[]>(() => [
    {
      id: "service",
      header: "Service",
      isRowHeader: true,
      minWidth: 260,
      cell: (service) => (
        <div className="min-w-0 py-1">
          <p className="truncate text-sm font-medium text-foreground">{service.displayName || service.name}</p>
          <p className="truncate font-mono text-[11px] text-muted">{service.name}</p>
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      accessorKey: "status",
      allowsSorting: true,
      minWidth: 120,
      cell: (service) => <ServiceStatus status={service.status} />,
    },
    { id: "account", header: "Account", accessorKey: "account", minWidth: 180 },
    {
      id: "actions",
      header: "Actions",
      align: "end",
      minWidth: 180,
      cell: (service) => (
        <div className="flex justify-end gap-1">
          <IconButton
            isPending={readingServiceName === service.name}
            label={`View ${service.displayName || service.name} details`}
            icon={faEye}
            onPress={() => void openService(service)}
          />
          {serviceCanStart(service.status) ? (
            <IconButton
              isPending={startingServiceName === service.name}
              label={`Start ${service.displayName || service.name}`}
              icon={faPlay}
              onPress={() => void startService(service)}
            />
          ) : null}
          {serviceCanStop(service.status) ? (
            <IconButton
              danger
              isDisabled={destructive.isPreparing || destructive.isExecuting}
              label={`Stop ${service.displayName || service.name}`}
              icon={faStop}
              onPress={() => void destructive.prepare({ actionId: "session.service.stop", name: service.name })}
            />
          ) : null}
        </div>
      ),
    },
  ], [destructive, openService, readingServiceName, startService, startingServiceName]);

  const activeState = section === "services" ? services : processes;

  return (
    <>
      <PanelShell
        icon={faMicrochip}
        title="Processes"
        description="Inspect bounded process details and Windows service state."
        action={<RefreshButton label={`Refresh ${section}`} pending={activeState.status === "loading"} onPress={() => void (section === "services" ? loadServices(undefined, debouncedQuery) : loadProcesses(undefined, debouncedQuery))} />}
      >
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {isWindows ? (
              <Segment aria-label="Process inventory" selectedKey={section} size="sm" onSelectionChange={(key) => {
                serviceDetailRequestSequence.current += 1;
                setReadingServiceName(undefined);
                setSelectedProcess(undefined);
                setSelectedService(undefined);
                setSection(String(key) as "processes" | "services");
              }}>
                <Segment.Item id="processes">Processes</Segment.Item>
                <Segment.Item id="services">Services</Segment.Item>
              </Segment>
            ) : <span className="text-sm font-medium text-foreground">Processes</span>}
            <SearchField aria-label={`Filter ${section}`} className="w-full sm:max-w-sm" value={query} variant="secondary" onChange={(value) => {
              serviceDetailRequestSequence.current += 1;
              setReadingServiceName(undefined);
              setSelectedProcess(undefined);
              setSelectedService(undefined);
              setQuery(value);
            }}>
              <SearchField.Group>
                <SearchField.SearchIcon><FontAwesomeIcon aria-hidden icon={faMagnifyingGlass} /></SearchField.SearchIcon>
                <SearchField.Input placeholder={section === "services" ? "Filter service, account, or path" : "Filter process, owner, PID, or command"} />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
          </div>

          {section === "processes" ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Segment aria-label="Process view" selectedKey={processView} size="sm" onSelectionChange={(key) => {
                  setSelectedProcess(undefined);
                  setProcessView(String(key) as "list" | "tree");
                }}>
                  <Segment.Item id="list">List</Segment.Item>
                  <Segment.Item id="tree">Tree</Segment.Item>
                </Segment>
                {processes.status === "ready" ? <InventoryCount loaded={processes.value.items.length} noun="processes" page={processes.value.page} query={debouncedQuery} /> : null}
              </div>
              {processes.status === "loading" ? <PanelLoading label="Loading processes" /> : null}
              {processes.status === "error" ? <PanelError message={processes.error} onRetry={() => void loadProcesses(undefined, debouncedQuery)} /> : null}
              {processes.status === "ready" ? (
                <>
                  {processes.value.page.truncated ? <BoundedNotice nextCursor={processes.value.page.nextCursor} noun="processes" /> : null}
                  {processView === "tree" && processRows.length > 0 ? <p className="text-xs text-muted">Hierarchy reflects the currently loaded process pages.</p> : null}
                  <DataGrid
                    aria-label={processView === "tree" ? "Session process tree" : "Session processes"}
                    columns={processColumns}
                    contentClassName="min-w-[850px]"
                    data={processRows}
                    getRowId={(process) => String(process.pid)}
                    rowHeight={52}
                    scrollContainerClassName="max-h-[520px] overflow-auto"
                    variant="secondary"
                    virtualized
                    onRowAction={(key) => setSelectedProcess(processes.value.items.find((process) => process.pid === Number(key)))}
                    renderEmptyState={() => <GridEmpty label={debouncedQuery ? "No processes match this search." : "No processes were reported."} />}
                  />
                  {processes.value.page.nextCursor ? <div className="flex justify-center"><Button isPending={isLoadingMoreProcesses} size="sm" variant="tertiary" onPress={() => void loadProcesses(processes.value.page.nextCursor, debouncedQuery)}>Load more processes</Button></div> : null}
                </>
              ) : null}
              {selectedProcess ? <ProcessDetail process={selectedProcess} /> : null}
            </>
          ) : (
            <>
              {services.status === "ready" ? <div className="flex justify-end"><InventoryCount loaded={services.value.items.length} noun="services" page={services.value.page} query={debouncedQuery} /></div> : null}
              {services.status === "loading" ? <PanelLoading label="Loading services" /> : null}
              {services.status === "error" ? <PanelError message={services.error} onRetry={() => void loadServices(undefined, debouncedQuery)} /> : null}
              {services.status === "ready" ? (
                <>
                  {services.value.page.truncated ? <BoundedNotice nextCursor={services.value.page.nextCursor} noun="services" /> : null}
                  <DataGrid
                    aria-label="Windows services"
                    columns={serviceColumns}
                    contentClassName="min-w-[760px]"
                    data={services.value.items}
                    getRowId={(service) => service.name}
                    rowHeight={52}
                    scrollContainerClassName="max-h-[520px] overflow-auto"
                    variant="secondary"
                    virtualized
                    onRowAction={(key) => {
                      const service = services.value.items.find((candidate) => candidate.name === String(key));
                      if (service) void openService(service);
                    }}
                    renderEmptyState={() => <GridEmpty label={debouncedQuery ? "No services match this search." : "No services were reported."} />}
                  />
                  {services.value.page.nextCursor ? <div className="flex justify-center"><Button isPending={isLoadingMoreServices} size="sm" variant="tertiary" onPress={() => void loadServices(services.value.page.nextCursor, debouncedQuery)}>Load more services</Button></div> : null}
                </>
              ) : null}
              {selectedService ? <ServiceDetail service={selectedService} /> : null}
            </>
          )}
        </div>
      </PanelShell>
      <DestructiveActionDialog action={destructive} />
    </>
  );
}

export function SessionEnvironmentPanel({ route }: SessionWorkspacePanelContext): React.JSX.Element {
  const routeKey = workspaceRouteKey(route);
  const [state, setState] = useState<LoadState<SessionBoundedPage<SessionEnvironmentEntry>>>({ status: "loading" });
  const [revealed, setRevealed] = useState<Record<string, SessionEnvironmentRevealResult>>({});
  const [revealingName, setRevealingName] = useState<string>();
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const listRequestSequence = useRef(0);
  const revealRequestSequence = useRef(0);
  const isCurrent = useLatestIdentity(routeKey);

  const load = useCallback(async (cursor?: string) => {
    const expected = routeKey;
    const sequence = ++listRequestSequence.current;
    if (cursor) setIsLoadingMore(true);
    else {
      revealRequestSequence.current += 1;
      setState({ status: "loading" });
      setRevealed({});
      setRevealingName(undefined);
    }
    try {
      const result = await runWorkbench({ operationId: "session.environment.list", limit: 100, ...(cursor ? { cursor } : {}) });
      if (!isCurrent(expected) || sequence !== listRequestSequence.current) return;
      setState((current) => cursor && current.status === "ready"
        ? { status: "ready", value: mergePagedResult(result, uniqueEnvironmentEntries([...current.value.items, ...result.items])) }
        : { status: "ready", value: result });
    } catch (error) {
      if (!isCurrent(expected) || sequence !== listRequestSequence.current) return;
      if (cursor) toast.danger("Could not load more environment variables", { description: errorMessage(error) });
      else setState({ status: "error", error: errorMessage(error) });
    } finally {
      if (isCurrent(expected) && sequence === listRequestSequence.current) setIsLoadingMore(false);
    }
  }, [isCurrent, routeKey]);

  useEffect(() => {
    listRequestSequence.current += 1;
    revealRequestSequence.current += 1;
    setState({ status: "loading" });
    setRevealed({});
    setRevealingName(undefined);
    setIsLoadingMore(false);
    void load();
  }, [load, routeKey]);

  useEffect(() => {
    const expirationTimes = Object.values(revealed).map((entry) => Date.parse(entry.expiresAt)).filter(Number.isFinite);
    if (expirationTimes.length === 0) return;
    const delay = Math.max(0, Math.min(...expirationTimes) - Date.now());
    const timer = window.setTimeout(() => {
      const now = Date.now();
      setRevealed((current) => Object.fromEntries(Object.entries(current).filter(([, value]) => Date.parse(value.expiresAt) > now)));
    }, Math.min(delay + 10, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [revealed]);

  const reveal = useCallback(async (name: string) => {
    const expected = routeKey;
    const sequence = ++revealRequestSequence.current;
    setRevealingName(name);
    try {
      const result = await runWorkbench({ operationId: "session.environment.reveal", name });
      if (isCurrent(expected) && sequence === revealRequestSequence.current) setRevealed((current) => ({ ...current, [name]: result }));
    } catch (error) {
      if (isCurrent(expected) && sequence === revealRequestSequence.current) toast.danger("Could not reveal value", { description: errorMessage(error) });
    } finally {
      if (isCurrent(expected) && sequence === revealRequestSequence.current) setRevealingName(undefined);
    }
  }, [isCurrent, routeKey]);

  const columns = useMemo<DataGridColumn<SessionEnvironmentEntry>[]>(() => [
    {
      id: "name",
      header: "Name",
      isRowHeader: true,
      minWidth: 240,
      cell: (entry) => (
        <div className="flex items-center gap-2 py-1">
          <span className="font-mono text-xs font-medium text-foreground">{entry.name}</span>
          {entry.sensitive ? <Chip color="warning" size="sm" variant="soft">Sensitive</Chip> : null}
        </div>
      ),
    },
    {
      id: "value",
      header: "Value",
      minWidth: 360,
      cell: (entry) => {
        const revealResult = revealed[entry.name];
        if (!entry.redacted) return <span className="break-all font-mono text-xs text-muted">{entry.value}</span>;
        if (revealResult && Date.parse(revealResult.expiresAt) > Date.now()) {
          return (
            <div className="min-w-0">
              <p className="break-all font-mono text-xs text-foreground">{revealResult.value}</p>
              <p className="mt-1 text-[11px] text-warning">Hidden again at {formatTime(revealResult.expiresAt)}</p>
            </div>
          );
        }
        return <span className="font-mono text-xs text-muted">••••••••</span>;
      },
    },
    {
      id: "action",
      header: "Action",
      align: "end",
      minWidth: 110,
      cell: (entry) => entry.redacted ? (
        <Button isPending={revealingName === entry.name} size="sm" variant="tertiary" onPress={() => void reveal(entry.name)}>
          <FontAwesomeIcon aria-hidden icon={faEye} /> Reveal
        </Button>
      ) : null,
    },
  ], [reveal, revealed, revealingName]);

  return (
    <PanelShell
      icon={faTerminal}
      title="Environment"
      description="Sensitive values stay redacted until explicitly revealed and automatically hide at expiry."
      action={<RefreshButton label="Refresh environment" pending={state.status === "loading"} onPress={() => void load()} />}
    >
      {state.status === "loading" ? <PanelLoading label="Loading environment" /> : null}
      {state.status === "error" ? <PanelError message={state.error} onRetry={() => void load()} /> : null}
      {state.status === "ready" ? (
        <div className="flex min-w-0 flex-col gap-3">
          <InventoryCount loaded={state.value.items.length} noun="environment variables" page={state.value.page} />
          {state.value.page.truncated ? <BoundedNotice nextCursor={state.value.page.nextCursor} noun="environment variables" /> : null}
          <DataGrid
            aria-label="Session environment variables"
            columns={columns}
            contentClassName="min-w-[760px]"
            data={state.value.items}
            getRowId={(entry) => entry.name}
            scrollContainerClassName="max-h-[600px] overflow-auto"
            variant="secondary"
            renderEmptyState={() => <GridEmpty label="No environment variables were reported." />}
          />
          {state.value.page.nextCursor ? (
            <div className="flex justify-center"><Button isPending={isLoadingMore} size="sm" variant="tertiary" onPress={() => void load(state.value.page.nextCursor)}>Load more variables</Button></div>
          ) : null}
        </div>
      ) : null}
    </PanelShell>
  );
}

export function SessionRegistryPanel({ route, session }: SessionWorkspacePanelContext): React.JSX.Element {
  const routeKey = workspaceRouteKey(route);
  const platform = normalizedPlatform(session.os);
  const [hive, setHive] = useState<SessionRegistryHive>("HKCU");
  const [path, setPath] = useState("");
  const [pathDraft, setPathDraft] = useState("");
  const [requestedLocation, setRequestedLocation] = useState<{ hive: SessionRegistryHive; path: string }>({ hive: "HKCU", path: "" });
  const [state, setState] = useState<LoadState<RegistryListing>>({ status: "loading" });
  const [selectedValue, setSelectedValue] = useState<SessionRegistryReadResult>();
  const [readingValueKey, setReadingValueKey] = useState<string>();
  const [isSavingHive, setIsSavingHive] = useState(false);
  const [isLoadingMoreSubkeys, setIsLoadingMoreSubkeys] = useState(false);
  const [isLoadingMoreValues, setIsLoadingMoreValues] = useState(false);
  const [editorMode, setEditorMode] = useState<RegistryEditorMode>();
  const navigationRequestSequence = useRef(0);
  const subkeyRequestSequence = useRef(0);
  const valueRequestSequence = useRef(0);
  const readRequestSequence = useRef(0);
  const isCurrent = useLatestIdentity(routeKey);

  const load = useCallback(async (nextHive: SessionRegistryHive, nextPath: string) => {
    if (platform !== "windows") return;
    const expected = routeKey;
    const requestSequence = ++navigationRequestSequence.current;
    subkeyRequestSequence.current += 1;
    valueRequestSequence.current += 1;
    readRequestSequence.current += 1;
    setReadingValueKey(undefined);
    setRequestedLocation({ hive: nextHive, path: nextPath });
    setState({ status: "loading" });
    setSelectedValue(undefined);
    setEditorMode(undefined);
    setIsLoadingMoreSubkeys(false);
    setIsLoadingMoreValues(false);
    try {
      const [subkeys, values] = await Promise.all([
        runWorkbench({ operationId: "session.registry.list-subkeys", hive: nextHive, path: nextPath, limit: 500 }),
        runWorkbench({ operationId: "session.registry.list-values", hive: nextHive, path: nextPath, limit: 500 }),
      ]);
      if (!isCurrent(expected) || requestSequence !== navigationRequestSequence.current) return;
      setHive(nextHive);
      setPath(nextPath);
      setPathDraft(nextPath);
      setState({
        status: "ready",
        value: {
          entries: registryEntries(subkeys.items, values.items),
          subkeysPage: subkeys.page,
          valuesPage: values.page,
        },
      });
    } catch (error) {
      if (isCurrent(expected) && requestSequence === navigationRequestSequence.current) {
        setState({ status: "error", error: errorMessage(error) });
      }
    }
  }, [isCurrent, platform, routeKey]);

  const loadRegistryContinuation = useCallback(async (kind: "key" | "value", cursor: string) => {
    if (platform !== "windows" || state.status !== "ready") return;
    const expected = routeKey;
    const navigationSequence = navigationRequestSequence.current;
    const sequenceRef = kind === "key" ? subkeyRequestSequence : valueRequestSequence;
    const sequence = ++sequenceRef.current;
    if (kind === "key") setIsLoadingMoreSubkeys(true);
    else setIsLoadingMoreValues(true);
    try {
      const result = kind === "key"
        ? await runWorkbench({ operationId: "session.registry.list-subkeys", hive, path, limit: 500, cursor })
        : await runWorkbench({ operationId: "session.registry.list-values", hive, path, limit: 500, cursor });
      if (
        !isCurrent(expected) ||
        navigationSequence !== navigationRequestSequence.current ||
        sequence !== sequenceRef.current
      ) return;
      setState((current) => {
        if (current.status !== "ready") return current;
        const existingNames = current.value.entries.filter((entry) => entry.kind === kind).map((entry) => entry.name);
        const otherEntries = current.value.entries.filter((entry) => entry.kind !== kind);
        const names = uniqueStrings([...existingNames, ...result.items]);
        const continuedEntries = names.map((name) => ({ id: `${kind}:${name}`, kind, name }));
        return {
          status: "ready",
          value: {
            ...current.value,
            entries: kind === "key" ? [...continuedEntries, ...otherEntries] : [...otherEntries, ...continuedEntries],
            ...(kind === "key"
              ? { subkeysPage: combinedPageSummary(result.page, names.length) }
              : { valuesPage: combinedPageSummary(result.page, names.length) }),
          },
        };
      });
    } catch (error) {
      if (isCurrent(expected) && navigationSequence === navigationRequestSequence.current && sequence === sequenceRef.current) {
        toast.danger(kind === "key" ? "Could not load more subkeys" : "Could not load more values", { description: errorMessage(error) });
      }
    } finally {
      if (isCurrent(expected) && navigationSequence === navigationRequestSequence.current && sequence === sequenceRef.current) {
        if (kind === "key") setIsLoadingMoreSubkeys(false);
        else setIsLoadingMoreValues(false);
      }
    }
  }, [hive, isCurrent, path, platform, routeKey, state.status]);

  useEffect(() => {
    setHive("HKCU");
    setPath("");
    setPathDraft("");
    setRequestedLocation({ hive: "HKCU", path: "" });
    setReadingValueKey(undefined);
    setSelectedValue(undefined);
    setEditorMode(undefined);
    navigationRequestSequence.current += 1;
    subkeyRequestSequence.current += 1;
    valueRequestSequence.current += 1;
    readRequestSequence.current += 1;
    if (platform === "windows") void load("HKCU", "");
  }, [load, platform, routeKey]);

  const readValue = useCallback(async (key: string) => {
    const expected = routeKey;
    const requestSequence = ++readRequestSequence.current;
    const rowKey = `value:${key}`;
    setReadingValueKey(rowKey);
    try {
      const result = await runWorkbench({ operationId: "session.registry.read", hive, path, key });
      if (isCurrent(expected) && requestSequence === readRequestSequence.current) setSelectedValue(result);
    } catch (error) {
      if (isCurrent(expected) && requestSequence === readRequestSequence.current) {
        toast.danger("Could not read registry value", { description: errorMessage(error) });
      }
    } finally {
      if (isCurrent(expected) && requestSequence === readRequestSequence.current) setReadingValueKey(undefined);
    }
  }, [hive, isCurrent, path, routeKey]);

  const destructive = useDestructiveAction(routeKey, () => {
    setEditorMode(undefined);
    void load(hive, path);
  });

  const reviewRegistryAction = useCallback(async (input: PrepareSessionDestructiveActionInput) => {
    if (destructive.isPreparing || destructive.isExecuting) return;
    const expected = routeKey;
    await destructive.prepare(input);
    if (isCurrent(expected)) setEditorMode(undefined);
  }, [destructive, isCurrent, routeKey]);

  const saveHive = useCallback(async () => {
    if (!path) return;
    const expected = routeKey;
    setIsSavingHive(true);
    try {
      const result = await runWorkbench({
        operationId: "session.registry.read-hive",
        rootHive: hive,
        requestedHive: path,
        maxBytes: SESSION_WORKBENCH_MAX_ARTIFACT_BYTES,
      });
      if (!isCurrent(expected)) return;
      if (result.status === "saved") toast.success("Registry hive saved", { description: result.suggestedBasename });
      else toast.info("Hive save canceled");
    } catch (error) {
      if (isCurrent(expected)) toast.danger("Could not save registry hive", { description: errorMessage(error) });
    } finally {
      if (isCurrent(expected)) setIsSavingHive(false);
    }
  }, [hive, isCurrent, path, routeKey]);

  const columns = useMemo<DataGridColumn<RegistryEntry>[]>(() => [
    {
      id: "name",
      header: "Name",
      isRowHeader: true,
      minWidth: 320,
      cell: (entry) => (
        <div className="flex items-center gap-2 py-1">
          <FontAwesomeIcon aria-hidden className={entry.kind === "key" ? "text-accent" : "text-muted"} icon={entry.kind === "key" ? faFolder : faKey} />
          <span className="truncate font-mono text-xs text-foreground">{entry.name || "(Default)"}</span>
        </div>
      ),
    },
    {
      id: "type",
      header: "Type",
      minWidth: 110,
      cell: (entry) => <Chip size="sm" variant="soft">{entry.kind === "key" ? "Key" : "Value"}</Chip>,
    },
    {
      id: "action",
      header: "Action",
      align: "end",
      minWidth: 110,
      cell: (entry) => (
        <div className="flex justify-end gap-1">
          <IconButton
            isPending={entry.kind === "value" && readingValueKey === entry.id}
            label={entry.kind === "key" ? `Open ${entry.name}` : `Read ${entry.name || "default value"}`}
            icon={entry.kind === "key" ? faArrowRight : faEye}
            onPress={() => entry.kind === "key"
              ? void load(hive, joinRegistryPath(path, entry.name))
              : void readValue(entry.name)}
          />
          {entry.kind === "key" ? (
            <IconButton
              danger
              isDisabled={destructive.isPreparing || destructive.isExecuting}
              label={`Delete registry key ${entry.name}`}
              icon={faTrash}
              onPress={() => void destructive.prepare({ actionId: "session.registry.delete-key", hive, path, key: entry.name })}
            />
          ) : null}
        </div>
      ),
    },
  ], [destructive, hive, load, path, readValue, readingValueKey]);

  if (platform !== "windows") {
    return <PanelUnavailable title="Registry unavailable" description="Registry browsing is available only for Windows sessions." />;
  }

  const crumbs = registryBreadcrumbs(hive, path);

  return (
    <>
    <PanelShell
      icon={faKey}
      title="Registry"
      description="Browse bounded Windows registry entries and review every remote write before execution."
      action={(
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button isDisabled={destructive.isPreparing || destructive.isExecuting || state.status !== "ready"} size="sm" variant="tertiary" onPress={() => setEditorMode("create-key")}>Create key</Button>
          <Button isDisabled={destructive.isPreparing || destructive.isExecuting || state.status !== "ready"} size="sm" variant="tertiary" onPress={() => setEditorMode("write-value")}>Write value</Button>
          <Tooltip delay={250}>
            <Button isDisabled={state.status !== "ready" || !path} isPending={isSavingHive} size="sm" variant="secondary" onPress={() => void saveHive()}>
              <FontAwesomeIcon aria-hidden icon={faDownload} /> Save hive
            </Button>
            <Tooltip.Content>{path ? "Save the selected registry subkey" : "Select a registry subkey before saving"}</Tooltip.Content>
          </Tooltip>
          <RefreshButton disabled={state.status !== "ready"} label="Refresh registry" pending={state.status === "loading"} onPress={() => void load(hive, path)} />
        </div>
      )}
    >
      <div className="flex min-w-0 flex-col gap-4">
        <div className="grid gap-3 lg:grid-cols-[180px_minmax(0,1fr)_auto] lg:items-end">
          <Select
            aria-label="Registry hive"
            value={hive}
            variant="secondary"
            onChange={(key) => {
              const next = String(key) as SessionRegistryHive;
              if (REGISTRY_HIVES.includes(next)) void load(next, "");
            }}
          >
            <Label>Hive</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator><FontAwesomeIcon aria-hidden className="size-3" icon={faChevronDown} /></Select.Indicator>
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {REGISTRY_HIVES.map((item) => (
                  <ListBox.Item id={item} key={item} textValue={item}>
                    <span className="font-mono text-xs">{item}</span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          <TextField value={pathDraft} variant="secondary" onChange={setPathDraft}>
            <Label>Registry path</Label>
            <Input className="font-mono text-xs" placeholder="Software\\Microsoft" />
          </TextField>
          <Button size="sm" onPress={() => void load(hive, normalizeRegistryPath(pathDraft))}>Go</Button>
        </div>
        <Breadcrumbs
          aria-label="Registry path"
          onAction={(key) => {
            const crumb = crumbs.find((item) => item.id === String(key));
            if (crumb) void load(crumb.hive, crumb.path);
          }}
        >
          {crumbs.map((crumb) => <Breadcrumbs.Item className="no-underline" id={crumb.id} key={crumb.id}>{crumb.label}</Breadcrumbs.Item>)}
        </Breadcrumbs>
        {!path ? (
          <p className="text-xs leading-relaxed text-muted">Select a registry subkey before saving. Root hive export is not available from this workbench.</p>
        ) : null}
        {state.status === "loading" ? <PanelLoading label="Loading registry" /> : null}
        {state.status === "error" ? (
          <PanelError message={state.error} onRetry={() => void load(requestedLocation.hive, requestedLocation.path)} />
        ) : null}
        {state.status === "ready" ? (
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <InventoryCount loaded={state.value.entries.filter((entry) => entry.kind === "key").length} noun="subkeys" page={state.value.subkeysPage} />
              <InventoryCount loaded={state.value.entries.filter((entry) => entry.kind === "value").length} noun="values" page={state.value.valuesPage} />
            </div>
            <DataGrid
              aria-label={`Registry entries in ${hive} ${path}`}
              columns={columns}
              contentClassName="min-w-[680px]"
              data={state.value.entries}
              getRowId={(entry) => entry.id}
              rowHeight={48}
              scrollContainerClassName="max-h-[520px] overflow-auto"
              variant="secondary"
              virtualized
              onRowAction={(key) => {
                const entry = state.value.entries.find((candidate) => candidate.id === String(key));
                if (!entry) return;
                if (entry.kind === "key") void load(hive, joinRegistryPath(path, entry.name));
                else void readValue(entry.name);
              }}
              renderEmptyState={() => <GridEmpty label="This registry key has no visible subkeys or values." />}
            />
            {state.value.subkeysPage.nextCursor || state.value.valuesPage.nextCursor ? (
              <div className="flex flex-wrap justify-center gap-2">
                {state.value.subkeysPage.nextCursor ? <Button isPending={isLoadingMoreSubkeys} size="sm" variant="tertiary" onPress={() => void loadRegistryContinuation("key", state.value.subkeysPage.nextCursor!)}>Load more subkeys</Button> : null}
                {state.value.valuesPage.nextCursor ? <Button isPending={isLoadingMoreValues} size="sm" variant="tertiary" onPress={() => void loadRegistryContinuation("value", state.value.valuesPage.nextCursor!)}>Load more values</Button> : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {selectedValue ? (
          <section className="rounded-xl border border-separator bg-default px-4 py-3" aria-labelledby="registry-value-heading">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-mono text-sm font-semibold text-foreground" id="registry-value-heading">{selectedValue.key || "(Default)"}</h3>
              <Chip size="sm" variant="soft">{selectedValue.hive}</Chip>
            </div>
            <p className="mt-1 truncate font-mono text-[11px] text-muted">{selectedValue.path}</p>
            <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface p-3 font-mono text-xs text-foreground">{selectedValue.value}</pre>
          </section>
        ) : null}
      </div>
    </PanelShell>
    {editorMode ? (
      <RegistryMutationSheet
        hive={hive}
        isLocked={destructive.isPreparing || destructive.isExecuting}
        key={`${routeKey}:${hive}:${path}:${editorMode}`}
        mode={editorMode}
        path={path}
        onClose={() => {
          if (!destructive.isPreparing && !destructive.isExecuting) setEditorMode(undefined);
        }}
        onReview={reviewRegistryAction}
      />
    ) : null}
    <DestructiveActionDialog action={destructive} />
    </>
  );
}

function RegistryMutationSheet({
  hive,
  path,
  mode,
  isLocked,
  onClose,
  onReview,
}: {
  hive: SessionRegistryHive;
  path: string;
  mode: RegistryEditorMode;
  isLocked: boolean;
  onClose: () => void;
  onReview: (input: PrepareSessionDestructiveActionInput) => Promise<void>;
}): React.JSX.Element {
  const [activeMode, setActiveMode] = useState(mode);
  const [keyName, setKeyName] = useState("");
  const [valueType, setValueType] = useState<SessionRegistryWriteValue["type"]>("string");
  const [valueDraft, setValueDraft] = useState("");
  const parsedValue = activeMode === "write-value" ? registryWriteValueFromDraft(valueType, valueDraft) : undefined;
  const validationError = activeMode === "write-value" ? registryWriteValueDraftError(valueType, valueDraft) : undefined;
  const canReview = activeMode === "create-key" ? keyName.trim().length > 0 : parsedValue !== undefined;
  const location = path ? `${hive}\\${path}` : hive;

  const changeMode = (next: RegistryEditorMode) => {
    setActiveMode(next);
    setKeyName("");
    setValueType("string");
    setValueDraft("");
  };

  const review = async () => {
    if (!canReview || isLocked) return;
    if (activeMode === "create-key") {
      await onReview({ actionId: "session.registry.create-key", hive, path, key: keyName.trim() });
      return;
    }
    if (!parsedValue) return;
    await onReview({ actionId: "session.registry.write", hive, path, key: keyName, value: parsedValue });
  };

  return (
    <Sheet isDismissable={!isLocked} isOpen placement="right" onOpenChange={(open) => { if (!open && !isLocked) onClose(); }}>
      <Sheet.Backdrop variant="blur">
        <Sheet.Content className="h-full w-full max-w-lg">
          <Sheet.Dialog className="h-full">
            <Sheet.CloseTrigger />
            <Sheet.Header>
              <Sheet.Heading>Review registry change</Sheet.Heading>
              <p className="truncate font-mono text-xs text-muted" title={location}>{location}</p>
            </Sheet.Header>
            <Sheet.Body className="min-h-0 overflow-auto">
              <div className="flex flex-col gap-5 py-1">
                <Segment aria-label="Registry change" selectedKey={activeMode} size="sm" onSelectionChange={(key) => changeMode(String(key) as RegistryEditorMode)}>
                  <Segment.Item id="create-key">Create key</Segment.Item>
                  <Segment.Item id="write-value">Write value</Segment.Item>
                </Segment>
                {activeMode === "create-key" ? (
                  <TextField value={keyName} variant="secondary" onChange={setKeyName}>
                    <Label>New subkey name</Label>
                    <Input className="font-mono text-xs" placeholder="NewKey" />
                    <Description>The subkey is created directly beneath the displayed registry location.</Description>
                  </TextField>
                ) : (
                  <>
                    <TextField value={keyName} variant="secondary" onChange={setKeyName}>
                      <Label>Value name</Label>
                      <Input className="font-mono text-xs" placeholder="Empty writes the default value" />
                      <Description>Leave empty only when intentionally writing the default value.</Description>
                    </TextField>
                    <Select
                      aria-label="Registry value type"
                      value={valueType}
                      variant="secondary"
                      onChange={(key) => {
                        setValueType(String(key) as SessionRegistryWriteValue["type"]);
                        setValueDraft("");
                      }}
                    >
                      <Label>Value type</Label>
                      <Select.Trigger><Select.Value /><Select.Indicator><FontAwesomeIcon aria-hidden className="size-3" icon={faChevronDown} /></Select.Indicator></Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          <ListBox.Item id="string" textValue="String">String<ListBox.ItemIndicator /></ListBox.Item>
                          <ListBox.Item id="binary" textValue="Binary">Binary<ListBox.ItemIndicator /></ListBox.Item>
                          <ListBox.Item id="dword" textValue="DWORD">DWORD<ListBox.ItemIndicator /></ListBox.Item>
                          <ListBox.Item id="qword" textValue="QWORD">QWORD<ListBox.ItemIndicator /></ListBox.Item>
                        </ListBox>
                      </Select.Popover>
                    </Select>
                    {valueType === "string" || valueType === "binary" ? (
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="registry-value-draft">{valueType === "binary" ? "Hexadecimal bytes" : "String value"}</Label>
                        <TextArea
                          aria-label={valueType === "binary" ? "Hexadecimal bytes" : "String value"}
                          className="min-h-44 font-mono text-xs"
                          id="registry-value-draft"
                          spellCheck={false}
                          value={valueDraft}
                          variant="secondary"
                          onChange={(event) => setValueDraft(event.target.value)}
                        />
                      </div>
                    ) : (
                      <TextField value={valueDraft} variant="secondary" onChange={setValueDraft}>
                        <Label>{valueType === "dword" ? "Unsigned 32-bit value" : "Unsigned 64-bit value"}</Label>
                        <Input className="font-mono text-xs" inputMode="numeric" placeholder="0" />
                      </TextField>
                    )}
                    {validationError ? <p className="text-xs text-danger" role="alert">{validationError}</p> : null}
                  </>
                )}
                <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs leading-relaxed text-warning-soft-foreground">
                  Main will bind the exact hive, path, name, type, and value to a short-lived review plan before anything is changed.
                </p>
              </div>
            </Sheet.Body>
            <Sheet.Footer>
              <Button isDisabled={isLocked} size="sm" variant="secondary" onPress={onClose}>Cancel</Button>
              <Button isDisabled={!canReview || isLocked} isPending={isLocked} size="sm" variant="danger" onPress={() => void review()}>
                {activeMode === "create-key" ? "Review create key" : "Review write value"}
              </Button>
            </Sheet.Footer>
          </Sheet.Dialog>
        </Sheet.Content>
      </Sheet.Backdrop>
    </Sheet>
  );
}

interface DestructiveActionState {
  plan: SessionDestructiveActionPlan | undefined;
  isPreparing: boolean;
  isExecuting: boolean;
  prepare: (input: PrepareSessionDestructiveActionInput) => Promise<void>;
  execute: () => Promise<void>;
  dismiss: () => void;
}

function useDestructiveAction(routeKey: string, onSucceeded?: () => void): DestructiveActionState {
  const [plan, setPlan] = useState<SessionDestructiveActionPlan>();
  const [isPreparing, setIsPreparing] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const prepareInFlightRef = useRef(false);
  const executeInFlightRef = useRef(false);
  const prepareSequenceRef = useRef(0);
  const executeSequenceRef = useRef(0);
  const isCurrent = useLatestIdentity(routeKey);
  const onSucceededRef = useRef(onSucceeded);
  onSucceededRef.current = onSucceeded;

  useEffect(() => {
    prepareSequenceRef.current += 1;
    executeSequenceRef.current += 1;
    prepareInFlightRef.current = false;
    executeInFlightRef.current = false;
    setPlan(undefined);
    setIsPreparing(false);
    setIsExecuting(false);
  }, [routeKey]);

  const prepare = useCallback(async (input: PrepareSessionDestructiveActionInput) => {
    if (prepareInFlightRef.current || executeInFlightRef.current) return;
    prepareInFlightRef.current = true;
    const expected = routeKey;
    const sequence = ++prepareSequenceRef.current;
    setIsPreparing(true);
    try {
      const result = await window.sliver.prepareSessionDestructiveAction(input);
      if (!isCurrent(expected) || sequence !== prepareSequenceRef.current) return;
      if (!result.ok || !result.value) throw new Error(result.error ?? "The action could not be reviewed");
      if (result.value.status === "canceled") {
        toast.info("Action canceled");
        return;
      }
      setPlan(result.value.plan);
    } catch (error) {
      if (isCurrent(expected) && sequence === prepareSequenceRef.current) {
        toast.danger("Could not review action", { description: errorMessage(error) });
      }
    } finally {
      if (sequence === prepareSequenceRef.current) {
        prepareInFlightRef.current = false;
        if (isCurrent(expected)) setIsPreparing(false);
      }
    }
  }, [isCurrent, routeKey]);

  const execute = useCallback(async () => {
    if (!plan || executeInFlightRef.current || prepareInFlightRef.current) return;
    executeInFlightRef.current = true;
    const expected = routeKey;
    const sequence = ++executeSequenceRef.current;
    setIsExecuting(true);
    try {
      const result = await window.sliver.executeSessionDestructiveActionPlan({ token: plan.token });
      if (!isCurrent(expected) || sequence !== executeSequenceRef.current) return;
      if (!result.ok || !result.value) throw new Error(result.error ?? "The reviewed action failed");
      announceDestructiveOutcome(result.value);
      if (result.value.status === "succeeded") onSucceededRef.current?.();
      setPlan(undefined);
    } catch (error) {
      if (isCurrent(expected) && sequence === executeSequenceRef.current) {
        toast.danger("Action failed", { description: errorMessage(error) });
      }
    } finally {
      if (sequence === executeSequenceRef.current) {
        executeInFlightRef.current = false;
        if (isCurrent(expected)) setIsExecuting(false);
      }
    }
  }, [isCurrent, plan, routeKey]);

  return {
    plan,
    isPreparing,
    isExecuting,
    prepare,
    execute,
    dismiss: () => {
      if (!executeInFlightRef.current) setPlan(undefined);
    },
  };
}

function DestructiveActionDialog({ action }: { action: DestructiveActionState }): React.JSX.Element {
  const { plan } = action;
  return (
    <AlertDialog.Backdrop
      isOpen={plan !== undefined}
      onOpenChange={(open) => {
        if (!open) action.dismiss();
      }}
      variant="blur"
    >
      <AlertDialog.Container placement="center" size="sm">
        <AlertDialog.Dialog className="sm:max-w-[440px]">
          <AlertDialog.Header>
            <AlertDialog.Icon status="danger"><FontAwesomeIcon aria-hidden className="size-4" icon={faTriangleExclamation} /></AlertDialog.Icon>
            <AlertDialog.Heading>{plan ? destructiveActionTitle(plan.action) : "Review destructive action"}</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            {plan ? (
              <div className="space-y-3 text-sm">
                <div className="rounded-xl border border-separator bg-default px-3 py-2.5">
                  <p className="font-medium text-foreground">{plan.target.name || plan.target.hostname || "Active session"}</p>
                  <p className="mt-0.5 text-xs text-muted">{plan.target.hostname} · {plan.target.os}</p>
                  <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-separator pt-2 text-xs">
                    <dt className="text-muted">Backend</dt>
                    <dd className="min-w-0 truncate text-foreground" title={`${plan.target.backend.displayName} (${plan.target.backend.id})`}>
                      <span>{plan.target.backend.displayName}</span>{" "}
                      <span className="select-all font-mono text-[11px] text-muted">({plan.target.backend.id})</span>
                    </dd>
                    <dt className="text-muted">Session</dt>
                    <dd className="select-all truncate font-mono text-[11px] text-foreground" title={plan.target.sessionId}>{plan.target.sessionId}</dd>
                    <dt className="text-muted">Fingerprint</dt>
                    <dd className="select-all truncate font-mono text-[11px] text-foreground" title={plan.target.fingerprint}>{plan.target.fingerprint}</dd>
                  </dl>
                </div>
                <p className="leading-relaxed text-danger-soft-foreground">{plan.warning}</p>
                <ActionImpact action={plan.action} />
                <p className="select-all truncate font-mono text-[11px] text-muted" title={plan.payloadDigest}>
                  Plan payload SHA-256 {plan.payloadDigest}
                </p>
                {plan.resource?.kind === "process" ? (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-default px-3 py-2 text-xs">
                    <dt className="text-muted">Executable</dt>
                    <dd className="truncate font-mono text-foreground">{plan.resource.executable || "Unknown"}</dd>
                    <dt className="text-muted">Owner</dt>
                    <dd className="truncate text-foreground">{plan.resource.owner || "Unknown"}</dd>
                    <dt className="text-muted">Parent PID</dt>
                    <dd className="font-mono text-foreground">{plan.resource.parentPid}</dd>
                    <dt className="text-muted">Architecture</dt>
                    <dd className="text-foreground">{plan.resource.architecture || "Unknown"}</dd>
                  </dl>
                ) : null}
                {plan.artifact ? (
                  <div className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground">
                    <p>Native file: {plan.artifact.suggestedBasename} · {formatBytes(plan.artifact.size)}</p>
                    <p className="mt-1 select-all truncate font-mono text-[11px]" title={plan.artifact.sha256}>SHA-256 {plan.artifact.sha256}</p>
                  </div>
                ) : null}
                <p className="text-xs leading-relaxed text-muted">
                  Main-issued plan expires at {formatTime(plan.expiresAt)}. Any target, backend, or payload change invalidates it.
                </p>
              </div>
            ) : null}
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button isDisabled={action.isExecuting} size="sm" variant="tertiary" onPress={action.dismiss}>Cancel</Button>
            <Button isDisabled={action.isPreparing} isPending={action.isExecuting} size="sm" variant="danger" onPress={() => void action.execute()}>
              Confirm action
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

function PanelShell({
  icon,
  title,
  description,
  action,
  children,
}: {
  icon: Parameters<typeof FontAwesomeIcon>[0]["icon"];
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  const headingId = `session-panel-${title.toLocaleLowerCase().replaceAll(/[^a-z0-9]+/gu, "-")}`;
  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-separator bg-surface" aria-labelledby={headingId}>
      <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="section-icon"><FontAwesomeIcon aria-hidden icon={icon} /></span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground" id={headingId}>{title}</h2>
            <p className="text-xs leading-relaxed text-muted">{description}</p>
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="border-t border-separator p-5 sm:p-6">{children}</div>
    </section>
  );
}

function PanelLoading({ label }: { label: string }): React.JSX.Element {
  return (
    <div aria-busy="true" aria-live="polite" className="flex min-h-48 items-center justify-center gap-3 text-sm text-muted" role="status">
      <Spinner size="sm" /> <span>{label}…</span>
    </div>
  );
}

function PanelError({ message, onRetry }: { message: string; onRetry: () => void }): React.JSX.Element {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl bg-danger-soft px-6 py-8 text-center" role="alert">
      <FontAwesomeIcon aria-hidden className="text-danger" icon={faTriangleExclamation} />
      <div>
        <p className="text-sm font-medium text-danger-soft-foreground">This session data is unavailable</p>
        <p className="mt-1 max-w-xl text-xs leading-relaxed text-danger-soft-foreground/80">{message}</p>
      </div>
      <Button size="sm" variant="tertiary" onPress={onRetry}>Try again</Button>
    </div>
  );
}

function PanelEmpty({
  icon,
  title,
  description,
}: {
  icon: Parameters<typeof FontAwesomeIcon>[0]["icon"];
  title: string;
  description: string;
}): React.JSX.Element {
  return (
    <EmptyState className="min-h-48 px-6 py-10" size="sm">
      <EmptyState.Header>
        <EmptyState.Media variant="icon"><FontAwesomeIcon aria-hidden icon={icon} /></EmptyState.Media>
        <EmptyState.Title>{title}</EmptyState.Title>
        <EmptyState.Description className="max-w-md">{description}</EmptyState.Description>
      </EmptyState.Header>
    </EmptyState>
  );
}

function PanelUnavailable({ title, description }: { title: string; description: string }): React.JSX.Element {
  return (
    <div className="rounded-2xl border border-separator bg-surface p-5 sm:p-6">
      <PanelEmpty icon={faTriangleExclamation} title={title} description={description} />
    </div>
  );
}

function GridEmpty({ label }: { label: string }): React.JSX.Element {
  return <div className="flex min-h-40 items-center justify-center px-6 py-10 text-center text-sm text-muted">{label}</div>;
}

function BoundedNotice({ nextCursor, noun }: { nextCursor: string | undefined; noun: string }): React.JSX.Element {
  return (
    <p className="bg-warning-soft px-4 py-2 text-xs text-warning-soft-foreground" role="status">
      {nextCursor ? `The ${noun} result is bounded. Load the next page to continue.` : `The server returned a truncated ${noun} result.`}
    </p>
  );
}

function InventoryCount({
  loaded,
  noun,
  page,
  query,
}: {
  loaded: number;
  noun: string;
  page: SessionPageSummary;
  query?: string;
}): React.JSX.Element {
  return (
    <p aria-live="polite" className="text-xs tabular-nums text-muted" role="status">
      {`Loaded ${loaded} of ${page.total} ${noun}${query ? ` matching “${query}”` : ""}${page.truncated ? " · bounded" : ""}`}
    </p>
  );
}

function RefreshButton({
  label,
  pending,
  disabled = false,
  onPress,
}: {
  label: string;
  pending: boolean;
  disabled?: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return <IconButton isDisabled={disabled} isPending={pending} label={label} icon={faRotate} onPress={onPress} />;
}

function IconButton({
  label,
  icon,
  danger = false,
  isDisabled = false,
  isPending = false,
  onPress,
}: {
  label: string;
  icon: Parameters<typeof FontAwesomeIcon>[0]["icon"];
  danger?: boolean;
  isDisabled?: boolean;
  isPending?: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Tooltip delay={250}>
      <Button
        aria-label={label}
        isIconOnly
        isDisabled={isDisabled}
        isPending={isPending}
        size="sm"
        variant={danger ? "danger-soft" : "ghost"}
        onPress={onPress}
      >
        <FontAwesomeIcon aria-hidden icon={icon} />
      </Button>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-muted">{label}</dt>
      <dd className={`mt-1 break-words text-sm text-foreground ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}

function Address({ value }: { value: SessionNetworkConnection["local"] }): React.JSX.Element {
  return <span className="font-mono text-xs text-muted">{value ? `${value.address}:${value.port}` : "Not reported"}</span>;
}

function ProcessDetail({ process }: { process: SessionProcess }): React.JSX.Element {
  return (
    <section className="rounded-xl border border-separator bg-default px-4 py-4" aria-labelledby="process-detail-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground" id="process-detail-heading">{process.executable || "Process details"}</h3>
        <Chip size="sm" variant="soft">PID {process.pid}</Chip>
      </div>
      <dl className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
        <Detail label="Owner" value={process.owner || "Not reported"} />
        <Detail label="Parent PID" value={String(process.parentPid)} mono />
        <Detail label="Architecture" value={process.architecture || "Not reported"} />
        <Detail label="Session ID" value={process.sessionId === undefined ? "Not reported" : String(process.sessionId)} mono />
      </dl>
      <p className="mt-4 text-[11px] font-medium text-muted">Command line</p>
      <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface p-3 font-mono text-xs text-foreground">
        {process.commandLine.length > 0 ? process.commandLine.join(" ") : "Not reported"}
      </pre>
    </section>
  );
}

function ServiceDetail({ service }: { service: SessionService }): React.JSX.Element {
  return (
    <section className="rounded-xl border border-separator bg-default px-4 py-4" aria-labelledby="service-detail-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground" id="service-detail-heading">{service.displayName || service.name}</h3>
          <p className="mt-0.5 font-mono text-[11px] text-muted">{service.name}</p>
        </div>
        <ServiceStatus status={service.status} />
      </div>
      {service.description ? <p className="mt-3 text-sm leading-relaxed text-muted">{service.description}</p> : null}
      <dl className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
        <Detail label="Account" value={service.account || "Not reported"} />
        <Detail label="Startup type" value={serviceStartupTypeLabel(service.startupType)} />
        <Detail label="Binary path" value={service.binaryPath || "Not reported"} mono />
        <Detail label="Message" value={service.message || "None"} />
      </dl>
    </section>
  );
}

function ServiceStatus({ status }: { status: number }): React.JSX.Element {
  const label = serviceStateLabel(status);
  const color = status === 4 ? "success" : status === 1 ? "default" : "warning";
  return <Chip color={color} size="sm" variant="soft">{label}</Chip>;
}

function serviceStateLabel(status: number): string {
  return ({
    1: "Stopped",
    2: "Starting",
    3: "Stopping",
    4: "Running",
    5: "Continuing",
    6: "Pausing",
    7: "Paused",
  } as const)[status as 1 | 2 | 3 | 4 | 5 | 6 | 7] ?? `Unknown (${status})`;
}

function serviceStartupTypeLabel(startupType: number): string {
  return ({
    0: "Boot",
    1: "System",
    2: "Automatic",
    3: "Manual",
    4: "Disabled",
  } as const)[startupType as 0 | 1 | 2 | 3 | 4] ?? `Unknown (${startupType})`;
}

function serviceCanStart(status: number): boolean {
  return status === 1;
}

function serviceCanStop(status: number): boolean {
  return status === 4 || status === 7;
}

function ActionImpact({ action }: { action: PrepareSessionDestructiveActionInput }): React.JSX.Element {
  const details = destructiveActionDetails(action);
  return (
    <dl className="grid gap-2 rounded-xl border border-separator bg-default px-3 py-2.5 text-xs">
      {details.map(([label, value]) => (
        <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-3" key={label}>
          <dt className="text-muted">{label}</dt>
          <dd className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

async function runWorkbench<T extends SessionWorkbenchInput>(
  input: T,
): Promise<SessionWorkbenchResultFor<T["operationId"]>> {
  const result = await window.sliver.runSessionWorkbench(input as SessionWorkbenchInput);
  if (!result.ok || !result.value) throw new Error(result.error ?? "The session workbench request failed");
  if (result.value.status === "outcome-unknown") {
    if (result.value.operationId !== input.operationId) {
      throw new Error("The session workbench returned a mismatched outcome");
    }
    throw new SessionOutcomeUnknownError(result.value.message);
  }
  if (result.value.status === "failed") {
    if (result.value.operationId !== input.operationId) {
      throw new Error("The session workbench returned a mismatched failure");
    }
    throw new SessionConfirmedFailureError(result.value.message);
  }
  if (result.value.result.operationId !== input.operationId) {
    throw new Error("The session workbench returned a mismatched result");
  }
  return result.value.result.value as SessionWorkbenchResultFor<T["operationId"]>;
}

class SessionOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionOutcomeUnknownError";
  }
}

class SessionConfirmedFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionConfirmedFailureError";
  }
}

function notifyWorkbenchFailure(failedTitle: string, unknownTitle: string, error: unknown): void {
  if (error instanceof SessionOutcomeUnknownError) {
    toast.warning(unknownTitle, { description: error.message });
  } else {
    toast.danger(failedTitle, { description: errorMessage(error) });
  }
}

function useLatestIdentity(identity: string): (expected: string) => boolean {
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return useCallback((expected: string) => mountedRef.current && identityRef.current === expected, []);
}

function workspaceRouteKey(route: SessionWorkspacePanelContext["route"]): string {
  return `${route.backendEpoch}:${route.connectionIncarnation}:${route.sessionId}:${route.targetFingerprint}`;
}

function normalizedPlatform(os: string): string {
  const value = os.trim().toLocaleLowerCase();
  if (value.includes("windows")) return "windows";
  if (value.includes("darwin") || value.includes("mac")) return "darwin";
  if (value.includes("linux")) return "linux";
  return value;
}

function networkConnectionKey(connection: SessionNetworkConnection, index: number): string {
  return [connection.protocol, connection.local?.address, connection.local?.port, connection.remote?.address, connection.remote?.port, index].join(":");
}

function networkConnectionIdentity(connection: SessionNetworkConnection): string {
  return [
    connection.protocol,
    connection.state,
    connection.uid,
    connection.local?.address,
    connection.local?.port,
    connection.remote?.address,
    connection.remote?.port,
    connection.process?.pid,
  ].join(":");
}

function uniqueNetworkInterfaces(items: SessionNetworkInterface[]): SessionNetworkInterface[] {
  return [...new Map(items.map((item) => [`${item.index}:${item.name}`, item])).values()];
}

function uniqueNetworkConnections(items: SessionNetworkConnection[]): SessionNetworkConnection[] {
  return [...new Map(items.map((item) => [networkConnectionIdentity(item), item])).values()];
}

function uniqueProcesses(items: SessionProcess[]): SessionProcess[] {
  return [...new Map(items.map((item) => [item.pid, item])).values()];
}

function uniqueServices(items: SessionService[]): SessionService[] {
  return [...new Map(items.map((item) => [item.name, item])).values()];
}

function uniqueEnvironmentEntries(items: SessionEnvironmentEntry[]): SessionEnvironmentEntry[] {
  return [...new Map(items.map((item) => [item.name, item])).values()];
}

function orderProcessesAsTree(items: SessionProcess[]): SessionProcess[] {
  const byPid = new Map(items.map((item) => [item.pid, item]));
  const children = new Map<number, SessionProcess[]>();
  for (const item of items) {
    const siblings = children.get(item.parentPid) ?? [];
    siblings.push(item);
    children.set(item.parentPid, siblings);
  }
  const roots = items.filter((item) => item.parentPid === item.pid || !byPid.has(item.parentPid));
  const ordered: SessionProcess[] = [];
  const seen = new Set<number>();
  const visit = (item: SessionProcess) => {
    if (seen.has(item.pid)) return;
    seen.add(item.pid);
    ordered.push(item);
    for (const child of children.get(item.pid) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  for (const item of items) visit(item);
  return ordered;
}

function processTreeDepths(items: SessionProcess[]): Map<number, number> {
  const byPid = new Map(items.map((item) => [item.pid, item]));
  const depths = new Map<number, number>();
  const depthFor = (item: SessionProcess, trail = new Set<number>()): number => {
    const known = depths.get(item.pid);
    if (known !== undefined) return known;
    if (trail.has(item.pid) || item.parentPid === item.pid) return 0;
    const parent = byPid.get(item.parentPid);
    if (!parent) return 0;
    const nextTrail = new Set(trail);
    nextTrail.add(item.pid);
    const depth = Math.min(depthFor(parent, nextTrail) + 1, 32);
    depths.set(item.pid, depth);
    return depth;
  };
  for (const item of items) depths.set(item.pid, depthFor(item));
  return depths;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function combinedPageSummary(page: SessionPageSummary, loaded: number): SessionPageSummary {
  return {
    ...page,
    truncated: Boolean(page.nextCursor) || loaded < page.total,
  };
}

function mergePagedResult<T, R extends { items: T[]; page: SessionPageSummary }>(result: R, items: T[]): R {
  return {
    ...result,
    items,
    page: combinedPageSummary(result.page, items.length),
  };
}

function registryEntries(subkeys: string[], values: string[]): RegistryEntry[] {
  return [
    ...uniqueStrings(subkeys).map((name) => ({ id: `key:${name}`, kind: "key" as const, name })),
    ...uniqueStrings(values).map((name) => ({ id: `value:${name}`, kind: "value" as const, name })),
  ];
}

function registryWriteValueFromDraft(type: SessionRegistryWriteValue["type"], draft: string): SessionRegistryWriteValue | undefined {
  if (registryWriteValueDraftError(type, draft)) return undefined;
  switch (type) {
    case "string": return { type, value: draft };
    case "binary": return { type, hex: draft.toLocaleLowerCase() };
    case "dword": return { type, value: Number(draft) };
    case "qword": return { type, value: draft };
  }
}

function registryWriteValueDraftError(type: SessionRegistryWriteValue["type"], draft: string): string | undefined {
  if (!draft) return "Enter a value before review.";
  if (draft.includes("\0")) return "Registry values cannot contain null characters.";
  if (draft.length > 65_536) return "Registry values are limited to 65,536 characters.";
  if (type === "binary" && !/^(?:[0-9a-f]{2})+$/iu.test(draft)) return "Binary data must be contiguous even-length hexadecimal.";
  if (type === "dword" && (!/^\d+$/u.test(draft) || Number(draft) > 0xffff_ffff)) return "DWORD must be an unsigned 32-bit decimal integer.";
  if (type === "qword") {
    if (!/^\d{1,20}$/u.test(draft)) return "QWORD must be an unsigned 64-bit decimal integer.";
    try {
      if (BigInt(draft) > 0xffff_ffff_ffff_ffffn) return "QWORD must be an unsigned 64-bit decimal integer.";
    } catch {
      return "QWORD must be an unsigned 64-bit decimal integer.";
    }
  }
  return undefined;
}

function registryLocation(hive: SessionRegistryHive, path: string): string {
  return path ? `${hive}\\${path}` : hive;
}

function registryValueTypeLabel(type: SessionRegistryWriteValue["type"]): string {
  return ({ string: "String", binary: "Binary", dword: "DWORD", qword: "QWORD" } as const)[type];
}

function registryReviewValue(value: SessionRegistryWriteValue): string {
  const rendered = value.type === "binary" ? value.hex : String(value.value);
  const unit = value.type === "binary" ? `${rendered.length / 2} bytes` : `${rendered.length} characters`;
  return rendered.length <= 512 ? rendered : `${rendered.slice(0, 512)}…\n[Preview truncated; ${unit}. The complete value is bound by the plan payload digest.]`;
}

function uniqueFiles(files: SessionFileEntry[]): SessionFileEntry[] {
  return [...new Map(files.map((file) => [file.path, file])).values()];
}

function uniqueMounts(mounts: SessionMount[]): SessionMount[] {
  return [...new Map(mounts.map((mount) => [mountKey(mount), mount])).values()];
}

function uniqueMemoryFiles(files: SessionMemoryFile[]): SessionMemoryFile[] {
  return [...new Map(files.map((file) => [file.fd, file])).values()];
}

function mountKey(mount: SessionMount): string {
  return `${mount.mountPoint}:${mount.volumeName}:${mount.filesystem}`;
}

function boundedContext(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, Math.trunc(parsed)));
}

function isHexFileView(value: FileViewResult): value is SessionHexFileView {
  return "hex" in value;
}

function fileViewContent(value: FileViewResult): string {
  return isHexFileView(value) ? value.hex : value.content;
}

function fileViewIsEditable(value: FileViewResult): boolean {
  return value.truncated === false && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/iu.test(value.sha256);
}

function editorDraftIsValid(value: FileViewResult, draft: string): boolean {
  if (!fileViewIsEditable(value)) return false;
  if (isHexFileView(value)) {
    return draft.length <= SESSION_EDITOR_MAX_BYTES * 2 && /^(?:[0-9a-f]{2})*$/iu.test(draft);
  }
  return new TextEncoder().encode(draft).byteLength <= SESSION_EDITOR_MAX_BYTES;
}

function joinRemotePath(parent: string, child: string, windows: boolean): string {
  const separator = windows ? "\\" : "/";
  return parent.endsWith("/") || parent.endsWith("\\") ? `${parent}${child}` : `${parent}${separator}${child}`;
}

export function pathBreadcrumbs(path: string, windows: boolean): Array<{ label: string; path: string }> {
  if (!path) return [];
  if (windows) {
    const normalized = path.replaceAll("/", "\\");
    if (normalized.startsWith("\\\\")) {
      const [server, share, ...parts] = normalized.slice(2).split("\\").filter(Boolean);
      if (server && share) {
        const root = `\\\\${server}\\${share}`;
        const crumbs = [{ label: root, path: root }];
        let current = root;
        for (const part of parts) {
          current = `${current}\\${part}`;
          crumbs.push({ label: part, path: current });
        }
        return crumbs;
      }
    }
    const parts = normalized.split("\\").filter(Boolean);
    const root = /^[A-Za-z]:$/u.test(parts[0] ?? "") ? `${parts.shift()}\\` : "\\";
    const crumbs = [{ label: root, path: root }];
    let current = root;
    for (const part of parts) {
      current = current.endsWith("\\") ? `${current}${part}` : `${current}\\${part}`;
      crumbs.push({ label: part, path: current });
    }
    return crumbs;
  }
  const parts = path.split("/").filter(Boolean);
  const crumbs = [{ label: "/", path: "/" }];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

function joinRegistryPath(parent: string, child: string): string {
  const normalizedChild = normalizeRegistryPath(child);
  return parent ? `${normalizeRegistryPath(parent)}\\${normalizedChild}` : normalizedChild;
}

function normalizeRegistryPath(path: string): string {
  return path.trim().replaceAll("/", "\\").replaceAll(/^\\+|\\+$/gu, "");
}

function registryBreadcrumbs(hive: SessionRegistryHive, path: string): Array<{ id: string; label: string; hive: SessionRegistryHive; path: string }> {
  const crumbs: Array<{ id: string; label: string; hive: SessionRegistryHive; path: string }> = [
    { id: `${hive}:`, label: hive, hive, path: "" },
  ];
  let current = "";
  for (const part of normalizeRegistryPath(path).split("\\").filter(Boolean)) {
    current = current ? `${current}\\${part}` : part;
    crumbs.push({ id: `${hive}:${current}`, label: part, hive, path: current });
  }
  return crumbs;
}

function destructiveActionTitle(action: PrepareSessionDestructiveActionInput): string {
  switch (action.actionId) {
    case "session.filesystem.rm": return "Delete this remote item?";
    case "session.filesystem.cp": return "Copy this remote item?";
    case "session.filesystem.mv": return "Move this remote item?";
    case "session.filesystem.chmod-recursive": return "Change permissions recursively?";
    case "session.filesystem.chown-recursive": return "Change owner recursively?";
    case "session.filesystem.memfiles.rm": return "Remove this memory file?";
    case "session.process.terminate": return `Terminate process ${action.pid}?`;
    case "session.service.stop": return `Stop service ${action.name}?`;
    case "session.filesystem.upload-overwrite": return "Overwrite this remote file?";
    case "session.filesystem.edit-text-overwrite":
    case "session.filesystem.patch-hex": return "Save changes to this remote file?";
    case "session.registry.write": return "Write this registry value?";
    case "session.registry.create-key": return "Create this registry key?";
    case "session.registry.delete-key": return "Delete this registry key?";
    default: return "Run this destructive action?";
  }
}

function destructiveActionDetails(action: PrepareSessionDestructiveActionInput): Array<[string, string]> {
  switch (action.actionId) {
    case "session.filesystem.rm": return [["Path", action.path], ["Recursive", action.recursive ? "Yes" : "No"]];
    case "session.process.terminate": return [["PID", String(action.pid)], ["Force", action.force ? "Yes" : "No"]];
    case "session.service.stop": return [["Service", action.name]];
    case "session.filesystem.cp":
    case "session.filesystem.mv": return [["Source", action.source], ["Destination", action.destination]];
    case "session.filesystem.chmod-recursive": return [["Path", action.path], ["Mode", action.fileMode]];
    case "session.filesystem.chown-recursive": return [["Path", action.path], ["Owner", `${action.uid}:${action.gid}`]];
    case "session.filesystem.memfiles.rm": return [["Descriptor", action.fd]];
    case "session.filesystem.upload-overwrite": return [["Remote path", action.remotePath]];
    case "session.filesystem.edit-text-overwrite": return [["Remote path", action.remotePath], ["Expected SHA-256", action.expectedSha256]];
    case "session.filesystem.patch-hex": return [["Remote path", action.remotePath], ["Expected SHA-256", action.expectedSha256]];
    case "session.registry.write": return [
      ["Location", registryLocation(action.hive, action.path)],
      ["Value name", action.key || "(Default)"],
      ["Value type", registryValueTypeLabel(action.value.type)],
      [action.value.type === "binary" ? "Hex bytes" : "Exact value", registryReviewValue(action.value)],
    ];
    case "session.registry.create-key":
    case "session.registry.delete-key": return [["Location", registryLocation(action.hive, action.path)], ["Key", action.key]];
  }
}

function announceDestructiveOutcome(outcome: SessionDestructiveActionOutcome): void {
  if (outcome.status === "succeeded") toast.success("Action complete", { description: outcome.message });
  else if (outcome.status === "outcome-unknown") toast.warning("Action outcome is unknown", { description: outcome.message });
  else toast.danger("Action did not complete", { description: outcome.message });
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "Not reported";
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1_000)} s`;
  if (milliseconds < 3_600_000) return `${Math.round(milliseconds / 60_000)} min`;
  return `${Math.round(milliseconds / 3_600_000)} hr`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "Unknown size";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function formatByteString(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? formatBytes(parsed) : value || "Unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
