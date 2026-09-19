import { useId, useRef, useState, type FormEvent } from "react";
import { Alert, Button, Description, FieldError, Input, Label, Modal, TextField } from "@heroui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPen } from "@fortawesome/free-solid-svg-icons";
import {
  CLOUD_DEPLOYMENT_NAME_MAX_LENGTH,
  parseRenameCloudDeploymentInput,
  type CloudDeploymentRecord,
  type RenameCloudDeploymentInput,
} from "../../../shared/cloud-deployment-contracts";
import type { CloudDeploymentAPI } from "../../../shared/cloud-deployment-ipc";

export function RenameCloudDeploymentModal({ api, initial, onCancel, onRenamed }: {
  readonly api: Pick<CloudDeploymentAPI, "renameDeployment">;
  readonly initial: RenameCloudDeploymentInput;
  readonly onCancel: () => void;
  readonly onRenamed: (deployment: CloudDeploymentRecord) => Promise<void>;
}): React.JSX.Element {
  const [name, setName] = useState(initial.name);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const selectedOnOpen = useRef(false);
  const formId = `rename-instance-${useId()}`;
  let parsed: RenameCloudDeploymentInput | undefined;
  try { parsed = parseRenameCloudDeploymentInput({ ...initial, name }); } catch { /* Display validation below. */ }
  const validationError = parsed ? null : `Use 1–${CLOUD_DEPLOYMENT_NAME_MAX_LENGTH} characters without control characters.`;
  const canSave = parsed !== undefined && parsed.name !== initial.name && !isSaving;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSave || !parsed || saving.current) return;
    saving.current = true;
    setIsSaving(true);
    setError(null);
    try {
      const result = await api.renameDeployment(parsed);
      if (!result.ok) {
        setError(result.error ?? "The instance could not be renamed.");
        return;
      }
      await onRenamed(result.value);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The instance could not be renamed.");
    } finally {
      saving.current = false;
      setIsSaving(false);
    }
  };

  return <Modal.Backdrop
    isDismissable={!isSaving}
    isKeyboardDismissDisabled={isSaving}
    isOpen
    variant="blur"
    onOpenChange={(open) => { if (!open && !saving.current) onCancel(); }}
  >
    <Modal.Container placement="center" size="sm">
      <Modal.Dialog className="sm:max-w-[460px]">
        <Modal.CloseTrigger isDisabled={isSaving} />
        <Modal.Header className="flex-row items-start pr-10">
          <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
            <FontAwesomeIcon aria-hidden className="size-4" icon={faPen} />
          </Modal.Icon>
          <div className="min-w-0">
            <Modal.Heading>Rename Instance</Modal.Heading>
            <p className="mt-1 text-sm text-muted">Update the instance’s Name tag.</p>
          </div>
        </Modal.Header>
        <Modal.Body>
          <form className="space-y-4" id={formId} onSubmit={(event) => void submit(event)}>
            {error ? <Alert role="alert" status="danger">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>Could not rename instance</Alert.Title>
                <Alert.Description>{error}</Alert.Description>
              </Alert.Content>
            </Alert> : null}
            <TextField
              fullWidth
              isDisabled={isSaving}
              isInvalid={validationError !== null}
              isRequired
              value={name}
              variant="secondary"
              onChange={(value) => { setName(value); setError(null); }}
            >
              <Label>Name</Label>
              <Input
                autoComplete="off"
                autoFocus
                maxLength={CLOUD_DEPLOYMENT_NAME_MAX_LENGTH}
                onFocus={(event) => {
                  if (selectedOnOpen.current) return;
                  selectedOnOpen.current = true;
                  event.currentTarget.select();
                }}
              />
              {validationError
                ? <FieldError>{validationError}</FieldError>
                : <Description>Up to {CLOUD_DEPLOYMENT_NAME_MAX_LENGTH} characters.</Description>}
            </TextField>
          </form>
        </Modal.Body>
        <Modal.Footer>
          <Button isDisabled={isSaving} variant="tertiary" onPress={onCancel}>Cancel</Button>
          <Button form={formId} isDisabled={!canSave} isPending={isSaving} type="submit" variant="primary">Save</Button>
        </Modal.Footer>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}
