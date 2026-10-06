import { AlertDialog, Button, ScrollShadow } from "@heroui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  isPending?: boolean;
  scrollShadow?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | boolean | Promise<void | boolean>;
}

export function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmLabel,
  isPending = false,
  scrollShadow = false,
  onOpenChange,
  onConfirm,
}: ConfirmDialogProps) {
  const body = <p className="text-sm leading-6 text-muted">{description}</p>;

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
              {scrollShadow ? (
                <ScrollShadow className="alert-dialog__body" hideScrollBar={false} size={28}>
                  {body}
                </ScrollShadow>
              ) : (
                <AlertDialog.Body>{body}</AlertDialog.Body>
              )}
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
