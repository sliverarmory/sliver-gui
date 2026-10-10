import type { languages } from "monaco-editor/editor/editor.api";
import { language as html } from "monaco-editor/languages/definitions/html/html";
import { language as css } from "monaco-editor/languages/definitions/css/css";
import { language as javascript } from "monaco-editor/languages/definitions/javascript/javascript";
import { language as typescript } from "monaco-editor/languages/definitions/typescript/typescript";
import { language as xml } from "monaco-editor/languages/definitions/xml/xml";
import { language as markdown } from "monaco-editor/languages/definitions/markdown/markdown";
import { language as yaml } from "monaco-editor/languages/definitions/yaml/yaml";

import { monaco } from "./monaco-runtime";
import { isolateWebsitePreviewGrammar } from "./website-preview-languages";

const json: languages.IMonarchLanguage = {
  tokenizer: { root: [
    [/\s+/, "white"], [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "string.key"],
    [/"(?:[^"\\]|\\.)*"/, "string"], [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
    [/\b(?:true|false|null)\b/, "keyword"], [/[{}\[\]]/, "delimiter.bracket"], [/[:,]/, "delimiter"],
  ] },
};

// These private IDs have tokenizers only: standard HTML, TS, JSON, etc. language
// services do not match these models, even when the editable code window is open.
for (const [name, grammar] of Object.entries({ html, css, javascript, typescript, json, xml, markdown, yaml, plaintext: { tokenizer: { root: [] } } })) {
  const id = `website-preview-${name}`;
  monaco.languages.register({ id });
  monaco.languages.setMonarchTokensProvider(id, isolateWebsitePreviewGrammar(grammar) as languages.IMonarchLanguage);
}

export { monaco };
