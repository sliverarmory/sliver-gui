import { useEffect, useId, useRef, useState } from "react";
import { Button, Description, Disclosure, Dropdown, FieldError, Input, Label, Modal, ScrollShadow, TextField, toast } from "@heroui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faWindows } from "@fortawesome/free-brands-svg-icons";
import { faArrowUpRightFromSquare, faChevronDown, faRoute } from "@fortawesome/free-solid-svg-icons";
import { rdpNetworkingKey, type RdpConnectInput, type RdpCredentialPersistence, type RdpNetworking, type RdpPendingConnection, type RdpProfile, type RdpSaveProfileInput, type RdpSocks5Proxy, type RdpSocks5Session, type RdpWindowAPI } from "../../../../shared/rdp-contracts";
import { useApplicationSettings } from "../ApplicationSettingsProvider";
import { SwitchRow } from "../FormControls";
import { RDP_RESOLUTIONS, validateRdpConnectForm, type RdpConnectFormField } from "./rdp-connect-form";

const PERSISTENCE_CHOICES = [
  { value: "none", label: "Do not save" },
  { value: "session", label: "Until the app quits" },
  { value: "secure", label: "Save securely on this device" },
] as const;
const RESOLUTION_CHOICES = [...RDP_RESOLUTIONS.map((size) => ({ value: size.value, label: `${size.width} × ${size.height}` })),
  { value: "custom", label: "Custom" }];

function sessionLabel(session: RdpSocks5Session): string {
  const hostname = session.hostname.trim();
  return hostname && hostname.toLowerCase() !== session.label.trim().toLowerCase() ? `${session.label} · ${hostname}` : session.label;
}

function proxyLabel(proxy: RdpSocks5Proxy): string {
  return `${proxy.label} — ${proxy.host.includes(":") ? `[${proxy.host}]` : proxy.host}:${proxy.port}${proxy.available ? "" : " (unavailable)"}`;
}

interface Props {
  readonly api: RdpWindowAPI;
  readonly securePersistenceAvailable: boolean;
  readonly initial?: RdpProfile | undefined;
  readonly temporary?: RdpPendingConnection | undefined;
  readonly socks5Proxies?: readonly RdpSocks5Proxy[] | undefined;
  readonly socks5Sessions?: readonly RdpSocks5Session[] | undefined;
  readonly onClose: () => void;
  readonly onConnected: (tabId: string) => void;
  readonly onProfileSaved: () => void;
}

export function RdpConnectDialog({ api, securePersistenceAvailable, initial: selectedProfile, temporary, socks5Proxies = [], socks5Sessions = [], onClose, onConnected, onProfileSaved }: Props): React.JSX.Element {
  const initial = temporary ? undefined : selectedProfile;
  const applicationSettings = useApplicationSettings();
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [label, setLabel] = useState(temporary?.label ?? initial?.label ?? "");
  const [host, setHost] = useState(temporary?.host ?? initial?.host ?? "");
  const [port, setPort] = useState(String(temporary?.port ?? initial?.port ?? 3389));
  const initialManualProxy = initial?.networking?.kind === "socks5-manual" ? initial.networking : undefined;
  const [route, setRoute] = useState(initial?.networking?.kind === "socks5" ? initial.networking.proxyId : initialManualProxy ? "manual" : "");
  const [createdProxies, setCreatedProxies] = useState<readonly RdpSocks5Proxy[]>([]);
  const proxyDisplayCache = useRef(new Map<string, RdpSocks5Proxy>());
  const observedProxyIds = useRef(new Set<string>());
  const [selectedSession, setSelectedSession] = useState<RdpSocks5Session>();
  const [sessionProxyError, setSessionProxyError] = useState<string>();
  // A newly created proxy can precede its inventory event. Once observed there,
  // the inventory owns its lifetime, including stopped or removed proxies.
  useEffect(() => {
    // Retain display metadata for an unavailable selection, never availability.
    for (const proxy of [...createdProxies, ...socks5Proxies]) proxyDisplayCache.current.set(proxy.id, proxy);
    for (const proxy of socks5Proxies) observedProxyIds.current.add(proxy.id);
    if (createdProxies.some((created) => observedProxyIds.current.has(created.id))) {
      setCreatedProxies((current) => current.filter((created) => !observedProxyIds.current.has(created.id)));
    }
  }, [createdProxies, socks5Proxies]);
  const availableProxies = [...socks5Proxies, ...createdProxies.filter((created) => !observedProxyIds.current.has(created.id) && !socks5Proxies.some((proxy) => proxy.id === created.id))];
  const [proxyHost, setProxyHost] = useState(initialManualProxy?.host ?? "");
  const [proxyPort, setProxyPort] = useState(String(initialManualProxy?.port ?? 1080));
  const [proxyUsername, setProxyUsername] = useState(initialManualProxy?.username ?? "");
  const [proxyPassword, setProxyPassword] = useState("");
  const [networkingOpen, setNetworkingOpen] = useState(Boolean(initial?.networking));
  const [remoteScreen, setRemoteScreen] = useState(initial?.signInMode === "remote-screen");
  const [username, setUsername] = useState(remoteScreen ? "" : initial?.username ?? "");
  const [domain, setDomain] = useState(remoteScreen ? "" : initial?.domain ?? "");
  const [password, setPassword] = useState("");
  const [persistence, setPersistence] = useState<RdpCredentialPersistence>(remoteScreen || (initial?.credentialPersistence === "secure" && !securePersistenceAvailable) ? "none" : initial?.credentialPersistence ?? "none");
  const [width, setWidth] = useState(String(initial?.width ?? 1280));
  const [height, setHeight] = useState(String(initial?.height ?? 800));
  const initialResolution = `${initial?.width ?? 1280}x${initial?.height ?? 800}`;
  const [resolution, setResolution] = useState(RDP_RESOLUTIONS.some((size) => size.value === initialResolution) ? initialResolution : "custom");
  const [customSizeEdited, setCustomSizeEdited] = useState(resolution === "custom");
  const [clipboardDraft, setClipboardDraft] = useState<boolean>();
  const [savingClipboard, setSavingClipboard] = useState(false);
  const clipboard = clipboardDraft ?? initial?.clipboard ?? applicationSettings?.settings.rdp.clipboard ?? true;
  const preferencesPending = savingClipboard || Boolean(applicationSettings && !applicationSettings.isReady);
  const [profileId, setProfileId] = useState(initial?.id);
  const [savedSignInMode, setSavedSignInMode] = useState(initial?.signInMode ?? "nla");
  const [savedNetworkingKey, setSavedNetworkingKey] = useState(rdpNetworkingKey(initial?.networking));
  const [credentialProfile, setCredentialProfile] = useState(initial);
  const [pending, setPending] = useState<"connect" | "save" | "cancel" | "proxy">();
  const operationPending = useRef(false);
  const networkManagerPending = useRef(false);
  const [openingNetworkManager, setOpeningNetworkManager] = useState(false);
  const [error, setError] = useState<string>();
  const [touched, setTouched] = useState<Partial<Record<RdpConnectFormField, boolean>>>({});
  const [submitted, setSubmitted] = useState<"connect" | "save">();
  const preset = RDP_RESOLUTIONS.find((size) => size.value === resolution);
  const manualProxy = !temporary && route === "manual";
  const sessionRoute = !temporary && route.startsWith("session:");
  const currentProxy = availableProxies.find((proxy) => proxy.id === route);
  const previousProxy = proxyDisplayCache.current.get(route);
  const selectedProxy = currentProxy ?? (previousProxy ? { ...previousProxy, available: false } : undefined);
  const selectedSessionId = sessionRoute ? route.slice("session:".length) : selectedProxy?.viaSessionId;
  const liveSelectedSession = socks5Sessions.find((session) => session.id === selectedSessionId);
  const previousSession = selectedSession?.id === selectedSessionId ? selectedSession : undefined;
  const missingSessionChoice = selectedSessionId && !liveSelectedSession ? {
    value: `session:${selectedSessionId}`,
    label: `Via ${previousSession ? sessionLabel(previousSession) : selectedProxy?.label ?? "Sliver session"} (unavailable)`,
    ...(previousSession ? { description: `Session ID: ${previousSession.sessionId}` } : {}), disabled: true,
  } : undefined;
  const routeChoices: readonly { value: string; label: string; description?: string; disabled?: boolean }[] = [
    { value: "", label: "Direct" },
    { value: "manual", label: "Manual SOCKS5" },
    ...socks5Sessions.map((session) => ({ value: `session:${session.id}`, label: `Via ${sessionLabel(session)}`, description: `Session ID: ${session.sessionId}` })),
    ...(missingSessionChoice ? [missingSessionChoice] : []),
    ...(route && !manualProxy && !sessionRoute && !selectedProxy?.viaSessionId && !currentProxy
      ? [{ value: route, label: selectedProxy ? proxyLabel(selectedProxy) : "Saved SOCKS5 proxy (unavailable)", disabled: true }] : []),
    ...availableProxies.filter((proxy) => !proxy.viaSessionId).map((proxy) => ({ value: proxy.id, label: proxyLabel(proxy), disabled: !proxy.available })),
  ];
  const selectedRoute = selectedProxy ? { value: route, label: proxyLabel(selectedProxy) } : routeChoices.find((choice) => choice.value === route);
  const selectedMenuKey = selectedSessionId ? `session:${selectedSessionId}` : route || "direct";
  const routeLabel = (choice: (typeof routeChoices)[number] | undefined): React.ReactNode => choice?.value.startsWith("session:")
    ? <><span className="font-normal italic text-muted">Via</span>{" "}<span className="font-medium">{choice.label.slice(4)}</span></>
    : choice?.label;
  const networking: RdpNetworking | undefined = temporary || !route || sessionRoute ? undefined : manualProxy
    ? { kind: "socks5-manual", host: proxyHost.trim(), port: Number(proxyPort), ...(proxyUsername.trim() ? { username: proxyUsername } : {}) }
    : { kind: "socks5", proxyId: route };
  const formValues = { label, host, port, username, domain, password, manualProxy, proxyHost, proxyPort, proxyUsername, proxyPassword,
    ...(remoteScreen ? { signInMode: "remote-screen" as const } : {}),
    width: preset ? String(preset.width) : width, height: preset ? String(preset.height) : height };
  const canUseSavedCredential = Boolean(!remoteScreen && credentialProfile?.signInMode !== "remote-screen" && credentialProfile?.hasCredential &&
    (credentialProfile.credentialPersistence !== "secure" || securePersistenceAvailable) &&
    credentialProfile.host.toLowerCase() === host.trim().toLowerCase() && credentialProfile.port === Number(port) &&
    rdpNetworkingKey(credentialProfile.networking) === rdpNetworkingKey(networking) &&
    credentialProfile.username === username.trim() && credentialProfile.domain === domain.trim());
  const validationErrors = validateRdpConnectForm(formValues, submitted !== "save" && !canUseSavedCredential, submitted !== "save");
  const fieldError = (field: RdpConnectFormField): string | undefined =>
    touched[field] || submitted ? validationErrors[field] : undefined;
  const fieldProps = (field: RdpConnectFormField) => ({
    name: field,
    isInvalid: Boolean(fieldError(field)),
    validationBehavior: "aria" as const,
    onBlur: () => setTouched((current) => ({ ...current, [field]: true })),
  });

  const values = (): RdpSaveProfileInput => {
    const portNumber = Number(port);
    const desktopWidth = Number(formValues.width);
    const desktopHeight = Number(formValues.height);
    return { ...(profileId ? { id: profileId } : {}), label: label.trim() || host.trim().slice(0, 120), host: host.trim(), port: portNumber,
      username: remoteScreen ? "" : username.trim(), domain: remoteScreen ? "" : domain.trim(), width: desktopWidth, height: desktopHeight, clipboard,
      ...(remoteScreen ? { signInMode: "remote-screen" as const } : {}),
      ...(networking ? { networking } : {}),
      scaleMode: initial?.scaleMode ?? "fit" };
  };

  const clearIdentitySecrets = (): void => {
    setPassword(""); setProxyPassword(""); setPersistence("none"); setCredentialProfile(undefined); setError(undefined);
  };

  const selectRoute = async (next: string): Promise<void> => {
    if (operationPending.current || temporary || (next === route && !sessionRoute) || (next === selectedMenuKey && currentProxy?.available)) return;
    setRoute(next); clearIdentitySecrets(); setSessionProxyError(undefined);
    if (!next.startsWith("session:")) return;
    const sessionId = next.slice("session:".length);
    setSelectedSession(socks5Sessions.find((session) => session.id === sessionId));
    operationPending.current = true; setPending("proxy");
    try {
      const result = await api.startSessionProxy(sessionId);
      if (!result.ok) throw new Error(result.error);
      if (!result.value.available) throw new Error("The session's SOCKS5 proxy is unavailable. Choose another route or try again.");
      setCreatedProxies((current) => [...current.filter((proxy) => proxy.id !== result.value.id), { ...result.value, viaSessionId: result.value.viaSessionId ?? sessionId }]);
      setRoute(result.value.id);
    } catch (cause) {
      setSessionProxyError(cause instanceof Error ? cause.message : "The session's SOCKS5 proxy could not be started.");
    } finally { operationPending.current = false; setPending(undefined); }
  };

  const openNetworkManager = async (): Promise<void> => {
    if (networkManagerPending.current || operationPending.current) return;
    networkManagerPending.current = true; setOpeningNetworkManager(true); setError(undefined);
    try {
      const result = await api.openNetworkManager();
      if (!result.ok) throw new Error(result.error);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The Network manager could not be opened."); }
    finally { networkManagerPending.current = false; setOpeningNetworkManager(false); }
  };

  const updateClipboard = async (selected: boolean): Promise<void> => {
    if (pending || preferencesPending) return;
    const previous = clipboard;
    setClipboardDraft(selected);
    setError(undefined);
    if (!applicationSettings) return;
    setSavingClipboard(true);
    try {
      const saved = await applicationSettings.updateSettings((current) => ({
        ...current, rdp: { ...current.rdp, clipboard: selected },
      }));
      if (!saved) throw new Error("The clipboard preference could not be saved. Try again.");
    } catch {
      setClipboardDraft(previous);
      setError("The clipboard preference could not be saved. Try again.");
    } finally { setSavingClipboard(false); }
  };

  const submit = async (action: "connect" | "save"): Promise<void> => {
    if (operationPending.current || preferencesPending || sessionRoute || (temporary && action === "save")) return;
    setError(undefined);
    setSubmitted(action);
    const errors = validateRdpConnectForm(formValues, action === "connect" && !canUseSavedCredential, action === "connect");
    const firstInvalid = Object.keys(errors)[0];
    if (firstInvalid) {
      if (firstInvalid.startsWith("proxy")) setNetworkingOpen(true);
      formRef.current?.querySelector<HTMLInputElement>(`input[name="${firstInvalid}"]`)?.focus();
      return;
    }
    if (action === "connect" && networking?.kind === "socks5" && !availableProxies.some((proxy) => proxy.id === networking.proxyId && proxy.available)) {
      setNetworkingOpen(true);
      setError("The selected SOCKS5 proxy is unavailable. Choose an available proxy or Direct.");
      return;
    }
    const input = values();
    operationPending.current = true;
    setPending(action);
    try {
      const sameConnectionMode = savedSignInMode === (remoteScreen ? "remote-screen" : "nla") && savedNetworkingKey === rdpNetworkingKey(networking);
      let selectedProfileId = sameConnectionMode ? profileId : undefined;
      if (!temporary && (action === "save" || (!remoteScreen && persistence !== "none" && !selectedProfileId))) {
        // An unsaved sign-in or route change must not use another profile's
        // credentials. Remembering the changed connection creates a new profile.
        const { id: _previousId, ...newProfile } = input;
        const saved = await api.saveProfile(action === "save" || sameConnectionMode ? input : newProfile);
        if (!saved.ok) throw new Error(saved.error);
        selectedProfileId = saved.value.id;
        setProfileId(selectedProfileId);
        setSavedSignInMode(saved.value.signInMode ?? "nla");
        setSavedNetworkingKey(rdpNetworkingKey(saved.value.networking));
        setCredentialProfile(saved.value);
        onProfileSaved();
        if (action === "save") {
          toast.success("Profile saved", { description: remoteScreen ? "Sign in after the remote screen opens." : "Passwords are stored only when you connect with a remember option." });
          return;
        }
      }
      const connection: RdpConnectInput = {
        host: input.host, port: input.port, username: input.username, domain: input.domain, width: input.width, height: input.height,
        clipboard: input.clipboard, label: input.label, scaleMode: input.scaleMode, persistence: temporary || remoteScreen ? "none" : persistence,
        ...(remoteScreen ? { signInMode: "remote-screen" as const } : {}),
        ...(input.networking ? { networking: input.networking } : {}),
        ...(manualProxy && proxyUsername.trim() ? { proxyPassword } : {}),
        ...(temporary ? { temporaryId: temporary.id } : selectedProfileId ? { profileId: selectedProfileId } : {}),
        ...((remoteScreen || (canUseSavedCredential && password === "")) ? {} : { password }),
      };
      setPassword(""); setProxyPassword("");
      let submitted: ReturnType<RdpWindowAPI["connect"]>;
      try { submitted = api.connect(connection); }
      finally {
        // The synchronous bridge call copies this request into the isolated world.
        delete (connection as { password?: string }).password;
        delete (connection as { proxyPassword?: string }).proxyPassword;
      }
      const result = await submitted;
      if (!result.ok) throw new Error(result.error);
      onConnected(result.value.id);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The connection could not be started.";
      setError(message);
      // Consuming a temporary request can unmount this dialog before the native
      // connection finishes, so its failure must also survive outside the form.
      if (temporary) toast.danger("Could not start Remote Desktop", { description: message });
    } finally { setPassword(""); setProxyPassword(""); setPending(undefined); operationPending.current = false; }
  };

  const close = async (): Promise<void> => {
    if (operationPending.current) return;
    setPassword(""); setProxyPassword("");
    if (!temporary) { onClose(); return; }
    operationPending.current = true;
    setPending("cancel"); setError(undefined);
    try {
      const result = await api.cancelTemporary(temporary.id);
      if (!result.ok) throw new Error(result.error);
      onClose();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The temporary connection could not be canceled.";
      setError(message);
      if (temporary) toast.danger("Could not cancel Remote Desktop", { description: message });
    } finally { setPending(undefined); operationPending.current = false; }
  };

  return <Modal.Backdrop isOpen isDismissable={!pending} isKeyboardDismissDisabled={Boolean(pending)} variant="blur" onOpenChange={(open) => { if (!open) void close(); }}>
    <Modal.Container size="lg" placement="center"><Modal.Dialog className="w-full max-w-[640px]">
      <Modal.CloseTrigger isDisabled={Boolean(pending)} />
      <Modal.Header><Modal.Heading className="flex items-center gap-2 pr-8">
        <FontAwesomeIcon aria-hidden icon={faWindows} />
        {temporary ? "Connect to Remote Desktop" : initial ? "Edit Remote Desktop" : "New Remote Desktop"}
      </Modal.Heading>
      </Modal.Header>
      <Modal.Body className="max-h-[65vh] overflow-y-auto"
        render={(props) => <ScrollShadow {...props} hideScrollBar={false} size={28} />}>
        <form ref={formRef} id={formId} noValidate className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void submit("connect"); }}>
          <TextField {...fieldProps("label")} value={label} onChange={setLabel} isDisabled={Boolean(pending)}>
            <Label>Connection name</Label><Input variant="secondary" maxLength={120} placeholder="Optional display name" />
            {fieldError("label") && <FieldError>{fieldError("label")}</FieldError>}
          </TextField>
          <div className="grid grid-cols-[1fr_7rem] gap-4">
            <TextField {...fieldProps("host")} value={host} onChange={(value) => { setHost(value); if (value.trim().toLowerCase() !== host.trim().toLowerCase()) clearIdentitySecrets(); }} isRequired isReadOnly={Boolean(temporary)} isDisabled={Boolean(pending)}>
              <Label>Computer</Label><Input variant="secondary" autoFocus={!temporary} maxLength={253} placeholder="hostname or IP address" autoComplete="off" />
              {fieldError("host") && <FieldError className="text-balance">{fieldError("host")}</FieldError>}
            </TextField>
            <TextField {...fieldProps("port")} value={port} onChange={(value) => { setPort(value); if (Number(value) !== Number(port)) clearIdentitySecrets(); }} isRequired isReadOnly={Boolean(temporary)} isDisabled={Boolean(pending)}>
              <Label>Port</Label><Input variant="secondary" inputMode="numeric" maxLength={5} />
              {fieldError("port") && <FieldError className="text-balance">{fieldError("port")}</FieldError>}
            </TextField>
          </div>
          <SwitchRow label="Sign in on the remote screen" description="Requires a server that allows connections without NLA."
            selected={remoteScreen} disabled={Boolean(pending)} onChange={(selected) => {
              setRemoteScreen(selected); setUsername(""); setDomain(""); clearIdentitySecrets(); setSubmitted(undefined); setTouched({});
            }} />
          {!remoteScreen && <><div className="grid grid-cols-2 gap-4">
            <TextField {...fieldProps("username")} value={username} onChange={(value) => { setUsername(value); if (value.trim() !== username.trim()) clearIdentitySecrets(); }} isRequired isDisabled={Boolean(pending)}>
              <Label>Username</Label><Input variant="secondary" autoFocus={Boolean(temporary)} maxLength={256} autoComplete="off" placeholder="Administrator" />
              {fieldError("username") && <FieldError>{fieldError("username")}</FieldError>}
            </TextField>
            <TextField {...fieldProps("domain")} value={domain} onChange={(value) => { setDomain(value); if (value.trim() !== domain.trim()) clearIdentitySecrets(); }} isDisabled={Boolean(pending)}>
              <Label>Domain</Label><Input variant="secondary" maxLength={256} autoComplete="off" placeholder="Optional" />
              {fieldError("domain") && <FieldError>{fieldError("domain")}</FieldError>}
            </TextField>
          </div>
          <TextField {...fieldProps("password")} value={password} onChange={setPassword} isRequired={!canUseSavedCredential} isDisabled={Boolean(pending)}>
            <Label>Password</Label><Input variant="secondary" type="password" maxLength={4096} autoComplete="new-password" placeholder={canUseSavedCredential ? "Use saved credential" : "Windows account password"} />
            {fieldError("password") && <FieldError>{fieldError("password")}</FieldError>}
          </TextField>
          {!temporary && <div className="grid gap-2"><Label htmlFor={`${formId}-remember`}>Remember password</Label>
            <Dropdown>
              <Button type="button" id={`${formId}-remember`} aria-label="Remember password" data-selected-value={persistence} variant="secondary" fullWidth
                className="justify-between" isDisabled={Boolean(pending)}>
                <span className="truncate">{PERSISTENCE_CHOICES.find((choice) => choice.value === persistence)?.label}</span><FontAwesomeIcon aria-hidden icon={faChevronDown} className="size-3 shrink-0 text-muted" />
              </Button>
              <Dropdown.Popover placement="bottom start" className="max-h-80 w-[var(--trigger-width)] max-w-[calc(100vw-2rem)]">
                <Dropdown.Menu aria-label="Remember password" selectionMode="single" selectedKeys={new Set([persistence])} onAction={(key) => {
                  const choice = PERSISTENCE_CHOICES.find((item) => item.value === key);
                  if (!operationPending.current && choice && (choice.value !== "secure" || securePersistenceAvailable)) setPersistence(choice.value);
                }}>
                  {PERSISTENCE_CHOICES.map((choice) => <Dropdown.Item key={choice.value} id={choice.value} data-selected-value={choice.value}
                    textValue={choice.label} isDisabled={choice.value === "secure" && !securePersistenceAvailable}>
                    <Dropdown.ItemIndicator className="shrink-0 text-accent" /><Label>{choice.label}</Label>
                  </Dropdown.Item>)}
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          </div>}
          {!temporary && !securePersistenceAvailable && <p className="text-xs text-muted">Secure password storage is unavailable. Passwords can be remembered until the app quits.</p>}</>}
          <div className="grid gap-2"><Label htmlFor={`${formId}-resolution`}>Desktop resolution</Label>
            <Dropdown>
              <Button type="button" id={`${formId}-resolution`} aria-label="Desktop resolution" data-selected-value={resolution} variant="secondary" fullWidth
                className="justify-between" isDisabled={Boolean(pending)}>
                <span className="truncate">{RESOLUTION_CHOICES.find((choice) => choice.value === resolution)?.label}</span><FontAwesomeIcon aria-hidden icon={faChevronDown} className="size-3 shrink-0 text-muted" />
              </Button>
              <Dropdown.Popover placement="bottom start" className="max-h-80 w-[var(--trigger-width)] max-w-[calc(100vw-2rem)]">
                <Dropdown.Menu aria-label="Desktop resolution" selectionMode="single" selectedKeys={new Set([resolution])} onAction={(key) => {
                  const next = String(key);
                  if (operationPending.current || !RESOLUTION_CHOICES.some((choice) => choice.value === next)) return;
                  if (next === "custom" && !customSizeEdited && preset) {
                    setWidth(String(preset.width)); setHeight(String(preset.height));
                  }
                  setResolution(next);
                }}>
                  {RESOLUTION_CHOICES.map((choice) => <Dropdown.Item key={choice.value} id={choice.value} data-selected-value={choice.value} textValue={choice.label}>
                    <Dropdown.ItemIndicator className="shrink-0 text-accent" /><Label>{choice.label}</Label>
                  </Dropdown.Item>)}
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          </div>
          {resolution === "custom" && <div className="grid grid-cols-2 gap-4">
            <TextField {...fieldProps("width")} value={width} onChange={(value) => { setWidth(value); setCustomSizeEdited(true); }} isRequired isDisabled={Boolean(pending)}>
              <Label>Desktop width</Label><Input variant="secondary" inputMode="numeric" maxLength={4} />
              {fieldError("width") && <FieldError>{fieldError("width")}</FieldError>}
            </TextField>
            <TextField {...fieldProps("height")} value={height} onChange={(value) => { setHeight(value); setCustomSizeEdited(true); }} isRequired isDisabled={Boolean(pending)}>
              <Label>Desktop height</Label><Input variant="secondary" inputMode="numeric" maxLength={4} />
              {fieldError("height") && <FieldError>{fieldError("height")}</FieldError>}
            </TextField>
          </div>}
          <SwitchRow label="Clipboard" description="Use the toolbar to send or receive text and files for this connection." selected={clipboard}
            onChange={(selected) => { void updateClipboard(selected); }} disabled={Boolean(pending) || preferencesPending} />
          <Disclosure isExpanded={networkingOpen} onExpandedChange={setNetworkingOpen} className="rounded-xl bg-surface-secondary">
            <Disclosure.Heading><Disclosure.Trigger className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium">
              <span className="flex items-center gap-2"><FontAwesomeIcon aria-hidden icon={faRoute} className="size-3.5 text-muted" />Networking</span>
              <Disclosure.Indicator><FontAwesomeIcon aria-hidden icon={faChevronDown} className="size-3 text-muted" /></Disclosure.Indicator>
            </Disclosure.Trigger></Disclosure.Heading>
            <Disclosure.Content><Disclosure.Body className="grid gap-2 px-4 pb-4">
              {temporary ? <p className="text-sm text-muted">This temporary connection uses the selected Sliver session.</p> : <>
                <div className="grid gap-2"><Label htmlFor={`${formId}-route`}>Connection route</Label>
                  <Dropdown>
                    <Button type="button" id={`${formId}-route`} aria-label="Connection route" data-route-value={route} variant="secondary" fullWidth
                      className="justify-between" isDisabled={Boolean(pending)}>
                      <span className="truncate">{routeLabel(selectedRoute)}</span><FontAwesomeIcon aria-hidden icon={faChevronDown} className="size-3 shrink-0 text-muted" />
                    </Button>
                    <Dropdown.Popover placement="bottom start" className="max-h-80 w-[var(--trigger-width)] min-w-80 max-w-[calc(100vw-2rem)]">
                      <Dropdown.Menu aria-label="Connection route" selectionMode="single" selectedKeys={new Set([selectedMenuKey])}
                        onAction={(key) => { void selectRoute(key === "direct" ? "" : String(key)); }}>
                        {routeChoices.map((choice) => <Dropdown.Item key={choice.value || "direct"} id={choice.value || "direct"}
                          data-route-value={choice.value} textValue={`${choice.label}${choice.description ? ` ${choice.description}` : ""}`} isDisabled={Boolean(choice.disabled)}>
                          <Dropdown.ItemIndicator className="shrink-0 text-accent" />
                          <div className="min-w-0 flex-1">
                            <Label className="block truncate">{routeLabel(choice)}</Label>
                            {choice.description && <Description className="block break-all font-mono text-xs">{choice.description}</Description>}
                          </div>
                        </Dropdown.Item>)}
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown>
                </div>
                {pending === "proxy" && <p role="status" className="text-xs text-muted">Starting SOCKS5 proxy…</p>}
                {sessionProxyError && <p role="alert" className="text-sm text-danger">{sessionProxyError}</p>}
                {manualProxy ? <div className="mt-2 grid gap-4">
                  <div className="grid grid-cols-[1fr_7rem] gap-4">
                    <TextField {...fieldProps("proxyHost")} value={proxyHost} onChange={(value) => { setProxyHost(value); if (value.trim().toLowerCase() !== proxyHost.trim().toLowerCase()) clearIdentitySecrets(); }} isRequired isDisabled={Boolean(pending)}>
                      <Label>Proxy address</Label><Input variant="secondary" maxLength={253} autoComplete="off" placeholder="hostname or IP address" />
                      {fieldError("proxyHost") && <FieldError>{fieldError("proxyHost")}</FieldError>}
                    </TextField>
                    <TextField {...fieldProps("proxyPort")} value={proxyPort} onChange={(value) => { setProxyPort(value); if (Number(value) !== Number(proxyPort)) clearIdentitySecrets(); }} isRequired isDisabled={Boolean(pending)}>
                      <Label>Proxy port</Label><Input variant="secondary" inputMode="numeric" maxLength={5} />
                      {fieldError("proxyPort") && <FieldError>{fieldError("proxyPort")}</FieldError>}
                    </TextField>
                  </div>
                  <TextField {...fieldProps("proxyUsername")} value={proxyUsername} onChange={(value) => { setProxyUsername(value); if (value !== proxyUsername) clearIdentitySecrets(); }} isDisabled={Boolean(pending)}>
                    <Label>Proxy username</Label><Input variant="secondary" maxLength={255} autoComplete="off" placeholder="Optional" />
                    {fieldError("proxyUsername") && <FieldError>{fieldError("proxyUsername")}</FieldError>}
                  </TextField>
                  {proxyUsername.trim() && <><TextField {...fieldProps("proxyPassword")} value={proxyPassword} onChange={setProxyPassword} isRequired isDisabled={Boolean(pending)}>
                    <Label>Proxy password</Label><Input variant="secondary" type="password" maxLength={255} autoComplete="new-password" />
                    {fieldError("proxyPassword") && <FieldError>{fieldError("proxyPassword")}</FieldError>}
                  </TextField><p className="text-xs text-muted">Proxy passwords are not remembered.</p></>}
                </div> : !sessionRoute && !availableProxies.some((proxy) => proxy.available) && !socks5Sessions.length && <p className="text-xs text-muted">No active Sliver sessions or managed SOCKS5 proxies are available.</p>}
                <Button size="sm" variant="tertiary" className="mt-1 justify-self-start" isPending={openingNetworkManager} isDisabled={Boolean(pending) || openingNetworkManager} onPress={() => { void openNetworkManager(); }}>
                  <FontAwesomeIcon aria-hidden icon={faArrowUpRightFromSquare} />Open Network manager
                </Button>
              </>}
            </Disclosure.Body></Disclosure.Content>
          </Disclosure>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </form>
      </Modal.Body>
      <Modal.Footer className="flex-wrap"><Button variant="tertiary" isDisabled={Boolean(pending)} isPending={pending === "cancel"} onPress={() => void close()}>Cancel</Button>
        {!temporary && <Button variant="secondary" isDisabled={Boolean(pending) || preferencesPending || sessionRoute} isPending={pending === "save"} onPress={() => void submit("save")}>Save profile</Button>}
        <Button type="submit" form={formId} isPending={pending === "connect"} isDisabled={Boolean(pending) || preferencesPending || sessionRoute}>Connect</Button>
      </Modal.Footer>
    </Modal.Dialog></Modal.Container>
  </Modal.Backdrop>;
}
