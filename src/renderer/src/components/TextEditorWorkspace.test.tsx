import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../../shared/application-settings-contracts";
import type { TextEditorDocument } from "../../../shared/text-editor-contracts";

const editorHandle = vi.hoisted(() => ({
  focus: vi.fn(), undo: vi.fn(), redo: vi.fn(), find: vi.fn(), replace: vi.fn(), commandPalette: vi.fn(),
}));

vi.mock("./CodeEditor", async () => {
  const React = await import("react");
  return { CodeEditor: (props: {
    value: string; readOnly: boolean; onChange: (value: string) => void; onReady: () => void;
    wordWrap: boolean; minimap: boolean; language: string; fontSize: number;
    useDefaultSaveKeybinding: boolean;
    keybindings: Record<string, string>;
    editorHandleRef?: Parameters<typeof React.useImperativeHandle>[0];
  }) => {
    React.useImperativeHandle(props.editorHandleRef, () => editorHandle, []);
    React.useEffect(() => { props.onReady(); }, []);
    return <textarea aria-label="Document text" value={props.value} readOnly={props.readOnly}
      data-wrap={String(props.wordWrap)} data-minimap={String(props.minimap)} data-language={props.language}
      data-font-size={props.fontSize} data-default-save-keybinding={String(props.useDefaultSaveKeybinding)}
      data-keybindings={JSON.stringify(props.keybindings)}
      onChange={(event) => props.onChange(event.target.value)} />;
  } };
});

import { TextEditorWorkspace } from "./TextEditorWorkspace";

const document: TextEditorDocument = { id: "document-one", title: "notes.txt", text: "original", language: "plaintext", readOnly: false };
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Linux x86_64" });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "platform");
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

  it("preserves content when editor controls change and enforces read-only mode", () => {
    const onSave = vi.fn();
    render(<TextEditorWorkspace document={{ ...document, readOnly: true }} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Word Wrap" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Document language" }), { target: { value: "xml" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Editor font size" }), { target: { value: "18" } });
    const editor = screen.getByLabelText("Document text");
    expect(editor).toHaveAttribute("data-wrap", "true");
    expect(editor).toHaveAttribute("data-language", "xml");
    expect(editor).toHaveAttribute("data-font-size", "18");
    expect(editor).toHaveValue("original");
    expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save As…" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("offers Bash, enables the minimap, and routes editor buttons through the Monaco handle", () => {
    render(<TextEditorWorkspace document={document} onSave={vi.fn()} onOpen={vi.fn()} />);
    const editor = screen.getByLabelText("Document text");
    expect(screen.getByRole("option", { name: "Bash" })).toBeInTheDocument();
    expect(editor).toHaveAttribute("data-minimap", "true");
    expect(editor).toHaveAttribute("data-default-save-keybinding", "false");
    expect(JSON.parse(editor.getAttribute("data-keybindings") ?? "{}")).toMatchObject({
      save: "mod+s", undo: "mod+z", redo: "mod+y", find: "mod+f",
      replace: "mod+alt+f", commandPalette: "f1",
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Document language" }), { target: { value: "shell" } });
    expect(editor).toHaveAttribute("data-language", "shell");

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
      },
    };
    render(<TextEditorWorkspace document={document} onSave={onSave} onOpen={onOpen} shortcuts={shortcuts} />);

    expect(JSON.parse(screen.getByLabelText("Document text").getAttribute("data-keybindings") ?? "{}")).toEqual({
      save: "mod+alt+s", undo: "mod+alt+u", redo: "mod+alt+r", find: "mod+alt+f",
      replace: "mod+alt+p", commandPalette: "mod+alt+k",
    });

    for (const [name, key] of [
      ["Open…", "O"], ["Save As…", "A"], ["Save", "S"], ["Undo", "U"], ["Redo", "R"],
      ["Find", "F"], ["Replace", "P"], ["Word Wrap", "W"], ["Commands", "K"],
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
    expect(editorHandle.undo).toHaveBeenCalledOnce();
    expect(editorHandle.redo).toHaveBeenCalledOnce();
    expect(editorHandle.find).toHaveBeenCalledOnce();
    expect(editorHandle.replace).toHaveBeenCalledOnce();
    expect(editorHandle.commandPalette).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Document text")).toHaveAttribute("data-wrap", "true");
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
