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
  Input,
  Label,
  ListBox,
  SearchField,
  Select,
  TextField,
  Tooltip,
  toast,
} from "@heroui/react";
import { Segment } from "@heroui-pro/react";
import { DataGrid } from "@heroui-pro/react/data-grid";
import type { DataGridColumn } from "@heroui-pro/react/data-grid";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowRight,
  faCamera,
  faChevronDown,
  faCircleNotch,
  faDownload,
  faEye,
  faFile,
  faFolder,
  faFolderPlus,
  faFloppyDisk,
  faKey,
  faMagnifyingGlass,
  faMicrochip,
  faNetworkWired,
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
  type SessionIdentityDetail,
  type SessionNetworkConnection,
  type SessionNetworkInterface,
  type SessionProcess,
  type SessionRegistryHive,
  type SessionRegistryReadResult,
  type SessionService,
  type SessionWorkbenchInput,
  type SessionWorkbenchResultFor,
} from "../../../shared/session-contracts";
import type {
  SessionWorkspacePanelContext,
  SessionWorkspacePanels,
} from "./SessionWorkspacePage";

type LoadState<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; error: string };

interface OverviewData {
  identity: SessionIdentityDetail | undefined;
  interfaces: SessionNetworkInterface[];
  connections: SessionNetworkConnection[];
}

interface RegistryEntry {
  id: string;
  kind: "key" | "value";
  name: string;
}

const REGISTRY_HIVES: readonly SessionRegistryHive[] = ["HKCU", "HKLM", "HKCR", "HKU", "HKCC"];

export const defaultSessionWorkspacePanels: SessionWorkspacePanels = {
  overview: (context) => <SessionOverviewPanel {...context} />,
  files: (context) => <SessionFilesPanel {...context} />,
  processes: (context) => <SessionProcessesPanel {...context} />,
  environment: (context) => <SessionEnvironmentPanel {...context} />,
  registry: (context) => <SessionRegistryPanel {...context} />,
};

export function SessionOverviewPanel({ route, session }: SessionWorkspacePanelContext): React.JSX.Element {
  const routeKey = workspaceRouteKey(route);
  const platform = normalizedPlatform(session.os);
  const [state, setState] = useState<LoadState<OverviewData>>({ status: "loading" });
  const [screenshot, setScreenshot] = useState<SessionCapturedArtifactResult>();
  const [isScreenshotSaved, setIsScreenshotSaved] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isSavingScreenshot, setIsSavingScreenshot] = useState(false);
  const isCurrent = useLatestIdentity(routeKey);

  const load = useCallback(async () => {
    const expected = routeKey;
    setState({ status: "loading" });
    try {
      const [interfaces, connections, identity] = await Promise.all([
        runWorkbench({ operationId: "session.network.interfaces", limit: 100 }),
        runWorkbench({
          operationId: "session.network.connections",
          tcp: true,
          udp: true,
          ip4: true,
          ip6: true,
          listening: false,
          limit: 100,
        }),
        platform === "windows"
          ? runWorkbench({ operationId: "session.identity.current-token-owner" })
          : Promise.resolve(undefined),
      ]);
      if (!isCurrent(expected)) return;
      setState({
        status: "ready",
        value: { identity, interfaces: interfaces.items, connections: connections.items },
      });
    } catch (error) {
      if (isCurrent(expected)) setState({ status: "error", error: errorMessage(error) });
    }
  }, [isCurrent, platform, routeKey]);

  useEffect(() => {
    setScreenshot(undefined);
    setIsScreenshotSaved(false);
    void load();
  }, [load, routeKey]);

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

  const connectionRows = useMemo(
    () => state.status === "ready"
      ? state.value.connections.map((connection, index) => ({ connection, id: networkConnectionKey(connection, index) }))
      : [],
    [state],
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
    <div className="flex min-w-0 flex-col gap-6">
      <PanelShell
        icon={faShieldHalved}
        title="Identity"
        description="Read-only session identity reported by the active implant."
        action={<RefreshButton label="Refresh overview" pending={state.status === "loading"} onPress={() => void load()} />}
      >
        {state.status === "loading" ? <PanelLoading label="Loading session overview" /> : null}
        {state.status === "error" ? <PanelError message={state.error} onRetry={() => void load()} /> : null}
        {state.status === "ready" ? (
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
            <Detail label="Host" value={state.value.identity?.hostname || session.hostname || "Not reported"} />
            <Detail label="User" value={state.value.identity?.username || session.username || "Not reported"} />
            <Detail label="Token owner" value={state.value.identity?.tokenOwner || (platform === "windows" ? "Not reported" : "Windows only")} />
            <Detail label="UID / GID" value={[state.value.identity?.uid ?? session.uid, state.value.identity?.gid ?? session.gid].filter(Boolean).join(" / ") || "Not reported"} mono />
            <Detail label="Executable" value={state.value.identity?.executable || session.executable || "Not reported"} mono />
            <Detail label="Platform" value={`${state.value.identity?.os || session.os || "unknown"}/${state.value.identity?.arch || session.arch || "unknown"}`} mono />
            <Detail label="Remote address" value={session.remoteAddress || "Not reported"} mono />
            <Detail label="Active C2" value={session.activeC2 || "Not reported"} mono />
            <Detail label="Transport" value={session.transport.toUpperCase()} />
          </dl>
        ) : null}
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

      <PanelShell icon={faNetworkWired} title="Network" description="Bounded interfaces and current socket inventory.">
        {state.status === "loading" ? <PanelLoading label="Loading network inventory" /> : null}
        {state.status === "error" ? <PanelError message={state.error} onRetry={() => void load()} /> : null}
        {state.status === "ready" ? (
          <div className="flex min-w-0 flex-col gap-5">
            {state.value.interfaces.length > 0 ? (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {state.value.interfaces.map((item) => (
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
          </div>
        ) : null}
      </PanelShell>
    </div>
  );
}

export function SessionFilesPanel({ route, session }: SessionWorkspacePanelContext): React.JSX.Element {
  const routeKey = workspaceRouteKey(route);
  const platform = normalizedPlatform(session.os);
  const isWindows = platform === "windows";
  const [state, setState] = useState<LoadState<SessionDirectoryListing>>({ status: "loading" });
  const [currentPath, setCurrentPath] = useState("");
  const [pathDraft, setPathDraft] = useState("");
  const [folderName, setFolderName] = useState("");
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [busyFile, setBusyFile] = useState<string>();
  const isCurrent = useLatestIdentity(routeKey);
  const destructive = useDestructiveAction(routeKey, () => currentPath && void loadPath(currentPath));

  const loadPath = useCallback(async (path: string, cursor?: string) => {
    const expected = routeKey;
    setState((current) => cursor && current.status === "ready" ? current : { status: "loading" });
    try {
      const listing = await runWorkbench({
        operationId: "session.filesystem.ls",
        path,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!isCurrent(expected)) return;
      setCurrentPath(listing.path);
      setPathDraft(listing.path);
      setState((current) => cursor && current.status === "ready"
        ? { status: "ready", value: { ...listing, items: uniqueFiles([...current.value.items, ...listing.items]) } }
        : { status: "ready", value: listing });
    } catch (error) {
      if (isCurrent(expected)) setState({ status: "error", error: errorMessage(error) });
    }
  }, [isCurrent, routeKey]);

  useEffect(() => {
    const expected = routeKey;
    setCurrentPath("");
    setPathDraft("");
    setState({ status: "loading" });
    void runWorkbench({ operationId: "session.filesystem.pwd" }).then(
      (result) => {
        if (isCurrent(expected)) void loadPath(result.path);
      },
      (error: unknown) => {
        if (isCurrent(expected)) setState({ status: "error", error: errorMessage(error) });
      },
    );
  }, [isCurrent, loadPath, routeKey]);

  const createFolder = useCallback(async () => {
    const name = folderName.trim();
    if (!name || !currentPath) return;
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
  }, [currentPath, folderName, isCurrent, isWindows, loadPath, routeKey]);

  const upload = useCallback(async () => {
    if (!currentPath) return;
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
  }, [currentPath, isCurrent, loadPath, routeKey]);

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
      minWidth: 150,
      cell: (file) => (
        <div className="flex justify-end gap-1">
          {file.isDirectory ? (
            <IconButton label={`Open ${file.name}`} icon={faArrowRight} onPress={() => void loadPath(file.path)} />
          ) : (
            <IconButton isPending={busyFile === file.path} label={`Download ${file.name}`} icon={faDownload} onPress={() => void download(file)} />
          )}
          <IconButton
            danger
            label={`Delete ${file.name}`}
            icon={faTrash}
            onPress={() => void destructive.prepare({
              actionId: "session.filesystem.rm",
              path: file.path,
              recursive: file.isDirectory,
              force: false,
            })}
          />
        </div>
      ),
    },
  ], [busyFile, destructive, download, loadPath]);

  const crumbs = pathBreadcrumbs(currentPath, isWindows);

  return (
    <>
      <PanelShell
        icon={faFolder}
        title="Files"
        description="Browse bounded directory results. Native file dialogs remain owned by the main process."
        action={(
          <div className="flex items-center gap-2">
            <Button isDisabled={!currentPath} isPending={isUploading} size="sm" variant="secondary" onPress={() => void upload()}>
              <FontAwesomeIcon aria-hidden icon={faUpload} /> Upload
            </Button>
            <RefreshButton label="Refresh directory" pending={state.status === "loading"} onPress={() => currentPath && void loadPath(currentPath)} />
          </div>
        )}
      >
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <TextField className="min-w-0 flex-1" value={pathDraft} variant="secondary" onChange={setPathDraft}>
              <Label>Remote path</Label>
              <Input className="font-mono text-xs" placeholder={isWindows ? "C:\\" : "/"} />
            </TextField>
            <Button isDisabled={!pathDraft.trim()} size="sm" onPress={() => void loadPath(pathDraft.trim())}>Go</Button>
          </div>
          {crumbs.length > 0 ? (
            <Breadcrumbs aria-label="Remote filesystem path" onAction={(key) => void loadPath(String(key))}>
              {crumbs.map((crumb) => <Breadcrumbs.Item id={crumb.path} key={crumb.path}>{crumb.label}</Breadcrumbs.Item>)}
            </Breadcrumbs>
          ) : null}
          <div className="flex flex-col gap-3 rounded-xl border border-separator bg-default p-3 sm:flex-row sm:items-end">
            <TextField className="min-w-0 flex-1" value={folderName} variant="secondary" onChange={setFolderName}>
              <Label>New folder name</Label>
              <Input placeholder="Folder name" />
            </TextField>
            <Button isDisabled={!currentPath || !folderName.trim()} isPending={isCreatingFolder} size="sm" variant="secondary" onPress={() => void createFolder()}>
              <FontAwesomeIcon aria-hidden icon={faFolderPlus} /> New folder
            </Button>
          </div>
          {state.status === "loading" ? <PanelLoading label="Loading directory" /> : null}
          {state.status === "error" ? <PanelError message={state.error} onRetry={() => currentPath && void loadPath(currentPath)} /> : null}
          {state.status === "ready" ? (
            <>
              <DataGrid
                aria-label={`Files in ${state.value.path}`}
                columns={columns}
                contentClassName="min-w-[900px]"
                data={state.value.items}
                getRowId={(file) => file.path}
                scrollContainerClassName="max-h-[560px] overflow-auto"
                variant="secondary"
                onRowAction={(key) => {
                  const file = state.value.items.find((candidate) => candidate.path === String(key));
                  if (file?.isDirectory) void loadPath(file.path);
                }}
                renderEmptyState={() => <GridEmpty label="This directory is empty." />}
              />
              {state.value.page.nextCursor ? (
                <div className="flex justify-center">
                  <Button size="sm" variant="tertiary" onPress={() => void loadPath(state.value.path, state.value.page.nextCursor)}>Load more</Button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PanelShell>
      <DestructiveActionDialog action={destructive} />
    </>
  );
}

export function SessionProcessesPanel({ route, session }: SessionWorkspacePanelContext): React.JSX.Element {
  const routeKey = workspaceRouteKey(route);
  const platform = normalizedPlatform(session.os);
  const isWindows = platform === "windows";
  const [section, setSection] = useState<"processes" | "services">("processes");
  const [query, setQuery] = useState("");
  const [processes, setProcesses] = useState<LoadState<SessionBoundedPage<SessionProcess>>>({ status: "loading" });
  const [services, setServices] = useState<LoadState<SessionBoundedPage<SessionService>>>({ status: "loading" });
  const [selectedProcess, setSelectedProcess] = useState<SessionProcess>();
  const [selectedService, setSelectedService] = useState<SessionService>();
  const [busyProcess, setBusyProcess] = useState<number>();
  const [busyService, setBusyService] = useState<string>();
  const isCurrent = useLatestIdentity(routeKey);

  const loadProcesses = useCallback(async () => {
    const expected = routeKey;
    setProcesses({ status: "loading" });
    try {
      const result = await runWorkbench({ operationId: "session.process.list", fullInfo: true, limit: 100 });
      if (isCurrent(expected)) setProcesses({ status: "ready", value: result });
    } catch (error) {
      if (isCurrent(expected)) setProcesses({ status: "error", error: errorMessage(error) });
    }
  }, [isCurrent, routeKey]);

  const loadServices = useCallback(async () => {
    if (!isWindows) return;
    const expected = routeKey;
    setServices({ status: "loading" });
    try {
      const result = await runWorkbench({ operationId: "session.service.list", limit: 100 });
      if (isCurrent(expected)) setServices({ status: "ready", value: result });
    } catch (error) {
      if (isCurrent(expected)) setServices({ status: "error", error: errorMessage(error) });
    }
  }, [isCurrent, isWindows, routeKey]);

  useEffect(() => {
    setSection("processes");
    setQuery("");
    setSelectedProcess(undefined);
    setSelectedService(undefined);
    void loadProcesses();
  }, [loadProcesses, routeKey]);

  useEffect(() => {
    if (section === "services" && isWindows && services.status === "loading") void loadServices();
  }, [isWindows, loadServices, section, services.status]);

  const destructive = useDestructiveAction(routeKey, () => {
    if (section === "services") void loadServices();
    else void loadProcesses();
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
    setBusyService(service.name);
    try {
      const detail = await runWorkbench({ operationId: "session.service.detail", name: service.name });
      if (isCurrent(expected)) setSelectedService(detail);
    } catch (error) {
      if (isCurrent(expected)) toast.danger("Could not load service", { description: errorMessage(error) });
    } finally {
      if (isCurrent(expected)) setBusyService(undefined);
    }
  }, [isCurrent, routeKey]);

  const startService = useCallback(async (service: SessionService) => {
    const expected = routeKey;
    setBusyService(service.name);
    try {
      const result = await runWorkbench({ operationId: "session.service.start", name: service.name });
      if (!isCurrent(expected)) return;
      toast.success("Service start requested", { description: result.displayName || result.name });
      await loadServices();
    } catch (error) {
      if (isCurrent(expected)) notifyWorkbenchFailure("Could not start service", "Service outcome unknown", error);
    } finally {
      if (isCurrent(expected)) setBusyService(undefined);
    }
  }, [isCurrent, loadServices, routeKey]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredProcesses = useMemo(
    () => processes.status === "ready"
      ? processes.value.items.filter((process) => processMatchesQuery(process, normalizedQuery))
      : [],
    [normalizedQuery, processes],
  );
  const filteredServices = useMemo(
    () => services.status === "ready"
      ? services.value.items.filter((service) => serviceMatchesQuery(service, normalizedQuery))
      : [],
    [normalizedQuery, services],
  );

  const processColumns = useMemo<DataGridColumn<SessionProcess>[]>(() => [
    {
      id: "process",
      header: "Process",
      isRowHeader: true,
      minWidth: 240,
      cell: (process) => (
        <div className="min-w-0 py-1">
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
      minWidth: isWindows ? 140 : 90,
      cell: (process) => (
        <div className="flex justify-end gap-1">
          {isWindows ? (
            <IconButton isPending={busyProcess === process.pid} label={`Dump process ${process.pid}`} icon={faDownload} onPress={() => void dumpProcess(process)} />
          ) : null}
          <IconButton
            danger
            label={`Terminate process ${process.pid}`}
            icon={faStop}
            onPress={() => void destructive.prepare({ actionId: "session.process.terminate", pid: process.pid, force: false })}
          />
        </div>
      ),
    },
  ], [busyProcess, destructive, dumpProcess, isWindows]);

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
      minWidth: 150,
      cell: (service) => (
        <div className="flex justify-end gap-1">
          <IconButton isPending={busyService === service.name} label={`Start ${service.displayName || service.name}`} icon={faPlay} onPress={() => void startService(service)} />
          <IconButton danger label={`Stop ${service.displayName || service.name}`} icon={faStop} onPress={() => void destructive.prepare({ actionId: "session.service.stop", name: service.name })} />
        </div>
      ),
    },
  ], [busyService, destructive, startService]);

  const activeState = section === "services" ? services : processes;

  return (
    <>
      <PanelShell
        icon={faMicrochip}
        title="Processes"
        description="Inspect bounded process details and Windows service state."
        action={<RefreshButton label={`Refresh ${section}`} pending={activeState.status === "loading"} onPress={() => void (section === "services" ? loadServices() : loadProcesses())} />}
      >
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {isWindows ? (
              <Segment selectedKey={section} size="sm" onSelectionChange={(key) => setSection(String(key) as "processes" | "services")}>
                <Segment.Item id="processes">Processes</Segment.Item>
                <Segment.Item id="services">Services</Segment.Item>
              </Segment>
            ) : <span className="text-sm font-medium text-foreground">Processes</span>}
            <SearchField aria-label={`Filter ${section}`} className="w-full sm:max-w-sm" value={query} variant="secondary" onChange={setQuery}>
              <SearchField.Group>
                <SearchField.SearchIcon><FontAwesomeIcon aria-hidden icon={faMagnifyingGlass} /></SearchField.SearchIcon>
                <SearchField.Input placeholder={section === "services" ? "Filter service, account, or path" : "Filter process, owner, PID, or command"} />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
          </div>

          {section === "processes" ? (
            <>
              {processes.status === "loading" ? <PanelLoading label="Loading processes" /> : null}
              {processes.status === "error" ? <PanelError message={processes.error} onRetry={() => void loadProcesses()} /> : null}
              {processes.status === "ready" ? (
                <DataGrid
                  aria-label="Session processes"
                  columns={processColumns}
                  contentClassName="min-w-[850px]"
                  data={filteredProcesses}
                  getRowId={(process) => String(process.pid)}
                  scrollContainerClassName="max-h-[520px] overflow-auto"
                  variant="secondary"
                  onRowAction={(key) => setSelectedProcess(processes.value.items.find((process) => process.pid === Number(key)))}
                  renderEmptyState={() => <GridEmpty label={normalizedQuery ? "No processes match this filter." : "No processes were reported."} />}
                />
              ) : null}
              {selectedProcess ? <ProcessDetail process={selectedProcess} /> : null}
            </>
          ) : (
            <>
              {services.status === "loading" ? <PanelLoading label="Loading services" /> : null}
              {services.status === "error" ? <PanelError message={services.error} onRetry={() => void loadServices()} /> : null}
              {services.status === "ready" ? (
                <DataGrid
                  aria-label="Windows services"
                  columns={serviceColumns}
                  contentClassName="min-w-[760px]"
                  data={filteredServices}
                  getRowId={(service) => service.name}
                  scrollContainerClassName="max-h-[520px] overflow-auto"
                  variant="secondary"
                  onRowAction={(key) => {
                    const service = services.value.items.find((candidate) => candidate.name === String(key));
                    if (service) void openService(service);
                  }}
                  renderEmptyState={() => <GridEmpty label={normalizedQuery ? "No services match this filter." : "No services were reported."} />}
                />
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
  const isCurrent = useLatestIdentity(routeKey);

  const load = useCallback(async () => {
    const expected = routeKey;
    setState({ status: "loading" });
    try {
      const result = await runWorkbench({ operationId: "session.environment.list", limit: 500 });
      if (isCurrent(expected)) setState({ status: "ready", value: result });
    } catch (error) {
      if (isCurrent(expected)) setState({ status: "error", error: errorMessage(error) });
    }
  }, [isCurrent, routeKey]);

  useEffect(() => {
    setRevealed({});
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
    setRevealingName(name);
    try {
      const result = await runWorkbench({ operationId: "session.environment.reveal", name });
      if (isCurrent(expected)) setRevealed((current) => ({ ...current, [name]: result }));
    } catch (error) {
      if (isCurrent(expected)) toast.danger("Could not reveal value", { description: errorMessage(error) });
    } finally {
      if (isCurrent(expected)) setRevealingName(undefined);
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
  const [state, setState] = useState<LoadState<RegistryEntry[]>>({ status: "loading" });
  const [selectedValue, setSelectedValue] = useState<SessionRegistryReadResult>();
  const [isReading, setIsReading] = useState(false);
  const [isSavingHive, setIsSavingHive] = useState(false);
  const isCurrent = useLatestIdentity(routeKey);

  const load = useCallback(async (nextHive: SessionRegistryHive, nextPath: string) => {
    if (platform !== "windows") return;
    const expected = routeKey;
    setState({ status: "loading" });
    setSelectedValue(undefined);
    try {
      const [subkeys, values] = await Promise.all([
        runWorkbench({ operationId: "session.registry.list-subkeys", hive: nextHive, path: nextPath, limit: 500 }),
        runWorkbench({ operationId: "session.registry.list-values", hive: nextHive, path: nextPath, limit: 500 }),
      ]);
      if (!isCurrent(expected)) return;
      setHive(nextHive);
      setPath(nextPath);
      setPathDraft(nextPath);
      setState({
        status: "ready",
        value: [
          ...subkeys.items.map((name) => ({ id: `key:${name}`, kind: "key" as const, name })),
          ...values.items.map((name) => ({ id: `value:${name}`, kind: "value" as const, name })),
        ],
      });
    } catch (error) {
      if (isCurrent(expected)) setState({ status: "error", error: errorMessage(error) });
    }
  }, [isCurrent, platform, routeKey]);

  useEffect(() => {
    setHive("HKCU");
    setPath("");
    setPathDraft("");
    if (platform === "windows") void load("HKCU", "");
  }, [load, platform, routeKey]);

  const readValue = useCallback(async (key: string) => {
    const expected = routeKey;
    setIsReading(true);
    try {
      const result = await runWorkbench({ operationId: "session.registry.read", hive, path, key });
      if (isCurrent(expected)) setSelectedValue(result);
    } catch (error) {
      if (isCurrent(expected)) toast.danger("Could not read registry value", { description: errorMessage(error) });
    } finally {
      if (isCurrent(expected)) setIsReading(false);
    }
  }, [hive, isCurrent, path, routeKey]);

  const saveHive = useCallback(async () => {
    const expected = routeKey;
    setIsSavingHive(true);
    try {
      const requestedHive = path ? `${hive}\\${path}` : hive;
      const result = await runWorkbench({
        operationId: "session.registry.read-hive",
        rootHive: hive,
        requestedHive,
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
        <IconButton
          isPending={entry.kind === "value" && isReading}
          label={entry.kind === "key" ? `Open ${entry.name}` : `Read ${entry.name || "default value"}`}
          icon={entry.kind === "key" ? faArrowRight : faEye}
          onPress={() => entry.kind === "key"
            ? void load(hive, joinRegistryPath(path, entry.name))
            : void readValue(entry.name)}
        />
      ),
    },
  ], [hive, isReading, load, path, readValue]);

  if (platform !== "windows") {
    return <PanelUnavailable title="Registry unavailable" description="Registry browsing is available only for Windows sessions." />;
  }

  const crumbs = registryBreadcrumbs(hive, path);

  return (
    <PanelShell
      icon={faKey}
      title="Registry"
      description="Browse and read the active Windows session registry without exposing local filesystem paths."
      action={(
        <div className="flex items-center gap-2">
          <Button isPending={isSavingHive} size="sm" variant="secondary" onPress={() => void saveHive()}>
            <FontAwesomeIcon aria-hidden icon={faDownload} /> Save hive
          </Button>
          <RefreshButton label="Refresh registry" pending={state.status === "loading"} onPress={() => void load(hive, path)} />
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
          {crumbs.map((crumb) => <Breadcrumbs.Item id={crumb.id} key={crumb.id}>{crumb.label}</Breadcrumbs.Item>)}
        </Breadcrumbs>
        {state.status === "loading" ? <PanelLoading label="Loading registry" /> : null}
        {state.status === "error" ? <PanelError message={state.error} onRetry={() => void load(hive, path)} /> : null}
        {state.status === "ready" ? (
          <DataGrid
            aria-label={`Registry entries in ${hive} ${path}`}
            columns={columns}
            contentClassName="min-w-[620px]"
            data={state.value}
            getRowId={(entry) => entry.id}
            scrollContainerClassName="max-h-[520px] overflow-auto"
            variant="secondary"
            onRowAction={(key) => {
              const entry = state.value.find((candidate) => candidate.id === String(key));
              if (!entry) return;
              if (entry.kind === "key") void load(hive, joinRegistryPath(path, entry.name));
              else void readValue(entry.name);
            }}
            renderEmptyState={() => <GridEmpty label="This registry key has no visible subkeys or values." />}
          />
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
  const isCurrent = useLatestIdentity(routeKey);
  const onSucceededRef = useRef(onSucceeded);
  onSucceededRef.current = onSucceeded;

  useEffect(() => {
    setPlan(undefined);
    setIsPreparing(false);
    setIsExecuting(false);
  }, [routeKey]);

  const prepare = useCallback(async (input: PrepareSessionDestructiveActionInput) => {
    const expected = routeKey;
    setIsPreparing(true);
    try {
      const result = await window.sliver.prepareSessionDestructiveAction(input);
      if (!isCurrent(expected)) return;
      if (!result.ok || !result.value) throw new Error(result.error ?? "The action could not be reviewed");
      if (result.value.status === "canceled") {
        toast.info("Action canceled");
        return;
      }
      setPlan(result.value.plan);
    } catch (error) {
      if (isCurrent(expected)) toast.danger("Could not review action", { description: errorMessage(error) });
    } finally {
      if (isCurrent(expected)) setIsPreparing(false);
    }
  }, [isCurrent, routeKey]);

  const execute = useCallback(async () => {
    if (!plan) return;
    const expected = routeKey;
    setIsExecuting(true);
    try {
      const result = await window.sliver.executeSessionDestructiveActionPlan({ token: plan.token });
      if (!isCurrent(expected)) return;
      if (!result.ok || !result.value) throw new Error(result.error ?? "The reviewed action failed");
      announceDestructiveOutcome(result.value);
      if (result.value.status === "succeeded") onSucceededRef.current?.();
      setPlan(undefined);
    } catch (error) {
      if (isCurrent(expected)) toast.danger("Action failed", { description: errorMessage(error) });
    } finally {
      if (isCurrent(expected)) setIsExecuting(false);
    }
  }, [isCurrent, plan, routeKey]);

  return {
    plan,
    isPreparing,
    isExecuting,
    prepare,
    execute,
    dismiss: () => {
      if (!isExecuting) setPlan(undefined);
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
                </div>
                <p className="leading-relaxed text-danger-soft-foreground">{plan.warning}</p>
                <ActionImpact action={plan.action} />
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
                  <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground">
                    Native file: {plan.artifact.suggestedBasename} · {formatBytes(plan.artifact.size)}
                  </p>
                ) : null}
                <p className="text-xs leading-relaxed text-muted">
                  Main-issued plan expires at {formatTime(plan.expiresAt)}. Any target, backend, or payload change invalidates it.
                </p>
              </div>
            ) : null}
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button isDisabled={action.isExecuting} size="sm" variant="tertiary" onPress={action.dismiss}>Cancel</Button>
            <Button isPending={action.isExecuting} size="sm" variant="danger" onPress={() => void action.execute()}>
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
    <div aria-busy="true" className="flex min-h-48 items-center justify-center gap-3 text-sm text-muted">
      <FontAwesomeIcon aria-hidden className="animate-spin" icon={faCircleNotch} /> {label}…
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

function RefreshButton({ label, pending, onPress }: { label: string; pending: boolean; onPress: () => void }): React.JSX.Element {
  return <IconButton isPending={pending} label={label} icon={faRotate} onPress={onPress} />;
}

function IconButton({
  label,
  icon,
  danger = false,
  isPending = false,
  onPress,
}: {
  label: string;
  icon: Parameters<typeof FontAwesomeIcon>[0]["icon"];
  danger?: boolean;
  isPending?: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Tooltip delay={250}>
      <Button
        aria-label={label}
        isIconOnly
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
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</dt>
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
      <p className="mt-4 text-[11px] font-medium uppercase tracking-wide text-muted">Command line</p>
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
        <Detail label="Startup type" value={String(service.startupType)} mono />
        <Detail label="Binary path" value={service.binaryPath || "Not reported"} mono />
        <Detail label="Message" value={service.message || "None"} />
      </dl>
    </section>
  );
}

function ServiceStatus({ status }: { status: number }): React.JSX.Element {
  const label = status === 4 ? "Running" : status === 1 ? "Stopped" : `State ${status}`;
  const color = status === 4 ? "success" : status === 1 ? "default" : "warning";
  return <Chip color={color} size="sm" variant="soft">{label}</Chip>;
}

function ActionImpact({ action }: { action: PrepareSessionDestructiveActionInput }): React.JSX.Element {
  const details = destructiveActionDetails(action);
  return (
    <dl className="grid gap-2 rounded-xl border border-separator bg-default px-3 py-2.5 text-xs">
      {details.map(([label, value]) => (
        <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-3" key={label}>
          <dt className="text-muted">{label}</dt>
          <dd className="break-all font-mono text-foreground">{value}</dd>
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
  return `${route.backendEpoch}:${route.connectionIncarnation}:${route.sessionId}`;
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

function processMatchesQuery(process: SessionProcess, query: string): boolean {
  if (!query) return true;
  return [process.executable, process.owner, process.architecture, String(process.pid), ...process.commandLine]
    .some((value) => value.toLocaleLowerCase().includes(query));
}

function serviceMatchesQuery(service: SessionService, query: string): boolean {
  if (!query) return true;
  return [service.name, service.displayName, service.description, service.account, service.binaryPath]
    .some((value) => value.toLocaleLowerCase().includes(query));
}

function uniqueFiles(files: SessionFileEntry[]): SessionFileEntry[] {
  return [...new Map(files.map((file) => [file.path, file])).values()];
}

function joinRemotePath(parent: string, child: string, windows: boolean): string {
  const separator = windows ? "\\" : "/";
  return parent.endsWith("/") || parent.endsWith("\\") ? `${parent}${child}` : `${parent}${separator}${child}`;
}

function pathBreadcrumbs(path: string, windows: boolean): Array<{ label: string; path: string }> {
  if (!path) return [];
  if (windows) {
    const normalized = path.replaceAll("/", "\\");
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
    case "session.process.terminate": return `Terminate process ${action.pid}?`;
    case "session.service.stop": return `Stop service ${action.name}?`;
    case "session.filesystem.upload-overwrite": return "Overwrite this remote file?";
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
    case "session.registry.write": return [["Location", `${action.hive}\\${action.path}`], ["Value", action.key]];
    case "session.registry.create-key":
    case "session.registry.delete-key": return [["Location", `${action.hive}\\${action.path}`], ["Key", action.key]];
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
