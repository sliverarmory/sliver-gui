import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => {
  type Model = {
    value: string;
    versionId: number;
    language: string;
    uri: string;
    dispose: ReturnType<typeof vi.fn>;
    updateOptions: ReturnType<typeof vi.fn>;
    pushStackElement: ReturnType<typeof vi.fn>;
    pushEditOperations: ReturnType<typeof vi.fn>;
    canUndo: ReturnType<typeof vi.fn>;
    canRedo: ReturnType<typeof vi.fn>;
    getValue: () => string;
    getValueLength: () => number;
    getValueInRange: (range: SelectionFixture) => string;
    getVersionId: () => number;
    getLanguageId: () => string;
    getFullModelRange: () => object;
  };
  type SelectionInput = {
    value: string;
    selectionStartLineNumber: number;
    selectionStartColumn: number;
    positionLineNumber: number;
    positionColumn: number;
  };
  type SelectionFixture = SelectionInput & { isEmpty: () => boolean };
  const selection = (input: SelectionInput): SelectionFixture => ({
    ...input,
    isEmpty: () => input.selectionStartLineNumber === input.positionLineNumber &&
      input.selectionStartColumn === input.positionColumn,
  });
  const models: Model[] = [];
  let selected: Model | null = null;
  let selections = [selection({
    value: "selected text",
    selectionStartLineNumber: 1,
    selectionStartColumn: 1,
    positionLineNumber: 1,
    positionColumn: 14,
  })];
  let change: (() => void) | undefined;
  let cursorChange: ((event: { position: { lineNumber: number; column: number } }) => void) | undefined;
  type Action = { id: string; run: () => void; keybindings?: number[] };
  const actions = new Map<string, Action>();
  const actionDispose = vi.fn();
  const listenerDispose = vi.fn();
  const cursorListenerDispose = vi.fn();
  const diagnosticsDispose = vi.fn();
  const keybindingRulesDispose = vi.fn();
  const addKeybindingRules = vi.fn((_rules: Array<{ keybinding: number; command: string; when?: string }>) =>
    ({ dispose: keybindingRulesDispose }));
  const instance = {
    dispose: vi.fn(),
    layout: vi.fn(),
    focus: vi.fn(),
    trigger: vi.fn(),
    updateOptions: vi.fn(),
    saveViewState: vi.fn(() => ({ cursor: 12 })),
    restoreViewState: vi.fn(),
    setModel: vi.fn((model: Model) => { selected = model; }),
    getModel: () => selected,
    getValue: () => selected?.value ?? "",
    getSelection: () => selections[0] ?? null,
    getSelections: () => selections,
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    onDidChangeModelContent: vi.fn((callback: () => void) => {
      change = callback;
      return { dispose: listenerDispose };
    }),
    onDidChangeCursorPosition: vi.fn((callback: typeof cursorChange) => {
      cursorChange = callback;
      return { dispose: cursorListenerDispose };
    }),
    addAction: vi.fn((action: Action) => {
      actions.set(action.id, action);
      return { dispose: actionDispose };
    }),
  };
  const create = vi.fn(() => instance);
  const setTheme = vi.fn();
  const setModelLanguage = vi.fn((model: Model, language: string) => { model.language = language; });
  const attachScriptDiagnostics = vi.fn(() => ({ dispose: diagnosticsDispose }));
  const createModel = vi.fn((value: string, language: string, uri: string) => {
    const model: Model = {
      value, versionId: 1, language, uri,
      dispose: vi.fn(), updateOptions: vi.fn(), pushStackElement: vi.fn(),
      canUndo: vi.fn(() => true),
      canRedo: vi.fn(() => true),
      getValue: () => model.value,
      getValueLength: () => model.value.length,
      getValueInRange: (range) => range.value,
      getVersionId: () => model.versionId,
      getLanguageId: () => model.language,
      getFullModelRange: () => ({ full: true }),
      pushEditOperations: vi.fn((_before: unknown, edits: Array<{ text: string }>) => {
        model.value = edits[0]?.text ?? "";
        model.versionId += 1;
        change?.();
      }),
    };
    models.push(model);
    return model;
  });
  return {
    models, actions, create, createModel, setTheme, setModelLanguage, attachScriptDiagnostics,
    instance, actionDispose, listenerDispose, cursorListenerDispose, diagnosticsDispose,
    addKeybindingRules, keybindingRulesDispose,
    type: (value: string) => {
      if (selected) {
        selected.value = value;
        selected.versionId += 1;
      }
      change?.();
    },
    setSelections: (next: SelectionInput[]) => { selections = next.map(selection); },
    moveCursor: (lineNumber: number, column: number) => cursorChange?.({ position: { lineNumber, column } }),
    reset: () => {
      selected = null;
      selections = [selection({
        value: "selected text",
        selectionStartLineNumber: 1,
        selectionStartColumn: 1,
        positionLineNumber: 1,
        positionColumn: 14,
      })];
      change = undefined;
      cursorChange = undefined;
      models.length = 0;
      actions.clear();
    },
  };
});

vi.mock("../editor/monaco-runtime", () => ({
  monaco: {
    editor: { create: mocked.create, createModel: mocked.createModel, setTheme: mocked.setTheme,
      setModelLanguage: mocked.setModelLanguage, addKeybindingRules: mocked.addKeybindingRules },
    Uri: { parse: (uri: string) => uri },
    languages: { getLanguages: () => [
      { id: "plaintext", extensions: [".txt"] },
      { id: "xml", extensions: [".xml"] },
      { id: "javascript", extensions: [".js"] },
    ] },
    KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
    KeyCode: {
      Enter: 3, LeftArrow: 15, UpArrow: 16, RightArrow: 17, DownArrow: 18,
      Digit0: 21, KeyA: 31, KeyS: 49, F1: 59, Semicolon: 85, Equal: 86, Comma: 87,
      Minus: 88, Period: 89, Slash: 90, Backquote: 91, BracketLeft: 92, Backslash: 93,
      BracketRight: 94, Quote: 95,
    },
  },
  attachScriptDiagnostics: mocked.attachScriptDiagnostics,
}));

import { CodeEditor, type CodeEditorHandle } from "./CodeEditor";

const disconnect = vi.fn();
const observe = vi.fn();
let onResize: ResizeObserverCallback | undefined;

function resize(width: number, height: number): void {
  const target = observe.mock.calls[0]?.[0] as HTMLElement;
  const boxSize = [{ inlineSize: width, blockSize: height }];
  onResize?.([{
    target, contentRect: new DOMRect(0, 0, width, height), borderBoxSize: boxSize,
    contentBoxSize: boxSize, devicePixelContentBoxSize: boxSize,
  }], {} as ResizeObserver);
}

function animationFrames(): { flush(): void; pending: Map<number, FrameRequestCallback> } {
  let next = 0;
  const pending = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++next;
    pending.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { pending.delete(id); });
  return {
    pending,
    flush: () => {
      const callbacks = [...pending.values()];
      pending.clear();
      act(() => { callbacks.forEach((callback) => callback(performance.now())); });
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.reset();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { onResize = callback; }
    observe = observe;
    disconnect = disconnect;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CodeEditor", () => {
  it("reuses cached models and restores their view state across script switches", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<CodeEditor value="one" modelKey="a" profile="script" onChange={onChange} />);
    await waitFor(() => expect(mocked.models).toHaveLength(1));
    const first = mocked.models[0];
    expect(first?.language).toBe("sliver-script");
    expect(mocked.create).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({ links: false, contextmenu: false }));
    rerender(<CodeEditor value="two" modelKey="b" profile="script" onChange={onChange} />);
    expect(mocked.models).toHaveLength(2);
    rerender(<CodeEditor value="one" modelKey="a" profile="script" onChange={onChange} />);
    expect(mocked.models).toHaveLength(2);
    expect(mocked.instance.getModel()).toBe(first);
    expect(mocked.instance.restoreViewState).toHaveBeenCalledWith({ cursor: 12 });
    expect(first?.pushEditOperations).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("echoes edits once and preserves undo for external controlled updates", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<CodeEditor value="one" modelKey="a" onChange={onChange} />);
    await waitFor(() => expect(mocked.models).toHaveLength(1));
    act(() => { mocked.type("edited"); });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("edited");
    rerender(<CodeEditor value="edited" modelKey="a" onChange={onChange} />);
    expect(mocked.models[0]?.pushEditOperations).not.toHaveBeenCalled();
    rerender(<CodeEditor value="external" modelKey="a" onChange={onChange} />);
    expect(mocked.models[0]?.pushEditOperations).toHaveBeenCalledOnce();
    expect(mocked.models[0]?.pushStackElement).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(mocked.attachScriptDiagnostics).not.toHaveBeenCalled();
  });

  it("uses fresh callbacks, updates options and disposes all owned resources", async () => {
    const initialSave = vi.fn();
    const initialRun = vi.fn();
    const save = vi.fn();
    const run = vi.fn();
    const { rerender, unmount } = render(<CodeEditor value="one" modelKey="a" profile="script" onChange={vi.fn()}
      onSave={initialSave} onRun={initialRun} />);
    await waitFor(() => expect(mocked.models).toHaveLength(1));
    rerender(<CodeEditor value="one" modelKey="a" profile="script" onChange={vi.fn()} onSave={save} onRun={run} readOnly theme="light" ariaLabel="Example source" />);
    mocked.actions.get("application.editor.save")?.run();
    mocked.actions.get("application.editor.run")?.run();
    expect(save).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(initialSave).not.toHaveBeenCalled();
    expect(initialRun).not.toHaveBeenCalled();
    expect(mocked.setTheme).toHaveBeenLastCalledWith("vs");
    expect(mocked.instance.updateOptions).toHaveBeenLastCalledWith({
      readOnly: true, ariaLabel: "Example source", wordWrap: "off",
      minimap: { enabled: false }, fontSize: 13, lineHeight: 21,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      lineNumbers: "on", renderWhitespace: "selection",
      stickyScroll: { enabled: false }, bracketPairColorization: { enabled: true },
      fontLigatures: false,
    });
    expect(observe).toHaveBeenCalledOnce();
    act(() => { resize(640, 480); });
    unmount();
    expect(mocked.instance.dispose).toHaveBeenCalledOnce();
    expect(mocked.models[0]?.dispose).toHaveBeenCalledOnce();
    expect(mocked.diagnosticsDispose).toHaveBeenCalledOnce();
    expect(mocked.listenerDispose).toHaveBeenCalledOnce();
    expect(mocked.cursorListenerDispose).toHaveBeenCalledOnce();
    expect(mocked.actionDispose).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("omits the built-in save chord when its host owns configurable shortcuts", async () => {
    const save = vi.fn();
    render(<CodeEditor value="text" modelKey="document" onChange={vi.fn()} onSave={save} useDefaultSaveKeybinding={false} />);
    await waitFor(() => expect(mocked.models).toHaveLength(1));
    const action = mocked.actions.get("application.editor.save");
    expect(action?.keybindings).toBeUndefined();
    expect(mocked.actions.has("application.editor.run")).toBe(false);
    act(() => { action?.run(); });
    expect(save).toHaveBeenCalledOnce();
  });

  it("adds and removes the Run action when its callback availability changes", async () => {
    const run = vi.fn();
    const { rerender } = render(<CodeEditor value="text" modelKey="document" onChange={vi.fn()} />);
    await waitFor(() => expect(mocked.models).toHaveLength(1));
    expect(mocked.actions.has("application.editor.run")).toBe(false);
    rerender(<CodeEditor value="text" modelKey="document" onChange={vi.fn()} onRun={run} />);
    expect(mocked.actions.has("application.editor.run")).toBe(true);
    mocked.actions.get("application.editor.run")?.run();
    expect(run).toHaveBeenCalledOnce();
    rerender(<CodeEditor value="text" modelKey="document" onChange={vi.fn()} />);
    expect(mocked.actionDispose).toHaveBeenCalledOnce();
  });

  it("replaces Monaco command bindings and disposes stale palette hints", async () => {
    const first = {
      save: "mod+alt+s", undo: "mod+z", redo: "mod+shift+z", find: "mod+f",
      replace: "mod+alt+f", commandPalette: "f2",
    };
    const { rerender, unmount } = render(<CodeEditor value="text" modelKey="document" onChange={vi.fn()}
      useDefaultSaveKeybinding={false} keybindings={first} />);
    await waitFor(() => expect(mocked.addKeybindingRules).toHaveBeenCalledOnce());
    const rules = mocked.addKeybindingRules.mock.calls[0]?.[0];
    expect(rules).toEqual(expect.arrayContaining([
      { keybinding: 0, command: "-application.editor.save" },
      { keybinding: 0, command: "-undo" },
      { keybinding: 0, command: "-redo" },
      { keybinding: 0, command: "-actions.find" },
      { keybinding: 0, command: "-editor.action.startFindReplaceAction" },
      { keybinding: 0, command: "-editor.action.quickCommand" },
      { keybinding: 2048 | 512 | 49, command: "application.editor.save", when: "editorTextFocus" },
      { keybinding: 60, command: "editor.action.quickCommand", when: "editorTextFocus" },
    ]));
    rerender(<CodeEditor value="text" modelKey="document" onChange={vi.fn()} useDefaultSaveKeybinding={false}
      keybindings={{ ...first, commandPalette: "f3" }} />);
    expect(mocked.keybindingRulesDispose).toHaveBeenCalledOnce();
    expect(mocked.addKeybindingRules).toHaveBeenCalledTimes(2);
    unmount();
    expect(mocked.keybindingRulesDispose).toHaveBeenCalledTimes(2);
  });

  it("keeps the document and undo history when only its language changes", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<CodeEditor value="text" modelKey="document" language="plaintext" onChange={onChange} />);
    await waitFor(() => expect(mocked.models).toHaveLength(1));
    const model = mocked.models[0];
    expect(model?.uri).toMatch(/\.txt$/u);
    act(() => { mocked.type("edited"); });
    rerender(<CodeEditor value="edited" modelKey="document" language="xml" onChange={onChange} />);
    expect(mocked.models).toHaveLength(1);
    expect(mocked.instance.getModel()).toBe(model);
    expect(mocked.setModelLanguage).toHaveBeenCalledExactlyOnceWith(model, "xml");
    expect(model?.pushEditOperations).not.toHaveBeenCalled();
    expect(mocked.instance.setModel).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("edited");
  });

  it("exposes focused editing controls while respecting current read-only state", async () => {
    const handle = createRef<CodeEditorHandle>();
    const { rerender, unmount } = render(<CodeEditor value="text" modelKey="document" onChange={vi.fn()} editorHandleRef={handle} />);
    await waitFor(() => expect(mocked.models).toHaveLength(1));
    const originalHandle = handle.current!;
    act(() => {
      originalHandle.focus();
      originalHandle.undo();
      originalHandle.redo();
      originalHandle.find();
      originalHandle.replace();
      originalHandle.commandPalette();
    });
    expect(mocked.instance.focus).toHaveBeenCalledTimes(6);
    expect(mocked.instance.trigger.mock.calls).toEqual([
      ["application.editor", "undo", null],
      ["application.editor", "redo", null],
      ["application.editor", "actions.find", null],
      ["application.editor", "editor.action.startFindReplaceAction", null],
      ["application.editor", "editor.action.quickCommand", null],
    ]);
    mocked.instance.trigger.mockClear();
    rerender(<CodeEditor value="text" modelKey="document" onChange={vi.fn()} editorHandleRef={handle} readOnly />);
    expect(handle.current).toBe(originalHandle);
    act(() => { originalHandle.undo(); originalHandle.redo(); originalHandle.replace(); originalHandle.find(); });
    expect(mocked.instance.trigger).toHaveBeenCalledExactlyOnceWith("application.editor", "actions.find", null);
    unmount();
    expect(handle.current).toBeNull();
    mocked.instance.trigger.mockClear();
    originalHandle.find();
    expect(mocked.instance.trigger).not.toHaveBeenCalled();
  });

  it("captures every selection and exposes context-menu commands with read-only guards", async () => {
    const handle = createRef<CodeEditorHandle>();
    const { rerender, unmount } = render(
      <CodeEditor value="text" modelKey="document" onChange={vi.fn()} editorHandleRef={handle} />,
    );
    await waitFor(() => expect(mocked.models).toHaveLength(1));
    const originalHandle = handle.current!;
    mocked.setSelections([{
      value: "",
      selectionStartLineNumber: 1,
      selectionStartColumn: 2,
      positionLineNumber: 1,
      positionColumn: 2,
    }, {
      value: "second selection",
      selectionStartLineNumber: 3,
      selectionStartColumn: 4,
      positionLineNumber: 3,
      positionColumn: 20,
    }]);

    expect(originalHandle.contextMenuState()).toEqual({
      canUndo: true,
      canRedo: true,
      hasSelection: true,
      hasText: true,
    });
    const capture = originalHandle.captureSelection();
    expect(capture).toEqual({
      text: "\nsecond selection",
      state: {
        modelUri: mocked.models[0]?.uri,
        modelVersionId: 1,
        selections: [{
          selectionStartLineNumber: 1,
          selectionStartColumn: 2,
          positionLineNumber: 1,
          positionColumn: 2,
        }, {
          selectionStartLineNumber: 3,
          selectionStartColumn: 4,
          positionLineNumber: 3,
          positionColumn: 20,
        }],
      },
    });
    act(() => {
      originalHandle.deleteSelection(capture?.state);
      originalHandle.pasteText("clipboard text", capture?.state);
      originalHandle.selectAll();
    });
    expect(mocked.instance.focus).toHaveBeenCalledTimes(3);
    expect(mocked.instance.trigger.mock.calls).toEqual([
      ["application.editor", "deleteLeft", null],
      ["application.editor", "paste", {
        text: "clipboard text",
        pasteOnNewLine: false,
        multicursorText: null,
      }],
      ["application.editor", "editor.action.selectAll", null],
    ]);

    mocked.instance.focus.mockClear();
    mocked.instance.trigger.mockClear();
    rerender(
      <CodeEditor value="text" modelKey="document" onChange={vi.fn()} editorHandleRef={handle} readOnly />,
    );
    expect(handle.current).toBe(originalHandle);
    expect(originalHandle.contextMenuState()).toEqual({
      canUndo: false,
      canRedo: false,
      hasSelection: true,
      hasText: true,
    });
    act(() => {
      originalHandle.pasteText("blocked clipboard text", capture?.state);
      originalHandle.deleteSelection(capture?.state);
      originalHandle.selectAll();
    });
    expect(mocked.instance.focus).toHaveBeenCalledOnce();
    expect(mocked.instance.trigger.mock.calls).toEqual([
      ["application.editor", "editor.action.selectAll", null],
    ]);

    mocked.setSelections([{
      value: "",
      selectionStartLineNumber: 1,
      selectionStartColumn: 1,
      positionLineNumber: 1,
      positionColumn: 1,
    }]);
    act(() => { mocked.type(""); });
    expect(originalHandle.contextMenuState()).toEqual({
      canUndo: false,
      canRedo: false,
      hasSelection: false,
      hasText: false,
    });
    expect(originalHandle.captureSelection()?.text).toBe("");
    mocked.instance.focus.mockClear();
    mocked.instance.trigger.mockClear();
    act(() => { originalHandle.deleteSelection(); });
    expect(mocked.instance.focus).not.toHaveBeenCalled();
    expect(mocked.instance.trigger).not.toHaveBeenCalled();

    unmount();
    expect(originalHandle.captureSelection()).toBeUndefined();
    act(() => { originalHandle.pasteText("ignored after disposal"); });
    expect(mocked.instance.trigger).not.toHaveBeenCalled();
    expect(originalHandle.contextMenuState()).toEqual({
      canUndo: false,
      canRedo: false,
      hasSelection: false,
      hasText: false,
    });
  });

  it("suppresses delayed clipboard edits after the model, version, or selections change", async () => {
    const handle = createRef<CodeEditorHandle>();
    const rendered = render(
      <CodeEditor value="text" modelKey="document" onChange={vi.fn()} editorHandleRef={handle} />,
    );
    await waitFor(() => expect(mocked.models).toHaveLength(1));
    const editor = handle.current!;
    const initial = editor.captureSelection()!;

    mocked.setSelections([{
      value: "moved selection",
      selectionStartLineNumber: 2,
      selectionStartColumn: 1,
      positionLineNumber: 2,
      positionColumn: 16,
    }]);
    act(() => {
      editor.pasteText("stale cursor paste", initial.state);
      editor.deleteSelection(initial.state);
    });
    expect(mocked.instance.focus).not.toHaveBeenCalled();
    expect(mocked.instance.trigger).not.toHaveBeenCalled();

    const beforeContentChange = editor.captureSelection()!;
    act(() => { mocked.type("changed text"); });
    act(() => {
      editor.pasteText("stale version paste", beforeContentChange.state);
      editor.deleteSelection(beforeContentChange.state);
    });
    expect(mocked.instance.focus).not.toHaveBeenCalled();
    expect(mocked.instance.trigger).not.toHaveBeenCalled();

    const beforeModelChange = editor.captureSelection()!;
    rendered.rerender(
      <CodeEditor value="other" modelKey="other-document" onChange={vi.fn()} editorHandleRef={handle} />,
    );
    expect(editor.captureSelection()?.state.modelUri).not.toBe(beforeModelChange.state.modelUri);
    act(() => {
      editor.pasteText("stale model paste", beforeModelChange.state);
      editor.deleteSelection(beforeModelChange.state);
    });
    expect(mocked.instance.focus).not.toHaveBeenCalled();
    expect(mocked.instance.trigger).not.toHaveBeenCalled();

    const current = editor.captureSelection()!;
    mocked.instance.focus.mockImplementationOnce(() => {
      mocked.setSelections([{
        value: "focus changed selection",
        selectionStartLineNumber: 4,
        selectionStartColumn: 1,
        positionLineNumber: 4,
        positionColumn: 24,
      }]);
    });
    act(() => { editor.pasteText("focus race paste", current.state); });
    expect(mocked.instance.focus).toHaveBeenCalledOnce();
    expect(mocked.instance.trigger).not.toHaveBeenCalled();
  });

  it("updates wrap, minimap and font controls without replacing the model and reports cursor changes", async () => {
    const ready = vi.fn();
    const firstCursor = vi.fn();
    const nextCursor = vi.fn();
    const { rerender } = render(<CodeEditor value="text" modelKey="document" onChange={vi.fn()} wordWrap minimap
      fontSize={16} fontFamily='"Fira Code", monospace' tabSize={4} insertSpaces={false}
      lineNumbers="relative" renderWhitespace="all" stickyScroll bracketPairColorization={false}
      fontLigatures onReady={ready} onCursorChange={firstCursor} />);
    await waitFor(() => expect(ready).toHaveBeenCalledOnce());
    expect(mocked.instance.getModel()).toBe(mocked.models[0]);
    expect(firstCursor).toHaveBeenCalledWith({ lineNumber: 1, column: 1 });
    expect(mocked.create).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({
      wordWrap: "on", minimap: { enabled: true }, fontSize: 16, lineHeight: 26,
      fontFamily: '"Fira Code", monospace', lineNumbers: "relative", renderWhitespace: "all",
      stickyScroll: { enabled: true }, bracketPairColorization: { enabled: false }, fontLigatures: true,
    }));
    expect(mocked.models[0]?.updateOptions).toHaveBeenLastCalledWith({ tabSize: 4, insertSpaces: false });
    rerender(<CodeEditor value="text" modelKey="document" onChange={vi.fn()} wordWrap={false} minimap={false} fontSize={18} onReady={ready} onCursorChange={nextCursor} />);
    act(() => { mocked.moveCursor(8, 12); });
    expect(nextCursor).toHaveBeenCalledExactlyOnceWith({ lineNumber: 8, column: 12 });
    expect(firstCursor).toHaveBeenCalledOnce();
    expect(mocked.instance.updateOptions).toHaveBeenLastCalledWith(expect.objectContaining({
      wordWrap: "off", minimap: { enabled: false }, fontSize: 18, lineHeight: 29,
    }));
    expect(mocked.models).toHaveLength(1);
    expect(ready).toHaveBeenCalledOnce();
  });

  it("uses bounded viewport dimensions and ignores fractional resize noise", async () => {
    const frames = animationFrames();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 640.8, height: 480.7 } as DOMRect);
    render(<CodeEditor value="one" modelKey="a" onChange={vi.fn()} />);
    await waitFor(() => expect(mocked.models).toHaveLength(1));
    expect(mocked.create).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({
      dimension: { width: 640, height: 480 },
    }));
    act(() => {
      resize(643.85, 219.99);
      resize(643.2, 219.1);
    });
    expect(frames.pending.size).toBe(1);
    frames.flush();
    expect(mocked.instance.layout).toHaveBeenCalledExactlyOnceWith({ width: 643, height: 219 });

    act(() => { resize(643.9, 219.9); });
    frames.flush();
    expect(mocked.instance.layout).toHaveBeenCalledOnce();

    act(() => { resize(644.05, 220.6); });
    frames.flush();
    expect(mocked.instance.layout).toHaveBeenLastCalledWith({ width: 644, height: 220 });
    expect(mocked.instance.layout).toHaveBeenCalledTimes(2);
  });

  it("relayouts a revealed view and cancels queued layout when disposed", async () => {
    const frames = animationFrames();
    const { unmount } = render(<CodeEditor value="one" modelKey="a" onChange={vi.fn()} />);
    await waitFor(() => expect(mocked.models).toHaveLength(1));
    act(() => { resize(640, 480); });
    frames.flush();
    act(() => { resize(0, 0); });
    frames.flush();
    expect(mocked.instance.layout).toHaveBeenCalledOnce();
    act(() => { resize(640, 480); });
    frames.flush();
    expect(mocked.instance.layout).toHaveBeenCalledTimes(2);
    act(() => { resize(700, 500); });
    expect(frames.pending.size).toBe(1);
    unmount();
    expect(frames.pending.size).toBe(0);
    frames.flush();
    expect(mocked.instance.layout).toHaveBeenCalledTimes(2);
  });
});
