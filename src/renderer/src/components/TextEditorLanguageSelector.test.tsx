import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { MonacoLanguageOption } from "../editor/monaco-language-catalog";
import { TextEditorLanguageSelector } from "./TextEditorLanguageSelector";

const LANGUAGES: readonly MonacoLanguageOption[] = [
  { id: "plaintext", label: "Plain Text", aliases: ["text"], extensions: [".txt"], filenames: [] },
  { id: "shell", label: "Bash", aliases: ["shell", "sh"], extensions: [".sh"], filenames: [] },
  { id: "powershell", label: "PowerShell", aliases: ["pwsh"], extensions: [".ps1"], filenames: [] },
  { id: "python", label: "Python", aliases: ["py"], extensions: [".py"], filenames: [] },
  { id: "rust", label: "Rust", aliases: [], extensions: [".rs"], filenames: [] },
  { id: "typescript", label: "TypeScript", aliases: ["ts"], extensions: [".ts"], filenames: [] },
  { id: "future-language", label: "Future Language", aliases: [], extensions: [".future"], filenames: [] },
];

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

afterEach(cleanup);

describe("TextEditorLanguageSelector", () => {
  it("fuzzy matches languages, renders icons, and selects with the pointer", async () => {
    const user = userEvent.setup();
    render(<ControlledLanguageSelector />);
    const trigger = languageTrigger();

    expect(trigger).toHaveTextContent("Python");
    expect(trigger.querySelector('svg[data-icon="python"]')).toBeInTheDocument();
    await user.click(trigger);
    const search = await screen.findByRole("searchbox", { name: "Search syntax languages" });
    await user.type(search, "pwrsh");

    const powerShell = await screen.findByRole("option", { name: "PowerShell" });
    expect(powerShell.querySelector('svg[data-icon="terminal"]')).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Python" })).not.toBeInTheDocument();
    await user.click(powerShell);

    await waitFor(() => expect(trigger).toHaveTextContent("PowerShell"));
    expect(screen.getByTestId("selected-language")).toHaveTextContent("powershell");
    expect(trigger.querySelector('svg[data-icon="terminal"]')).toBeInTheDocument();
  });

  it("keeps every result icon-bearing and supports keyboard selection and empty results", async () => {
    const user = userEvent.setup();
    render(<ControlledLanguageSelector />);
    const trigger = languageTrigger();

    await user.click(trigger);
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(LANGUAGES.length);
    for (const option of options) {
      expect(option.querySelector("svg[aria-hidden=\"true\"]")).toBeInTheDocument();
    }
    expect(screen.getByRole("option", { name: "Future Language" })
      .querySelector('svg[data-icon="code"]')).toBeInTheDocument();

    let search = screen.getByRole("searchbox", { name: "Search syntax languages" });
    await user.type(search, "tpsrpt");
    expect(await screen.findByRole("option", { name: "TypeScript" })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(trigger).toHaveTextContent("TypeScript"));

    await user.click(trigger);
    search = await screen.findByRole("searchbox", { name: "Search syntax languages" });
    expect(search).toHaveValue("");
    expect(await screen.findAllByRole("option")).toHaveLength(LANGUAGES.length);
    await user.type(search, "no-such-syntax");
    expect(await screen.findByText("No matching languages.")).toBeInTheDocument();
  });
});

function ControlledLanguageSelector(): React.JSX.Element {
  const [language, setLanguage] = useState("python");
  return (
    <>
      <TextEditorLanguageSelector language={language} languages={LANGUAGES} onChange={setLanguage} />
      <output data-testid="selected-language">{language}</output>
    </>
  );
}

function languageTrigger(): HTMLElement {
  const trigger = globalThis.document.querySelector<HTMLElement>('[data-slot="autocomplete-trigger"]');
  if (!trigger) throw new Error("Language autocomplete trigger was not rendered");
  return trigger;
}
