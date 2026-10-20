import { useId, useState } from "react";
import { Button, Input, Label, Modal, TextField } from "@heroui/react";
import { NativeSelect } from "@heroui-pro/react/native-select";
import type { RdpCredentialPersistence, RdpProfile } from "../../../../shared/rdp-contracts";

interface Props {
  readonly profile: RdpProfile;
  readonly securePersistenceAvailable: boolean;
  readonly pending: boolean;
  readonly error: string | undefined;
  readonly onClose: () => void;
  readonly onConnect: (password: string, persistence: RdpCredentialPersistence) => void;
}

export function RdpProfilePasswordDialog({ profile, securePersistenceAvailable, pending, error, onClose, onConnect }: Props): React.JSX.Element {
  const formId = useId();
  const [password, setPassword] = useState("");
  const [persistence, setPersistence] = useState<RdpCredentialPersistence>(
    profile.credentialPersistence === "secure" && !securePersistenceAvailable ? "none" : profile.credentialPersistence,
  );
  const account = profile.domain ? `${profile.domain}\\${profile.username}` : profile.username;
  return <Modal.Backdrop isOpen isDismissable={!pending} isKeyboardDismissDisabled={pending} variant="blur"
    onOpenChange={(open) => { if (!open) onClose(); }}>
    <Modal.Container size="sm"><Modal.Dialog>
      <Modal.CloseTrigger isDisabled={pending} />
      <Modal.Header><Modal.Heading className="break-words pr-8">Connect to {profile.label}</Modal.Heading></Modal.Header>
      <Modal.Body>
        <form id={formId} className="grid gap-4" onSubmit={(event) => {
          event.preventDefault();
          if (pending || !password) return;
          const submitted = password;
          setPassword("");
          onConnect(submitted, persistence);
        }}>
          <p className="break-all text-sm text-muted">Enter the password for {account} on {profile.host}.</p>
          <TextField value={password} onChange={setPassword} isRequired isDisabled={pending}>
            <Label>Password</Label><Input autoFocus variant="secondary" type="password" autoComplete="new-password" maxLength={4096} />
          </TextField>
          <NativeSelect fullWidth variant="secondary">
            <Label htmlFor={`${formId}-remember`}>Remember password</Label>
            <NativeSelect.Trigger id={`${formId}-remember`} value={persistence} disabled={pending}
              onChange={(event) => setPersistence(event.target.value as RdpCredentialPersistence)}>
              <NativeSelect.Option value="none">Do not save</NativeSelect.Option>
              <NativeSelect.Option value="session">Until the app quits</NativeSelect.Option>
              <NativeSelect.Option value="secure" disabled={!securePersistenceAvailable}>Save securely on this device</NativeSelect.Option>
            </NativeSelect.Trigger>
          </NativeSelect>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </form>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" isDisabled={pending} onPress={onClose}>Cancel</Button>
        <Button type="submit" form={formId} isPending={pending} isDisabled={pending || !password}>Connect</Button>
      </Modal.Footer>
    </Modal.Dialog></Modal.Container>
  </Modal.Backdrop>;
}
