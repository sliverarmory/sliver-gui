import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../shared/application-settings-contracts";
import {
  DEFAULT_TEXT_EDITOR_SETTINGS_STATE,
  type TextEditorSettingsValues,
} from "../../shared/text-editor-settings-contracts";
import type { OperationResult } from "../../shared/contracts";
import type {
  TextEditorAPI,
  TextEditorRemoteOverwriteRequest,
} from "../../shared/text-editor-contracts";
import { TextEditorWindowApp } from "./TextEditorWindowApp";

vi.mock("./components/TextEditorWorkspace", () => ({
  TextEditorWorkspace: ({
    document,
    onSave,
    editorSettings,
    onEditorSettingsChange,
    onOpenSettings,
  }: {
    document: { readonly title: string };
    onSave: (text: string, saveAs: boolean) => Promise<unknown>;
    editorSettings: TextEditorSettingsValues;
    onEditorSettingsChange: (settings: TextEditorSettingsValues) => void;
    onOpenSettings: () => void;
  }) => (
    <div data-testid="text-editor-workspace">
      {document.title}
      <button type="button" onClick={() => void onSave("updated\n", false)}>Save test document</button>
      <button type="button" onClick={onOpenSettings}>Open editor settings</button>
      <button type="button" onClick={() => onEditorSettingsChange({
        ...editorSettings,
        wordWrap: !editorSettings.wordWrap,
      })}>Toggle saved word wrap</button>
    </div>
  ),
}));

const overwriteRequest: TextEditorRemoteOverwriteRequest = {
  requestId: "00000000-0000-4000-8000-000000000001",
  path: "/home/olenna.tyrell/.bashrc",
  target: {
    name: "goad_linux_amd64",
    hostname: "highgarden",
    sessionId: "sliver-gui-cloud-6f0a80ed-bdd5-4ec0-aa53-7ecca9dfc31b",
    backend: {
      id: "team-highgarden",
      displayName: "Highgarden production",
    },
  },
  originalSha256: "a".repeat(64),
  newSha256: "b".repeat(64),
  warning: "This replaces remote file content after a best-effort digest preflight; the upstream RPC is not atomic.",
};

let remoteOverwriteListener: ((request: TextEditorRemoteOverwriteRequest) => void) | undefined;
const unsubscribeRemoteOverwrite = vi.fn();
const respondToRemoteOverwrite = vi.fn<TextEditorAPI["respondToRemoteOverwrite"]>();
const api: TextEditorAPI = {
  getDocument: vi.fn(async () => ({
    ok: true as const,
    value: {
      id: "remote-document-1",
      title: ".bashrc",
      text: "export EDITOR=vim\n",
      language: "shell",
      readOnly: false,
      remote: true,
    },
  })),
  openFile: vi.fn(async () => ({ ok: true as const, value: null })),
  save: vi.fn(async () => ({ ok: true as const, value: { title: ".bashrc" } })),
  setDirty: vi.fn(async () => ({ ok: true as const })),
  respondToRemoteOverwrite,
  onRemoteOverwriteRequested: vi.fn((listener) => {
    remoteOverwriteListener = listener;
    return unsubscribeRemoteOverwrite;
  }),
  getApplicationSettings: vi.fn(async () => DEFAULT_APPLICATION_SETTINGS_STATE),
  onApplicationSettingsChanged: vi.fn(() => () => undefined),
  getEditorSettings: vi.fn(async () => DEFAULT_TEXT_EDITOR_SETTINGS_STATE),
  updateEditorSettings: vi.fn(async () => ({ ok: true as const, value: {
    ...DEFAULT_TEXT_EDITOR_SETTINGS_STATE,
    revision: DEFAULT_TEXT_EDITOR_SETTINGS_STATE.revision + 1,
  } })),
  onEditorSettingsChanged: vi.fn(() => () => undefined),
};

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
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

beforeEach(() => {
  remoteOverwriteListener = undefined;
  unsubscribeRemoteOverwrite.mockClear();
  respondToRemoteOverwrite.mockReset();
  respondToRemoteOverwrite.mockResolvedValue({ ok: true });
  for (const value of Object.values(api)) {
    if (typeof value === "function" && "mockClear" in value && value !== respondToRemoteOverwrite) {
      vi.mocked(value).mockClear();
    }
  }
  vi.mocked(api.getEditorSettings).mockReset();
  vi.mocked(api.getEditorSettings).mockResolvedValue(DEFAULT_TEXT_EDITOR_SETTINGS_STATE);
  vi.mocked(api.updateEditorSettings).mockReset();
  vi.mocked(api.updateEditorSettings).mockImplementation(async ({ expectedRevision, settings }) => ({
    ok: true,
    value: {
      v: 1,
      revision: expectedRevision + 1,
      ...settings,
    },
  }));
  Object.defineProperty(window, "textEditor", { configurable: true, value: api });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "textEditor");
});

describe("TextEditorWindowApp remote overwrite review", () => {
  it("loads, opens, and persists standalone editor settings through the narrow bridge", async () => {
    const user = userEvent.setup();
    render(<TextEditorWindowApp />);
    await screen.findByTestId("text-editor-workspace");
    await waitFor(() => expect(api.getEditorSettings).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "Toggle saved word wrap" }));
    const { v: _version, revision: _revision, ...expectedSettings } = DEFAULT_TEXT_EDITOR_SETTINGS_STATE;
    await waitFor(() => expect(api.updateEditorSettings).toHaveBeenCalledWith({
      expectedRevision: 0,
      settings: { ...expectedSettings, wordWrap: true },
    }));

    await user.click(screen.getByRole("button", { name: "Open editor settings" }));
    expect(await screen.findByRole("dialog", { name: "Editor settings" })).toBeInTheDocument();
  });

  it("reloads the latest settings after a revision conflict and retries against that revision", async () => {
    vi.mocked(api.getEditorSettings)
      .mockResolvedValueOnce(DEFAULT_TEXT_EDITOR_SETTINGS_STATE)
      .mockResolvedValue({
        ...DEFAULT_TEXT_EDITOR_SETTINGS_STATE,
        revision: 2,
        fontSize: 20,
      });
    vi.mocked(api.updateEditorSettings)
      .mockResolvedValueOnce({ ok: false, error: "Editor settings changed in another window." })
      .mockImplementation(async ({ expectedRevision, settings }) => ({
        ok: true,
        value: { v: 1, revision: expectedRevision + 1, ...settings },
      }));

    const user = userEvent.setup();
    render(<TextEditorWindowApp />);
    await screen.findByTestId("text-editor-workspace");
    await waitFor(() => expect(api.getEditorSettings).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "Open editor settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Editor settings" });
    const fontSize = within(dialog).getByRole("textbox", { name: "Font size" });
    await user.clear(fontSize);
    await user.type(fontSize, "18");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The latest settings are loaded for review.",
    );
    expect(fontSize).toHaveValue("20");
    expect(api.updateEditorSettings).toHaveBeenNthCalledWith(1, {
      expectedRevision: 0,
      settings: expect.objectContaining({ fontSize: 18 }),
    });

    await user.clear(fontSize);
    await user.type(fontSize, "18");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateEditorSettings).toHaveBeenNthCalledWith(2, {
      expectedRevision: 2,
      settings: expect.objectContaining({ fontSize: 18 }),
    }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Editor settings" })).not.toBeInTheDocument());
  });

  it("formats the remote target and content digests before confirming the main-owned request", async () => {
    const user = userEvent.setup();
    render(<TextEditorWindowApp />);
    expect(await screen.findByTestId("text-editor-workspace")).toHaveTextContent(".bashrc");

    act(() => remoteOverwriteListener?.(overwriteRequest));

    const dialog = await screen.findByRole("alertdialog", { name: "Overwrite remote file?" });
    expect(within(dialog).getByRole("region", { name: "Remote file" })).toHaveTextContent(overwriteRequest.path);
    const target = within(dialog).getByRole("region", { name: "Remote target" });
    expect(target).toHaveTextContent("goad_linux_amd64");
    expect(target).toHaveTextContent("highgarden");
    expect(target).toHaveTextContent("Highgarden production");
    expect(target).toHaveTextContent("team-highgarden");
    expect(target).toHaveTextContent(overwriteRequest.target.sessionId);
    const digests = within(dialog).getByRole("region", { name: "Content digests" });
    expect(digests).toHaveTextContent(`Original SHA-256${overwriteRequest.originalSha256}`);
    expect(digests).toHaveTextContent(`New SHA-256${overwriteRequest.newSha256}`);
    expect(dialog).toHaveTextContent(overwriteRequest.warning);

    await user.click(within(dialog).getByRole("button", { name: "Overwrite file" }));
    expect(respondToRemoteOverwrite).toHaveBeenCalledOnce();
    expect(respondToRemoteOverwrite).toHaveBeenCalledWith({
      requestId: overwriteRequest.requestId,
      confirmed: true,
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("turns Escape into one negative response while the response is pending", async () => {
    const pending = deferred<OperationResult>();
    respondToRemoteOverwrite.mockReturnValue(pending.promise);
    const user = userEvent.setup();
    render(<TextEditorWindowApp />);
    await screen.findByTestId("text-editor-workspace");
    act(() => remoteOverwriteListener?.(overwriteRequest));
    await screen.findByRole("alertdialog", { name: "Overwrite remote file?" });

    await user.keyboard("{Escape}");
    expect(respondToRemoteOverwrite).toHaveBeenCalledWith({
      requestId: overwriteRequest.requestId,
      confirmed: false,
    });
    await user.keyboard("{Escape}");
    expect(respondToRemoteOverwrite).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();

    await act(async () => pending.resolve({ ok: true }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("keeps the review open with a useful error when main rejects the response", async () => {
    respondToRemoteOverwrite.mockResolvedValue({ ok: false, error: "The review request expired." });
    const user = userEvent.setup();
    render(<TextEditorWindowApp />);
    await screen.findByTestId("text-editor-workspace");
    act(() => remoteOverwriteListener?.(overwriteRequest));
    const dialog = await screen.findByRole("alertdialog", { name: "Overwrite remote file?" });

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The review request expired.");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("closes a stale review when the corresponding save finishes without a decision response", async () => {
    const pendingSave = deferred<OperationResult<{ readonly title: string } | null>>();
    vi.mocked(api.save).mockReturnValueOnce(pendingSave.promise);
    const user = userEvent.setup();
    render(<TextEditorWindowApp />);
    await user.click(await screen.findByRole("button", { name: "Save test document" }));
    act(() => remoteOverwriteListener?.(overwriteRequest));
    expect(await screen.findByRole("alertdialog", { name: "Overwrite remote file?" })).toBeInTheDocument();

    await act(async () => pendingSave.resolve({ ok: true, value: null }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(respondToRemoteOverwrite).not.toHaveBeenCalled();
  });
});

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
