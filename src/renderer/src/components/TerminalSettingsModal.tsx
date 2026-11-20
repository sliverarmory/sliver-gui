import { Button, Modal, ScrollShadow, toast } from "@heroui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMessages } from "../i18n/ApplicationLocaleProvider";
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
  const { settings: copy, terminal: terminalCopy } = useMessages();
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
              <Modal.Heading>{terminalCopy.settings}</Modal.Heading>
              <p className="mt-1 text-sm leading-5 text-muted">
                {terminalCopy.appearanceDescription}
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
                  if (!result.ok) toast.danger(terminalCopy.openConfigError, { description: result.error });
                }).catch(() => toast.danger(terminalCopy.openConfigError));
              }}>{terminalCopy.editConfig}</Button>}
              <p className="text-xs text-muted">{terminalCopy.themeSettingsHint}</p>
            </div>
          </Modal.Body>
          <Modal.Footer className="items-center justify-between gap-3">
            <Button
              size="sm"
              variant="tertiary"
              onPress={() => onDraftChange(DEFAULT_CONSOLE_TERMINAL_SETTINGS)}
            >
              {copy.resetDefaults}
            </Button>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" onPress={() => onOpenChange(false)}>{copy.cancel}</Button>
              <Button isDisabled={!validSettings} size="sm" onPress={onSave}>{copy.save}</Button>
            </div>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
