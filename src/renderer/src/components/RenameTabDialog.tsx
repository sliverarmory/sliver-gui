import { useEffect, useId, useRef, type FormEvent } from "react";
import {
  Button,
  Description,
  FieldError,
  Input,
  Label,
  Modal,
  TextField,
} from "@heroui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPen } from "@fortawesome/free-solid-svg-icons";
import {
  TERMINAL_TAB_LABEL_MAX_LENGTH,
  normalizeTerminalTabLabel,
} from "../../../shared/terminal-tab-label";

export const TERMINAL_TAB_NAME_MAX_LENGTH = TERMINAL_TAB_LABEL_MAX_LENGTH;

export interface RenameTabDialogProps {
  readonly description: string;
  readonly error?: string | undefined;
  readonly isOpen: boolean;
  readonly isPending?: boolean;
  readonly name: string;
  readonly originalName: string;
  readonly onNameChange: (name: string) => void;
  readonly onOpenChange: (isOpen: boolean) => void;
  readonly onRename: (name: string) => void;
}

export function RenameTabDialog({
  description,
  error,
  isOpen,
  isPending = false,
  name,
  originalName,
  onNameChange,
  onOpenChange,
  onRename,
}: RenameTabDialogProps): React.JSX.Element {
  const formId = `rename-tab-${useId()}`;
  const selectedOnOpenRef = useRef(false);
  useEffect(() => {
    if (!isOpen) selectedOnOpenRef.current = false;
  }, [isOpen]);
  const normalizedName = normalizeTerminalTabName(name);
  const localError = isOpen && normalizedName === undefined
    ? `Use 1–${TERMINAL_TAB_NAME_MAX_LENGTH} visible characters.`
    : undefined;
  const validationError = error ?? localError;
  const canRename = normalizedName !== undefined && normalizedName !== originalName && !isPending;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (canRename) onRename(normalizedName);
  };

  return (
    <Modal.Backdrop
      isDismissable={!isPending}
      isKeyboardDismissDisabled={isPending}
      isOpen={isOpen}
      variant="blur"
      onOpenChange={onOpenChange}
    >
      <Modal.Container placement="center" size="sm">
        <Modal.Dialog>
          <Modal.CloseTrigger isDisabled={isPending} />
          <Modal.Header className="flex-row items-start pr-10">
            <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
              <FontAwesomeIcon aria-hidden className="size-4" icon={faPen} />
            </Modal.Icon>
            <div className="min-w-0">
              <Modal.Heading>Rename tab</Modal.Heading>
              <p className="mt-1 text-sm leading-5 text-muted">{description}</p>
            </div>
          </Modal.Header>
          <Modal.Body>
            <form id={formId} onSubmit={submit}>
              <TextField
                fullWidth
                isDisabled={isPending}
                isInvalid={Boolean(validationError)}
                isRequired
                value={name}
                variant="secondary"
                onChange={onNameChange}
              >
                <Label>Tab name</Label>
                <Input
                  autoFocus
                  maxLength={TERMINAL_TAB_NAME_MAX_LENGTH}
                  onFocus={(event) => {
                    if (selectedOnOpenRef.current) return;
                    selectedOnOpenRef.current = true;
                    event.currentTarget.select();
                  }}
                />
                {validationError
                  ? <FieldError>{validationError}</FieldError>
                  : <Description>Up to {TERMINAL_TAB_NAME_MAX_LENGTH} characters.</Description>}
              </TextField>
            </form>
          </Modal.Body>
          <Modal.Footer>
            <Button
              isDisabled={isPending}
              size="sm"
              variant="secondary"
              onPress={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              form={formId}
              isDisabled={!canRename}
              isPending={isPending}
              size="sm"
              type="submit"
            >
              Rename
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

export function normalizeTerminalTabName(value: string): string | undefined {
  return normalizeTerminalTabLabel(value);
}
