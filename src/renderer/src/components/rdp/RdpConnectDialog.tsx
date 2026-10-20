import { useId, useState } from "react";
import { Button, Input, Label, Modal, TextField } from "@heroui/react";
import { NativeSelect } from "@heroui-pro/react/native-select";
import type { RdpConnectInput, RdpCredentialPersistence, RdpProfile, RdpSaveProfileInput, RdpWindowAPI } from "../../../../shared/rdp-contracts";
import { SwitchRow } from "../FormControls";

interface Props {
  readonly api: RdpWindowAPI;
  readonly securePersistenceAvailable: boolean;
  readonly initial?: RdpProfile | undefined;
  readonly onClose: () => void;
  readonly onConnected: (tabId: string) => void;
  readonly onProfileSaved: () => void;
}

export function RdpConnectDialog({ api, securePersistenceAvailable, initial, onClose, onConnected, onProfileSaved }: Props): React.JSX.Element {
  const formId = useId();
  const [label, setLabel] = useState(initial?.label ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(String(initial?.port ?? 3389));
  const [username, setUsername] = useState(initial?.username ?? "");
  const [domain, setDomain] = useState(initial?.domain ?? "");
  const [password, setPassword] = useState("");
  const [persistence, setPersistence] = useState<RdpCredentialPersistence>(initial?.credentialPersistence === "secure" && !securePersistenceAvailable ? "none" : initial?.credentialPersistence ?? "none");
  const [width, setWidth] = useState(String(initial?.width ?? 1280));
  const [height, setHeight] = useState(String(initial?.height ?? 800));
  const [clipboard, setClipboard] = useState(initial?.clipboard ?? false);
  const [profileId, setProfileId] = useState(initial?.id);
  const [pending, setPending] = useState<"connect" | "save">();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const values = (): RdpSaveProfileInput => {
    const portNumber = Number(port);
    const desktopWidth = Number(width);
    const desktopHeight = Number(height);
    if (!host.trim() || host.trim().length > 253 || /[\s/\\@]/u.test(host.trim())) throw new Error("Enter a hostname or IP address without a scheme or path.");
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new Error("Use a port between 1 and 65535.");
    if (!username.trim()) throw new Error("Enter the Windows username.");
    if (![desktopWidth, desktopHeight].every((value) => Number.isInteger(value) && value >= 200 && value <= 8192) || desktopWidth * desktopHeight > 16_777_216) {
      throw new Error("Use desktop dimensions from 200 to 8192 pixels, with at most 16 million pixels in total.");
    }
    return { ...(profileId ? { id: profileId } : {}), label: label.trim() || host.trim().slice(0, 120), host: host.trim(), port: portNumber,
      username: username.trim(), domain: domain.trim(), width: desktopWidth, height: desktopHeight, clipboard,
      scaleMode: initial?.scaleMode ?? "fit" };
  };

  const submit = async (action: "connect" | "save"): Promise<void> => {
    if (pending) return;
    setError(undefined);
    setNotice(undefined);
    let input: RdpSaveProfileInput;
    try { input = values(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Review the connection settings."); return; }
    setPending(action);
    try {
      let selectedProfileId = profileId;
      if (action === "save" || (persistence !== "none" && !selectedProfileId)) {
        const saved = await api.saveProfile(input);
        if (!saved.ok) throw new Error(saved.error);
        selectedProfileId = saved.value.id;
        setProfileId(selectedProfileId);
        onProfileSaved();
        if (action === "save") { setNotice("Profile saved. Passwords are stored only when you connect with a remember option."); return; }
      }
      const connection: RdpConnectInput = {
        host: input.host, port: input.port, username: input.username, domain: input.domain, width: input.width, height: input.height,
        clipboard: input.clipboard, label: input.label, scaleMode: input.scaleMode, persistence,
        ...(selectedProfileId ? { profileId: selectedProfileId } : {}),
        ...((initial?.hasCredential && password === "") ? {} : { password }),
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
      <Modal.Header><Modal.Heading>{initial ? "Connect to Remote Desktop" : "New Remote Desktop"}</Modal.Heading>
        <p className="text-sm text-muted">Connect directly to a Windows computer using Network Level Authentication.</p>
      </Modal.Header>
      <Modal.Body className="max-h-[65vh] overflow-y-auto">
        <form id={formId} className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void submit("connect"); }}>
          <TextField value={label} onChange={setLabel} isDisabled={Boolean(pending)}><Label>Connection name</Label><Input maxLength={120} placeholder="Optional display name" /></TextField>
          <div className="grid grid-cols-[1fr_7rem] gap-4">
            <TextField value={host} onChange={setHost} isRequired isDisabled={Boolean(pending)}><Label>Computer</Label><Input autoFocus maxLength={255} placeholder="hostname or IP address" autoComplete="off" /></TextField>
            <TextField value={port} onChange={setPort} isRequired isDisabled={Boolean(pending)}><Label>Port</Label><Input inputMode="numeric" maxLength={5} /></TextField>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <TextField value={username} onChange={setUsername} isRequired isDisabled={Boolean(pending)}><Label>Username</Label><Input maxLength={256} autoComplete="off" placeholder="Administrator" /></TextField>
            <TextField value={domain} onChange={setDomain} isDisabled={Boolean(pending)}><Label>Domain</Label><Input maxLength={255} autoComplete="off" placeholder="Optional" /></TextField>
          </div>
          <TextField value={password} onChange={setPassword} isDisabled={Boolean(pending)}><Label>Password</Label><Input type="password" maxLength={4096} autoComplete="new-password" placeholder={initial?.hasCredential ? "Use saved credential" : "Windows account password"} /></TextField>
          <NativeSelect fullWidth><Label htmlFor={`${formId}-remember`}>Remember password</Label>
            <NativeSelect.Trigger id={`${formId}-remember`} aria-label="Remember password" value={persistence} disabled={Boolean(pending)} onChange={(event) => setPersistence(event.target.value as RdpCredentialPersistence)}>
              <NativeSelect.Option value="none">Do not save</NativeSelect.Option><NativeSelect.Option value="session">Until the app quits</NativeSelect.Option>
              <NativeSelect.Option value="secure" disabled={!securePersistenceAvailable}>Save securely on this device</NativeSelect.Option>
            </NativeSelect.Trigger>
          </NativeSelect>
          {!securePersistenceAvailable && <p className="text-xs text-muted">Secure password storage is unavailable. Passwords can be remembered until the app quits.</p>}
          <div className="grid grid-cols-2 gap-4">
            <TextField value={width} onChange={setWidth} isDisabled={Boolean(pending)}><Label>Desktop width</Label><Input inputMode="numeric" maxLength={4} /></TextField>
            <TextField value={height} onChange={setHeight} isDisabled={Boolean(pending)}><Label>Desktop height</Label><Input inputMode="numeric" maxLength={4} /></TextField>
          </div>
          <SwitchRow label="Text clipboard" description="Use the toolbar to send or receive clipboard text for this connection." selected={clipboard} onChange={setClipboard} disabled={Boolean(pending)} />
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          {notice && <p role="status" className="text-sm text-muted">{notice}</p>}
        </form>
      </Modal.Body>
      <Modal.Footer className="flex-wrap"><Button variant="tertiary" isDisabled={Boolean(pending)} onPress={onClose}>Cancel</Button>
        <Button variant="secondary" isDisabled={Boolean(pending)} isPending={pending === "save"} onPress={() => void submit("save")}>Save profile</Button>
        <Button type="submit" form={formId} isPending={pending === "connect"} isDisabled={Boolean(pending)}>Connect</Button>
      </Modal.Footer>
    </Modal.Dialog></Modal.Container>
  </Modal.Backdrop>;
}
