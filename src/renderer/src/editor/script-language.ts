import type * as Monaco from "monaco-editor/editor/editor.api";
import { conf, language } from "monaco-editor/languages/definitions/javascript/javascript";
import type { Diagnostic, TypeScriptWorker } from "monaco-editor/languages/features/typescript/register";

import ScriptLanguageWorker from "./script-language.worker?worker";
import { SCRIPT_LANGUAGE_ID } from "./script-language-config";

type MonacoAPI = typeof Monaco;
let worker: Monaco.editor.MonacoWebWorker<TypeScriptWorker> | undefined;
let activeModels = 0;

function getWorker(monaco: MonacoAPI): Monaco.editor.MonacoWebWorker<TypeScriptWorker> {
  if (!worker) {
    const nativeWorker = new ScriptLanguageWorker();
    // The pinned Monaco initialize() helper consumes one startup message before
    // accepting the editor's RPC/model-sync protocol.
    nativeWorker.postMessage({});
    worker = monaco.editor.createWebWorker<TypeScriptWorker>({ worker: nativeWorker });
  }
  return worker;
}

async function withModel(monaco: MonacoAPI, model: Monaco.editor.ITextModel): Promise<TypeScriptWorker> {
  return getWorker(monaco).withSyncedResources([model.uri]);
}

interface CompletionEntry { name: string; kind: string; sortText?: string }

export function registerScriptLanguage(monaco: MonacoAPI): void {
  monaco.languages.register({ id: SCRIPT_LANGUAGE_ID });
  monaco.languages.setLanguageConfiguration(SCRIPT_LANGUAGE_ID, conf);
  monaco.languages.setMonarchTokensProvider(SCRIPT_LANGUAGE_ID, language);
  monaco.languages.registerCompletionItemProvider(SCRIPT_LANGUAGE_ID, {
    triggerCharacters: ["."],
    async provideCompletionItems(model, position, _context, token) {
      const client = await withModel(monaco, model);
      if (token.isCancellationRequested || model.isDisposed()) return { suggestions: [] };
      const result: { entries: CompletionEntry[] } | undefined = await client.getCompletionsAtPosition(
        model.uri.toString(), model.getOffsetAt(position),
      );
      if (!result || token.isCancellationRequested || model.isDisposed()) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return {
        suggestions: result.entries.map((entry) => ({
          label: entry.name,
          insertText: entry.name,
          sortText: entry.sortText ?? entry.name,
          range,
          kind: entry.kind === "method" || entry.kind === "function"
            ? monaco.languages.CompletionItemKind.Function
            : entry.kind === "keyword"
              ? monaco.languages.CompletionItemKind.Keyword
              : monaco.languages.CompletionItemKind.Variable,
        })),
      };
    },
  });
}

/** Keep markers attached to the cached model, independent of its visible editor. */
export function attachScriptDiagnostics(monaco: MonacoAPI, model: Monaco.editor.ITextModel): Monaco.IDisposable {
  activeModels += 1;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const check = async (): Promise<void> => {
    const request = ++generation;
    const version = model.getVersionId();
    try {
      const client = await withModel(monaco, model);
      if (disposed || model.isDisposed()) return;
      const [syntax, semantic] = await Promise.all([
        client.getSyntacticDiagnostics(model.uri.toString()),
        client.getSemanticDiagnostics(model.uri.toString()),
      ]);
      if (disposed || model.isDisposed() || request !== generation || version !== model.getVersionId()) return;
      monaco.editor.setModelMarkers(model, SCRIPT_LANGUAGE_ID, [...syntax, ...semantic].map((diagnostic) => {
        const start = model.getPositionAt(diagnostic.start ?? 0);
        const end = model.getPositionAt((diagnostic.start ?? 0) + (diagnostic.length ?? 1));
        return {
          ...{
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: end.lineNumber,
            endColumn: end.column,
          },
          severity: diagnostic.category === 0 ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
          message: diagnosticMessage(diagnostic.messageText),
          code: String(diagnostic.code),
          source: "Script",
        };
      }));
    } catch {
      // Editing remains available when analysis is interrupted during teardown.
      // Execution reports its own syntax/runtime errors through the runner.
    }
  };
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => { void check(); }, 250);
  };
  const subscription = model.onDidChangeContent(schedule);
  schedule();
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      clearTimeout(timer);
      subscription.dispose();
      activeModels -= 1;
      if (activeModels === 0) {
        worker?.dispose();
        worker = undefined;
      }
    },
  };
}

function diagnosticMessage(message: Diagnostic["messageText"]): string {
  if (typeof message === "string") return message;
  return [message.messageText, ...(message.next ?? []).map(diagnosticMessage)].join("\n");
}
