import type * as Monaco from "monaco-editor/editor/editor.api";

/** Local JSON highlighting; no schema downloads or language-service worker. */
export function registerJsonLanguage(monaco: typeof Monaco): void {
  monaco.languages.register({ id: "json", extensions: [".json"], aliases: ["JSON", "json"] });
  monaco.languages.setLanguageConfiguration("json", {
    brackets: [["{", "}"], ["[", "]"]],
    autoClosingPairs: [
      { open: "{", close: "}" }, { open: "[", close: "]" },
      { open: '"', close: '"', notIn: ["string"] },
    ],
    surroundingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: '"', close: '"' }],
  });
  monaco.languages.setMonarchTokensProvider("json", {
    defaultToken: "invalid",
    tokenPostfix: ".json",
    tokenizer: {
      root: [
        [/\s+/, "white"],
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "string.key"],
        [/"/, { token: "string.value", next: "@string" }],
        [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
        [/\b(?:true|false|null)\b/, "keyword"],
        [/[{}\[\]]/, "delimiter.bracket"],
        [/[:,]/, "delimiter"],
      ],
      string: [
        [/[^"\\]+/, "string.value"],
        [/\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/"/, { token: "string.value", next: "@pop" }],
      ],
    },
  });
}
