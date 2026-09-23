import { useCallback, useEffect, useState } from "react";

import type { TextEditorDocument } from "../../shared/text-editor-contracts";
import { useApplicationSettings } from "./components/ApplicationSettingsProvider";
import { AuxiliaryWindowFrame } from "./components/AuxiliaryWindowFrame";
import { TextEditorWorkspace } from "./components/TextEditorWorkspace";

export function TextEditorWindowApp(): React.JSX.Element {
  const api = window.textEditor;
  const settings = useApplicationSettings();
  const [document, setDocument] = useState<TextEditorDocument>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!api) { setError("The text editor is unavailable in this window."); return; }
    let active = true;
    void api.getDocument().then((result) => {
      if (!active) return;
      if (result.ok && result.value) setDocument(result.value);
      else setError(result.ok ? "The document is unavailable." : result.error);
    }).catch(() => { if (active) setError("The document could not be loaded."); });
    return () => { active = false; };
  }, [api]);

  const dirtyChanged = useCallback((dirty: boolean): void => {
    void api?.setDirty(dirty).then((result) => {
      if (!result.ok) setError(result.error);
    }).catch(() => setError("The window could not track unsaved changes. Keep this window open until your work is saved."));
  }, [api]);

  return <AuxiliaryWindowFrame ariaLabel="Text Editor" className="text-editor-window-surface flex min-w-0 flex-col">
    {error && <p role="alert" className="px-6 py-4 text-sm text-danger">{error}</p>}
    {document && api ? <TextEditorWorkspace key={document.id} document={document}
      theme={settings?.resolvedTheme ?? "dark"} {...(settings ? { shortcuts: settings.settings } : {})} onDirtyChange={dirtyChanged}
      onSave={async (text, saveAs) => {
        const result = await api.save({ text, saveAs });
        if (!result.ok) throw new Error(result.error);
        return result.value ?? null;
      }}
      {...(document.remote ? {} : { onOpen: async () => {
        const result = await api.openFile();
        if (!result.ok) throw new Error(result.error);
        if (result.value) setDocument(result.value);
      } })} /> : !error && <p role="status" className="p-6 text-sm text-muted">Loading document…</p>}
  </AuxiliaryWindowFrame>;
}
