import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button, Kbd } from "@heroui/react";

import {
  DEFAULT_COMMAND_PALETTE_SHORTCUT,
  isCommandPaletteShortcut,
  normalizeCommandPaletteShortcutKey,
} from "../../../shared/application-settings-contracts";

interface ShortcutKeyboardEvent {
  readonly altKey: boolean;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly key: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export interface CommandPaletteShortcutRecorderProps {
  readonly isDisabled?: boolean;
  readonly shortcut: string;
  readonly onChange: (shortcut: string) => void;
}

export function CommandPaletteShortcutRecorder({
  isDisabled = false,
  shortcut,
  onChange,
}: CommandPaletteShortcutRecorderProps): React.JSX.Element {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string>();

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (!isRecording) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      setIsRecording(false);
      setError(undefined);
      return;
    }

    const next = commandPaletteShortcutFromKeyboardEvent(event);
    if (!next) {
      const hasModifier = isApplePlatform() ? event.metaKey : event.ctrlKey;
      setError(hasModifier && normalizeCommandPaletteShortcutKey(event.key, event.code)
        ? "That shortcut is reserved by the app or operating system. Try another."
        : hasModifier
          ? "Press a letter, number, or function key with the modifier."
          : "Include Command on macOS or Ctrl on Windows and Linux.");
      return;
    }

    setIsRecording(false);
    setError(undefined);
    onChange(next);
  };

  return (
    <div className="flex min-w-0 flex-col items-start gap-2 sm:shrink-0 sm:items-end">
      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
        <CommandPaletteShortcutKbd shortcut={shortcut} />
        <Button
          aria-pressed={isRecording}
          data-command-palette-shortcut-recorder={isRecording ? "true" : undefined}
          isDisabled={isDisabled}
          size="sm"
          variant={isRecording ? "primary" : "outline"}
          onBlur={() => {
            setIsRecording(false);
            setError(undefined);
          }}
          onKeyDown={handleKeyDown}
          onPress={() => {
            setIsRecording((current) => !current);
            setError(undefined);
          }}
        >
          {isRecording ? "Press shortcut…" : "Change shortcut"}
        </Button>
        <Button
          isDisabled={isDisabled || shortcut === DEFAULT_COMMAND_PALETTE_SHORTCUT}
          size="sm"
          variant="tertiary"
          onPress={() => onChange(DEFAULT_COMMAND_PALETTE_SHORTCUT)}
        >
          Reset
        </Button>
      </div>
      <p
        aria-live="polite"
        className={error ? "text-xs text-danger sm:text-right" : "text-xs text-muted sm:text-right"}
      >
        {error ?? (isRecording ? "Press Escape to cancel." : "Works while a Sliver Desktop window is focused.")}
      </p>
    </div>
  );
}

export function CommandPaletteShortcutKbd({
  className,
  shortcut,
}: {
  readonly className?: string;
  readonly shortcut: string;
}): React.JSX.Element {
  const tokens = shortcut.split("+");
  const key = tokens.at(-1) ?? "";
  const modifiers = tokens.slice(0, -1);
  const apple = isApplePlatform();

  return (
    <Kbd
      aria-label={formatCommandPaletteShortcut(shortcut, apple)}
      {...(className === undefined ? {} : { className })}
    >
      {modifiers.map((modifier) => {
        if (modifier === "mod") {
          return <Kbd.Abbr key="mod" keyValue={apple ? "command" : "ctrl"} />;
        }
        if (modifier === "alt") {
          return <Kbd.Abbr key="alt" keyValue={apple ? "option" : "alt"} />;
        }
        return <Kbd.Abbr key="shift" keyValue="shift" />;
      })}
      {key === "ArrowLeft" || key === "ArrowRight" ? (
        <Kbd.Abbr keyValue={key === "ArrowLeft" ? "left" : "right"} />
      ) : <Kbd.Content>{shortcutKeyLabel(key)}</Kbd.Content>}
    </Kbd>
  );
}

export function commandPaletteShortcutFromKeyboardEvent(
  event: ShortcutKeyboardEvent,
  apple = isApplePlatform(),
): string | undefined {
  const key = normalizeCommandPaletteShortcutKey(event.key, event.code);
  if (!key) return undefined;

  const primaryModifier = apple ? event.metaKey : event.ctrlKey;
  const unsupportedPrimaryModifier = apple ? event.ctrlKey : event.metaKey;
  if (unsupportedPrimaryModifier) return undefined;

  const modifiers = [
    primaryModifier ? "mod" : undefined,
    event.altKey ? "alt" : undefined,
    event.shiftKey ? "shift" : undefined,
  ].filter((modifier): modifier is string => modifier !== undefined);
  const shortcut = [...modifiers, key].join("+");
  return isCommandPaletteShortcut(shortcut) ? shortcut : undefined;
}

export function formatCommandPaletteShortcut(shortcut: string, apple = isApplePlatform()): string {
  const labels = shortcut.split("+").map((token) => {
    if (token === "mod") return apple ? "Command" : "Ctrl";
    if (token === "alt") return apple ? "Option" : "Alt";
    if (token === "shift") return "Shift";
    return shortcutKeyLabel(token);
  });
  return labels.join(" + ");
}

export function isApplePlatform(platform = globalThis.navigator?.platform ?? ""): boolean {
  return /Mac|iPhone|iPad/u.test(platform);
}

function shortcutKeyLabel(value: string): string {
  if (value === "ArrowLeft") return "Left Arrow";
  if (value === "ArrowRight") return "Right Arrow";
  return value.toUpperCase();
}
