import type { editor } from "monaco-editor/editor/editor.api";
import { useEffect, useRef, useState } from "react";

import type { WebsitePreviewLanguage } from "../editor/website-preview-languages";
import { useApplicationSettings } from "./ApplicationSettingsProvider";

export interface WebsiteSourceEditorProps {
  text: string;
  language: WebsitePreviewLanguage;
  ariaLabel: string;
}

let sourceSequence = 0;

/** A disposable syntax viewer. No application actions or editable model handles are exposed. */
export function WebsiteSourceEditor({ text, language, ariaLabel }: WebsiteSourceEditorProps): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const theme = useApplicationSettings()?.resolvedTheme ?? "dark";

  useEffect(() => {
    let disposed = false;
    let instance: editor.IStandaloneCodeEditor | undefined;
    let model: editor.ITextModel | undefined;
    setReady(false);
    setError(false);
    void import("../editor/website-preview-runtime").then(({ monaco }) => {
      if (disposed || !container.current) return;
      // Server paths and MIME strings never form a model URI or choose a module.
      const uri = monaco.Uri.parse(`inmemory://website-preview/source-${++sourceSequence}`);
      model = monaco.editor.createModel(text, `website-preview-${language}`, uri);
      instance = monaco.editor.create(container.current, {
        model,
        ariaLabel,
        readOnly: true,
        domReadOnly: true,
        editContext: false,
        automaticLayout: true,
        autoDetectHighContrast: false,
        theme: theme === "light" ? "vs" : "vs-dark",
        links: false,
        contextmenu: false,
        hover: { enabled: "off" },
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        wordBasedSuggestions: "off",
        parameterHints: { enabled: false },
        inlineSuggest: { enabled: false },
        codeLens: false,
        colorDecorators: false,
        "semanticHighlighting.enabled": false,
        renderValidationDecorations: "off",
        dropIntoEditor: { enabled: false },
        pasteAs: { enabled: false },
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        stickyScroll: { enabled: false },
        wordWrap: "off",
        fontSize: 12,
        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        lineNumbers: "on",
        renderControlCharacters: true,
        unicodeHighlight: { ambiguousCharacters: true, invisibleCharacters: true },
        padding: { top: 12, bottom: 12 },
      });
      setReady(true);
    }).catch(() => {
      instance?.dispose();
      model?.dispose();
      instance = undefined;
      model = undefined;
      if (!disposed) setError(true);
    });
    return () => {
      disposed = true;
      instance?.dispose();
      model?.dispose();
    };
  }, [text, language, ariaLabel, theme]);

  return (
    <div className="relative h-[min(420px,52vh)] min-h-48 min-w-0 overflow-hidden rounded-xl border border-separator" data-website-source-editor={language}>
      <div className="absolute inset-0" ref={container} />
      {!ready && !error ? <p className="p-4 text-sm text-muted" role="status">Loading source editor…</p> : null}
      {error ? <div className="absolute inset-0 overflow-auto p-4"><p className="mb-2 text-xs text-warning" role="status">Syntax highlighting is unavailable. Showing source as plain text.</p><pre aria-label={ariaLabel} className="whitespace-pre font-mono text-xs">{text}</pre></div> : null}
    </div>
  );
}
