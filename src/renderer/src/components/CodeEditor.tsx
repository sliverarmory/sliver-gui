import type { editor, IDisposable, KeyCode, Selection } from "monaco-editor/editor/editor.api";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";

import { isKeyboardShortcut } from "../../../shared/keyboard-shortcuts";
import { SCRIPT_LANGUAGE_ID } from "../editor/script-language-config";
import { preferredMonacoExtension } from "../editor/monaco-language-catalog";

type MonacoRuntime = typeof import("../editor/monaco-runtime");
export type CodeEditorProfile = "default" | "script";

export interface CodeEditorContextMenuState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly hasSelection: boolean;
  readonly hasText: boolean;
}

export interface CodeEditorSelectionRangeState {
  readonly selectionStartLineNumber: number;
  readonly selectionStartColumn: number;
  readonly positionLineNumber: number;
  readonly positionColumn: number;
}

export interface CodeEditorSelectionState {
  readonly modelUri: string;
  readonly modelVersionId: number;
  readonly selections: readonly CodeEditorSelectionRangeState[];
}

export interface CodeEditorSelectionCapture {
  readonly text: string;
  readonly state: CodeEditorSelectionState;
}

export interface CodeEditorHandle {
  focus(): void;
  contextMenuState(): CodeEditorContextMenuState;
  undo(): void;
  redo(): void;
  captureSelection(): CodeEditorSelectionCapture | undefined;
  pasteText(text: string, expectedState?: CodeEditorSelectionState): void;
  deleteSelection(expectedState?: CodeEditorSelectionState): void;
  selectAll(): void;
  find(): void;
  replace(): void;
  commandPalette(): void;
}

export interface CodeEditorCursor {
  readonly lineNumber: number;
  readonly column: number;
}

const CODE_EDITOR_SHORTCUT_COMMANDS = ["save", "undo", "redo", "find", "replace", "commandPalette"] as const;
export type CodeEditorShortcutCommand = (typeof CODE_EDITOR_SHORTCUT_COMMANDS)[number];
export type CodeEditorKeybindings = Readonly<Record<CodeEditorShortcutCommand, string>>;

const CODE_EDITOR_COMMAND_IDS: Readonly<Record<CodeEditorShortcutCommand, string>> = {
  save: "application.editor.save",
  undo: "undo",
  redo: "redo",
  find: "actions.find",
  replace: "editor.action.startFindReplaceAction",
  commandPalette: "editor.action.quickCommand",
};

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Stable in-memory identity; changing it preserves the prior model's undo/view state. */
  modelKey: string;
  language?: string;
  profile?: CodeEditorProfile;
  readOnly?: boolean;
  ariaLabel?: string;
  onSave?: () => void;
  onRun?: () => void;
  editorHandleRef?: Ref<CodeEditorHandle>;
  wordWrap?: boolean;
  minimap?: boolean;
  fontSize?: number;
  fontFamily?: string;
  tabSize?: number;
  insertSpaces?: boolean;
  lineNumbers?: "on" | "relative" | "off";
  renderWhitespace?: "none" | "selection" | "boundary" | "trailing" | "all";
  stickyScroll?: boolean;
  bracketPairColorization?: boolean;
  fontLigatures?: boolean;
  /** Keep the built-in save key only when a host does not own configurable shortcuts. */
  useDefaultSaveKeybinding?: boolean;
  /** Monaco-owned shortcut remaps; hosts retain window-only commands separately. */
  keybindings?: CodeEditorKeybindings;
  onCursorChange?: (position: CodeEditorCursor) => void;
  onReady?: () => void;
  theme?: "light" | "dark";
  className?: string;
}

interface CachedModel {
  model: editor.ITextModel;
  viewState: editor.ICodeEditorViewState | null;
  diagnostics?: IDisposable;
}

let editorSequence = 0;

/**
 * Reusable local Monaco wrapper. Models live for this component's mounted
 * lifetime, preserving undo/selection/scroll when switching modelKey. Unmount
 * disposes every model, listener, observer, editor and script-analysis worker.
 */
export function CodeEditor(props: CodeEditorProps): React.JSX.Element {
  const {
    value, modelKey, language = "javascript", profile = "default", readOnly = false,
    ariaLabel = "Code editor", theme = "dark", className = "", wordWrap = false,
    minimap = false, fontSize = 13,
    fontFamily = '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    tabSize = 2, insertSpaces = true, lineNumbers = "on", renderWhitespace = "selection",
    stickyScroll = false, bracketPairColorization = true, fontLigatures = false,
  } = props;
  const container = useRef<HTMLDivElement>(null);
  const currentProps = useRef(props);
  currentProps.current = props;
  const runtimeRef = useRef<MonacoRuntime | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const models = useRef(new Map<string, CachedModel>());
  const selectedModel = useRef<string | null>(null);
  const synchronizing = useRef(false);
  const ownerId = useRef<string | null>(null);
  if (ownerId.current === null) ownerId.current = String(++editorSequence);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasRunAction = Boolean(props.onRun);
  const keybindings = props.keybindings;

  useImperativeHandle(props.editorHandleRef, () => {
    const command = (
      id: string,
      changesContent = false,
      args: unknown = null,
      expectedSelectionState?: CodeEditorSelectionState,
    ): void => {
      const instance = editorRef.current;
      if (!instance || (changesContent && currentProps.current.readOnly)) return;
      if (expectedSelectionState && !selectionStateMatches(instance, expectedSelectionState)) return;
      instance.focus();
      // Focus restoration can synchronously run editor listeners. Recheck the
      // captured model and selections before applying delayed clipboard work.
      if (expectedSelectionState && !selectionStateMatches(instance, expectedSelectionState)) return;
      instance.trigger("application.editor", id, args);
    };
    return {
      focus: () => { editorRef.current?.focus(); },
      contextMenuState: () => {
        const instance = editorRef.current;
        const model = instance?.getModel();
        const selections = instance?.getSelections();
        const writable = currentProps.current.readOnly !== true;
        return {
          canUndo: Boolean(writable && model?.canUndo()),
          canRedo: Boolean(writable && model?.canRedo()),
          hasSelection: Boolean(selections?.some((selection) => !selection.isEmpty())),
          hasText: Boolean(model && model.getValueLength() > 0),
        };
      },
      undo: () => command("undo", true),
      redo: () => command("redo", true),
      captureSelection: () => {
        const instance = editorRef.current;
        const model = instance?.getModel();
        const selections = instance?.getSelections();
        if (!model || !selections) return undefined;
        return {
          text: selections.map((selection) => model.getValueInRange(selection)).join("\n"),
          state: selectionState(model, selections),
        };
      },
      pasteText: (text, expectedState) => command("paste", true, {
        text,
        pasteOnNewLine: false,
        multicursorText: null,
      }, expectedState),
      deleteSelection: (expectedState) => {
        const selections = editorRef.current?.getSelections();
        if (!selections?.some((selection) => !selection.isEmpty())) return;
        command("deleteLeft", true, null, expectedState);
      },
      selectAll: () => command("editor.action.selectAll"),
      find: () => command("actions.find"),
      replace: () => command("editor.action.startFindReplaceAction", true),
      commandPalette: () => command("editor.action.quickCommand"),
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const disposables: IDisposable[] = [];
    let resizeObserver: ResizeObserver | undefined;
    let frame: number | undefined;
    void import("../editor/monaco-runtime").then((runtime) => {
      if (disposed || !container.current) return;
      const host = container.current;
      runtimeRef.current = runtime;
      const latest = currentProps.current;
      runtime.monaco.editor.setTheme(latest.theme === "light" ? "vs" : "vs-dark");
      let pendingDimension = editorDimensions(host.getBoundingClientRect());
      let lastDimension: editor.IDimension | undefined;
      const instance = runtime.monaco.editor.create(host, {
        model: null,
        dimension: pendingDimension,
        ariaLabel: latest.ariaLabel ?? "Code editor",
        readOnly: latest.readOnly ?? false,
        automaticLayout: false,
        autoDetectHighContrast: false,
        contextmenu: false,
        links: false,
        minimap: { enabled: latest.minimap ?? false },
        fontFamily: latest.fontFamily ?? '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        fontSize: latest.fontSize ?? 13,
        lineHeight: Math.round((latest.fontSize ?? 13) * 21 / 13),
        tabSize: latest.tabSize ?? 2,
        insertSpaces: latest.insertSpaces ?? true,
        lineNumbers: latest.lineNumbers ?? "on",
        renderWhitespace: latest.renderWhitespace ?? "selection",
        bracketPairColorization: { enabled: latest.bracketPairColorization ?? true },
        fontLigatures: latest.fontLigatures ?? false,
        scrollBeyondLastLine: false,
        padding: { top: 12, bottom: 12 },
        renderLineHighlight: "line",
        roundedSelection: false,
        stickyScroll: { enabled: latest.stickyScroll ?? false },
        wordWrap: latest.wordWrap ? "on" : "off",
        hover: { enabled: "off" },
        unicodeHighlight: { ambiguousCharacters: true, invisibleCharacters: true },
        suggest: { showWords: false },
      });
      editorRef.current = instance;
      disposables.push(instance.onDidChangeModelContent(() => {
        if (!synchronizing.current) currentProps.current.onChange(instance.getValue());
      }));
      disposables.push(instance.onDidChangeCursorPosition(({ position }) => {
        currentProps.current.onCursorChange?.({ lineNumber: position.lineNumber, column: position.column });
      }));
      disposables.push(instance.addAction({
        id: "application.editor.save",
        label: "Save",
        ...(latest.useDefaultSaveKeybinding === false ? {} : {
          keybindings: [runtime.monaco.KeyMod.CtrlCmd | runtime.monaco.KeyCode.KeyS],
        }),
        run: () => { currentProps.current.onSave?.(); },
      }));
      const layout = (): void => {
        if (frame !== undefined) return;
        frame = requestAnimationFrame(() => {
          frame = undefined;
          if (disposed) return;
          const dimension = pendingDimension;
          if (dimension.width <= 0 || dimension.height <= 0) {
            // A hidden mounted view must relayout when it becomes visible again.
            lastDimension = undefined;
            return;
          }
          if (lastDimension?.width === dimension.width && lastDimension.height === dimension.height) return;
          lastDimension = dimension;
          instance.layout(dimension);
        });
      };
      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries.find((candidate) => candidate.target === host);
        if (!entry) return;
        // clientWidth/clientHeight round fractional panel sizes, which can make
        // Monaco overflow its viewport and provoke another parent resize.
        pendingDimension = editorDimensions(entry.contentRect);
        layout();
      });
      resizeObserver.observe(host);
      layout();
      setReady(true);
    }).catch(() => {
      if (!disposed) setError("The code editor could not be loaded. Reopen this view to try again.");
    });
    return () => {
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      for (const disposable of disposables) disposable.dispose();
      editorRef.current?.dispose();
      editorRef.current = null;
      for (const entry of models.current.values()) {
        entry.diagnostics?.dispose();
        entry.model.dispose();
      }
      models.current.clear();
      selectedModel.current = null;
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = editorRef.current;
    const runtime = runtimeRef.current;
    if (!ready || !hasRunAction || !instance || !runtime) return;
    const action = instance.addAction({
      id: "application.editor.run",
      label: "Run",
      keybindings: [runtime.monaco.KeyMod.CtrlCmd | runtime.monaco.KeyCode.Enter],
      run: () => { currentProps.current.onRun?.(); },
    });
    return () => action.dispose();
  }, [hasRunAction, ready]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!ready || !runtime || !keybindings) return;
    const replacements = CODE_EDITOR_SHORTCUT_COMMANDS.flatMap((command) => {
      const keybinding = toMonacoKeybinding(runtime, keybindings[command]);
      return keybinding === undefined ? [] : [{
        keybinding,
        command: CODE_EDITOR_COMMAND_IDS[command],
        when: "editorTextFocus",
      }];
    });
    const rules = runtime.monaco.editor.addKeybindingRules([
      ...CODE_EDITOR_SHORTCUT_COMMANDS.map((command) => ({
        keybinding: 0,
        command: `-${CODE_EDITOR_COMMAND_IDS[command]}`,
      })),
      ...replacements,
    ]);
    return () => rules.dispose();
  }, [keybindings, ready]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    const instance = editorRef.current;
    if (!ready || !runtime || !instance) return;
    const resolvedLanguage = profile === "script" ? SCRIPT_LANGUAGE_ID : language;
    // Language selection must not replace the document's undo/selection state.
    // The script profile retains separate diagnostics and a separate model.
    const identity = JSON.stringify([modelKey, profile]);
    if (selectedModel.current !== identity) {
      const previous = selectedModel.current === null ? undefined : models.current.get(selectedModel.current);
      if (previous) previous.viewState = instance.saveViewState();
      let entry = models.current.get(identity);
      if (!entry) {
        const extension = profile === "script" ? "js" :
          preferredMonacoExtension(language, runtime.monaco.languages.getLanguages()) ?? editorExtension(language);
        const uri = runtime.monaco.Uri.parse(
          `inmemory://editor-${ownerId.current}/${encodeURIComponent(identity)}.${extension}`,
        );
        const model = runtime.monaco.editor.createModel(value, resolvedLanguage, uri);
        model.updateOptions({
          tabSize: currentProps.current.tabSize ?? 2,
          insertSpaces: currentProps.current.insertSpaces ?? true,
        });
        entry = { model, viewState: null };
        if (profile === "script") entry.diagnostics = runtime.attachScriptDiagnostics(runtime.monaco, model);
        models.current.set(identity, entry);
      }
      synchronizing.current = true;
      try {
        instance.setModel(entry.model);
        if (entry.viewState) instance.restoreViewState(entry.viewState);
        selectedModel.current = identity;
        const position = instance.getPosition();
        if (position) currentProps.current.onCursorChange?.({ lineNumber: position.lineNumber, column: position.column });
      } finally {
        synchronizing.current = false;
      }
    }
    const model = instance.getModel();
    if (model && model.getLanguageId() !== resolvedLanguage) runtime.monaco.editor.setModelLanguage(model, resolvedLanguage);
    if (model && model.getValue() !== value) {
      synchronizing.current = true;
      try {
        // Controlled updates preserve undo; echoes of onChange do no work.
        model.pushStackElement();
        model.pushEditOperations(null, [{ range: model.getFullModelRange(), text: value }], () => null);
        model.pushStackElement();
      } finally {
        synchronizing.current = false;
      }
    }
  }, [ready, modelKey, language, profile, value]);

  useEffect(() => {
    if (!ready) return;
    for (const { model } of models.current.values()) model.updateOptions({ tabSize, insertSpaces });
  }, [ready, tabSize, insertSpaces]);

  useEffect(() => {
    if (!ready) return;
    editorRef.current?.updateOptions({
      readOnly, ariaLabel, wordWrap: wordWrap ? "on" : "off", minimap: { enabled: minimap }, fontSize,
      fontFamily, lineHeight: Math.round(fontSize * 21 / 13), lineNumbers, renderWhitespace,
      stickyScroll: { enabled: stickyScroll }, bracketPairColorization: { enabled: bracketPairColorization },
      fontLigatures,
    });
    runtimeRef.current?.monaco.editor.setTheme(theme === "light" ? "vs" : "vs-dark");
  }, [ready, readOnly, ariaLabel, theme, wordWrap, minimap, fontSize, fontFamily, lineNumbers,
    renderWhitespace, stickyScroll, bracketPairColorization, fontLigatures]);

  useEffect(() => {
    if (ready) currentProps.current.onReady?.();
  }, [ready]);

  return (
    <div className={`relative h-full min-h-0 min-w-0 w-full overflow-hidden ${className}`} data-code-editor={profile}>
      <div className="absolute inset-0 min-h-0 min-w-0 overflow-hidden" ref={container} />
      {!ready && !error && <div className="absolute inset-0 flex items-center justify-center text-sm text-muted" role="status">Loading editor…</div>}
      {error && <div className="absolute inset-0 flex items-center justify-center p-4 text-sm text-danger" role="alert">{error}</div>}
    </div>
  );
}

function selectionState(
  model: editor.ITextModel,
  selections: readonly Selection[],
): CodeEditorSelectionState {
  return {
    modelUri: model.uri.toString(),
    modelVersionId: model.getVersionId(),
    selections: selections.map((selection) => ({
      selectionStartLineNumber: selection.selectionStartLineNumber,
      selectionStartColumn: selection.selectionStartColumn,
      positionLineNumber: selection.positionLineNumber,
      positionColumn: selection.positionColumn,
    })),
  };
}

function selectionStateMatches(
  instance: editor.IStandaloneCodeEditor,
  expected: CodeEditorSelectionState,
): boolean {
  const model = instance.getModel();
  const selections = instance.getSelections();
  if (!model || !selections || model.uri.toString() !== expected.modelUri ||
    model.getVersionId() !== expected.modelVersionId || selections.length !== expected.selections.length) return false;
  return selections.every((selection, index) => {
    const expectedSelection = expected.selections[index];
    return expectedSelection !== undefined &&
      selection.selectionStartLineNumber === expectedSelection.selectionStartLineNumber &&
      selection.selectionStartColumn === expectedSelection.selectionStartColumn &&
      selection.positionLineNumber === expectedSelection.positionLineNumber &&
      selection.positionColumn === expectedSelection.positionColumn;
  });
}

function editorDimensions(size: Pick<DOMRectReadOnly, "width" | "height">): editor.IDimension {
  return { width: Math.max(0, Math.floor(size.width)), height: Math.max(0, Math.floor(size.height)) };
}

function editorExtension(language: string): string {
  const extensions: Readonly<Record<string, string>> = {
    javascript: "js", typescript: "ts", plaintext: "txt", json: "json",
    xml: "xml", markdown: "md", yaml: "yaml", css: "css", html: "html", shell: "sh", powershell: "ps1",
  };
  return extensions[language] ?? "txt";
}

function toMonacoKeybinding(runtime: MonacoRuntime, shortcut: string): number | undefined {
  if (!isKeyboardShortcut(shortcut)) return undefined;
  const tokens = shortcut.split("+");
  const key = tokens.at(-1);
  if (!key) return undefined;
  const keyCode = monacoKeyCode(runtime, key);
  if (keyCode === undefined) return undefined;
  return keyCode |
    (tokens.includes("mod") ? runtime.monaco.KeyMod.CtrlCmd : 0) |
    (tokens.includes("alt") ? runtime.monaco.KeyMod.Alt : 0) |
    (tokens.includes("shift") ? runtime.monaco.KeyMod.Shift : 0);
}

function monacoKeyCode(runtime: MonacoRuntime, key: string): KeyCode | undefined {
  if (/^[a-z]$/u.test(key)) {
    return (runtime.monaco.KeyCode.KeyA + key.charCodeAt(0) - "a".charCodeAt(0)) as KeyCode;
  }
  if (/^[0-9]$/u.test(key)) {
    return (runtime.monaco.KeyCode.Digit0 + Number(key)) as KeyCode;
  }
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/u.exec(key);
  if (functionKey) return (runtime.monaco.KeyCode.F1 + Number(functionKey[1]) - 1) as KeyCode;
  const fixed: Readonly<Record<string, KeyCode>> = {
    arrowleft: runtime.monaco.KeyCode.LeftArrow,
    arrowright: runtime.monaco.KeyCode.RightArrow,
    arrowup: runtime.monaco.KeyCode.UpArrow,
    arrowdown: runtime.monaco.KeyCode.DownArrow,
    ";": runtime.monaco.KeyCode.Semicolon,
    "=": runtime.monaco.KeyCode.Equal,
    ",": runtime.monaco.KeyCode.Comma,
    "-": runtime.monaco.KeyCode.Minus,
    ".": runtime.monaco.KeyCode.Period,
    "/": runtime.monaco.KeyCode.Slash,
    "`": runtime.monaco.KeyCode.Backquote,
    "[": runtime.monaco.KeyCode.BracketLeft,
    "\\": runtime.monaco.KeyCode.Backslash,
    "]": runtime.monaco.KeyCode.BracketRight,
    "'": runtime.monaco.KeyCode.Quote,
  };
  return fixed[key];
}
