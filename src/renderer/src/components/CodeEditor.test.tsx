import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => {
  type Model = {
    value: string;
    language: string;
    uri: string;
    dispose: ReturnType<typeof vi.fn>;
    updateOptions: ReturnType<typeof vi.fn>;
    pushStackElement: ReturnType<typeof vi.fn>;
    pushEditOperations: ReturnType<typeof vi.fn>;
    getValue: () => string;
    getFullModelRange: () => object;
  };
  const models: Model[] = [];
  let selected: Model | null = null;
  let change: (() => void) | undefined;
  const actions = new Map<string, { run: () => void }>();
  const actionDispose = vi.fn();
  const listenerDispose = vi.fn();
  const diagnosticsDispose = vi.fn();
  const instance = {
    dispose: vi.fn(),
    layout: vi.fn(),
    updateOptions: vi.fn(),
    saveViewState: vi.fn(() => ({ cursor: 12 })),
    restoreViewState: vi.fn(),
    setModel: vi.fn((model: Model) => { selected = model; }),
    getModel: () => selected,
    getValue: () => selected?.value ?? "",
    onDidChangeModelContent: vi.fn((callback: () => void) => {
      change = callback;
      return { dispose: listenerDispose };
    }),
    addAction: vi.fn((action: { id: string; run: () => void }) => {
      actions.set(action.id, action);
      return { dispose: actionDispose };
    }),
  };
  const create = vi.fn(() => instance);
  const setTheme = vi.fn();
  const attachScriptDiagnostics = vi.fn(() => ({ dispose: diagnosticsDispose }));
  const createModel = vi.fn((value: string, language: string, uri: string) => {
    const model: Model = {
      value, language, uri,
      dispose: vi.fn(), updateOptions: vi.fn(), pushStackElement: vi.fn(),
      getValue: () => model.value,
      getFullModelRange: () => ({ full: true }),
      pushEditOperations: vi.fn((_before: unknown, edits: Array<{ text: string }>) => {
        model.value = edits[0]?.text ?? "";
        change?.();
      }),
    };
    models.push(model);
    return model;
  });
  return {
    models, actions, create, createModel, setTheme, attachScriptDiagnostics,
    instance, actionDispose, listenerDispose, diagnosticsDispose,
    type: (value: string) => { if (selected) selected.value = value; change?.(); },
    reset: () => { selected = null; change = undefined; models.length = 0; actions.clear(); },
  };
});

vi.mock("../editor/monaco-runtime", () => ({
  monaco: {
    editor: { create: mocked.create, createModel: mocked.createModel, setTheme: mocked.setTheme },
    Uri: { parse: (uri: string) => uri },
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49, Enter: 3 },
  },
  attachScriptDiagnostics: mocked.attachScriptDiagnostics,
}));

import { CodeEditor } from "./CodeEditor";

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
    const save = vi.fn();
    const run = vi.fn();
    const { rerender, unmount } = render(<CodeEditor value="one" modelKey="a" profile="script" onChange={vi.fn()} />);
    await waitFor(() => expect(mocked.models).toHaveLength(1));
    rerender(<CodeEditor value="one" modelKey="a" profile="script" onChange={vi.fn()} onSave={save} onRun={run} readOnly theme="light" ariaLabel="Example source" />);
    mocked.actions.get("application.editor.save")?.run();
    mocked.actions.get("application.editor.run")?.run();
    expect(save).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(mocked.setTheme).toHaveBeenLastCalledWith("vs");
    expect(mocked.instance.updateOptions).toHaveBeenLastCalledWith({ readOnly: true, ariaLabel: "Example source" });
    expect(observe).toHaveBeenCalledOnce();
    act(() => { resize(640, 480); });
    unmount();
    expect(mocked.instance.dispose).toHaveBeenCalledOnce();
    expect(mocked.models[0]?.dispose).toHaveBeenCalledOnce();
    expect(mocked.diagnosticsDispose).toHaveBeenCalledOnce();
    expect(mocked.listenerDispose).toHaveBeenCalledOnce();
    expect(mocked.actionDispose).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledOnce();
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
