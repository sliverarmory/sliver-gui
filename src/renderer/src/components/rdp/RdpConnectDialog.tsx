import { useId, useRef, useState } from "react";
import { Button, FieldError, Input, Label, Modal, ScrollShadow, TextField, toast } from "@heroui/react";
import { NativeSelect } from "@heroui-pro/react/native-select";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faWindows } from "@fortawesome/free-brands-svg-icons";
import type { RdpConnectInput, RdpCredentialPersistence, RdpProfile, RdpSaveProfileInput, RdpWindowAPI } from "../../../../shared/rdp-contracts";
import { useApplicationSettings } from "../ApplicationSettingsProvider";
import { SwitchRow } from "../FormControls";
import { RDP_RESOLUTIONS, validateRdpConnectForm, type RdpConnectFormField } from "./rdp-connect-form";

interface Props {
  readonly api: RdpWindowAPI;
  readonly securePersistenceAvailable: boolean;
  readonly initial?: RdpProfile | undefined;
  readonly onClose: () => void;
  readonly onConnected: (tabId: string) => void;
  readonly onProfileSaved: () => void;
}

export function RdpConnectDialog({ api, securePersistenceAvailable, initial, onClose, onConnected, onProfileSaved }: Props): React.JSX.Element {
  const applicationSettings = useApplicationSettings();
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [label, setLabel] = useState(initial?.label ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(String(initial?.port ?? 3389));
  const [username, setUsername] = useState(initial?.username ?? "");
  const [domain, setDomain] = useState(initial?.domain ?? "");
  const [password, setPassword] = useState("");
  const [persistence, setPersistence] = useState<RdpCredentialPersistence>(initial?.credentialPersistence === "secure" && !securePersistenceAvailable ? "none" : initial?.credentialPersistence ?? "none");
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
  const [credentialProfile, setCredentialProfile] = useState(initial);
  const [pending, setPending] = useState<"connect" | "save">();
  const [error, setError] = useState<string>();
  const [touched, setTouched] = useState<Partial<Record<RdpConnectFormField, boolean>>>({});
  const [submitted, setSubmitted] = useState<"connect" | "save">();
  const preset = RDP_RESOLUTIONS.find((size) => size.value === resolution);
  const formValues = { label, host, port, username, domain, password,
    width: preset ? String(preset.width) : width, height: preset ? String(preset.height) : height };
  const canUseSavedCredential = Boolean(credentialProfile?.hasCredential &&
    credentialProfile.host.toLowerCase() === host.trim().toLowerCase() && credentialProfile.port === Number(port) &&
    credentialProfile.username === username.trim() && credentialProfile.domain === domain.trim());
  const validationErrors = validateRdpConnectForm(formValues, submitted !== "save" && !canUseSavedCredential);
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
      username: username.trim(), domain: domain.trim(), width: desktopWidth, height: desktopHeight, clipboard,
      scaleMode: initial?.scaleMode ?? "fit" };
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
    if (pending || preferencesPending) return;
    setError(undefined);
    setSubmitted(action);
    const errors = validateRdpConnectForm(formValues, action === "connect" && !canUseSavedCredential);
    const firstInvalid = Object.keys(errors)[0];
    if (firstInvalid) {
      formRef.current?.querySelector<HTMLInputElement>(`input[name="${firstInvalid}"]`)?.focus();
      return;
    }
    const input = values();
    setPending(action);
    try {
      let selectedProfileId = profileId;
      if (action === "save" || (persistence !== "none" && !selectedProfileId)) {
        const saved = await api.saveProfile(input);
        if (!saved.ok) throw new Error(saved.error);
        selectedProfileId = saved.value.id;
        setProfileId(selectedProfileId);
        setCredentialProfile(saved.value);
        onProfileSaved();
        if (action === "save") {
          toast.success("Profile saved", { description: "Passwords are stored only when you connect with a remember option." });
          return;
        }
      }
      const connection: RdpConnectInput = {
        host: input.host, port: input.port, username: input.username, domain: input.domain, width: input.width, height: input.height,
        clipboard: input.clipboard, label: input.label, scaleMode: input.scaleMode, persistence,
        ...(selectedProfileId ? { profileId: selectedProfileId } : {}),
        ...((canUseSavedCredential && password === "") ? {} : { password }),
      };
      setPassword("");
      const submitted = api.connect(connection);
      // The synchronous bridge call copies this request into the isolated world.
      delete (connection as { password?: string }).password;
      const result = await submitted;
      if (!result.ok) throw new Error(result.error);
      onConnected(result.value.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The connection could not be started.");
    } finally { setPassword(""); setPending(undefined); }
  };

  return <Modal.Backdrop isOpen isDismissable={!pending} isKeyboardDismissDisabled={Boolean(pending)} variant="blur" onOpenChange={(open) => { if (!open) { setPassword(""); onClose(); } }}>
    <Modal.Container size="md" placement="center"><Modal.Dialog>
      <Modal.CloseTrigger isDisabled={Boolean(pending)} />
      <Modal.Header><Modal.Heading className="flex items-center gap-2 pr-8">
        <FontAwesomeIcon aria-hidden icon={faWindows} />
        {initial ? "Edit Remote Desktop" : "New Remote Desktop"}
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
            <TextField {...fieldProps("host")} value={host} onChange={setHost} isRequired isDisabled={Boolean(pending)}>
              <Label>Computer</Label><Input variant="secondary" autoFocus maxLength={253} placeholder="hostname or IP address" autoComplete="off" />
              {fieldError("host") && <FieldError className="text-balance">{fieldError("host")}</FieldError>}
            </TextField>
            <TextField {...fieldProps("port")} value={port} onChange={setPort} isRequired isDisabled={Boolean(pending)}>
              <Label>Port</Label><Input variant="secondary" inputMode="numeric" maxLength={5} />
              {fieldError("port") && <FieldError className="text-balance">{fieldError("port")}</FieldError>}
            </TextField>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <TextField {...fieldProps("username")} value={username} onChange={setUsername} isRequired isDisabled={Boolean(pending)}>
              <Label>Username</Label><Input variant="secondary" maxLength={256} autoComplete="off" placeholder="Administrator" />
              {fieldError("username") && <FieldError>{fieldError("username")}</FieldError>}
            </TextField>
            <TextField {...fieldProps("domain")} value={domain} onChange={setDomain} isDisabled={Boolean(pending)}>
              <Label>Domain</Label><Input variant="secondary" maxLength={256} autoComplete="off" placeholder="Optional" />
              {fieldError("domain") && <FieldError>{fieldError("domain")}</FieldError>}
            </TextField>
          </div>
          <TextField {...fieldProps("password")} value={password} onChange={setPassword} isRequired={!canUseSavedCredential} isDisabled={Boolean(pending)}>
            <Label>Password</Label><Input variant="secondary" type="password" maxLength={4096} autoComplete="new-password" placeholder={canUseSavedCredential ? "Use saved credential" : "Windows account password"} />
            {fieldError("password") && <FieldError>{fieldError("password")}</FieldError>}
          </TextField>
          <NativeSelect fullWidth variant="secondary"><Label htmlFor={`${formId}-remember`}>Remember password</Label>
            <NativeSelect.Trigger id={`${formId}-remember`} aria-label="Remember password" value={persistence} disabled={Boolean(pending)} onChange={(event) => setPersistence(event.target.value as RdpCredentialPersistence)}>
              <NativeSelect.Option value="none">Do not save</NativeSelect.Option><NativeSelect.Option value="session">Until the app quits</NativeSelect.Option>
              <NativeSelect.Option value="secure" disabled={!securePersistenceAvailable}>Save securely on this device</NativeSelect.Option>
            </NativeSelect.Trigger>
          </NativeSelect>
          {!securePersistenceAvailable && <p className="text-xs text-muted">Secure password storage is unavailable. Passwords can be remembered until the app quits.</p>}
          <NativeSelect fullWidth variant="secondary">
            <Label htmlFor={`${formId}-resolution`}>Desktop resolution</Label>
            <NativeSelect.Trigger id={`${formId}-resolution`} value={resolution} disabled={Boolean(pending)} onChange={(event) => {
              const next = event.target.value;
              if (next === "custom" && !customSizeEdited && preset) {
                setWidth(String(preset.width)); setHeight(String(preset.height));
              }
              setResolution(next);
            }}>
              {RDP_RESOLUTIONS.map((size) => <NativeSelect.Option key={size.value} value={size.value}>{size.width} × {size.height}</NativeSelect.Option>)}
              <NativeSelect.Option value="custom">Custom</NativeSelect.Option>
            </NativeSelect.Trigger>
          </NativeSelect>
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
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </form>
      </Modal.Body>
      <Modal.Footer className="flex-wrap"><Button variant="tertiary" isDisabled={Boolean(pending)} onPress={onClose}>Cancel</Button>
        <Button variant="secondary" isDisabled={Boolean(pending) || preferencesPending} isPending={pending === "save"} onPress={() => void submit("save")}>Save profile</Button>
        <Button type="submit" form={formId} isPending={pending === "connect"} isDisabled={Boolean(pending) || preferencesPending}>Connect</Button>
      </Modal.Footer>
    </Modal.Dialog></Modal.Container>
  </Modal.Backdrop>;
}
