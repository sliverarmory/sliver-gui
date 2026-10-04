import { faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { AlertDialog, Button } from "@heroui/react";

import type { TextEditorRemoteOverwriteRequest } from "../../../shared/text-editor-contracts";

interface RemoteOverwriteDialogProps {
  readonly request: TextEditorRemoteOverwriteRequest | undefined;
  readonly responseChoice: boolean | undefined;
  readonly responseError: string | undefined;
  readonly onRespond: (confirmed: boolean) => void;
}

export function RemoteOverwriteDialog({
  request,
  responseChoice,
  responseError,
  onRespond,
}: RemoteOverwriteDialogProps): React.JSX.Element {
  const isResponding = responseChoice !== undefined;

  return (
    <AlertDialog.Backdrop
      isDismissable={!isResponding}
      isKeyboardDismissDisabled={isResponding}
      isOpen={request !== undefined}
      onOpenChange={(open) => {
        if (!open && !isResponding) onRespond(false);
      }}
      variant="blur"
    >
      <AlertDialog.Container placement="center" size="lg">
        <AlertDialog.Dialog className="sm:max-w-2xl">
          <AlertDialog.Header>
            <AlertDialog.Icon status="warning">
              <FontAwesomeIcon aria-hidden className="size-5" icon={faTriangleExclamation} />
            </AlertDialog.Icon>
            <AlertDialog.Heading>Overwrite remote file?</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            {request ? (
              <div className="space-y-4 text-sm">
                <p className="leading-6 text-muted">
                  Save the edited content over this file on the remote session?
                </p>

                <section aria-label="Remote file" className="rounded-xl border border-separator bg-default px-4 py-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Remote path</h3>
                  <p className="mt-1.5 select-all break-all font-mono text-sm text-foreground">{request.path}</p>
                </section>

                <section aria-label="Remote target" className="rounded-xl border border-separator bg-default px-4 py-3">
                  <h3 className="font-medium text-foreground">{request.target.name || request.target.hostname || "Active session"}</h3>
                  <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 border-t border-separator pt-3 text-xs">
                    <dt className="text-muted">Hostname</dt>
                    <dd className="min-w-0 break-words text-foreground">{request.target.hostname || "Unknown"}</dd>
                    <dt className="text-muted">Backend</dt>
                    <dd className="min-w-0 text-foreground">
                      <span>{request.target.backend.displayName}</span>{" "}
                      <span className="select-all break-all font-mono text-[11px] text-muted">({request.target.backend.id})</span>
                    </dd>
                    <dt className="text-muted">Session ID</dt>
                    <dd className="select-all break-all font-mono text-[11px] text-foreground">{request.target.sessionId}</dd>
                  </dl>
                </section>

                <section aria-label="Content digests" className="grid gap-3 sm:grid-cols-2">
                  <DigestBlock digest={request.originalSha256} label="Original SHA-256" />
                  <DigestBlock digest={request.newSha256} label="New SHA-256" />
                </section>

                <div className="flex gap-3 rounded-xl bg-warning-soft px-4 py-3 text-warning-soft-foreground">
                  <FontAwesomeIcon aria-hidden className="mt-0.5 size-4 shrink-0" icon={faTriangleExclamation} />
                  <p className="leading-5">{request.warning}</p>
                </div>

                {responseError ? (
                  <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-soft-foreground">
                    {responseError}
                  </p>
                ) : null}
              </div>
            ) : null}
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button
              isDisabled={isResponding}
              isPending={responseChoice === false}
              size="sm"
              variant="tertiary"
              onPress={() => onRespond(false)}
            >
              {responseChoice === false ? "Cancelling…" : "Cancel"}
            </Button>
            <Button
              isDisabled={isResponding}
              isPending={responseChoice === true}
              size="sm"
              variant="danger"
              onPress={() => onRespond(true)}
            >
              {responseChoice === true ? "Overwriting…" : "Overwrite file"}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

function DigestBlock({ digest, label }: { readonly digest: string; readonly label: string }): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-xl bg-surface-secondary px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1.5 select-all break-all font-mono text-[11px] leading-5 text-foreground">{digest}</p>
    </div>
  );
}
