import { faArrowRotateLeft, faArrowRotateRight } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { NativeSelect } from "@heroui-pro/react/native-select";
import { Button, Tooltip } from "@heroui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../../shared/application-settings-contracts";
import {
  defaultKeyboardShortcut,
  matchesKeyboardShortcut,
  resolveKeyboardShortcut,
  type KeyboardShortcutAction,
  type KeyboardShortcutSettings,
} from "../../../shared/keyboard-shortcuts";
import type { TextEditorDocument } from "../../../shared/text-editor-contracts";
import { shortcutAriaKeyShortcuts } from "../navigation-shortcuts";
import { formatCommandPaletteShortcut, isApplePlatform } from "./CommandPaletteShortcut";
import { CodeEditor, type CodeEditorHandle, type CodeEditorKeybindings } from "./CodeEditor";

export interface TextEditorWorkspaceProps {
  /** Mount with key={document.id} when replacing a document. */
  document: TextEditorDocument;
  theme?: "light" | "dark";
  onSave: (text: string, saveAs: boolean) => Promise<{ title: string } | null>;
  onOpen?: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  shortcuts?: KeyboardShortcutSettings;
}

const LANGUAGES = [
  ["plaintext", "Plain Text"], ["xml", "XML"], ["json", "JSON"],
  ["markdown", "Markdown"], ["yaml", "YAML"], ["html", "HTML"],
  ["css", "CSS"], ["shell", "Bash"], ["javascript", "JavaScript"], ["typescript", "TypeScript"],
] as const;

const TEXT_EDITOR_SHORTCUT_ACTIONS = [
  "textEditorOpen", "textEditorSaveAs", "textEditorSave", "textEditorUndo",
  "textEditorRedo", "textEditorFind", "textEditorReplace", "textEditorWordWrap",
  "textEditorCommandPalette",
] as const satisfies readonly KeyboardShortcutAction[];
type TextEditorShortcutAction = (typeof TEXT_EDITOR_SHORTCUT_ACTIONS)[number];

/** Document UI only: callers own persistence and native-window lifecycle. */
export function TextEditorWorkspace({
  document,
  theme = "dark",
  onSave,
  onOpen,
  onDirtyChange,
  shortcuts = DEFAULT_APPLICATION_SETTINGS_STATE,
}: TextEditorWorkspaceProps): React.JSX.Element {
  const [text, setText] = useState(document.text);
  const [savedText, setSavedText] = useState(document.text);
  const [title, setTitle] = useState(document.title);
  const [language, setLanguage] = useState(LANGUAGES.some(([id]) => id === document.language) ? document.language : "plaintext");
  const [wordWrap, setWordWrap] = useState(false);
  const [fontSize, setFontSize] = useState(13);
  const [cursor, setCursor] = useState({ lineNumber: 1, column: 1 });
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<"save" | "open" | null>(null);
  const [error, setError] = useState<string>();
  const editor = useRef<CodeEditorHandle>(null);
  const pendingRef = useRef(false);
  const dirtyRef = useRef(false);
  const dirty = text !== savedText;
  const readOnly = document.readOnly || pending === "open";
  const apple = isApplePlatform();
  const shortcutFor = (action: TextEditorShortcutAction): string => resolveKeyboardShortcut(action, shortcuts, apple);
  const shortcutLabel = (action: TextEditorShortcutAction): string => formatCommandPaletteShortcut(shortcutFor(action), apple);
  const shortcutAria = (action: TextEditorShortcutAction): string => shortcutAriaKeyShortcuts(shortcutFor(action), apple);
  const editorKeybindings = useMemo<CodeEditorKeybindings>(() => ({
    save: resolveKeyboardShortcut("textEditorSave", shortcuts, apple),
    undo: resolveKeyboardShortcut("textEditorUndo", shortcuts, apple),
    redo: resolveKeyboardShortcut("textEditorRedo", shortcuts, apple),
    find: resolveKeyboardShortcut("textEditorFind", shortcuts, apple),
    replace: resolveKeyboardShortcut("textEditorReplace", shortcuts, apple),
    commandPalette: resolveKeyboardShortcut("textEditorCommandPalette", shortcuts, apple),
  }), [apple, shortcuts]);
  dirtyRef.current = dirty;

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (!dirtyRef.current && !pendingRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  const save = useCallback(async (saveAs = false): Promise<void> => {
    if (pendingRef.current || document.readOnly || (saveAs && document.remote) || !ready || (!dirty && !saveAs)) return;
    pendingRef.current = true;
    setPending("save");
    setError(undefined);
    // This snapshot is the only saved baseline, even if typing continues.
    const snapshot = text;
    try {
      const result = await onSave(snapshot, saveAs);
      if (result) {
        setSavedText(snapshot);
        setTitle(result.title);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The document could not be saved.");
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }, [dirty, document.readOnly, document.remote, onSave, ready, text]);

  const open = useCallback(async (): Promise<void> => {
    if (!onOpen || pendingRef.current) return;
    pendingRef.current = true;
    setPending("open");
    setError(undefined);
    try { await onOpen(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The document could not be opened."); }
    finally { pendingRef.current = false; setPending(null); }
  }, [onOpen]);

  useEffect(() => {
    const run = (action: TextEditorShortcutAction): void => {
      switch (action) {
        case "textEditorOpen": void open(); break;
        case "textEditorSaveAs": void save(true); break;
        case "textEditorSave": void save(); break;
        case "textEditorUndo": editor.current?.undo(); break;
        case "textEditorRedo": editor.current?.redo(); break;
        case "textEditorFind": editor.current?.find(); break;
        case "textEditorReplace": editor.current?.replace(); break;
        case "textEditorWordWrap": setWordWrap((current) => !current); break;
        case "textEditorCommandPalette": editor.current?.commandPalette(); break;
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return;
      if (preservesOverlayEditing(event, apple)) return;
      const action = TEXT_EDITOR_SHORTCUT_ACTIONS.find((candidate) =>
        matchesKeyboardShortcut(shortcutFor(candidate), event, apple));
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) run(action);
        return;
      }
      // When a binding is changed, consume its old default before Monaco or
      // Chromium can continue handling the stale shortcut.
      const displaced = TEXT_EDITOR_SHORTCUT_ACTIONS.some((candidate) => {
        const configured = shortcutFor(candidate);
        const original = defaultKeyboardShortcut(candidate, apple);
        return configured !== original && matchesKeyboardShortcut(original, event, apple);
      });
      if (displaced) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [apple, open, save, shortcuts]);
  const eol = useMemo(() => {
    const endings = new Set(text.match(/\r\n|\r|\n/gu));
    if (endings.size > 1) return "Mixed EOL";
    return endings.has("\r\n") ? "CRLF" : endings.has("\r") ? "CR" : "LF";
  }, [text]);

  return <div className="text-editor-window flex h-full min-h-0 min-w-0 flex-1 flex-col" aria-label="Text editor workspace">
    <header className="text-editor-header flex shrink-0 flex-wrap items-center justify-between gap-2 pe-4 ps-[var(--text-editor-header-start,1rem)] py-2">
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <h1 className="truncate text-base font-semibold" title={title}>{title}</h1>
        <p className="shrink-0 text-xs text-muted" role="status">{document.readOnly ? "Read only" : pending === "save" ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}</p>
      </div>
      <div className="flex items-center gap-2">
        {onOpen && <Tooltip delay={250}>
          <Button size="sm" variant="tertiary" onPress={() => void open()} isDisabled={pending !== null}
            render={(props) => <button {...props} aria-keyshortcuts={shortcutAria("textEditorOpen")} />}>Open…</Button>
          <Tooltip.Content>{`Open · ${shortcutLabel("textEditorOpen")}`}</Tooltip.Content>
        </Tooltip>}
        {!document.remote && <Tooltip delay={250}>
          <Button size="sm" variant="tertiary" onPress={() => void save(true)} isDisabled={!ready || document.readOnly || pending !== null}
            render={(props) => <button {...props} aria-keyshortcuts={shortcutAria("textEditorSaveAs")} />}>Save As…</Button>
          <Tooltip.Content>{`Save As · ${shortcutLabel("textEditorSaveAs")}`}</Tooltip.Content>
        </Tooltip>}
        <Tooltip delay={250}>
          <Button size="sm" onPress={() => void save()} isPending={pending === "save"}
            isDisabled={!ready || !dirty || document.readOnly || pending !== null}
            render={(props) => <button {...props} aria-keyshortcuts={shortcutAria("textEditorSave")} />}>Save</Button>
          <Tooltip.Content>{`Save · ${shortcutLabel("textEditorSave")}`}</Tooltip.Content>
        </Tooltip>
      </div>
    </header>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-y border-separator px-4 py-2" role="group" aria-label="Editor controls">
      <Tooltip delay={250}><Button isIconOnly size="sm" variant="ghost" aria-label="Undo" isDisabled={!ready || readOnly}
        render={(props) => <button {...props} aria-keyshortcuts={shortcutAria("textEditorUndo")} />}
        onPress={() => editor.current?.undo()}><FontAwesomeIcon icon={faArrowRotateLeft} /></Button>
        <Tooltip.Content>{`Undo · ${shortcutLabel("textEditorUndo")}`}</Tooltip.Content></Tooltip>
      <Tooltip delay={250}><Button isIconOnly size="sm" variant="ghost" aria-label="Redo" isDisabled={!ready || readOnly}
        render={(props) => <button {...props} aria-keyshortcuts={shortcutAria("textEditorRedo")} />}
        onPress={() => editor.current?.redo()}><FontAwesomeIcon icon={faArrowRotateRight} /></Button>
        <Tooltip.Content>{`Redo · ${shortcutLabel("textEditorRedo")}`}</Tooltip.Content></Tooltip>
      <Tooltip delay={250}><Button size="sm" variant="ghost" isDisabled={!ready}
        render={(props) => <button {...props} aria-keyshortcuts={shortcutAria("textEditorFind")} />}
        onPress={() => editor.current?.find()}>Find</Button>
        <Tooltip.Content>{`Find · ${shortcutLabel("textEditorFind")}`}</Tooltip.Content></Tooltip>
      <Tooltip delay={250}><Button size="sm" variant="ghost" isDisabled={!ready || readOnly}
        render={(props) => <button {...props} aria-keyshortcuts={shortcutAria("textEditorReplace")} />}
        onPress={() => editor.current?.replace()}>Replace</Button>
        <Tooltip.Content>{`Replace · ${shortcutLabel("textEditorReplace")}`}</Tooltip.Content></Tooltip>
      <Tooltip delay={250}><Button size="sm" variant={wordWrap ? "secondary" : "ghost"} aria-pressed={wordWrap}
        render={(props) => <button {...props} aria-keyshortcuts={shortcutAria("textEditorWordWrap")} />}
        onPress={() => setWordWrap((current) => !current)}>Word Wrap</Button>
        <Tooltip.Content>{`Word Wrap · ${shortcutLabel("textEditorWordWrap")}`}</Tooltip.Content></Tooltip>
      <Tooltip delay={250}><Button size="sm" variant="ghost" isDisabled={!ready}
        render={(props) => <button {...props} aria-keyshortcuts={shortcutAria("textEditorCommandPalette")} />}
        onPress={() => editor.current?.commandPalette()}>Commands</Button>
        <Tooltip.Content>{`Command Palette · ${shortcutLabel("textEditorCommandPalette")}`}</Tooltip.Content></Tooltip>
      <div className="ml-auto flex items-center gap-2">
        <NativeSelect variant="secondary">
          <NativeSelect.Trigger aria-label="Editor font size" value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))}>
            {[11, 12, 13, 14, 16, 18, 20, 24].map((size) => <NativeSelect.Option key={size} value={size}>{size} px</NativeSelect.Option>)}
            <NativeSelect.Indicator />
          </NativeSelect.Trigger>
        </NativeSelect>
        <NativeSelect variant="secondary">
          <NativeSelect.Trigger aria-label="Document language" value={language} onChange={(event) => setLanguage(event.target.value)}>
            {LANGUAGES.map(([id, label]) => <NativeSelect.Option key={id} value={id}>{label}</NativeSelect.Option>)}
            <NativeSelect.Indicator />
          </NativeSelect.Trigger>
        </NativeSelect>
      </div>
    </div>
    {error && <p role="alert" className="shrink-0 px-6 py-3 text-sm text-danger">{error}</p>}
    <div className="min-h-0 min-w-0 flex-1">
      <CodeEditor modelKey={document.id} value={text} language={language} theme={theme} readOnly={readOnly}
        ariaLabel="Document text" editorHandleRef={editor} wordWrap={wordWrap} minimap fontSize={fontSize}
        useDefaultSaveKeybinding={false} keybindings={editorKeybindings}
        onCursorChange={setCursor} onReady={() => { setReady(true); editor.current?.focus(); }}
        onSave={() => void save()} onChange={(value) => {
          if (readOnly) return;
          dirtyRef.current = value !== savedText;
          setText(value);
        }} />
    </div>
    <footer className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-separator px-6 py-2 text-xs tabular-nums text-muted" aria-label="Editor status">
      <span>Ln {cursor.lineNumber}, Col {cursor.column}</span>
      <span>{text.length.toLocaleString()} characters</span>
      <span className="ml-auto">UTF-8</span><span>{eol}</span>
    </footer>
  </div>;
}

function preservesOverlayEditing(event: KeyboardEvent, apple: boolean): boolean {
  const target = event.target instanceof Element ? event.target : null;
  const editable = target?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])');
  if (!editable || editable.matches(".monaco-editor .inputarea")) return false;
  return matchesKeyboardShortcut(defaultKeyboardShortcut("textEditorUndo", apple), event, apple) ||
    matchesKeyboardShortcut(defaultKeyboardShortcut("textEditorRedo", apple), event, apple);
}
