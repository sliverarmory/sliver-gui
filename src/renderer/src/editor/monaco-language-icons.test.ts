import { faEthereum, faPython, faRust } from "@fortawesome/free-brands-svg-icons";
import { faCode, faDatabase, faFileCode, faTerminal } from "@fortawesome/free-solid-svg-icons";
import { describe, expect, it } from "vitest";

import { monacoLanguageIcon } from "./monaco-language-icons";

describe("Monaco language icons", () => {
  it("uses recognizable brand and category icons", () => {
    expect(monacoLanguageIcon("python")).toBe(faPython);
    expect(monacoLanguageIcon("rust")).toBe(faRust);
    expect(monacoLanguageIcon("sol")).toBe(faEthereum);
    expect(monacoLanguageIcon("powershell")).toBe(faTerminal);
    expect(monacoLanguageIcon("mysql")).toBe(faDatabase);
    expect(monacoLanguageIcon("freemarker2.tag-angle.interpolation-dollar")).toBe(faFileCode);
  });

  it("gives every unknown Monaco contribution a stable code fallback", () => {
    expect(monacoLanguageIcon("future-language")).toBe(faCode);
    expect(monacoLanguageIcon("FUTURE-LANGUAGE")).toBe(faCode);
  });
});
