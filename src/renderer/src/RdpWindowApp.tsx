import { createRef, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Button, Chip, Input, Label, Modal, Tabs, TextField, Tooltip } from "@heroui/react";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { NativeSelect } from "@heroui-pro/react/native-select";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowsRotate, faClipboard, faDesktop, faExpand, faFolderOpen, faGear, faKey, faPlus, faPowerOff, faShieldHalved, faTrash, faXmark } from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import type { RdpProfile, RdpScaleMode, RdpWindowState } from "../../shared/rdp-contracts";
import type { OperationResult } from "../../shared/contracts";
import { AuxiliaryWindowFrame } from "./components/AuxiliaryWindowFrame";
import { RenamableTab } from "./components/RenamableTab";
import { RenameTabDialog } from "./components/RenameTabDialog";
import { SwitchRow } from "./components/FormControls";
import { RdpConnectDialog } from "./components/rdp/RdpConnectDialog";
import { phaseLabel, RdpDesktop, type RdpDesktopHandle } from "./components/rdp/RdpDesktop";
import "./components/rdp/rdp.css";

const EMPTY_STATE: RdpWindowState = { tabs: [], profiles: [], securePersistenceAvailable: false, maxSessions: 4 };

export function RdpWindowApp(): React.JSX.Element {
  const api = window.rdp;
  const [state, setState] = useState<RdpWindowState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [connectOpen, setConnectOpen] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState<RdpProfile>();
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renameId, setRenameId] = useState<string>();
  const [renameName, setRenameName] = useState("");
  const [reconnectId, setReconnectId] = useState<string>();
  const [reconnectPassword, setReconnectPassword] = useState("");
  const [pending, setPending] = useState<string>();
  const [deleteProfile, setDeleteProfile] = useState<RdpProfile>();
  const [scaleModes, setScaleModes] = useState<Readonly<Record<string, RdpScaleMode>>>({});
  const [autoResize, setAutoResize] = useState(false);
  const stateEvents = useRef(0);
  const pendingRef = useRef(false);
  const refs = useRef(new Map<string, RefObject<RdpDesktopHandle | null>>());
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0];
  const reviewTab = state.tabs.find((tab) => tab.review !== undefined);
  const review = reviewTab?.review;
  const modalOpen = connectOpen || profilesOpen || settingsOpen || Boolean(renameId || reconnectId || review || deleteProfile);

  const refresh = useCallback(async (): Promise<void> => {
    if (!api) return;
    const events = stateEvents.current;
    try {
      const result = await api.getState();
      if (!result.ok) setError(result.error);
      else if (events === stateEvents.current) setState(result.value);
    } catch { setError("Remote Desktop state could not be refreshed."); }
  }, [api]);

  useEffect(() => {
    if (!api) { setError("Remote Desktop is unavailable in this window."); setLoading(false); return; }
    let mounted = true;
    let receivedEvent = false;
    const remove = api.onStateChanged((next) => { if (mounted) { stateEvents.current += 1; receivedEvent = true; setState(next); setLoading(false); } });
    void api.getState().then((result) => {
      if (!mounted) return;
      if (!result.ok) setError(result.error);
      else if (!receivedEvent) setState(result.value);
      setLoading(false);
    }).catch(() => { if (mounted) { setError("Remote Desktop could not be initialized."); setLoading(false); } });
    return () => { mounted = false; remove(); };
  }, [api]);

  useEffect(() => {
    document.title = activeTab ? `Remote Desktop — ${activeTab.label}` : "Remote Desktop";
    const present = new Set(state.tabs.map(({ id }) => id));
    for (const id of refs.current.keys()) if (!present.has(id)) refs.current.delete(id);
  }, [activeTab, state.tabs]);

  const act = useCallback(async (key: string, operation: () => Promise<OperationResult | OperationResult<unknown>>, success?: () => void): Promise<boolean> => {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(key); setError(undefined); setNotice(undefined);
    try {
      const result = await operation();
      if (!result.ok) throw new Error(result.error);
      success?.();
      await refresh();
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The remote desktop action failed."); return false; }
    finally { pendingRef.current = false; setPending(undefined); }
  }, [refresh]);

  const newConnection = (profile?: RdpProfile): void => {
    activeTab && refs.current.get(activeTab.id)?.current?.release();
    setSelectedProfile(profile); setProfilesOpen(false); setConnectOpen(true); setError(undefined);
  };
  const selectTab = (id: string): void => {
    if (!api || id === activeTab?.id) return;
    if (activeTab) refs.current.get(activeTab.id)?.current?.release();
    setState((current) => ({ ...current, activeTabId: id }));
    void api.selectTab(id).then((result) => { if (!result.ok) setError(result.error); }).catch(() => setError("The tab could not be selected."));
  };
  const liveCount = state.tabs.filter(({ state: phase }) => phase !== "disconnected" && phase !== "failed").length;
  const activeHandle = (): RdpDesktopHandle | null | undefined => activeTab ? refs.current.get(activeTab.id)?.current : undefined;
  const activeConnected = activeTab?.state === "active";
  const scaleMode = activeTab ? scaleModes[activeTab.id] ?? activeTab.scaleMode : "fit";

  const profiles = <div className="grid gap-1">
    {state.profiles.length === 0 ? <p className="py-4 text-sm text-muted">Save a connection profile to find it here. Passwords are managed separately.</p> : state.profiles.map((profile) => <div className="rdp-profile-row" key={profile.id}>
      <FontAwesomeIcon aria-hidden icon={faDesktop} className="text-muted" />
      <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{profile.label}</p><p className="truncate text-xs text-muted">{profile.username}@{profile.host}:{profile.port}</p></div>
      <Button size="sm" variant="secondary" isDisabled={state.tabs.length >= state.maxSessions} onPress={() => newConnection(profile)}>Connect</Button>
      <IconButton label={`Delete ${profile.label}`} icon={faTrash} onPress={() => setDeleteProfile(profile)} />
    </div>)}
  </div>;

  return <AuxiliaryWindowFrame ariaLabel="Remote Desktop" className="rdp-window">
    <header className="rdp-toolbar">
      <div className="mr-auto flex items-center gap-2"><FontAwesomeIcon aria-hidden icon={faDesktop} className="text-muted" /><h1 className="text-sm font-semibold">Remote Desktop</h1></div>
      <Button size="sm" isDisabled={!api || loading || state.tabs.length >= state.maxSessions} onPress={() => newConnection()}><FontAwesomeIcon aria-hidden icon={faPlus} />New connection</Button>
      <IconButton label="Saved profiles" icon={faFolderOpen} disabled={!api || loading} onPress={() => setProfilesOpen(true)} />
      <IconButton label="Display settings" icon={faGear} disabled={!activeTab} onPress={() => setSettingsOpen(true)} />
    </header>
    {error && <div role="alert" className="flex items-center justify-between gap-4 border-b border-border px-4 py-2 text-sm text-danger"><p>{error}</p><Button aria-label="Dismiss error" isIconOnly size="sm" variant="ghost" onPress={() => setError(undefined)}><FontAwesomeIcon icon={faXmark} /></Button></div>}
    {activeConnected && activeTab.error && <p role="status" className="border-b border-border px-4 py-2 text-sm text-warning">{activeTab.error}</p>}
    {notice && <p role="status" className="border-b border-border px-4 py-2 text-sm text-muted">{notice}</p>}
    {loading ? <div className="grid flex-1 place-items-center text-sm text-muted" role="status">Opening Remote Desktop…</div> : state.tabs.length === 0 ? <div className="min-h-0 flex-1 overflow-y-auto">
      <EmptyState className="mx-auto max-w-lg py-12"><EmptyState.Header><EmptyState.Media variant="icon"><FontAwesomeIcon aria-hidden icon={faDesktop} /></EmptyState.Media><EmptyState.Title>Your Windows desktops</EmptyState.Title><EmptyState.Description>Connect directly to a Windows computer. Remote Desktop works independently of your Sliver connections.</EmptyState.Description></EmptyState.Header>
        <EmptyState.Content><Button isDisabled={!api} onPress={() => newConnection()}>Connect to a computer</Button></EmptyState.Content>
      </EmptyState>
      {state.profiles.length > 0 && <section className="rdp-profiles" aria-label="Saved profiles"><h2 className="mb-2 text-sm font-semibold">Saved Profiles</h2>{profiles}</section>}
    </div> : <>
      <Tabs className="rdp-tabs" selectedKey={activeTab?.id ?? ""} onSelectionChange={(id) => selectTab(String(id))}>
        <Tabs.ListContainer><Tabs.List aria-label="Remote desktop sessions" className="px-3">
          {state.tabs.map((tab) => <RenamableTab key={tab.id} id={tab.id} ariaLabel={tab.label} onRename={(id) => { setRenameId(id); setRenameName(tab.label); }}>
            <span className="max-w-52 truncate">{tab.label}</span><span className="sr-only">{phaseLabel(tab.state)}</span><Tabs.Indicator />
          </RenamableTab>)}
        </Tabs.List></Tabs.ListContainer>
        {activeTab && <div className="rdp-toolbar" aria-label="Remote desktop controls">
          <Chip size="sm" color={activeTab.state === "active" ? "success" : activeTab.state === "failed" ? "danger" : "default"} variant="soft"><Chip.Label>{phaseLabel(activeTab.state)}</Chip.Label></Chip>
          <span className="mr-auto hidden truncate text-xs text-muted sm:block">{activeTab.host}:{activeTab.port}</span>
          <NativeSelect className="w-28"><NativeSelect.Trigger aria-label="Desktop scale" value={scaleMode} onChange={(event) => setScaleModes((current) => ({ ...current, [activeTab.id]: event.target.value as RdpScaleMode }))}>
            <NativeSelect.Option value="fit">Fit</NativeSelect.Option><NativeSelect.Option value="actual">Actual size</NativeSelect.Option>
          </NativeSelect.Trigger></NativeSelect>
          <IconButton label="Send Ctrl+Alt+Delete" icon={faKey} disabled={!activeConnected} onPress={() => activeHandle()?.specialKey("ctrl-alt-delete")} />
          <IconButton label="Send Windows key" icon={faDesktop} disabled={!activeConnected} onPress={() => activeHandle()?.specialKey("windows")} />
          <IconButton label="Send clipboard text" icon={faClipboard} disabled={!activeConnected || !activeTab.clipboardReady || !activeTab.clipboard || Boolean(pending)} onPress={() => { void act("clipboard-send", () => api!.clipboard({ tabId: activeTab.id, direction: "send" }), () => setNotice("Clipboard text sent to the remote desktop.")); }} />
          <Button size="sm" variant="ghost" isDisabled={!activeConnected || !activeTab.clipboardAvailable || !activeTab.clipboard || Boolean(pending)} onPress={() => { void act("clipboard-receive", () => api!.clipboard({ tabId: activeTab.id, direction: "receive" }), () => setNotice("Remote text copied to the clipboard.")); }}>Receive clipboard</Button>
          <IconButton label="Toggle fullscreen" icon={faExpand} disabled={!api} onPress={() => { void act("fullscreen", () => api!.toggleFullscreen()); }} />
          {activeTab.state === "disconnected" || activeTab.state === "failed" ? <IconButton label="Reconnect" icon={faArrowsRotate} disabled={Boolean(pending)} onPress={() => { setReconnectPassword(""); setReconnectId(activeTab.id); }} /> : <IconButton label={activeConnected ? "Disconnect" : "Cancel connection"} icon={faPowerOff} disabled={Boolean(pending)} onPress={() => { void act("disconnect", () => api!.disconnect(activeTab.id)); }} />}
          <IconButton label="Close remote desktop tab" icon={faXmark} disabled={Boolean(pending)} onPress={() => { void act("close", () => api!.closeTab(activeTab.id)); }} />
        </div>}
        <div className="rdp-tab-panels">
          {api && state.tabs.map((tab) => {
            let desktopRef = refs.current.get(tab.id);
            if (!desktopRef) { desktopRef = createRef<RdpDesktopHandle>(); refs.current.set(tab.id, desktopRef); }
            return <RdpDesktop key={`${tab.id}:${tab.attempt}`} ref={desktopRef} api={api} tab={tab} active={tab.id === activeTab?.id} inputEnabled={!modalOpen}
              scaleMode={scaleModes[tab.id] ?? tab.scaleMode} autoResize={autoResize} />;
          })}
        </div>
      </Tabs>
      <footer className="rdp-footer"><span>Click the desktop to control it. Ctrl+Alt+Escape releases keyboard input.</span><span>{liveCount}/{state.maxSessions} connected</span></footer>
    </>}
    {api && connectOpen && <RdpConnectDialog api={api} initial={selectedProfile} securePersistenceAvailable={state.securePersistenceAvailable} onClose={() => setConnectOpen(false)} onProfileSaved={() => { void refresh(); }} onConnected={(id) => { setConnectOpen(false); void refresh(); void api.selectTab(id); }} />}
    <Modal.Backdrop isOpen={profilesOpen && !deleteProfile} variant="blur" onOpenChange={setProfilesOpen}><Modal.Container size="md"><Modal.Dialog><Modal.CloseTrigger /><Modal.Header><Modal.Heading>Saved Profiles</Modal.Heading></Modal.Header><Modal.Body className="max-h-[60vh] overflow-y-auto">{profiles}</Modal.Body><Modal.Footer><Button variant="secondary" onPress={() => setProfilesOpen(false)}>Close</Button><Button isDisabled={state.tabs.length >= state.maxSessions} onPress={() => newConnection()}>New connection</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop>
    <Modal.Backdrop isOpen={settingsOpen} variant="blur" onOpenChange={setSettingsOpen}><Modal.Container size="sm"><Modal.Dialog><Modal.CloseTrigger /><Modal.Header><Modal.Heading>Display Settings</Modal.Heading></Modal.Header><Modal.Body className="grid gap-4">
      <SwitchRow label="Resize desktop with window" description="Request a desktop size matching this window. Some servers require reconnecting to change their size." selected={autoResize} onChange={setAutoResize} />
      <Button variant="secondary" isDisabled={!activeConnected} onPress={() => { activeHandle()?.resizeToWindow(); setSettingsOpen(false); }}>Resize to this window</Button>
      <p className="text-xs text-muted">Fit scales the remote picture locally. Actual size displays one screen pixel per desktop pixel.</p>
    </Modal.Body><Modal.Footer><Button onPress={() => setSettingsOpen(false)}>Done</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop>
    <RenameTabDialog isOpen={Boolean(renameId)} name={renameName} originalName={state.tabs.find(({ id }) => id === renameId)?.label ?? ""} description="Choose a name for this remote desktop tab." onNameChange={setRenameName} isPending={pending === "rename"} onOpenChange={(open) => { if (!open) setRenameId(undefined); }} onRename={(label) => { if (api && renameId) void act("rename", () => api.renameTab({ tabId: renameId, label }), () => setRenameId(undefined)); }} />
    {review && api && <Modal.Backdrop isOpen isDismissable={false} isKeyboardDismissDisabled variant="blur"><Modal.Container size="md"><Modal.Dialog><Modal.Header><Modal.Icon><FontAwesomeIcon aria-hidden icon={faShieldHalved} /></Modal.Icon><Modal.Heading>Review Server Certificate</Modal.Heading></Modal.Header>
      <Modal.Body className="grid max-h-[60vh] gap-4 overflow-y-auto"><p className="text-sm">{review.reason}</p><dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted">Computer</dt><dd className="break-all">{review.host}:{review.port}</dd><dt className="text-muted">Subject</dt><dd className="break-all">{review.subject || "Not provided"}</dd><dt className="text-muted">Issuer</dt><dd className="break-all">{review.issuer || "Not provided"}</dd><dt className="text-muted">Valid from</dt><dd>{review.validFrom || "Not provided"}</dd><dt className="text-muted">Valid until</dt><dd>{review.validTo || "Not provided"}</dd><dt className="text-muted">SHA-256</dt><dd className="break-all font-mono text-xs">{review.fingerprint}</dd>
      </dl>{error && <p role="alert" className="text-sm text-danger">{error}</p>}<p className="text-xs text-muted">Verify this fingerprint with the computer administrator before trusting the connection.</p>{!review.canOverride && <p className="text-sm text-danger">This certificate cannot be accepted. Correct the server certificate before reconnecting.</p>}</Modal.Body>
      <Modal.Footer className="flex-wrap"><Button variant="secondary" isDisabled={Boolean(pending)} onPress={() => { void act("trust-reject", () => api.respondToCertificate({ token: review.token, decision: "reject" })); }}>Cancel connection</Button><Button variant="secondary" isDisabled={Boolean(pending) || !review.canOverride} onPress={() => { void act("trust-once", () => api.respondToCertificate({ token: review.token, decision: "once" })); }}>Trust once</Button><Button isDisabled={Boolean(pending) || !review.canOverride} onPress={() => { void act("trust-pin", () => api.respondToCertificate({ token: review.token, decision: "pin" })); }}>Trust and remember</Button></Modal.Footer>
    </Modal.Dialog></Modal.Container></Modal.Backdrop>}
    <Modal.Backdrop isOpen={Boolean(reconnectId)} variant="blur" onOpenChange={(open) => { if (!open) { setReconnectId(undefined); setReconnectPassword(""); } }}><Modal.Container size="sm"><Modal.Dialog><Modal.CloseTrigger /><Modal.Header><Modal.Heading>Reconnect to Remote Desktop</Modal.Heading></Modal.Header><Modal.Body><TextField value={reconnectPassword} onChange={setReconnectPassword}><Label>Password</Label><Input type="password" autoComplete="new-password" placeholder="Use remembered password if available" maxLength={4096} /></TextField><p className="mt-2 text-xs text-muted">Enter your password if it was not remembered for this connection.</p>{error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}</Modal.Body><Modal.Footer><Button variant="secondary" onPress={() => { setReconnectId(undefined); setReconnectPassword(""); }}>Cancel</Button><Button isPending={pending === "reconnect"} onPress={() => {
      if (!api || !reconnectId) return;
      const input = { tabId: reconnectId, ...(reconnectPassword ? { password: reconnectPassword } : {}) };
      setReconnectPassword("");
      void act("reconnect", () => api.reconnect(input), () => setReconnectId(undefined)).finally(() => { delete input.password; });
    }}>Reconnect</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop>
    <Modal.Backdrop isOpen={Boolean(deleteProfile)} variant="blur" onOpenChange={(open) => { if (!open) setDeleteProfile(undefined); }}><Modal.Container size="sm"><Modal.Dialog><Modal.CloseTrigger /><Modal.Header><Modal.Heading>Delete Profile</Modal.Heading></Modal.Header><Modal.Body><p className="text-sm">Delete {deleteProfile?.label} and its saved credential? Existing desktop sessions remain open.</p></Modal.Body><Modal.Footer><Button variant="secondary" onPress={() => setDeleteProfile(undefined)}>Cancel</Button><Button variant="danger-soft" isDisabled={Boolean(pending)} onPress={() => { if (api && deleteProfile) void act("delete-profile", () => api.deleteProfile(deleteProfile.id), () => setDeleteProfile(undefined)); }}>Delete profile</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop>
  </AuxiliaryWindowFrame>;
}

function IconButton({ label, icon, disabled = false, onPress }: { readonly label: string; readonly icon: IconDefinition; readonly disabled?: boolean; readonly onPress: () => void }): React.JSX.Element {
  return <Tooltip delay={250}><Button isIconOnly size="sm" variant="ghost" aria-label={label} isDisabled={disabled} onPress={onPress}><FontAwesomeIcon aria-hidden icon={icon} /></Button><Tooltip.Content>{label}</Tooltip.Content></Tooltip>;
}
