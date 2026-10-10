declare module "monaco-editor/languages/definitions/*" {
  import type { languages } from "monaco-editor/editor/editor.api";
  export const language: languages.IMonarchLanguage;
}
