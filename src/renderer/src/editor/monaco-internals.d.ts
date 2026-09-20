declare module "monaco-editor/languages/definitions/javascript/javascript" {
  import type { languages } from "monaco-editor/editor/editor.api";
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}

declare module "monaco-editor/languages/features/typescript/ts.worker" {
  import type { TypeScriptWorker } from "monaco-editor/languages/features/typescript/register";
  export function initialize(callback: (context: unknown) => TypeScriptWorker): void;
  export function create(context: unknown, data: unknown): TypeScriptWorker;
}

declare module "monaco-editor/languages/features/typescript/tsWorker" {
  import type { TypeScriptWorker } from "monaco-editor/languages/features/typescript/register";
  export function create(context: unknown, data: unknown): TypeScriptWorker;
}

declare module "monaco-editor/editor/browser/coreCommands";
declare module "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching";
declare module "monaco-editor/editor/contrib/clipboard/browser/clipboard";
declare module "monaco-editor/editor/contrib/comment/browser/comment";
declare module "monaco-editor/editor/contrib/find/browser/findController";
declare module "monaco-editor/editor/contrib/folding/browser/folding";
declare module "monaco-editor/editor/contrib/hover/browser/hoverContribution";
declare module "monaco-editor/editor/contrib/indentation/browser/indentation";
declare module "monaco-editor/editor/contrib/linesOperations/browser/linesOperations";
declare module "monaco-editor/editor/contrib/multicursor/browser/multicursor";
declare module "monaco-editor/editor/contrib/suggest/browser/suggestController";
declare module "monaco-editor/editor/contrib/snippet/browser/snippetController2";
declare module "monaco-editor/editor/contrib/tokenization/browser/tokenization";
declare module "monaco-editor/editor/contrib/wordOperations/browser/wordOperations";
