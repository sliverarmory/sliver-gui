import { faGear } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  Button,
  Description,
  Label,
  ListBox,
  Modal,
  NumberField,
  ScrollShadow,
  Select,
} from "@heroui/react";

import {
  DEFAULT_TEXT_EDITOR_SETTINGS,
  TEXT_EDITOR_FONTS,
  TEXT_EDITOR_FONT_SIZE_MAX,
  TEXT_EDITOR_FONT_SIZE_MIN,
  TEXT_EDITOR_TAB_SIZE_MAX,
  TEXT_EDITOR_TAB_SIZE_MIN,
  isTextEditorFontId,
  isTextEditorLineNumbers,
  isTextEditorRenderWhitespace,
  parseTextEditorSettingsValues,
  type TextEditorSettingsValues,
} from "../../../shared/text-editor-settings-contracts";
import { SwitchRow } from "./FormControls";

const LINE_NUMBER_OPTIONS = [
  { id: "on", label: "On" },
  { id: "relative", label: "Relative" },
  { id: "off", label: "Off" },
] as const;

const WHITESPACE_OPTIONS = [
  { id: "none", label: "None" },
  { id: "selection", label: "Selection" },
  { id: "boundary", label: "Boundary" },
  { id: "trailing", label: "Trailing" },
  { id: "all", label: "All" },
] as const;

export interface TextEditorSettingsModalProps {
  readonly draft: TextEditorSettingsValues;
  readonly error?: string | undefined;
  readonly isOpen: boolean;
  readonly isSaving?: boolean;
  readonly onDraftChange: (settings: TextEditorSettingsValues) => void;
  readonly onOpenChange: (isOpen: boolean) => void;
  readonly onSave: () => void;
}

export function TextEditorSettingsModal({
  draft,
  error,
  isOpen,
  isSaving = false,
  onDraftChange,
  onOpenChange,
  onSave,
}: TextEditorSettingsModalProps): React.JSX.Element {
  const selectedFont = TEXT_EDITOR_FONTS.find(({ id }) => id === draft.fontId);
  const validFontSize = integerInRange(draft.fontSize, TEXT_EDITOR_FONT_SIZE_MIN, TEXT_EDITOR_FONT_SIZE_MAX);
  const validTabSize = integerInRange(draft.tabSize, TEXT_EDITOR_TAB_SIZE_MIN, TEXT_EDITOR_TAB_SIZE_MAX);
  const validSettings = isValidSettings(draft);

  return (
    <Modal.Backdrop
      isDismissable={!isSaving}
      isKeyboardDismissDisabled={isSaving}
      isOpen={isOpen}
      variant="blur"
      onOpenChange={(open) => {
        if (open || !isSaving) onOpenChange(open);
      }}
    >
      <Modal.Container placement="center" scroll="inside" size="lg">
        <Modal.Dialog className="sm:max-w-[720px]">
          <Modal.CloseTrigger isDisabled={isSaving} />
          <Modal.Header className="flex-row items-start pr-10">
            <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
              <FontAwesomeIcon aria-hidden icon={faGear} />
            </Modal.Icon>
            <div className="min-w-0">
              <Modal.Heading>Editor settings</Modal.Heading>
              <p className="mt-1 text-sm leading-5 text-muted">
                Applied to every standalone text editor window.
              </p>
            </div>
          </Modal.Header>

          <Modal.Body
            className="flex flex-col gap-6"
            render={(props) => <ScrollShadow {...props} hideScrollBar={false} size={28} />}
          >
            <section aria-labelledby="text-editor-settings-typography" className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground" id="text-editor-settings-typography">
                  Typography and indentation
                </h3>
                <p className="mt-1 text-xs leading-5 text-muted">
                  Choose an embedded font and how Monaco formats indentation.
                </p>
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <Select
                  fullWidth
                  isDisabled={isSaving}
                  value={draft.fontId}
                  variant="secondary"
                  onChange={(value) => {
                    if (isTextEditorFontId(value)) onDraftChange({ ...draft, fontId: value });
                  }}
                >
                  <Label>Font family</Label>
                  <Select.Trigger>
                    <Select.Value>{selectedFont?.label}</Select.Value>
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {TEXT_EDITOR_FONTS.map((font) => (
                        <ListBox.Item id={font.id} key={font.id} textValue={font.label}>
                          <span style={{ fontFamily: `"${font.family}", monospace` }}>{font.label}</span>
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                  <Description>Embedded in Sliver GUI and available offline.</Description>
                </Select>

                <NumberSetting
                  description={`${TEXT_EDITOR_FONT_SIZE_MIN}–${TEXT_EDITOR_FONT_SIZE_MAX} pixels.`}
                  invalid={!validFontSize}
                  label="Font size"
                  max={TEXT_EDITOR_FONT_SIZE_MAX}
                  min={TEXT_EDITOR_FONT_SIZE_MIN}
                  value={draft.fontSize}
                  disabled={isSaving}
                  onChange={(fontSize) => onDraftChange({ ...draft, fontSize })}
                />

                <NumberSetting
                  description={`${TEXT_EDITOR_TAB_SIZE_MIN}–${TEXT_EDITOR_TAB_SIZE_MAX} spaces per indentation level.`}
                  invalid={!validTabSize}
                  label="Tab size"
                  max={TEXT_EDITOR_TAB_SIZE_MAX}
                  min={TEXT_EDITOR_TAB_SIZE_MIN}
                  value={draft.tabSize}
                  disabled={isSaving}
                  onChange={(tabSize) => onDraftChange({ ...draft, tabSize })}
                />

                <Select
                  fullWidth
                  isDisabled={isSaving}
                  value={draft.lineNumbers}
                  variant="secondary"
                  onChange={(value) => {
                    if (isTextEditorLineNumbers(value)) onDraftChange({ ...draft, lineNumbers: value });
                  }}
                >
                  <Label>Line numbers</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {LINE_NUMBER_OPTIONS.map((option) => (
                        <ListBox.Item id={option.id} key={option.id} textValue={option.label}>
                          {option.label}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>

                <Select
                  fullWidth
                  isDisabled={isSaving}
                  value={draft.renderWhitespace}
                  variant="secondary"
                  onChange={(value) => {
                    if (isTextEditorRenderWhitespace(value)) {
                      onDraftChange({ ...draft, renderWhitespace: value });
                    }
                  }}
                >
                  <Label>Visible whitespace</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {WHITESPACE_OPTIONS.map((option) => (
                        <ListBox.Item id={option.id} key={option.id} textValue={option.label}>
                          {option.label}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                  <Description>Show whitespace everywhere or only in selected contexts.</Description>
                </Select>
              </div>
            </section>

            <section aria-labelledby="text-editor-settings-features" className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground" id="text-editor-settings-features">
                  Editor features
                </h3>
                <p className="mt-1 text-xs leading-5 text-muted">
                  Control navigation aids and source display behavior.
                </p>
              </div>
              <div className="grid gap-px overflow-hidden rounded-xl bg-surface-secondary p-1 sm:grid-cols-2">
                <SwitchRow disabled={isSaving} label="Minimap"
                  description="Show a compact overview beside the document." selected={draft.minimap}
                  onChange={(minimap) => onDraftChange({ ...draft, minimap })} />
                <SwitchRow disabled={isSaving} label="Word wrap"
                  description="Wrap long lines inside the editor viewport." selected={draft.wordWrap}
                  onChange={(wordWrap) => onDraftChange({ ...draft, wordWrap })} />
                <SwitchRow disabled={isSaving} label="Insert spaces"
                  description="Use spaces when indenting instead of tab characters." selected={draft.insertSpaces}
                  onChange={(insertSpaces) => onDraftChange({ ...draft, insertSpaces })} />
                <SwitchRow disabled={isSaving} label="Sticky scroll"
                  description="Keep enclosing scopes visible while scrolling." selected={draft.stickyScroll}
                  onChange={(stickyScroll) => onDraftChange({ ...draft, stickyScroll })} />
                <SwitchRow disabled={isSaving} label="Bracket pair colors"
                  description="Use distinct colors for nested bracket pairs." selected={draft.bracketPairColorization}
                  onChange={(bracketPairColorization) => onDraftChange({ ...draft, bracketPairColorization })} />
                <SwitchRow disabled={isSaving} label="Font ligatures"
                  description="Combine supported character sequences into glyphs." selected={draft.fontLigatures}
                  onChange={(fontLigatures) => onDraftChange({ ...draft, fontLigatures })} />
              </div>
            </section>

            {error ? <p className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-soft-foreground" role="alert">
              {error}
            </p> : null}
          </Modal.Body>

          <Modal.Footer className="flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center">
            <Button
              isDisabled={isSaving || sameSettings(draft, DEFAULT_TEXT_EDITOR_SETTINGS)}
              size="sm"
              variant="tertiary"
              onPress={() => onDraftChange({ ...DEFAULT_TEXT_EDITOR_SETTINGS })}
            >
              Reset defaults
            </Button>
            <div className="flex items-center justify-end gap-2">
              <Button isDisabled={isSaving} size="sm" variant="secondary" onPress={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button isDisabled={!validSettings} isPending={isSaving} size="sm" onPress={onSave}>
                Save
              </Button>
            </div>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function NumberSetting({
  description,
  disabled,
  invalid,
  label,
  max,
  min,
  onChange,
  value,
}: {
  readonly description: string;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly label: string;
  readonly max: number;
  readonly min: number;
  readonly onChange: (value: number) => void;
  readonly value: number;
}): React.JSX.Element {
  return (
    <NumberField
      commitBehavior="validate"
      formatOptions={{ useGrouping: false }}
      isDisabled={disabled}
      isInvalid={invalid}
      maxValue={max}
      minValue={min}
      step={1}
      value={value}
      variant="secondary"
      onChange={(next) => onChange(Number.isFinite(next) ? Math.trunc(next) : 0)}
    >
      <Label>{label}</Label>
      <NumberField.Group className="grid-cols-1">
        <NumberField.Input />
      </NumberField.Group>
      <Description>{description}</Description>
    </NumberField>
  );
}

function isValidSettings(settings: TextEditorSettingsValues): boolean {
  try {
    parseTextEditorSettingsValues(settings);
    return true;
  } catch {
    return false;
  }
}

function integerInRange(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function sameSettings(left: TextEditorSettingsValues, right: TextEditorSettingsValues): boolean {
  return left.fontId === right.fontId &&
    left.fontSize === right.fontSize &&
    left.tabSize === right.tabSize &&
    left.insertSpaces === right.insertSpaces &&
    left.minimap === right.minimap &&
    left.wordWrap === right.wordWrap &&
    left.lineNumbers === right.lineNumbers &&
    left.renderWhitespace === right.renderWhitespace &&
    left.stickyScroll === right.stickyScroll &&
    left.bracketPairColorization === right.bracketPairColorization &&
    left.fontLigatures === right.fontLigatures;
}
