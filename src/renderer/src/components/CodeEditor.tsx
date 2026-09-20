import type { editor, IDisposable } from "monaco-editor/editor/editor.api";
import { useEffect, useRef, useState } from "react";

import { SCRIPT_LANGUAGE_ID } from "../editor/script-language-config";

type MonacoRuntime = typeof import("../editor/monaco-runtime");
export type CodeEditorProfile = "default" | "script";

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
    ariaLabel = "Code editor", theme = "dark", className = "",
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
        minimap: { enabled: false },
        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        lineHeight: 21,
        tabSize: 2,
        insertSpaces: true,
        scrollBeyondLastLine: false,
        padding: { top: 12, bottom: 12 },
        renderLineHighlight: "line",
        roundedSelection: false,
        stickyScroll: { enabled: false },
        wordWrap: "off",
        hover: { enabled: "off" },
        unicodeHighlight: { ambiguousCharacters: true, invisibleCharacters: true },
        suggest: { showWords: false },
      });
      editorRef.current = instance;
      disposables.push(instance.onDidChangeModelContent(() => {
        if (!synchronizing.current) currentProps.current.onChange(instance.getValue());
      }));
      disposables.push(instance.addAction({
        id: "application.editor.save",
        label: "Save",
        keybindings: [runtime.monaco.KeyMod.CtrlCmd | runtime.monaco.KeyCode.KeyS],
        run: () => { currentProps.current.onSave?.(); },
      }));
      disposables.push(instance.addAction({
        id: "application.editor.run",
        label: "Run",
        keybindings: [runtime.monaco.KeyMod.CtrlCmd | runtime.monaco.KeyCode.Enter],
        run: () => { currentProps.current.onRun?.(); },
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
    const runtime = runtimeRef.current;
    const instance = editorRef.current;
    if (!ready || !runtime || !instance) return;
    const resolvedLanguage = profile === "script" ? SCRIPT_LANGUAGE_ID : language;
    const identity = JSON.stringify([modelKey, resolvedLanguage]);
    if (selectedModel.current !== identity) {
      const previous = selectedModel.current === null ? undefined : models.current.get(selectedModel.current);
      if (previous) previous.viewState = instance.saveViewState();
      let entry = models.current.get(identity);
      if (!entry) {
        const extension = language === "typescript" && profile !== "script" ? "ts" : "js";
        const uri = runtime.monaco.Uri.parse(
          `inmemory://editor-${ownerId.current}/${encodeURIComponent(identity)}.${extension}`,
        );
        const model = runtime.monaco.editor.createModel(value, resolvedLanguage, uri);
        model.updateOptions({ tabSize: 2, insertSpaces: true });
        entry = { model, viewState: null };
        if (profile === "script") entry.diagnostics = runtime.attachScriptDiagnostics(runtime.monaco, model);
        models.current.set(identity, entry);
      }
      synchronizing.current = true;
      try {
        instance.setModel(entry.model);
        if (entry.viewState) instance.restoreViewState(entry.viewState);
        selectedModel.current = identity;
      } finally {
        synchronizing.current = false;
      }
    }
    const model = instance.getModel();
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
    editorRef.current?.updateOptions({ readOnly, ariaLabel });
    runtimeRef.current?.monaco.editor.setTheme(theme === "light" ? "vs" : "vs-dark");
  }, [ready, readOnly, ariaLabel, theme]);

  return (
    <div className={`relative h-full min-h-0 min-w-0 w-full overflow-hidden ${className}`} data-code-editor={profile}>
      <div className="absolute inset-0 min-h-0 min-w-0 overflow-hidden" ref={container} />
      {!ready && !error && <div className="absolute inset-0 flex items-center justify-center text-sm text-muted" role="status">Loading editor…</div>}
      {error && <div className="absolute inset-0 flex items-center justify-center p-4 text-sm text-danger" role="alert">{error}</div>}
    </div>
  );
}

function editorDimensions(size: Pick<DOMRectReadOnly, "width" | "height">): editor.IDimension {
  return { width: Math.max(0, Math.floor(size.width)), height: Math.max(0, Math.floor(size.height)) };
}
