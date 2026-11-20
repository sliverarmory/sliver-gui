import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Button, Card, SearchField, Tooltip } from "@heroui/react";
import { useFilter } from "@react-aria/i18n";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMagnifyingGlass, faPen, faRotateLeft } from "@fortawesome/free-solid-svg-icons";

import type { ApplicationSettingsState } from "../../../shared/application-settings-contracts";
import {
  KEYBOARD_SHORTCUT_DEFINITIONS,
  defaultKeyboardShortcut,
  getKeyboardShortcutConflict,
  keyboardShortcutFromEvent,
  resolveKeyboardShortcut,
  type KeyboardShortcutAction,
  type KeyboardShortcutConflict,
} from "../../../shared/keyboard-shortcuts";
import { useMessages } from "../i18n/ApplicationLocaleProvider";
import { formatMessage } from "../i18n/messages";
import { CommandPaletteShortcutKbd, formatCommandPaletteShortcut, isApplePlatform } from "./CommandPaletteShortcut";

export interface KeyboardShortcutsSettingsProps {
  readonly settings: ApplicationSettingsState;
  readonly isSaving: boolean;
  readonly onShortcutChange: (action: KeyboardShortcutAction, shortcut: string | undefined) => void;
  readonly onReset: () => void;
  readonly toolbarContainer?: HTMLElement | null;
}

type ShortcutIssue = KeyboardShortcutConflict | { readonly reason: "recordFailed" | "invalidKey" };

export function KeyboardShortcutsSettings({ settings, isSaving, onShortcutChange, onReset, toolbarContainer }: KeyboardShortcutsSettingsProps) {
  const messages = useMessages();
  const { shortcuts, shortcutGroups, shortcutActions } = messages;
  const { contains } = useFilter({ sensitivity: "base" });
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<KeyboardShortcutAction>();
  const [starting, setStarting] = useState<KeyboardShortcutAction>();
  const [error, setError] = useState<{ action: KeyboardShortcutAction; issue: ShortcutIssue }>();
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
        setError({ action, issue: { reason: "recordFailed" } });
      }
    }
  };

  const changeShortcut = (action: KeyboardShortcutAction, shortcut: string | undefined) => {
    const value = shortcut ?? defaultKeyboardShortcut(action, apple);
    const conflict = getKeyboardShortcutConflict(action, value, settings, apple);
    if (conflict) {
      setError({ action, issue: conflict });
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
      setError({ action, issue: { reason: "invalidKey" } });
      return;
    }
    changeShortcut(action, shortcut);
  };

  const search = query.trim();
  const visible = KEYBOARD_SHORTCUT_DEFINITIONS.filter(({ id, group }) => {
    const shortcut = resolveKeyboardShortcut(id, settings, apple);
    const { label, description } = shortcutActions[id];
    return contains(`${label} ${description} ${shortcutGroups[group]} ${shortcut} ${formatCommandPaletteShortcut(shortcut, apple)}`, search);
  });
  const groups = [...new Set(visible.map(({ group }) => group))];
  const customized = KEYBOARD_SHORTCUT_DEFINITIONS.some(({ id }) =>
    resolveKeyboardShortcut(id, settings, apple) !== defaultKeyboardShortcut(id, apple));

  const toolbar = (
    <div className="keyboard-shortcuts__toolbar space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="keyboard-shortcuts-heading" className="text-lg font-medium">{messages.settings.keyboard}</h2>
        <Button size="sm" variant="tertiary" isDisabled={isSaving || !customized} onPress={() => {
          stopRecording();
          setError(undefined);
          onReset();
        }}>{shortcuts.resetAll}</Button>
      </div>
      <SearchField aria-label={shortcuts.search} className="w-full sm:max-w-sm" value={query} onChange={(value) => {
        stopRecording();
        setQuery(value);
      }}>
        <SearchField.Group>
          <SearchField.SearchIcon><FontAwesomeIcon aria-hidden icon={faMagnifyingGlass} /></SearchField.SearchIcon>
          <SearchField.Input placeholder={shortcuts.search} maxLength={200} />
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
          <Card.Header><Card.Title>{shortcutGroups[group]}</Card.Title></Card.Header>
          <Card.Content className="divide-y divide-separator">
            {visible.filter((definition) => definition.group === group).map((definition) => {
              const shortcut = resolveKeyboardShortcut(definition.id, settings, apple);
              const isRecording = recording === definition.id;
              const isStarting = starting === definition.id;
              const { label, description } = shortcutActions[definition.id];
              const issue = error?.action === definition.id ? error.issue : undefined;
              const message = issue?.reason === "alreadyAssigned"
                ? formatMessage(shortcuts.alreadyAssigned, { action: shortcutActions[issue.action.id].label })
                : issue && shortcuts[issue.reason];
              return (
                <div key={definition.id} className="py-3 first:pt-0 last:pb-0" role="group" aria-label={label}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{label}</p>
                      <p className="mt-1 text-xs leading-5 text-muted">{description}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                      <CommandPaletteShortcutKbd className="text-xs" shortcut={shortcut} />
                      <Tooltip delay={250}>
                        <Button aria-label={formatMessage(isRecording ? shortcuts.cancelChangeAction : shortcuts.changeAction, { action: label })}
                          aria-pressed={isRecording} data-command-palette-shortcut-recorder={isRecording ? "true" : undefined}
                          isDisabled={isSaving} isIconOnly={!isRecording && !isStarting} size="sm"
                          variant={isRecording ? "secondary" : "ghost"}
                          onPress={() => void startRecording(definition.id)}
                          onBlur={() => { if (isRecording || isStarting) stopRecording(); }}
                          onKeyDown={(event) => recordKey(definition.id, event)}>
                          {isStarting ? shortcuts.preparing : isRecording ? shortcuts.pressShortcut : <FontAwesomeIcon aria-hidden icon={faPen} />}
                        </Button>
                        <Tooltip.Content>{isRecording ? shortcuts.escapeCancels : shortcuts.change}</Tooltip.Content>
                      </Tooltip>
                      <Tooltip delay={250}>
                        <Button aria-label={formatMessage(shortcuts.resetAction, { action: label })} isIconOnly size="sm" variant="ghost"
                          isDisabled={isSaving || shortcut === defaultKeyboardShortcut(definition.id, apple)}
                          onPress={() => changeShortcut(definition.id, undefined)}>
                          <FontAwesomeIcon aria-hidden icon={faRotateLeft} />
                        </Button>
                        <Tooltip.Content>{shortcuts.reset}</Tooltip.Content>
                      </Tooltip>
                    </div>
                  </div>
                  {message || isRecording ? <p className={`mt-2 text-xs ${message ? "text-danger" : "text-muted"}`} role={message ? "alert" : "status"}>
                    {message ?? shortcuts.recordHint}
                  </p> : null}
                </div>
              );
            })}
          </Card.Content>
        </Card>
      ))}
      {visible.length === 0 ? <p className="py-6 text-center text-sm text-muted" role="status">{shortcuts.noResults}</p> : null}
      <p className="text-xs leading-5 text-muted">{shortcuts.platformHint}</p>
    </section>
  );
}
