import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  Button,
  Description,
  FieldError,
  Input,
  Label,
  Modal,
  TextArea,
  TextField,
  toast,
} from "@heroui/react";

import type { SliverSnapshot } from "../../../shared/contracts";
import type { SessionEnvironmentEntry } from "../../../shared/session-contracts";
import {
  OPERATION_INPUT_LIMITS,
  parseTargetOperationInput,
  type TargetOperationInput,
  type TargetOperationRecord,
} from "../../../shared/operation-contracts";

interface EnvironmentVariableModalBaseProps {
  readonly targetIdentity: string;
  readonly capabilities: SliverSnapshot["targetContext"]["capabilities"];
  readonly onClose: () => void;
  readonly onSubmitted: (operation: TargetOperationRecord) => boolean;
}

export type EnvironmentVariableModalProps = EnvironmentVariableModalBaseProps & (
  | {
      readonly mode: "add";
      readonly entry?: never;
    }
  | {
      readonly mode: "edit";
      readonly entry: SessionEnvironmentEntry;
    }
);

const UNSUCCESSFUL_OPERATION_STATES = new Set<TargetOperationRecord["state"]>([
  "failed",
  "canceled",
  "partial",
  "outcome-unknown",
  "target-disappeared",
]);

export function EnvironmentVariableModal(props: EnvironmentVariableModalProps): React.JSX.Element {
  const { mode, targetIdentity, capabilities, onClose, onSubmitted } = props;
  const formId = `environment-variable-${useId()}`;
  const initialName = mode === "edit" ? props.entry.name : "";
  const initialValue = mode === "edit" && !props.entry.redacted ? props.entry.value : "";
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState(initialValue);
  const [isValueDirty, setIsValueDirty] = useState(false);
  const [error, setError] = useState<string>();
  const [isPending, setIsPending] = useState(false);
  const activeRef = useRef(false);
  const pendingRef = useRef(false);
  const requestRef = useRef(0);
  const identityRef = useRef(targetIdentity);
  identityRef.current = targetIdentity;

  const capability = capabilities.find((candidate) => candidate.id === "target.environment.write");
  const unavailableReason = capability?.available
    ? undefined
    : capability?.reason?.message ?? "Environment changes are unavailable for this session.";
  const submittedName = mode === "edit" ? props.entry.name : name.trim();
  const { input, nameValidationError, valueValidationError } = validateDraft(submittedName, value);
  const hasValueChange = mode === "add" || (isValueDirty && (props.entry.redacted || value !== initialValue));
  const canSubmit = input !== undefined && hasValueChange && !unavailableReason && !isPending;
  const heading = mode === "add" ? "Add environment variable" : "Edit environment variable";
  const submitLabel = mode === "add" ? "Add variable" : "Save changes";

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
    setName(initialName);
    setValue(initialValue);
    setIsValueDirty(false);
    setError(undefined);
    setIsPending(false);
    // A target change replaces the modal draft. Changes to a live entry must not
    // overwrite input while this modal remains open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetIdentity]);

  const close = (): void => {
    if (!pendingRef.current) onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSubmit || !input || pendingRef.current) return;
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
        setError(result.error ?? "The environment change was rejected.");
        return;
      }
      if (!onSubmitted(result.value) || !isCurrent()) return;
      if (UNSUCCESSFUL_OPERATION_STATES.has(result.value.state)) {
        setError(result.value.message ?? "The environment variable could not be updated.");
        return;
      }
      toast.success(mode === "add" ? "Environment variable added" : "Environment variable updated", {
        description: submittedName,
      });
      onClose();
    } catch (submitError) {
      if (isCurrent()) setError(errorMessage(submitError));
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
            <Modal.Heading>{heading}</Modal.Heading>
            <p className="mt-1 text-sm leading-5 text-muted">
              {mode === "add"
                ? "Add a variable to the selected session environment."
                : `Replace the value of ${props.entry.name}.`}
            </p>
          </Modal.Header>
          <Modal.Body>
            <form className="flex flex-col gap-4" id={formId} onSubmit={(event) => { void submit(event); }}>
              <TextField
                fullWidth
                isDisabled={isPending}
                isInvalid={Boolean(nameValidationError)}
                isReadOnly={mode === "edit"}
                isRequired
                value={name}
                variant="secondary"
                onChange={(nextName) => {
                  if (mode === "add") setName(nextName);
                  setError(undefined);
                }}
              >
                <Label>Variable name</Label>
                <Input
                  autoFocus={mode === "add"}
                  className="font-mono text-xs"
                  maxLength={OPERATION_INPUT_LIMITS.environmentNameLength}
                  readOnly={mode === "edit"}
                  spellCheck={false}
                />
                {nameValidationError
                  ? <FieldError>{nameValidationError}</FieldError>
                  : <Description>Names cannot contain equals signs or NUL characters.</Description>}
              </TextField>

              <TextField
                fullWidth
                isDisabled={isPending}
                isInvalid={Boolean(valueValidationError)}
                value={value}
                variant="secondary"
                onChange={(nextValue) => {
                  setValue(nextValue);
                  setIsValueDirty(true);
                  setError(undefined);
                }}
              >
                <Label>Variable value</Label>
                <TextArea
                  autoFocus={mode === "edit"}
                  className="min-h-24 font-mono text-xs"
                  maxLength={OPERATION_INPUT_LIMITS.environmentValueLength}
                  rows={4}
                  spellCheck={false}
                />
                {valueValidationError ? <FieldError>{valueValidationError}</FieldError> : null}
                {!valueValidationError ? (
                  <Description>
                    {mode === "edit" && props.entry.redacted
                      ? "The current value is protected. Enter a replacement value to enable Save; empty values are allowed after an explicit edit."
                      : "Empty values are allowed."}
                  </Description>
                ) : null}
              </TextField>

              {error || unavailableReason ? (
                <p className="text-sm text-danger" role="alert">{error ?? unavailableReason}</p>
              ) : null}
            </form>
          </Modal.Body>
          <Modal.Footer>
            <Button isDisabled={isPending} size="sm" variant="secondary" onPress={close}>Cancel</Button>
            <Button form={formId} isDisabled={!canSubmit} isPending={isPending} size="sm" type="submit">
              {submitLabel}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function validateDraft(name: string, value: string): {
  input?: TargetOperationInput;
  nameValidationError?: string;
  valueValidationError?: string;
} {
  try {
    parseTargetOperationInput({ operationId: "target.env-unset", name });
  } catch {
    return {
      nameValidationError: `Use 1–${OPERATION_INPUT_LIMITS.environmentNameLength} characters without equals signs or NUL characters.`,
    };
  }

  try {
    return {
      input: parseTargetOperationInput({ operationId: "target.env-set", name, value }),
    };
  } catch {
    return {
      valueValidationError: `Use at most ${OPERATION_INPUT_LIMITS.environmentValueLength.toLocaleString("en-US")} characters without NUL characters.`,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
