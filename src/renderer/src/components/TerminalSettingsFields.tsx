import {
  Description,
  Label,
  ListBox,
  NumberField,
  Select,
} from "@heroui/react";

import { useNumberFormatter } from "@react-aria/i18n";
import { useMessages } from "../i18n/ApplicationLocaleProvider";
import { formatMessage } from "../i18n/messages";
import { SwitchRow } from "./FormControls";
import {
  CONSOLE_TERMINAL_FONTS,
  CONSOLE_TERMINAL_FONT_SIZE_MAX,
  CONSOLE_TERMINAL_FONT_SIZE_MIN,
  isConsoleTerminalCursorStyle,
  isConsoleTerminalFontId,
  type ConsoleTerminalSettings,
} from "./console-terminal-settings";

export function isValidTerminalSettings(settings: ConsoleTerminalSettings): boolean {
  return isConsoleTerminalFontId(settings.fontId) &&
    Number.isSafeInteger(settings.fontSize) &&
    settings.fontSize >= CONSOLE_TERMINAL_FONT_SIZE_MIN &&
    settings.fontSize <= CONSOLE_TERMINAL_FONT_SIZE_MAX &&
    isConsoleTerminalCursorStyle(settings.cursorStyle) &&
    typeof settings.cursorBlink === "boolean" &&
    typeof settings.smoothScrolling === "boolean" &&
    typeof settings.transparentWindows === "boolean";
}

export function TerminalSettingsFields({
  settings,
  onChange,
}: {
  readonly settings: ConsoleTerminalSettings;
  readonly onChange: (settings: ConsoleTerminalSettings) => void;
}): React.JSX.Element {
  const { terminal: copy } = useMessages();
  const numberFormatter = useNumberFormatter({ useGrouping: false });
  const selectedFont = CONSOLE_TERMINAL_FONTS.find(({ id }) => id === settings.fontId);
  const validFontSize = Number.isSafeInteger(settings.fontSize) &&
    settings.fontSize >= CONSOLE_TERMINAL_FONT_SIZE_MIN &&
    settings.fontSize <= CONSOLE_TERMINAL_FONT_SIZE_MAX;

  return (
    <>
      <Select
        fullWidth
        value={settings.fontId}
        variant="secondary"
        onChange={(value) => {
          if (isConsoleTerminalFontId(value)) onChange({ ...settings, fontId: value });
        }}
      >
        <Label>{copy.fontFamily}</Label>
        <Select.Trigger>
          <Select.Value>{selectedFont?.label}</Select.Value>
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {CONSOLE_TERMINAL_FONTS.map((font) => (
              <ListBox.Item id={font.id} key={font.id} textValue={font.label}>
                <span style={{ fontFamily: `"${font.family}", monospace` }}>{font.label}</span>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
        <Description>{copy.fontFamilyDescription}</Description>
      </Select>

      <NumberField
        commitBehavior="validate"
        formatOptions={{ useGrouping: false }}
        isInvalid={!validFontSize}
        maxValue={CONSOLE_TERMINAL_FONT_SIZE_MAX}
        minValue={CONSOLE_TERMINAL_FONT_SIZE_MIN}
        step={1}
        value={settings.fontSize}
        variant="secondary"
        onChange={(fontSize) => onChange({
          ...settings,
          fontSize: Number.isFinite(fontSize) ? Math.trunc(fontSize) : 0,
        })}
      >
        <Label>{copy.fontSize}</Label>
        <NumberField.Group className="grid-cols-1">
          <NumberField.Input />
        </NumberField.Group>
        <Description>{formatMessage(copy.fontSizeRange, {
          min: numberFormatter.format(CONSOLE_TERMINAL_FONT_SIZE_MIN),
          max: numberFormatter.format(CONSOLE_TERMINAL_FONT_SIZE_MAX),
        })}</Description>
      </NumberField>

      <Select
        fullWidth
        value={settings.cursorStyle}
        variant="secondary"
        onChange={(value) => {
          if (isConsoleTerminalCursorStyle(value)) {
            onChange({ ...settings, cursorStyle: value });
          }
        }}
      >
        <Label>{copy.cursorShape}</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            <ListBox.Item id="block">{copy.block}<ListBox.ItemIndicator /></ListBox.Item>
            <ListBox.Item id="underline">{copy.underline}<ListBox.ItemIndicator /></ListBox.Item>
            <ListBox.Item id="bar">{copy.bar}<ListBox.ItemIndicator /></ListBox.Item>
          </ListBox>
        </Select.Popover>
      </Select>

      <SwitchRow
        description={copy.transparentDescription}
        label={copy.transparent}
        selected={settings.transparentWindows}
        onChange={(transparentWindows) => onChange({ ...settings, transparentWindows })}
      />

      <div className="grid gap-px overflow-hidden rounded-xl bg-surface-secondary p-1">
        <SwitchRow
          description={copy.cursorBlinkDescription}
          label={copy.cursorBlink}
          selected={settings.cursorBlink}
          onChange={(cursorBlink) => onChange({ ...settings, cursorBlink })}
        />
        <SwitchRow
          description={copy.smoothScrollingDescription}
          label={copy.smoothScrolling}
          selected={settings.smoothScrolling}
          onChange={(smoothScrolling) => onChange({ ...settings, smoothScrolling })}
        />
      </div>
    </>
  );
}
