import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  modelDispose: vi.fn(),
  editorDispose: vi.fn(),
  createModel: vi.fn(),
  create: vi.fn(),
}));
vi.mock("../editor/website-preview-runtime", () => ({
  monaco: {
    Uri: { parse: (value: string) => value },
    editor: {
      createModel: mocked.createModel.mockImplementation(() => ({ dispose: mocked.modelDispose })),
      create: mocked.create.mockImplementation(() => ({ dispose: mocked.editorDispose })),
    },
  },
}));

import { WebsiteSourceEditor } from "./WebsiteSourceEditor";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("WebsiteSourceEditor", () => {
  it("uses a disposable read-only Monaco model with syntax-only grammar and no active editor services", async () => {
    const source = '<script>window.sliver.deleteWebsite({name:"target"})</script><a href="file:///etc/passwd">Go</a>';
    const { container, unmount } = render(<WebsiteSourceEditor text={source} language="html" ariaLabel="Website content source" />);
    await waitFor(() => expect(mocked.create).toHaveBeenCalledOnce());
    expect(mocked.createModel).toHaveBeenCalledWith(source, "website-preview-html", expect.stringMatching(/^inmemory:\/\/website-preview\/source-\d+$/u));
    expect(mocked.create).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({
      readOnly: true, domReadOnly: true, editContext: false, automaticLayout: true, links: false, contextmenu: false,
      hover: { enabled: "off" }, quickSuggestions: false, suggestOnTriggerCharacters: false,
      wordBasedSuggestions: "off", parameterHints: { enabled: false }, inlineSuggest: { enabled: false },
      codeLens: false, colorDecorators: false, "semanticHighlighting.enabled": false,
      renderValidationDecorations: "off", dropIntoEditor: { enabled: false }, pasteAs: { enabled: false },
      ariaLabel: "Website content source",
    }));
    expect(container.querySelector("iframe, webview, script, img, a, object, embed")).toBeNull();
    unmount();
    expect(mocked.modelDispose).toHaveBeenCalledOnce();
    expect(mocked.editorDispose).toHaveBeenCalledOnce();
  });

  it("disposes the old model when content changes rather than preserving untrusted content in editor history", async () => {
    const { rerender } = render(<WebsiteSourceEditor text="first" language="plaintext" ariaLabel="Website content source" />);
    await waitFor(() => expect(mocked.create).toHaveBeenCalledOnce());
    rerender(<WebsiteSourceEditor text="second" language="css" ariaLabel="Website content source" />);
    await waitFor(() => expect(mocked.create).toHaveBeenCalledTimes(2));
    expect(mocked.modelDispose).toHaveBeenCalledOnce();
    expect(mocked.editorDispose).toHaveBeenCalledOnce();
    expect(mocked.createModel).toHaveBeenLastCalledWith("second", "website-preview-css", expect.any(String));
  });

  it("falls back to inert source when Monaco cannot initialize", async () => {
    mocked.create.mockImplementationOnce(() => { throw new Error("failed to initialize"); });
    render(<WebsiteSourceEditor text='<img src="https://attacker.invalid"><script>alert(1)</script>' language="html" ariaLabel="Website content source" />);
    const fallback = await screen.findByLabelText("Website content source");
    expect(fallback.textContent).toContain('<img src="https://attacker.invalid">');
    expect(fallback.children).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent("Showing source as plain text");
  });
});
