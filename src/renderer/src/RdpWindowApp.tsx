import { createRef, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Button, Chip, FieldError, Input, Label, Modal, Tabs, TextField, Tooltip, toast } from "@heroui/react";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { NativeSelect } from "@heroui-pro/react/native-select";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowsRotate, faDesktop, faDownload, faExpand, faFileImport, faFolderOpen, faGear, faKey, faPlus, faPowerOff, faShieldHalved, faUpload, faXmark } from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import type { RdpConnectInput, RdpCredentialPersistence, RdpImportResult, RdpProfile, RdpScaleMode, RdpWindowState } from "../../shared/rdp-contracts";
import type { OperationResult } from "../../shared/contracts";
import { parseRdpProxyPassword } from "../../shared/rdp-validation";
import { AuxiliaryWindowFrame } from "./components/AuxiliaryWindowFrame";
import { RenamableTab } from "./components/RenamableTab";
import { RenameTabDialog } from "./components/RenameTabDialog";
import { SwitchRow } from "./components/FormControls";
import { useApplicationSettings } from "./components/ApplicationSettingsProvider";
import { RdpConnectDialog } from "./components/rdp/RdpConnectDialog";
import { RdpProfileGrid } from "./components/rdp/RdpProfileGrid";
import { RdpProfileDropZone } from "./components/rdp/RdpProfileDropZone";
import { RdpProfilePasswordDialog } from "./components/rdp/RdpProfilePasswordDialog";
import { RdpFileTransferToasts } from "./components/rdp/RdpFileTransferToasts";
import { phaseLabel, RdpDesktop, type RdpDesktopHandle } from "./components/rdp/RdpDesktop";
import "./components/rdp/rdp.css";

const EMPTY_STATE: RdpWindowState = { tabs: [], profiles: [], securePersistenceAvailable: false, maxSessions: 4 };

export function RdpWindowApp(): React.JSX.Element {
  const api = window.rdp;
  const applicationSettings = useApplicationSettings();
  const [state, setState] = useState<RdpWindowState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [connectOpen, setConnectOpen] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState<RdpProfile>();
  const [passwordProfile, setPasswordProfile] = useState<RdpProfile>();
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [importSummary, setImportSummary] = useState<RdpImportResult>();
  const [queuedImports, setQueuedImports] = useState<readonly RdpImportResult[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renameId, setRenameId] = useState<string>();
  const [renameName, setRenameName] = useState("");
  const [reconnectId, setReconnectId] = useState<string>();
  const [reconnectPassword, setReconnectPassword] = useState("");
  const [reconnectProxyPassword, setReconnectProxyPassword] = useState("");
  const [reconnectProxyError, setReconnectProxyError] = useState<string>();
  const [pending, setPending] = useState<string>();
  const [deleteProfile, setDeleteProfile] = useState<RdpProfile>();
  const [scaleModes, setScaleModes] = useState<Readonly<Record<string, RdpScaleMode>>>({});
  const [autoResize, setAutoResize] = useState(false);
  const [highDpi, setHighDpi] = useState(false);
  const stateEvents = useRef(0);
  const latestState = useRef(state);
  const pendingRef = useRef(false);
  const refs = useRef(new Map<string, RefObject<RdpDesktopHandle | null>>());
  const warnedTabs = useRef(new Map<string, { attempt: number; message: string }>());
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0];
  const reviewTab = state.tabs.find((tab) => tab.review !== undefined);
  const review = reviewTab?.review;
  const temporaryConnection = state.pendingConnection;
  const reconnectTab = state.tabs.find((tab) => tab.id === reconnectId);
  const reconnectNeedsProxyPassword = reconnectTab?.networking?.kind === "socks5-manual" && Boolean(reconnectTab.networking.username);
  const modalOpen = connectOpen || profilesOpen || settingsOpen || Boolean(importSummary || temporaryConnection || renameId || reconnectId || review || deleteProfile || passwordProfile);

  const acceptState = useCallback((next: RdpWindowState): void => {
    const previous = latestState.current;
    const merged = { ...next, tabs: next.tabs.map((tab) => {
      const current = previous.tabs.find((item) => item.id === tab.id && item.attempt === tab.attempt)?.fileTransfer;
      const incoming = tab.fileTransfer;
      if (!current) return tab;
      // Compact progress can arrive while a full snapshot is being read. Keep
      // one transfer monotonic without carrying progress into a new attempt.
      if (!incoming || (incoming.id === current.id && (
        current.phase === "completed" || current.phase === "failed" || current.phase === "canceled" ||
        (current.phase === "transferring" && incoming.phase === "preparing") ||
        incoming.transferredBytes < current.transferredBytes || incoming.completedFiles < current.completedFiles
      ))) return { ...tab, fileTransfer: current };
      return tab;
    }) };
    latestState.current = merged;
    setState(merged);
  }, []);

  const reportError = useCallback((message: string): void => {
    setError(message);
    toast.danger("Remote Desktop action failed", { description: message });
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!api) return;
    const events = stateEvents.current;
    try {
      const result = await api.getState();
      if (!result.ok) reportError(result.error);
      else if (events === stateEvents.current) acceptState(result.value);
    } catch { reportError("Remote Desktop state could not be refreshed."); }
  }, [api, reportError, acceptState]);

  const presentImportResult = useCallback((result: RdpImportResult): void => {
    if (result.canceled || !result.items.length) return;
    for (const desktop of refs.current.values()) desktop.current?.release();
    const imported = result.items.filter((item) => item.profile).length;
    if (result.items.some((item) => item.error || item.warnings.length)) {
      setProfilesOpen(false); setImportSummary(result);
    } else {
      toast.success(`${imported} ${imported === 1 ? "profile" : "profiles"} imported`);
      if (latestState.current.tabs.length) setProfilesOpen(true);
    }
  }, []);

  useEffect(() => {
    if (!api) { reportError("Remote Desktop is unavailable in this window."); setLoading(false); return; }
    let mounted = true;
    let receivedEvent = false;
    const remove = api.onStateChanged((next) => { if (mounted) { stateEvents.current += 1; receivedEvent = true; acceptState(next); setLoading(false); } });
    const removeProgress = api.onFileTransferProgress((event) => {
      const current = latestState.current;
      if (!mounted || !current.tabs.some((tab) => tab.id === event.tabId && tab.attempt === event.attempt)) return;
      stateEvents.current += 1;
      receivedEvent = true;
      acceptState({ ...current, tabs: current.tabs.map((tab) => tab.id === event.tabId && tab.attempt === event.attempt
        ? { ...tab, fileTransfer: event.progress } : tab) });
    });
    // Register before getState: main flushes imports queued during an OS launch
    // once this window requests its initial state.
    const removeImports = api.onProfilesImported?.((result) => {
      if (!mounted) return;
      setQueuedImports((current) => [...current, result]);
      void refresh();
    });
    void api.getState().then((result) => {
      if (!mounted) return;
      if (!result.ok) reportError(result.error);
      else if (!receivedEvent) acceptState(result.value);
      setLoading(false);
    }).catch(() => { if (mounted) { reportError("Remote Desktop could not be initialized."); setLoading(false); } });
    return () => { mounted = false; remove(); removeProgress(); removeImports?.(); };
  }, [api, reportError, acceptState, refresh]);

  useEffect(() => {
    if (loading || pending || modalOpen || !queuedImports.length) return;
    presentImportResult(queuedImports[0]!);
    setQueuedImports((current) => current.slice(1));
  }, [loading, pending, modalOpen, queuedImports, presentImportResult]);

  useEffect(() => {
    for (const [id, previous] of warnedTabs.current) {
      if (!state.tabs.some((tab) => tab.id === id && tab.attempt === previous.attempt && tab.error === previous.message)) warnedTabs.current.delete(id);
    }
    if (activeTab?.state !== "active" || !activeTab.error) return;
    const previous = warnedTabs.current.get(activeTab.id);
    if (previous?.attempt === activeTab.attempt && previous.message === activeTab.error) return;
    warnedTabs.current.set(activeTab.id, { attempt: activeTab.attempt, message: activeTab.error });
    toast.warning("Remote Desktop warning", { description: activeTab.error });
  }, [activeTab, state.tabs]);

  useEffect(() => {
    document.title = activeTab ? `Remote Desktop — ${activeTab.label}` : "Remote Desktop";
    const present = new Set(state.tabs.map(({ id }) => id));
    for (const id of refs.current.keys()) if (!present.has(id)) refs.current.delete(id);
  }, [activeTab, state.tabs]);

  useEffect(() => {
    if (!temporaryConnection) return;
    for (const desktop of refs.current.values()) desktop.current?.release();
    setConnectOpen(false); setSelectedProfile(undefined); setProfilesOpen(false); setSettingsOpen(false);
    setPasswordProfile(undefined); setReconnectId(undefined); setReconnectPassword(""); setReconnectProxyPassword(""); setReconnectProxyError(undefined);
    setRenameId(undefined); setDeleteProfile(undefined); setError(undefined);
    setImportSummary(undefined);
  }, [temporaryConnection?.id]);

  const act = useCallback(async (key: string, operation: () => Promise<OperationResult | OperationResult<unknown>>, success?: () => void, errorHandled?: () => boolean): Promise<boolean> => {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(key); setError(undefined);
    try {
      const result = await operation();
      if (!result.ok) throw new Error(result.error);
      success?.();
      await refresh();
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The remote desktop action failed.";
      if (errorHandled?.()) setError(message); else reportError(message);
      return false;
    }
    finally { pendingRef.current = false; setPending(undefined); }
  }, [refresh, reportError]);

  const transferClipboard = (direction: "send" | "receive"): void => {
    if (!activeTab || !api) return;
    const tabId = activeTab.id;
    const previousTransfer = latestState.current.tabs.find((tab) => tab.id === tabId)?.fileTransfer?.id;
    const receivingFiles = direction === "receive" && activeTab.clipboardFilesAvailable;
    const hasTransferNotice = (): boolean => {
      const progress = latestState.current.tabs.find((tab) => tab.id === tabId)?.fileTransfer;
      return progress?.direction === direction && progress.id !== previousTransfer;
    };
    void act(`clipboard-${direction}`, () => api.clipboard({ tabId, direction }), () => {
      if (direction === "send" && !hasTransferNotice()) toast.success("Clipboard ready to paste on the remote desktop.");
      else if (!receivingFiles && !hasTransferNotice()) toast.success("Remote content copied to the clipboard.");
    }, hasTransferNotice);
  };

  const newConnection = (profile?: RdpProfile): void => {
    activeTab && refs.current.get(activeTab.id)?.current?.release();
    setSelectedProfile(profile); setProfilesOpen(false); setConnectOpen(true); setError(undefined);
  };
  const connectProfile = async (profile: RdpProfile, password?: string, persistence: RdpCredentialPersistence = profile.credentialPersistence): Promise<void> => {
    if (!api || pendingRef.current || state.tabs.length >= state.maxSessions) return;
    if (activeTab) refs.current.get(activeTab.id)?.current?.release();
    setProfilesOpen(false);
    await act("connect-profile", () => {
      const remoteScreen = profile.signInMode === "remote-screen";
      const input: RdpConnectInput = {
        profileId: profile.id, label: profile.label, host: profile.host, port: profile.port,
        username: remoteScreen ? "" : profile.username, domain: remoteScreen ? "" : profile.domain, width: profile.width, height: profile.height,
        clipboard: profile.clipboard, scaleMode: profile.scaleMode, persistence: remoteScreen ? "none" : persistence,
        ...(profile.networking ? { networking: profile.networking } : {}),
        ...(remoteScreen ? { signInMode: "remote-screen" as const } : password === undefined ? {} : { password }),
      };
      try { return api.connect(input); }
      finally { delete (input as { password?: string }).password; }
    }, () => setPasswordProfile(undefined));
  };
  const openProfile = (profile: RdpProfile): void => {
    if (!api || pendingRef.current || state.tabs.length >= state.maxSessions) return;
    const route = profile.networking;
    if ((profile.signInMode !== "remote-screen" && !profile.username.trim()) ||
      (route?.kind === "socks5-manual" && route.username) ||
      (route?.kind === "socks5" && !state.socks5Proxies?.some((proxy) => proxy.id === route.proxyId && proxy.available))) {
      newConnection(profile); return;
    }
    if (profile.signInMode === "remote-screen" || (profile.hasCredential && (profile.credentialPersistence !== "secure" || state.securePersistenceAvailable))) {
      void connectProfile(profile); return;
    }
    if (activeTab) refs.current.get(activeTab.id)?.current?.release();
    setProfilesOpen(false); setError(undefined); setPasswordProfile(profile);
  };
  const selectTab = (id: string): void => {
    if (!api || id === activeTab?.id) return;
    if (activeTab) refs.current.get(activeTab.id)?.current?.release();
    setState((current) => ({ ...current, activeTabId: id }));
    void api.selectTab(id).then((result) => { if (!result.ok) reportError(result.error); }).catch(() => reportError("The tab could not be selected."));
  };
  const liveCount = state.tabs.filter(({ state: phase }) => phase !== "disconnected" && phase !== "failed").length;
  const activeHandle = (): RdpDesktopHandle | null | undefined => activeTab ? refs.current.get(activeTab.id)?.current : undefined;
  const activeConnected = activeTab?.state === "active";
  const scaleMode = activeTab ? scaleModes[activeTab.id] ?? activeTab.scaleMode : "fit";
  const reconnect = (): void => {
    if (!activeTab || !api || activeTab.temporary) return;
    setError(undefined); setReconnectPassword(""); setReconnectProxyPassword(""); setReconnectProxyError(undefined);
    if (activeTab.signInMode === "remote-screen" && !(activeTab.networking?.kind === "socks5-manual" && activeTab.networking.username)) void act("reconnect", () => api.reconnect({ tabId: activeTab.id }));
    else setReconnectId(activeTab.id);
  };
  const closeReconnect = (): void => {
    if (pendingRef.current) return;
    setReconnectId(undefined); setReconnectPassword(""); setReconnectProxyPassword(""); setReconnectProxyError(undefined);
  };
  const submitReconnect = (): void => {
    if (!api || !reconnectTab || pendingRef.current) return;
    let proxyPassword: string | undefined;
    try { proxyPassword = parseRdpProxyPassword(reconnectNeedsProxyPassword ? reconnectProxyPassword : undefined, reconnectTab.networking); }
    catch (cause) { setReconnectProxyError(cause instanceof Error ? cause.message : "Enter the proxy password."); return; }
    setReconnectProxyError(undefined);
    const input = { tabId: reconnectTab.id, ...(reconnectTab.signInMode !== "remote-screen" && reconnectPassword ? { password: reconnectPassword } : {}),
      ...(proxyPassword === undefined ? {} : { proxyPassword }) };
    setReconnectPassword(""); setReconnectProxyPassword("");
    void act("reconnect", () => {
      try { return api.reconnect(input); }
      finally { delete input.password; delete input.proxyPassword; }
    }, () => setReconnectId(undefined));
  };
  const importProfiles = (files?: readonly File[]): void => {
    if (!api || pendingRef.current || temporaryConnection || connectOpen || importSummary) return;
    activeHandle()?.release();
    void act("import", async () => {
      const result = await (files ? api.importDroppedProfiles(files) : api.importProfiles());
      if (result.ok) presentImportResult(result.value);
      return result;
    });
  };
  const importDisabled = !api || loading || Boolean(pending || temporaryConnection || connectOpen || importSummary);

  const profiles = <RdpProfileDropZone disabled={importDisabled} pending={pending === "import"} onDropFiles={importProfiles}>
    <RdpProfileGrid profiles={state.profiles} tabs={state.tabs}
      disabled={Boolean(pending) || state.tabs.length >= state.maxSessions} onConnect={openProfile} onEdit={newConnection} onDelete={setDeleteProfile} />
    <p className="mt-4 text-xs text-muted">Drop .rdp files here to import saved connections.</p>
  </RdpProfileDropZone>;

  return <AuxiliaryWindowFrame ariaLabel="Remote Desktop" className="rdp-window">
    <RdpFileTransferToasts tabs={state.tabs} />
    <header className="rdp-toolbar">
      <div className="mr-auto flex items-center gap-2"><FontAwesomeIcon aria-hidden icon={faDesktop} className="text-muted" /><h1 className="text-sm font-semibold">Remote Desktop</h1></div>
      <Button size="sm" isDisabled={!api || loading || state.tabs.length >= state.maxSessions} onPress={() => newConnection()}><FontAwesomeIcon aria-hidden icon={faPlus} />New connection</Button>
      <Button size="sm" variant="secondary" isDisabled={importDisabled} isPending={pending === "import"} onPress={() => importProfiles()}><FontAwesomeIcon aria-hidden icon={faFileImport} />Import .rdp</Button>
      <IconButton label="Saved profiles" icon={faFolderOpen} disabled={!api || loading} onPress={() => setProfilesOpen(true)} />
      <IconButton label="Configuration" icon={faGear} disabled={!api || loading} onPress={() => setSettingsOpen(true)} />
    </header>
    {loading ? <div className="grid flex-1 place-items-center text-sm text-muted" role="status">Opening Remote Desktop…</div> : state.tabs.length === 0 ? <div className="min-h-0 flex-1 overflow-y-auto">
      {state.profiles.length === 0 ? <RdpProfileDropZone disabled={importDisabled} pending={pending === "import"} onDropFiles={importProfiles}><EmptyState className="mx-auto max-w-lg py-12"><EmptyState.Header><EmptyState.Media variant="icon"><FontAwesomeIcon aria-hidden icon={faDesktop} /></EmptyState.Media><EmptyState.Title>Your Windows desktops</EmptyState.Title><EmptyState.Description>Connect to a Windows computer or drop .rdp files here to import saved connections.</EmptyState.Description></EmptyState.Header>
        <EmptyState.Content><Button isDisabled={!api} onPress={() => newConnection()}>Connect to a computer</Button></EmptyState.Content>
      </EmptyState></RdpProfileDropZone> : <section className="rdp-profiles" aria-label="Saved profiles">
        <div className="rdp-profiles__heading"><h2 className="text-xl font-semibold">Saved Connections</h2><span className="text-sm tabular-nums text-muted">{state.profiles.length}</span></div>
        <p className="mb-6 text-sm text-muted">The last saved view of each desktop.</p>
        {profiles}
      </section>}
    </div> : <>
      <Tabs className="rdp-tabs" selectedKey={activeTab?.id ?? ""} onSelectionChange={(id) => selectTab(String(id))}>
        <Tabs.ListContainer className="rdp-tabs__bar"><Tabs.List aria-label="Remote desktop sessions" className="rdp-tabs__list">
          {state.tabs.map((tab) => <RenamableTab key={tab.id} id={tab.id} className="rdp-tabs__tab" ariaLabel={tab.label} onRename={(id) => { setRenameId(id); setRenameName(tab.label); }}>
            <span className="max-w-52 truncate">{tab.label}</span><span className="sr-only">{phaseLabel(tab.state)}</span><Tabs.Indicator />
          </RenamableTab>)}
        </Tabs.List></Tabs.ListContainer>
        {activeTab && <div className="rdp-toolbar" aria-label="Remote desktop controls">
          <Chip size="sm" color={activeTab.state === "active" ? "success" : activeTab.state === "failed" ? "danger" : "default"} variant="soft"><Chip.Label>{phaseLabel(activeTab.state)}</Chip.Label></Chip>
          <span className="mr-auto hidden truncate text-xs text-muted sm:block">{activeTab.temporary ? "Temporary connection" : `${activeTab.host}:${activeTab.port}`}</span>
          <NativeSelect className="w-28"><NativeSelect.Trigger aria-label="Desktop scale" value={scaleMode} onChange={(event) => setScaleModes((current) => ({ ...current, [activeTab.id]: event.target.value as RdpScaleMode }))}>
            <NativeSelect.Option value="fit">Fit</NativeSelect.Option><NativeSelect.Option value="actual">Actual size</NativeSelect.Option>
          </NativeSelect.Trigger></NativeSelect>
          <IconButton label="Send Ctrl+Alt+Delete" icon={faKey} disabled={!activeConnected} onPress={() => activeHandle()?.specialKey("ctrl-alt-delete")} />
          <IconButton label="Send Windows key" icon={faDesktop} disabled={!activeConnected} onPress={() => activeHandle()?.specialKey("windows")} />
          <IconButton label="Send clipboard" icon={faUpload} disabled={!activeConnected || !activeTab.clipboardReady || !activeTab.clipboard || Boolean(pending)} onPress={() => transferClipboard("send")} />
          <IconButton label="Receive clipboard" icon={faDownload} disabled={!activeConnected || !(activeTab.clipboardAvailable || activeTab.clipboardFilesAvailable) || !activeTab.clipboard || Boolean(pending)} onPress={() => transferClipboard("receive")} />
          <IconButton label="Toggle fullscreen" icon={faExpand} disabled={!api} onPress={() => { void act("fullscreen", () => api!.toggleFullscreen()); }} />
          {activeTab.state === "disconnected" || activeTab.state === "failed" ? !activeTab.temporary && <IconButton label="Reconnect" icon={faArrowsRotate} disabled={Boolean(pending)} onPress={reconnect} /> : <IconButton label={activeConnected ? "Disconnect" : "Cancel connection"} icon={faPowerOff} disabled={Boolean(pending)} onPress={() => { void act("disconnect", async () => { if (!activeTab.temporary) await activeHandle()?.savePreview(); return api!.disconnect(activeTab.id); }); }} />}
          <IconButton label="Close remote desktop tab" icon={faXmark} disabled={Boolean(pending)} onPress={() => { void act("close", async () => { if (!activeTab.temporary) await activeHandle()?.savePreview(); return api!.closeTab(activeTab.id); }); }} />
        </div>}
        <div className="rdp-tab-panels">
          {api && state.tabs.map((tab) => {
            let desktopRef = refs.current.get(tab.id);
            if (!desktopRef) { desktopRef = createRef<RdpDesktopHandle>(); refs.current.set(tab.id, desktopRef); }
            return <RdpDesktop key={`${tab.id}:${tab.attempt}`} ref={desktopRef} api={api} tab={tab} active={tab.id === activeTab?.id} inputEnabled={!modalOpen}
              scaleMode={scaleModes[tab.id] ?? tab.scaleMode} autoResize={autoResize} highDpi={highDpi} />;
          })}
        </div>
      </Tabs>
      <footer className="rdp-footer"><span>Click the desktop to control it. Ctrl+Alt+Escape releases keyboard input.</span><span>{liveCount}/{state.maxSessions} connected</span></footer>
    </>}
    {api && (connectOpen || temporaryConnection) && <RdpConnectDialog key={temporaryConnection?.id ?? selectedProfile?.id ?? "new"} api={api} initial={selectedProfile} temporary={temporaryConnection} socks5Proxies={state.socks5Proxies} socks5Sessions={state.socks5Sessions} securePersistenceAvailable={state.securePersistenceAvailable} onClose={() => { setConnectOpen(false); if (temporaryConnection) void refresh(); }} onProfileSaved={() => { void refresh(); }} onConnected={(id) => { setConnectOpen(false); void refresh(); void api.selectTab(id); }} />}
    {passwordProfile && <RdpProfilePasswordDialog key={passwordProfile.id} profile={passwordProfile}
      securePersistenceAvailable={state.securePersistenceAvailable} pending={Boolean(pending)} error={error}
      onClose={() => setPasswordProfile(undefined)} onConnect={(password, persistence) => { void connectProfile(passwordProfile, password, persistence); }} />}
    <Modal.Backdrop isOpen={profilesOpen && !deleteProfile} variant="blur" onOpenChange={setProfilesOpen}><Modal.Container size="lg"><Modal.Dialog className="rdp-profiles-dialog"><Modal.CloseTrigger /><Modal.Header><Modal.Heading>Saved Connections</Modal.Heading></Modal.Header><Modal.Body className="max-h-[65vh] overflow-y-auto">{profiles}</Modal.Body><Modal.Footer><Button variant="secondary" onPress={() => setProfilesOpen(false)}>Close</Button><Button variant="secondary" isDisabled={importDisabled} isPending={pending === "import"} onPress={() => importProfiles()}>Import .rdp</Button><Button isDisabled={state.tabs.length >= state.maxSessions} onPress={() => newConnection()}>New connection</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop>
    {importSummary && <Modal.Backdrop isOpen variant="blur" onOpenChange={(open) => { if (!open) setImportSummary(undefined); }}><Modal.Container size="md"><Modal.Dialog><Modal.CloseTrigger /><Modal.Header><Modal.Heading>RDP import results</Modal.Heading></Modal.Header>
      <Modal.Body className="grid max-h-[60vh] gap-4 overflow-y-auto">
        <p className="text-sm">{importSummary.items.filter((item) => item.profile).length} of {importSummary.items.length} profiles imported.</p>
        {importSummary.items.map((item, index) => <div key={index} className="grid gap-1 text-sm">
          <p className="break-all font-medium">{item.name}</p>
          {item.error && <p className="text-danger">{item.error}</p>}
          {item.warnings.map((warning, warningIndex) => <p key={warningIndex} className="text-muted">{warning}</p>)}
          {!item.error && !item.warnings.length && <p className="text-muted">Imported</p>}
        </div>)}
      </Modal.Body><Modal.Footer><Button onPress={() => setImportSummary(undefined)}>Done</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop>}
    <Modal.Backdrop isOpen={settingsOpen} variant="blur" onOpenChange={setSettingsOpen}><Modal.Container size="sm"><Modal.Dialog><Modal.CloseTrigger /><Modal.Header><Modal.Heading>Configuration</Modal.Heading></Modal.Header><Modal.Body className="grid max-h-[65vh] gap-4 overflow-y-auto">
      <SwitchRow label="Transparent clipboard" description="Automatically share text and files with the selected desktop while this window is focused. Requires Clipboard on the connection."
        selected={applicationSettings?.settings.rdp.transparentClipboard ?? false} disabled={!applicationSettings?.isReady || applicationSettings.isSaving}
        onChange={(selected) => { void applicationSettings?.updateSettings((current) => ({ ...current, rdp: { ...current.rdp, transparentClipboard: selected } })); }} />
      <SwitchRow label="Resize desktop with window" description="Request a desktop size matching this window. Some servers require reconnecting to change their size." selected={autoResize} disabled={!activeTab} onChange={setAutoResize} />
      <SwitchRow label="Scale desktop for high-DPI displays" description="Use this display’s pixel density for a sharper desktop with matching text and icon scaling." selected={highDpi} disabled={!activeTab || !autoResize} onChange={setHighDpi} />
      <Button variant="secondary" isDisabled={!activeConnected} onPress={() => { activeHandle()?.resizeToWindow(); setSettingsOpen(false); }}>Resize to this window</Button>
      <p className="text-xs text-muted">Fit scales the remote picture locally. Actual size displays one screen pixel per desktop pixel.</p>
    </Modal.Body><Modal.Footer><Button onPress={() => setSettingsOpen(false)}>Done</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop>
    <RenameTabDialog isOpen={Boolean(renameId)} name={renameName} originalName={state.tabs.find(({ id }) => id === renameId)?.label ?? ""} description="Choose a name for this remote desktop tab." onNameChange={setRenameName} isPending={pending === "rename"} onOpenChange={(open) => { if (!open) setRenameId(undefined); }} onRename={(label) => { if (api && renameId) void act("rename", () => api.renameTab({ tabId: renameId, label }), () => setRenameId(undefined)); }} />
    {review && api && <Modal.Backdrop isOpen isDismissable={false} isKeyboardDismissDisabled variant="blur"><Modal.Container size="md"><Modal.Dialog><Modal.Header><Modal.Icon><FontAwesomeIcon aria-hidden icon={faShieldHalved} /></Modal.Icon><Modal.Heading>Review Server Certificate</Modal.Heading></Modal.Header>
      <Modal.Body className="grid max-h-[60vh] gap-4 overflow-y-auto"><p className="text-sm">{review.reason}</p><dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted">Computer</dt><dd className="break-all">{review.host}:{review.port}</dd><dt className="text-muted">Subject</dt><dd className="break-all">{review.subject || "Not provided"}</dd><dt className="text-muted">Issuer</dt><dd className="break-all">{review.issuer || "Not provided"}</dd><dt className="text-muted">Valid from</dt><dd>{review.validFrom || "Not provided"}</dd><dt className="text-muted">Valid until</dt><dd>{review.validTo || "Not provided"}</dd><dt className="text-muted">SHA-256</dt><dd className="break-all font-mono text-xs">{review.fingerprint}</dd>
      </dl>{error && <p role="alert" className="text-sm text-danger">{error}</p>}<p className="text-xs text-muted">Verify this fingerprint with the computer administrator before trusting the connection.</p>{!review.canOverride && <p className="text-sm text-danger">This certificate cannot be accepted. Correct the server certificate before reconnecting.</p>}</Modal.Body>
      <Modal.Footer className="flex-wrap"><Button variant="secondary" isDisabled={Boolean(pending)} onPress={() => { void act("trust-reject", () => api.respondToCertificate({ token: review.token, decision: "reject" })); }}>Cancel connection</Button><Button variant="secondary" isDisabled={Boolean(pending) || !review.canOverride} onPress={() => { void act("trust-once", () => api.respondToCertificate({ token: review.token, decision: "once" })); }}>Trust once</Button>{!reviewTab?.temporary && <Button isDisabled={Boolean(pending) || !review.canOverride} onPress={() => { void act("trust-pin", () => api.respondToCertificate({ token: review.token, decision: "pin" })); }}>Trust and remember</Button>}</Modal.Footer>
    </Modal.Dialog></Modal.Container></Modal.Backdrop>}
    <Modal.Backdrop isOpen={Boolean(reconnectId)} variant="blur" isDismissable={!pending} isKeyboardDismissDisabled={Boolean(pending)} onOpenChange={(open) => { if (!open) closeReconnect(); }}><Modal.Container size="sm"><Modal.Dialog><Modal.CloseTrigger isDisabled={Boolean(pending)} /><Modal.Header><Modal.Heading>Reconnect to Remote Desktop</Modal.Heading></Modal.Header><Modal.Body className="grid gap-4">
      {reconnectTab?.signInMode !== "remote-screen" && <div><TextField value={reconnectPassword} onChange={setReconnectPassword} isDisabled={Boolean(pending)}><Label>Password</Label><Input type="password" autoComplete="new-password" placeholder="Use remembered password if available" maxLength={4096} /></TextField><p className="mt-2 text-xs text-muted">Enter your password if it was not remembered for this connection.</p></div>}
      {reconnectNeedsProxyPassword && <div><TextField value={reconnectProxyPassword} onChange={(value) => { setReconnectProxyPassword(value); setReconnectProxyError(undefined); }} isRequired isInvalid={Boolean(reconnectProxyError)} validationBehavior="aria" isDisabled={Boolean(pending)}>
        <Label>Proxy password</Label><Input type="password" autoComplete="new-password" maxLength={255} autoFocus={reconnectTab?.signInMode === "remote-screen"} />
        {reconnectProxyError && <FieldError>{reconnectProxyError}</FieldError>}
      </TextField><p className="mt-2 text-xs text-muted">Proxy passwords are not remembered.</p></div>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </Modal.Body><Modal.Footer><Button variant="secondary" isDisabled={Boolean(pending)} onPress={closeReconnect}>Cancel</Button><Button isPending={pending === "reconnect"} isDisabled={Boolean(pending)} onPress={submitReconnect}>Reconnect</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop>
    <Modal.Backdrop isOpen={Boolean(deleteProfile)} variant="blur" onOpenChange={(open) => { if (!open) setDeleteProfile(undefined); }}><Modal.Container size="sm"><Modal.Dialog><Modal.CloseTrigger /><Modal.Header><Modal.Heading>Delete Profile</Modal.Heading></Modal.Header><Modal.Body><p className="text-sm">Delete {deleteProfile?.label}, its saved preview, and its saved credential? Existing desktop sessions remain open.</p></Modal.Body><Modal.Footer><Button variant="secondary" onPress={() => setDeleteProfile(undefined)}>Cancel</Button><Button variant="danger-soft" isDisabled={Boolean(pending)} onPress={() => { if (api && deleteProfile) void act("delete-profile", () => api.deleteProfile(deleteProfile.id), () => setDeleteProfile(undefined)); }}>Delete profile</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop>
  </AuxiliaryWindowFrame>;
}

function IconButton({ label, icon, disabled = false, onPress }: { readonly label: string; readonly icon: IconDefinition; readonly disabled?: boolean; readonly onPress: () => void }): React.JSX.Element {
  return <Tooltip delay={250}><Button isIconOnly size="sm" variant="ghost" aria-label={label} isDisabled={disabled} onPress={onPress}><FontAwesomeIcon aria-hidden icon={icon} /></Button><Tooltip.Content>{label}</Tooltip.Content></Tooltip>;
}
