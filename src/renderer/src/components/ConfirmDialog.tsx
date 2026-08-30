import { AlertDialog, Button } from "@heroui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  isPending?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | boolean | Promise<void | boolean>;
}

export function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmLabel,
  isPending = false,
  onOpenChange,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Backdrop isOpen={isOpen} onOpenChange={onOpenChange} variant="blur">
      <AlertDialog.Container size="sm">
        <AlertDialog.Dialog>
          {({ close }) => (
            <>
              <AlertDialog.Header>
                <AlertDialog.Icon status="danger">
                  <FontAwesomeIcon icon={faTriangleExclamation} className="size-5" />
                </AlertDialog.Icon>
                <AlertDialog.Heading>{title}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p className="text-sm leading-6 text-muted">{description}</p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="tertiary" onPress={close} isDisabled={isPending}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  isPending={isPending}
                  onPress={async () => {
                    const confirmed = await onConfirm();
                    if (confirmed !== false) close();
                  }}
                >
                  {confirmLabel}
                </Button>
              </AlertDialog.Footer>
            </>
          )}
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}
