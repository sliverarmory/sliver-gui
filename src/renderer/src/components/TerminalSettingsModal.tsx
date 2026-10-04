import { Button, Modal, ScrollShadow, toast } from "@heroui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faGear } from "@fortawesome/free-solid-svg-icons";

import {
  isValidTerminalSettings,
  TerminalSettingsFields,
} from "./TerminalSettingsFields";
import {
  DEFAULT_CONSOLE_TERMINAL_SETTINGS,
  type ConsoleTerminalSettings,
} from "./console-terminal-settings";

export interface TerminalSettingsModalProps {
  readonly draft: ConsoleTerminalSettings;
  readonly isOpen: boolean;
  readonly onDraftChange: (settings: ConsoleTerminalSettings) => void;
  readonly onOpenChange: (isOpen: boolean) => void;
  readonly onSave: () => void;
}

export function TerminalSettingsModal({
  draft,
  isOpen,
  onDraftChange,
  onOpenChange,
  onSave,
}: TerminalSettingsModalProps): React.JSX.Element {
  const validSettings = isValidTerminalSettings(draft);

  return (
    <Modal.Backdrop isOpen={isOpen} variant="blur" onOpenChange={onOpenChange}>
      <Modal.Container placement="center" size="sm">
        <Modal.Dialog className="sm:max-w-[460px]">
          <Modal.CloseTrigger />
          <Modal.Header className="flex-row items-start pr-10">
            <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
              <FontAwesomeIcon aria-hidden icon={faGear} />
            </Modal.Icon>
            <div className="min-w-0">
              <Modal.Heading>Terminal Settings</Modal.Heading>
              <p className="mt-1 text-sm leading-5 text-muted">
                Applied to every console, SSH session, and managed shell window.
              </p>
            </div>
          </Modal.Header>
          <Modal.Body
            className="max-h-[60vh] overflow-y-auto"
            render={(props) => <ScrollShadow {...props} hideScrollBar={false} size={28} />}
          >
            {/* Preserve control heights; only the outer body should shrink and scroll. */}
            <div className="grid gap-5">
              <TerminalSettingsFields settings={draft} onChange={onDraftChange} />
              {window.ghosttySettings && <Button variant="secondary" onPress={() => {
                void window.ghosttySettings!.editConfig().then((result) => {
                  if (!result.ok) toast.danger("Could not open Ghostty config", { description: result.error });
                }).catch(() => toast.danger("Could not open Ghostty config"));
              }}>Edit Ghostty config</Button>}
              <p className="text-xs text-muted">Choose Ghostty themes in Settings → Terminal. Config changes apply when saved.</p>
            </div>
          </Modal.Body>
          <Modal.Footer className="items-center justify-between gap-3">
            <Button
              size="sm"
              variant="tertiary"
              onPress={() => onDraftChange(DEFAULT_CONSOLE_TERMINAL_SETTINGS)}
            >
              Reset defaults
            </Button>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" onPress={() => onOpenChange(false)}>Cancel</Button>
              <Button isDisabled={!validSettings} size="sm" onPress={onSave}>Save</Button>
            </div>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
