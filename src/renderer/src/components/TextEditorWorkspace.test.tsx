import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../../shared/application-settings-contracts";
import type { ApplicationContextMenuItem } from "../../../shared/application-context-menu-contracts";
import type { TextEditorDocument } from "../../../shared/text-editor-contracts";
import { renderWithApplicationContextMenu as render } from "../application-context-menu-test-utils";

const editorHandle = vi.hoisted(() => ({
  focus: vi.fn(),
  contextMenuState: vi.fn(() => ({ canUndo: true, canRedo: true, hasSelection: true, hasText: true })),
  captureSelection: vi.fn(() => ({
    text: "selected editor text",
    state: {
      modelUri: "inmemory://document",
      modelVersionId: 1,
      selections: [{
        selectionStartLineNumber: 1, selectionStartColumn: 1,
        positionLineNumber: 1, positionColumn: 21,
      }],
    },
  })),
  undo: vi.fn(), redo: vi.fn(), pasteText: vi.fn(), deleteSelection: vi.fn(),
  selectAll: vi.fn(), find: vi.fn(), replace: vi.fn(), commandPalette: vi.fn(),
}));

vi.mock("./CodeEditor", async () => {
  const React = await import("react");
  return { CodeEditor: (props: {
    value: string; readOnly: boolean; onChange: (value: string) => void; onReady: () => void;
    wordWrap: boolean; minimap: boolean; language: string; fontSize: number;
    fontFamily: string; tabSize: number; insertSpaces: boolean; lineNumbers: string;
    renderWhitespace: string; stickyScroll: boolean; bracketPairColorization: boolean; fontLigatures: boolean;
    useDefaultSaveKeybinding: boolean;
    keybindings: Record<string, string>;
    editorHandleRef?: Parameters<typeof React.useImperativeHandle>[0];
  }) => {
    React.useImperativeHandle(props.editorHandleRef, () => editorHandle, []);
    React.useEffect(() => { props.onReady(); }, []);
    return <div className="monaco-editor"><textarea className="inputarea" aria-label="Document text"
      value={props.value} readOnly={props.readOnly}
      data-wrap={String(props.wordWrap)} data-minimap={String(props.minimap)} data-language={props.language}
      data-font-size={props.fontSize} data-default-save-keybinding={String(props.useDefaultSaveKeybinding)}
      data-font-family={props.fontFamily} data-tab-size={props.tabSize} data-insert-spaces={String(props.insertSpaces)}
      data-line-numbers={props.lineNumbers} data-whitespace={props.renderWhitespace}
      data-sticky-scroll={String(props.stickyScroll)} data-bracket-colors={String(props.bracketPairColorization)}
      data-font-ligatures={String(props.fontLigatures)}
      data-keybindings={JSON.stringify(props.keybindings)}
      onChange={(event) => props.onChange(event.target.value)} /></div>;
  } };
});

import { TextEditorWorkspace } from "./TextEditorWorkspace";

const document: TextEditorDocument = { id: "document-one", title: "notes.txt", text: "original", language: "plaintext", readOnly: false };
beforeEach(() => {
  vi.clearAllMocks();
  editorHandle.contextMenuState.mockReturnValue({
    canUndo: true, canRedo: true, hasSelection: true, hasText: true,
  });
  editorHandle.captureSelection.mockReturnValue({
    text: "selected editor text",
    state: {
      modelUri: "inmemory://document",
      modelVersionId: 1,
      selections: [{
        selectionStartLineNumber: 1, selectionStartColumn: 1,
        positionLineNumber: 1, positionColumn: 21,
      }],
    },
  });
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Linux x86_64" });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: vi.fn(async () => "replacement text"), writeText: vi.fn(async () => undefined) },
  });
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    value: { isActive: true },
  });
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "platform");
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(navigator, "userActivation");
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

describe("TextEditorWorkspace", () => {
  it("keeps remote documents in the editor when overwrite is canceled and hides local file actions", async () => {
    const onSave = vi.fn().mockResolvedValue(null);
    render(<TextEditorWorkspace document={{ ...document, remote: true }} onSave={onSave} />);
    expect(screen.queryByRole("button", { name: "Save As…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open…" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Document text"), { target: { value: "remote draft" } });
    fireEvent.keyDown(window, { key: "S", code: "KeyS", ctrlKey: true, shiftKey: true });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("remote draft", false));
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
  });

  it("retains the submitted snapshot as baseline when typing continues during save", async () => {
    let finish!: (result: { title: string }) => void;
    const onSave = vi.fn(() => new Promise<{ title: string }>((resolve) => { finish = resolve; }));
    const onDirtyChange = vi.fn();
    render(<TextEditorWorkspace document={document} onSave={onSave} onDirtyChange={onDirtyChange} />);
    fireEvent.change(screen.getByLabelText("Document text"), { target: { value: "first edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("first edit", false));
    fireEvent.change(screen.getByLabelText("Document text"), { target: { value: "second edit" } });
    await act(async () => { finish({ title: "saved.txt" }); });
    expect(screen.getByRole("heading", { name: "saved.txt" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(screen.getByLabelText("Document text"), { target: { value: "first edit" } });
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps the draft after cancelled and failed saves and vetoes unloading", async () => {
    const onSave = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("Disk is full"));
    render(<TextEditorWorkspace document={document} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Document text"), { target: { value: "keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk is full");
    expect(screen.getByLabelText("Document text")).toHaveValue("keep this draft");
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("disables replacement actions during open and restores editing on cancellation", async () => {
    let finish!: () => void;
    const onOpen = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<TextEditorWorkspace document={document} onSave={vi.fn()} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "Open…" }));
    expect(screen.getByLabelText("Document text")).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Save As…" })).toBeDisabled();
    await act(async () => finish());
    expect(screen.getByLabelText("Document text")).not.toHaveAttribute("readonly");
    expect(screen.getByLabelText("Document text")).toHaveValue("original");
  });

  it("preserves content when editor controls change and enforces read-only mode", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<TextEditorWorkspace document={{ ...document, readOnly: true }} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Word Wrap" }));
    await selectEditorLanguage(user, "xml", "XML");
    const editor = screen.getByLabelText("Document text");
    expect(editor).toHaveAttribute("data-wrap", "true");
    expect(editor).toHaveAttribute("data-language", "xml");
    expect(editor).toHaveAttribute("data-font-size", "13");
    expect(editor).toHaveValue("original");
    expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save As…" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("offers icon-bearing shell languages, enables the minimap, and routes editor buttons through Monaco", async () => {
    const user = userEvent.setup();
    render(<TextEditorWorkspace document={document} onSave={vi.fn()} onOpen={vi.fn()} />);
    const editor = screen.getByLabelText("Document text");
    expect(screen.getByRole("button", { name: "Editor settings" })).toBeInTheDocument();
    expect(editor).toHaveAttribute("data-minimap", "true");
    expect(editor).toHaveAttribute("data-font-ligatures", "true");
    expect(editor).toHaveAttribute("data-default-save-keybinding", "false");
    expect(JSON.parse(editor.getAttribute("data-keybindings") ?? "{}")).toMatchObject({
      save: "mod+s", undo: "mod+z", redo: "mod+y", find: "mod+f",
      replace: "mod+alt+f", commandPalette: "f1",
    });
    const search = await openLanguageSelector(user);
    expect(screen.getByRole("option", { name: "Bash" })
      .querySelector('svg[data-icon="terminal"]')).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "PowerShell" })
      .querySelector('svg[data-icon="terminal"]')).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Bash" }));
    expect(editor).toHaveAttribute("data-language", "shell");
    await user.click(languageTrigger());
    const nextSearch = await screen.findByRole("searchbox", { name: "Search syntax languages" });
    expect(search).not.toBeInTheDocument();
    await user.type(nextSearch, "pwrsh");
    await user.click(await screen.findByRole("option", { name: "PowerShell" }));
    expect(editor).toHaveAttribute("data-language", "powershell");

    editorHandle.undo.mockClear();
    editorHandle.redo.mockClear();
    editorHandle.find.mockClear();
    editorHandle.replace.mockClear();
    editorHandle.commandPalette.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    fireEvent.click(screen.getByRole("button", { name: "Commands" }));
    expect(editorHandle.undo).toHaveBeenCalledOnce();
    expect(editorHandle.redo).toHaveBeenCalledOnce();
    expect(editorHandle.find).toHaveBeenCalledOnce();
    expect(editorHandle.replace).toHaveBeenCalledOnce();
    expect(editorHandle.commandPalette).toHaveBeenCalledOnce();
  });

  it("shows and executes configured shortcuts for every editor button", async () => {
    const onOpen = vi.fn().mockResolvedValue(undefined);
    const onSave = vi.fn().mockResolvedValue(null);
    const onOpenSettings = vi.fn();
    const shortcuts = {
      ...DEFAULT_APPLICATION_SETTINGS_STATE,
      keyboardShortcuts: {
        textEditorOpen: "mod+alt+o",
        textEditorSaveAs: "mod+alt+a",
        textEditorSave: "mod+alt+s",
        textEditorUndo: "mod+alt+u",
        textEditorRedo: "mod+alt+r",
        textEditorFind: "mod+alt+f",
        textEditorReplace: "mod+alt+p",
        textEditorWordWrap: "mod+alt+w",
        textEditorCommandPalette: "mod+alt+k",
        textEditorSettings: "mod+alt+g",
      },
    };
    render(<TextEditorWorkspace document={document} onSave={onSave} onOpen={onOpen}
      onOpenSettings={onOpenSettings} shortcuts={shortcuts} />);

    expect(JSON.parse(screen.getByLabelText("Document text").getAttribute("data-keybindings") ?? "{}")).toEqual({
      save: "mod+alt+s", undo: "mod+alt+u", redo: "mod+alt+r", find: "mod+alt+f",
      replace: "mod+alt+p", commandPalette: "mod+alt+k",
    });

    for (const [name, key] of [
      ["Open…", "O"], ["Save As…", "A"], ["Save", "S"], ["Undo", "U"], ["Redo", "R"],
      ["Find", "F"], ["Replace", "P"], ["Word Wrap", "W"], ["Commands", "K"], ["Editor settings", "G"],
    ] as const) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-keyshortcuts", `Control+Alt+${key}`);
    }

    pressConfiguredShortcut("o");
    await waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "Open…" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Document text"), { target: { value: "draft" } });
    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
    expect(onSave).not.toHaveBeenCalled();

    pressConfiguredShortcut("a");
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("draft", true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    pressConfiguredShortcut("s");
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("draft", false));

    editorHandle.undo.mockClear();
    editorHandle.redo.mockClear();
    editorHandle.find.mockClear();
    editorHandle.replace.mockClear();
    editorHandle.commandPalette.mockClear();
    pressConfiguredShortcut("u");
    pressConfiguredShortcut("r");
    pressConfiguredShortcut("f");
    pressConfiguredShortcut("p");
    pressConfiguredShortcut("w");
    pressConfiguredShortcut("k");
    pressConfiguredShortcut("g");
    expect(editorHandle.undo).toHaveBeenCalledOnce();
    expect(editorHandle.redo).toHaveBeenCalledOnce();
    expect(editorHandle.find).toHaveBeenCalledOnce();
    expect(editorHandle.replace).toHaveBeenCalledOnce();
    expect(editorHandle.commandPalette).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Document text")).toHaveAttribute("data-wrap", "true");
  });

  it("uses the Command symbol in macOS editor tooltips and context-menu shortcuts", async () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    const rendered = render(<TextEditorWorkspace document={document} onSave={vi.fn()} />);

    const editor = screen.getByLabelText("Document text");
    fireEvent.pointerDown(editor, { button: 2 });
    fireEvent.contextMenu(editor, { clientX: 40, clientY: 24 });
    rendered.contextMenu.emit();
    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    const undo = within(menu).getByRole("menuitem", { name: "Undo" });
    expect(undo).toHaveTextContent("⌘ + Z");
    expect(undo).not.toHaveTextContent("Command");
  });

  it("uses the application context menu for Monaco while preserving native overlay input actions", async () => {
    const user = userEvent.setup();
    const clipboard = {
      readText: vi.fn(async () => "replacement text"),
      writeText: vi.fn(async () => undefined),
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    let rendered = render(<TextEditorWorkspace document={document} onSave={vi.fn()} />);
    const editor = screen.getByLabelText("Document text");
    const openMenu = async (target: Element, items?: readonly ApplicationContextMenuItem[]) => {
      fireEvent.pointerDown(target, { button: 2 });
      fireEvent.contextMenu(target, { clientX: 40, clientY: 24 });
      rendered.contextMenu.emit(items);
      return screen.findByRole("menu", { name: "Application context menu" });
    };

    let menu = await openMenu(editor);
    for (const label of ["Undo", "Redo", "Cut", "Copy", "Paste", "Delete", "Select All", "Inspect Element"]) {
      expect(within(menu).getByRole("menuitem", { name: label })).toBeInTheDocument();
    }
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(8);
    await user.click(within(menu).getByRole("menuitem", { name: "Cut" }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith("selected editor text"));
    expect(editorHandle.deleteSelection).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ modelUri: "inmemory://document", modelVersionId: 1 }),
    );
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Application context menu" })).not.toBeInTheDocument());
    expect(rendered.contextMenu.api.executeAction).not.toHaveBeenCalled();

    rendered.unmount();
    rendered = render(<TextEditorWorkspace document={{ ...document, readOnly: true }} onSave={vi.fn()} />);
    const readOnlyEditor = screen.getByLabelText("Document text");
    await waitFor(() => expect(readOnlyEditor).toHaveAttribute("readonly"));
    menu = await openMenu(readOnlyEditor);
    for (const label of ["Undo", "Redo", "Cut", "Paste", "Delete"]) {
      expect(within(menu).getByRole("menuitem", { name: label }), label).toHaveAttribute("aria-disabled", "true");
    }
    expect(within(menu).getByRole("menuitem", { name: "Copy" })).not.toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitem", { name: "Select All" })).not.toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Application context menu" })).not.toBeInTheDocument());

    const overlay = globalThis.document.createElement("input");
    overlay.setAttribute("aria-label", "Find overlay input");
    screen.getByLabelText("Document text").parentElement?.append(overlay);
    menu = await openMenu(overlay, nativeOverlayItems());
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(4);
    expect(within(menu).queryByRole("menuitem", { name: "Undo" })).not.toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: "Copy" }));
    await waitFor(() => expect(rendered.contextMenu.api.executeAction).toHaveBeenCalledOnce());
    expect(editorHandle.captureSelection).toHaveBeenCalledOnce();
  });

  it("binds delayed cut and paste work to the selection captured before clipboard I/O", async () => {
    const user = userEvent.setup();
    const write = deferred<void>();
    const read = deferred<string>();
    const clipboard = {
      readText: vi.fn(() => read.promise),
      writeText: vi.fn(() => write.promise),
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    const rendered = render(<TextEditorWorkspace document={document} onSave={vi.fn()} />);
    const editor = screen.getByLabelText("Document text");
    const original = editorHandle.captureSelection();
    const changed = {
      text: "later selection",
      state: {
        modelUri: "inmemory://document",
        modelVersionId: 2,
        selections: [{
          selectionStartLineNumber: 2, selectionStartColumn: 1,
          positionLineNumber: 2, positionColumn: 16,
        }],
      },
    };
    const openMenu = async () => {
      fireEvent.pointerDown(editor, { button: 2 });
      fireEvent.contextMenu(editor, { clientX: 40, clientY: 24 });
      rendered.contextMenu.emit();
      return screen.findByRole("menu", { name: "Application context menu" });
    };

    let menu = await openMenu();
    await user.click(within(menu).getByRole("menuitem", { name: "Cut" }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith("selected editor text"));
    editorHandle.captureSelection.mockReturnValue(changed);
    await act(async () => write.resolve());
    expect(editorHandle.deleteSelection).toHaveBeenCalledExactlyOnceWith(original?.state);

    editorHandle.captureSelection.mockReturnValue(original);
    menu = await openMenu();
    await user.click(within(menu).getByRole("menuitem", { name: "Paste" }));
    await waitFor(() => expect(clipboard.readText).toHaveBeenCalledOnce());
    editorHandle.captureSelection.mockReturnValue(changed);
    await act(async () => read.resolve("delayed clipboard text"));
    expect(editorHandle.pasteText).toHaveBeenCalledExactlyOnceWith(
      "delayed clipboard text",
      original?.state,
    );
  });

  it("leaves standard undo and redo inside Monaco overlay inputs", () => {
    render(<TextEditorWorkspace document={document} onSave={vi.fn()} />);
    const palette = documentNode("quick-input-widget");
    const find = documentNode("find-widget");
    editorHandle.undo.mockClear();
    editorHandle.redo.mockClear();
    fireEvent.keyDown(palette, { key: "z", code: "KeyZ", ctrlKey: true });
    fireEvent.keyDown(find, { key: "y", code: "KeyY", ctrlKey: true });
    expect(editorHandle.undo).not.toHaveBeenCalled();
    expect(editorHandle.redo).not.toHaveBeenCalled();
    palette.parentElement?.remove();
    find.parentElement?.remove();
  });
});

function pressConfiguredShortcut(key: string): void {
  fireEvent.keyDown(window, { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, altKey: true });
}

function documentNode(containerClass: string): HTMLInputElement {
  const container = globalThis.document.createElement("div");
  container.className = containerClass;
  const input = globalThis.document.createElement("input");
  container.append(input);
  globalThis.document.body.append(container);
  return input;
}

function nativeOverlayItems(): readonly ApplicationContextMenuItem[] {
  return [
    {
      type: "action", actionId: "10000000-0000-4000-8000-000000000001",
      kind: "copy", label: "Copy", enabled: true, shortcut: "mod+c",
    },
    {
      type: "action", actionId: "10000000-0000-4000-8000-000000000002",
      kind: "paste", label: "Paste", enabled: true, shortcut: "mod+v",
    },
    {
      type: "action", actionId: "10000000-0000-4000-8000-000000000003",
      kind: "select-all", label: "Select All", enabled: true, shortcut: "mod+a",
    },
    {
      type: "action", actionId: "10000000-0000-4000-8000-000000000004",
      kind: "inspect", label: "Inspect Element", enabled: true,
    },
  ];
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function languageTrigger(): HTMLElement {
  const trigger = globalThis.document.querySelector<HTMLElement>(
    '[data-slot="autocomplete-trigger"]',
  );
  if (!trigger) throw new Error("Language autocomplete trigger was not rendered");
  return trigger;
}

async function openLanguageSelector(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  await user.click(languageTrigger());
  return screen.findByRole("searchbox", { name: "Search syntax languages" });
}

async function selectEditorLanguage(
  user: ReturnType<typeof userEvent.setup>,
  query: string,
  label: string,
): Promise<void> {
  const search = await openLanguageSelector(user);
  await user.type(search, query);
  await user.click(await screen.findByRole("option", { name: label }));
}
