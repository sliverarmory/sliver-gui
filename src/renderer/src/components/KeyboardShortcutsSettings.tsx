import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Button, Card, SearchField, Tooltip } from "@heroui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMagnifyingGlass, faPen, faRotateLeft } from "@fortawesome/free-solid-svg-icons";

import type { ApplicationSettingsState } from "../../../shared/application-settings-contracts";
import {
  KEYBOARD_SHORTCUT_DEFINITIONS,
  defaultKeyboardShortcut,
  keyboardShortcutConflict,
  keyboardShortcutFromEvent,
  resolveKeyboardShortcut,
  type KeyboardShortcutAction,
} from "../../../shared/keyboard-shortcuts";
import { CommandPaletteShortcutKbd, formatCommandPaletteShortcut, isApplePlatform } from "./CommandPaletteShortcut";

export interface KeyboardShortcutsSettingsProps {
  readonly settings: ApplicationSettingsState;
  readonly isSaving: boolean;
  readonly onShortcutChange: (action: KeyboardShortcutAction, shortcut: string | undefined) => void;
  readonly onReset: () => void;
  readonly toolbarContainer?: HTMLElement | null;
}

export function KeyboardShortcutsSettings({ settings, isSaving, onShortcutChange, onReset, toolbarContainer }: KeyboardShortcutsSettingsProps) {
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<KeyboardShortcutAction>();
  const [starting, setStarting] = useState<KeyboardShortcutAction>();
  const [error, setError] = useState<{ action: KeyboardShortcutAction; message: string }>();
  const generation = useRef(0);
  const apple = isApplePlatform();

  const stopRecording = useCallback(() => {
    generation.current += 1;
    setStarting(undefined);
    setRecording(undefined);
    void window.sliver?.setKeyboardShortcutRecording?.(false).catch(() => undefined);
  }, []);

  useEffect(() => {
    window.addEventListener("blur", stopRecording);
    return () => {
      window.removeEventListener("blur", stopRecording);
      generation.current += 1;
      void window.sliver?.setKeyboardShortcutRecording?.(false).catch(() => undefined);
    };
  }, [stopRecording]);

  const startRecording = async (action: KeyboardShortcutAction) => {
    if (recording === action) {
      stopRecording();
      return;
    }
    const request = ++generation.current;
    setStarting(action);
    setError(undefined);
    try {
      await window.sliver?.setKeyboardShortcutRecording?.(true);
      if (generation.current === request) {
        setStarting(undefined);
        setRecording(action);
      }
    } catch {
      if (generation.current === request) {
        stopRecording();
        setError({ action, message: "Could not start recording. Try again." });
      }
    }
  };

  const changeShortcut = (action: KeyboardShortcutAction, shortcut: string | undefined) => {
    const value = shortcut ?? defaultKeyboardShortcut(action, apple);
    const conflict = keyboardShortcutConflict(action, value, settings, apple);
    if (conflict) {
      setError({ action, message: conflict });
      return;
    }
    stopRecording();
    setError(undefined);
    onShortcutChange(action, shortcut);
  };

  const recordKey = (action: KeyboardShortcutAction, event: KeyboardEvent<HTMLButtonElement>) => {
    if (recording !== action) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stopRecording();
      setError(undefined);
      return;
    }
    if (event.repeat || event.nativeEvent.isComposing || ["Meta", "Control", "Alt", "Shift"].includes(event.key)) return;
    const shortcut = keyboardShortcutFromEvent(event, apple);
    if (!shortcut) {
      setError({ action, message: "Use a modifier with a letter, number, arrow or punctuation key, or press a function key." });
      return;
    }
    changeShortcut(action, shortcut);
  };

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = KEYBOARD_SHORTCUT_DEFINITIONS.filter((definition) => {
    const shortcut = resolveKeyboardShortcut(definition.id, settings, apple);
    return `${definition.label} ${definition.description} ${definition.group} ${shortcut} ${formatCommandPaletteShortcut(shortcut, apple)}`
      .toLocaleLowerCase().includes(normalizedQuery);
  });
  const groups = [...new Set(visible.map(({ group }) => group))];
  const customized = KEYBOARD_SHORTCUT_DEFINITIONS.some(({ id }) =>
    resolveKeyboardShortcut(id, settings, apple) !== defaultKeyboardShortcut(id, apple));

  const toolbar = (
    <div className="keyboard-shortcuts__toolbar space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="keyboard-shortcuts-heading" className="text-lg font-medium">Keyboard Shortcuts</h2>
        <Button size="sm" variant="tertiary" isDisabled={isSaving || !customized} onPress={() => {
          stopRecording();
          setError(undefined);
          onReset();
        }}>Reset all to defaults</Button>
      </div>
      <SearchField aria-label="Search shortcuts" className="w-full sm:max-w-sm" value={query} onChange={(value) => {
        stopRecording();
        setQuery(value);
      }}>
        <SearchField.Group>
          <SearchField.SearchIcon><FontAwesomeIcon aria-hidden icon={faMagnifyingGlass} /></SearchField.SearchIcon>
          <SearchField.Input placeholder="Search shortcuts" maxLength={200} />
          <SearchField.ClearButton />
        </SearchField.Group>
      </SearchField>
    </div>
  );

  return (
    <section aria-labelledby="keyboard-shortcuts-heading" className="space-y-5">
      {toolbarContainer === undefined ? toolbar : toolbarContainer ? createPortal(toolbar, toolbarContainer) : null}
      {groups.map((group) => (
        <Card key={group} variant="secondary">
          <Card.Header><Card.Title>{group}</Card.Title></Card.Header>
          <Card.Content className="divide-y divide-separator">
            {visible.filter((definition) => definition.group === group).map((definition) => {
              const shortcut = resolveKeyboardShortcut(definition.id, settings, apple);
              const isRecording = recording === definition.id;
              const isStarting = starting === definition.id;
              const message = error?.action === definition.id ? error.message : undefined;
              return (
                <div key={definition.id} className="py-3 first:pt-0 last:pb-0" role="group" aria-label={definition.label}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{definition.label}</p>
                      <p className="mt-1 text-xs leading-5 text-muted">{definition.description}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                      <CommandPaletteShortcutKbd className="text-xs" shortcut={shortcut} />
                      <Tooltip delay={250}>
                        <Button aria-label={`${isRecording ? "Cancel changing" : "Change"} shortcut for ${definition.label}`}
                          aria-pressed={isRecording} data-command-palette-shortcut-recorder={isRecording ? "true" : undefined}
                          isDisabled={isSaving} isIconOnly={!isRecording && !isStarting} size="sm"
                          variant={isRecording ? "secondary" : "ghost"}
                          onPress={() => void startRecording(definition.id)}
                          onBlur={() => { if (isRecording || isStarting) stopRecording(); }}
                          onKeyDown={(event) => recordKey(definition.id, event)}>
                          {isStarting ? "Preparing…" : isRecording ? "Press shortcut…" : <FontAwesomeIcon aria-hidden icon={faPen} />}
                        </Button>
                        <Tooltip.Content>{isRecording ? "Escape cancels" : "Change shortcut"}</Tooltip.Content>
                      </Tooltip>
                      <Tooltip delay={250}>
                        <Button aria-label={`Reset shortcut for ${definition.label}`} isIconOnly size="sm" variant="ghost"
                          isDisabled={isSaving || shortcut === defaultKeyboardShortcut(definition.id, apple)}
                          onPress={() => changeShortcut(definition.id, undefined)}>
                          <FontAwesomeIcon aria-hidden icon={faRotateLeft} />
                        </Button>
                        <Tooltip.Content>Reset to default</Tooltip.Content>
                      </Tooltip>
                    </div>
                  </div>
                  {message || isRecording ? <p className={`mt-2 text-xs ${message ? "text-danger" : "text-muted"}`} role={message ? "alert" : "status"}>
                    {message ?? "Press a new shortcut, or Escape to cancel."}
                  </p> : null}
                </div>
              );
            })}
          </Card.Content>
        </Card>
      ))}
      {visible.length === 0 ? <p className="py-6 text-center text-sm text-muted" role="status">No shortcuts match your search.</p> : null}
      <p className="text-xs leading-5 text-muted">Use Command on macOS or Ctrl on Windows and Linux. Standard editing, system shortcuts, and terminal control keys keep their usual behavior.</p>
    </section>
  );
}
