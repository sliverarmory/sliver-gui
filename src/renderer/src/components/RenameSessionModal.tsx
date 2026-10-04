import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  Button,
  Description,
  FieldError,
  Input,
  Label,
  Modal,
  TextField,
  toast,
} from "@heroui/react";
import type { SliverSnapshot } from "../../../shared/contracts";
import {
  OPERATION_INPUT_LIMITS,
  parseTargetOperationInput,
  type TargetOperationInput,
  type TargetOperationRecord,
} from "../../../shared/operation-contracts";
import type { SessionSummary } from "../../../shared/target-contracts";

export interface RenameSessionModalProps {
  readonly session: SessionSummary;
  readonly targetIdentity: string;
  readonly capabilities: SliverSnapshot["targetContext"]["capabilities"];
  readonly onClose: () => void;
  readonly onSubmitted: (operation: TargetOperationRecord) => boolean;
}

export function RenameSessionModal({
  session,
  targetIdentity,
  capabilities,
  onClose,
  onSubmitted,
}: RenameSessionModalProps): React.JSX.Element {
  const formId = `rename-session-${useId()}`;
  const [name, setName] = useState(session.name);
  const [error, setError] = useState<string>();
  const [isPending, setIsPending] = useState(false);
  const activeRef = useRef(false);
  const pendingRef = useRef(false);
  const requestRef = useRef(0);
  const identityRef = useRef(targetIdentity);
  const selectedOnOpenRef = useRef(false);
  identityRef.current = targetIdentity;
  const capability = capabilities.find((candidate) => candidate.id === "target.rename");
  const unavailableReason = capability?.available
    ? undefined
    : capability?.reason?.message ?? "Renaming is unavailable for this session.";
  const normalizedName = name.trim();
  let input: TargetOperationInput | undefined;
  let validationError: string | undefined;
  try {
    input = parseTargetOperationInput({ operationId: "target.rename", name: normalizedName });
  } catch {
    validationError = `Use 1–${OPERATION_INPUT_LIMITS.renameLength} letters, numbers, dots, dashes, or underscores. Names cannot be \".\" or start with \"..\".`;
  }
  const canRename = input !== undefined && normalizedName !== session.name && !unavailableReason && !isPending;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    requestRef.current += 1;
    pendingRef.current = false;
    selectedOnOpenRef.current = false;
    setName(session.name);
    setError(undefined);
    setIsPending(false);
    // Live name updates must not overwrite an in-progress draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetIdentity]);

  const close = (): void => {
    if (!pendingRef.current) onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canRename || !input || pendingRef.current) return;
    const submittedIdentity = targetIdentity;
    const request = ++requestRef.current;
    const isCurrent = (): boolean => activeRef.current
      && requestRef.current === request
      && identityRef.current === submittedIdentity;
    pendingRef.current = true;
    setIsPending(true);
    setError(undefined);
    try {
      const result = await window.sliver.submitTargetOperation(input);
      if (!isCurrent()) return;
      if (!result.ok || !result.value) {
        setError(result.error ?? "The rename was rejected.");
        return;
      }
      if (!onSubmitted(result.value) || !isCurrent()) return;
      if (["failed", "canceled", "partial", "outcome-unknown", "target-disappeared"].includes(result.value.state)) {
        setError(result.value.message ?? "The session could not be renamed.");
        return;
      }
      toast.success("Rename submitted", { description: normalizedName });
      onClose();
    } catch (submitError) {
      if (isCurrent()) setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      if (isCurrent()) {
        pendingRef.current = false;
        setIsPending(false);
      }
    }
  };

  return (
    <Modal.Backdrop
      isDismissable={!isPending}
      isKeyboardDismissDisabled={isPending}
      isOpen
      variant="blur"
      onOpenChange={(isOpen) => { if (!isOpen) close(); }}
    >
      <Modal.Container placement="center" size="sm">
        <Modal.Dialog>
          <Modal.CloseTrigger isDisabled={isPending} />
          <Modal.Header className="pr-10">
            <Modal.Heading>Rename session</Modal.Heading>
            <p className="mt-1 text-sm leading-5 text-muted">Change the session name for {session.hostname}.</p>
          </Modal.Header>
          <Modal.Body>
            <form id={formId} onSubmit={(event) => { void submit(event); }}>
              <TextField
                fullWidth
                isDisabled={isPending}
                isInvalid={Boolean(validationError)}
                isRequired
                value={name}
                variant="secondary"
                onChange={(value) => { setName(value); setError(undefined); }}
              >
                <Label>Session name</Label>
                <Input
                  autoFocus
                  maxLength={OPERATION_INPUT_LIMITS.renameLength}
                  onFocus={(event) => {
                    if (selectedOnOpenRef.current) return;
                    selectedOnOpenRef.current = true;
                    event.currentTarget.select();
                  }}
                />
                {validationError
                  ? <FieldError>{validationError}</FieldError>
                  : <Description>Up to {OPERATION_INPUT_LIMITS.renameLength} letters, numbers, dots, dashes, or underscores.</Description>}
              </TextField>
              {error || unavailableReason ? (
                <p className="mt-3 text-sm text-danger" role="alert">{error ?? unavailableReason}</p>
              ) : null}
            </form>
          </Modal.Body>
          <Modal.Footer>
            <Button isDisabled={isPending} size="sm" variant="secondary" onPress={close}>Cancel</Button>
            <Button form={formId} isDisabled={!canRename} isPending={isPending} size="sm" type="submit">Rename</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
