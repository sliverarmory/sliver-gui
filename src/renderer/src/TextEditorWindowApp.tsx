import { useCallback, useEffect, useRef, useState } from "react";

import type {
  TextEditorDocument,
  TextEditorRemoteOverwriteRequest,
} from "../../shared/text-editor-contracts";
import {
  DEFAULT_TEXT_EDITOR_SETTINGS_STATE,
  type TextEditorSettingsState,
  type TextEditorSettingsValues,
} from "../../shared/text-editor-settings-contracts";
import { useApplicationSettings } from "./components/ApplicationSettingsProvider";
import { AuxiliaryWindowFrame } from "./components/AuxiliaryWindowFrame";
import { RemoteOverwriteDialog } from "./components/RemoteOverwriteDialog";
import { TextEditorWorkspace } from "./components/TextEditorWorkspace";
import { TextEditorSettingsModal } from "./components/TextEditorSettingsModal";

export function TextEditorWindowApp(): React.JSX.Element {
  const api = window.textEditor;
  const settings = useApplicationSettings();
  const [document, setDocument] = useState<TextEditorDocument>();
  const [error, setError] = useState<string>();
  const [editorSettings, setEditorSettings] = useState<TextEditorSettingsState>(DEFAULT_TEXT_EDITOR_SETTINGS_STATE);
  const [settingsDraft, setSettingsDraft] = useState<TextEditorSettingsValues>(DEFAULT_TEXT_EDITOR_SETTINGS_STATE);
  const [settingsDraftRevision, setSettingsDraftRevision] = useState(DEFAULT_TEXT_EDITOR_SETTINGS_STATE.revision);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string>();
  const [overwriteRequest, setOverwriteRequest] = useState<TextEditorRemoteOverwriteRequest | undefined>(undefined);
  const [overwriteResponseChoice, setOverwriteResponseChoice] = useState<boolean | undefined>(undefined);
  const [overwriteResponseError, setOverwriteResponseError] = useState<string | undefined>(undefined);
  const overwriteRequestRef = useRef<TextEditorRemoteOverwriteRequest | undefined>(undefined);
  const respondingRequestIdRef = useRef<string | undefined>(undefined);
  const saveSequenceRef = useRef(0);
  const editorSettingsRef = useRef(editorSettings);
  const settingsSavingRef = useRef(false);
  editorSettingsRef.current = editorSettings;

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

  useEffect(() => {
    if (!api) return;
    let active = true;
    const apply = (next: TextEditorSettingsState): void => {
      if (!active || next.revision < editorSettingsRef.current.revision) return;
      editorSettingsRef.current = next;
      setEditorSettings(next);
    };
    const unsubscribe = api.onEditorSettingsChanged(apply);
    void api.getEditorSettings().then(apply).catch(() => {
      if (active) setError("Editor settings could not be loaded. Defaults are active for this window.");
    });
    return () => { active = false; unsubscribe(); };
  }, [api]);

  useEffect(() => {
    if (!api) return;
    return api.onRemoteOverwriteRequested((request) => {
      if (overwriteRequestRef.current) return;
      overwriteRequestRef.current = request;
      respondingRequestIdRef.current = undefined;
      setOverwriteResponseChoice(undefined);
      setOverwriteResponseError(undefined);
      setOverwriteRequest(request);
    });
  }, [api]);

  const dirtyChanged = useCallback((dirty: boolean): void => {
    void api?.setDirty(dirty).then((result) => {
      if (!result.ok) setError(result.error);
    }).catch(() => setError("The window could not track unsaved changes. Keep this window open until your work is saved."));
  }, [api]);

  const clearOverwriteRequest = useCallback((requestId?: string): void => {
    if (requestId && overwriteRequestRef.current?.requestId !== requestId) return;
    overwriteRequestRef.current = undefined;
    respondingRequestIdRef.current = undefined;
    setOverwriteRequest(undefined);
    setOverwriteResponseChoice(undefined);
    setOverwriteResponseError(undefined);
  }, []);

  const respondToOverwrite = useCallback((confirmed: boolean): void => {
    const request = overwriteRequestRef.current;
    if (!api || !request || respondingRequestIdRef.current === request.requestId) return;
    respondingRequestIdRef.current = request.requestId;
    setOverwriteResponseChoice(confirmed);
    setOverwriteResponseError(undefined);
    void api.respondToRemoteOverwrite({ requestId: request.requestId, confirmed }).then((result) => {
      if (!result.ok) {
        setOverwriteResponseError(result.error);
        return;
      }
      clearOverwriteRequest(request.requestId);
    }).catch(() => {
      setOverwriteResponseError("The overwrite decision could not be sent. Try again while this window remains open.");
    }).finally(() => {
      if (respondingRequestIdRef.current === request.requestId) {
        respondingRequestIdRef.current = undefined;
        setOverwriteResponseChoice(undefined);
      }
    });
  }, [api, clearOverwriteRequest]);

  const saveEditorSettings = useCallback(async (
    next: TextEditorSettingsValues,
    closeOnSuccess: boolean,
    expectedRevision?: number,
  ): Promise<void> => {
    if (!api || settingsSavingRef.current) return;
    settingsSavingRef.current = true;
    setSettingsSaving(true);
    setSettingsError(undefined);
    const submittedRevision = expectedRevision ?? editorSettingsRef.current.revision;
    try {
      const result = await api.updateEditorSettings({
        expectedRevision: submittedRevision,
        settings: next,
      });
      if (!result.ok || !result.value) {
        let message = result.ok ? "Editor settings could not be saved." : result.error;
        try {
          const latest = await api.getEditorSettings();
          if (latest.revision !== submittedRevision) {
            editorSettingsRef.current = latest;
            setEditorSettings(latest);
            setSettingsDraft(settingsValues(latest));
            setSettingsDraftRevision(latest.revision);
            message = `${message} The latest settings are loaded for review.`;
          }
        } catch {
          // Keep the submitted draft when the latest revision cannot be read.
        }
        setSettingsError(message);
        if (!settingsOpen) setError(message);
        return;
      }
      editorSettingsRef.current = result.value;
      setEditorSettings(result.value);
      setSettingsDraft(settingsValues(result.value));
      setSettingsDraftRevision(result.value.revision);
      if (closeOnSuccess) setSettingsOpen(false);
    } catch {
      const message = "Editor settings could not be saved.";
      setSettingsError(message);
      if (!settingsOpen) setError(message);
    } finally {
      settingsSavingRef.current = false;
      setSettingsSaving(false);
    }
  }, [api, settingsOpen]);

  const openSettings = useCallback((): void => {
    setSettingsDraft(settingsValues(editorSettingsRef.current));
    setSettingsDraftRevision(editorSettingsRef.current.revision);
    setSettingsError(undefined);
    setSettingsOpen(true);
  }, []);

  return <>
    <AuxiliaryWindowFrame ariaLabel="Text Editor" className="text-editor-window-surface flex min-w-0 flex-col">
      {error && <p role="alert" className="px-6 py-4 text-sm text-danger">{error}</p>}
      {document && api ? <TextEditorWorkspace key={document.id} document={document}
        theme={settings?.resolvedTheme ?? "dark"} {...(settings ? { shortcuts: settings.settings } : {})} onDirtyChange={dirtyChanged}
        editorSettings={settingsValues(editorSettings)} onOpenSettings={openSettings}
        onEditorSettingsChange={(next) => { void saveEditorSettings(next, false); }}
        onSave={async (text, saveAs) => {
          const sequence = ++saveSequenceRef.current;
          try {
            const result = await api.save({ text, saveAs });
            if (!result.ok) throw new Error(result.error);
            return result.value ?? null;
          } finally {
            if (saveSequenceRef.current === sequence) clearOverwriteRequest();
          }
        }}
        {...(document.remote ? {} : { onOpen: async () => {
          const result = await api.openFile();
          if (!result.ok) throw new Error(result.error);
          if (result.value) setDocument(result.value);
        } })} /> : !error && <p role="status" className="p-6 text-sm text-muted">Loading document…</p>}
    </AuxiliaryWindowFrame>
    <RemoteOverwriteDialog
      request={overwriteRequest}
      responseChoice={overwriteResponseChoice}
      responseError={overwriteResponseError}
      onRespond={respondToOverwrite}
    />
    <TextEditorSettingsModal
      draft={settingsDraft}
      error={settingsError}
      isOpen={settingsOpen}
      isSaving={settingsSaving}
      onDraftChange={setSettingsDraft}
      onOpenChange={(open) => {
        if (open) openSettings();
        else setSettingsOpen(false);
      }}
      onSave={() => { void saveEditorSettings(settingsDraft, true, settingsDraftRevision); }}
    />
  </>;
}

function settingsValues(state: TextEditorSettingsState): TextEditorSettingsValues {
  const { v: _version, revision: _revision, ...settings } = state;
  return settings;
}
