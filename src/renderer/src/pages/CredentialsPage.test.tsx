import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type { OperationResult, SliverDesktopAPI } from "../../../shared/contracts";
import type { CredentialCatalogPage } from "../../../shared/operator-data-contracts";
import { CredentialsPage } from "./CredentialsPage";

const CREDENTIAL_ID = "8f45c4cd-8309-46de-88b8-1f08b92e9541";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "sliver");
});

describe("CredentialsPage", () => {
  it("loads only metadata and wipes a deliberately revealed field on blur", async () => {
    const user = userEvent.setup();
    const revealedBytes = new TextEncoder().encode("operator-secret");
    const listCredentials = vi.fn().mockResolvedValue({ ok: true, value: credentialPage() });
    const revealCredentialSecret = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        item: credentialPage().items[0],
        field: "plaintext",
        value: revealedBytes,
      },
    });
    installAPI({ listCredentials, revealCredentialSecret });

    render(<CredentialsPage snapshot={connectedSnapshot()} />);

    expect(await screen.findByText("alice")).toBeInTheDocument();
    expect(listCredentials).toHaveBeenCalledWith({ query: "", kind: "all", limit: 100 });
    expect(revealCredentialSecret).not.toHaveBeenCalled();
    expect(screen.queryByText("operator-secret")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "View credential" }));
    const dialog = await screen.findByRole("dialog", { name: "alice" });
    expect(within(dialog).getAllByText("Redacted")).toHaveLength(2);

    await user.click(within(dialog).getAllByRole("button", { name: "Reveal" })[0]!);
    expect(await within(dialog).findByText("operator-secret")).toBeInTheDocument();
    expect(revealCredentialSecret).toHaveBeenCalledWith({ id: CREDENTIAL_ID, field: "plaintext" });

    fireEvent.blur(window);
    await waitFor(() => expect(screen.queryByText("operator-secret")).not.toBeInTheDocument());
    expect([...revealedBytes]).toEqual(new Array(revealedBytes.byteLength).fill(0));
  });

  it("copies by credential identity without revealing a secret to the renderer", async () => {
    const user = userEvent.setup();
    const copyCredentialSecret = vi.fn().mockResolvedValue({
      ok: true,
      value: { expiresAt: new Date(Date.now() + 30_000).toISOString() },
    });
    const clearCredentialClipboard = vi.fn().mockResolvedValue({ ok: true });
    installAPI({
      listCredentials: vi.fn().mockResolvedValue({ ok: true, value: credentialPage() }),
      copyCredentialSecret,
      clearCredentialClipboard,
    });

    render(<CredentialsPage snapshot={connectedSnapshot()} />);
    expect(await screen.findByText("alice")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View credential" }));
    const dialog = await screen.findByRole("dialog", { name: "alice" });

    await user.click(within(dialog).getAllByRole("button", { name: "Copy" })[0]!);
    expect(copyCredentialSecret).toHaveBeenCalledWith({ id: CREDENTIAL_ID, field: "plaintext" });
    expect(within(dialog).getByRole("button", { name: "Clear clipboard" })).toBeInTheDocument();
    expect(screen.queryByText("operator-secret")).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Clear clipboard" }));
    expect(clearCredentialClipboard).toHaveBeenCalledOnce();
  });

  it("clears uncontrolled secret inputs before IPC settles and zeroes the sent arrays", async () => {
    const user = userEvent.setup();
    const addition = deferred<OperationResult>();
    const addCredential = vi.fn().mockReturnValue(addition.promise);
    installAPI({
      listCredentials: vi.fn().mockResolvedValue({ ok: true, value: credentialPage() }),
      addCredential,
    });

    render(<CredentialsPage snapshot={connectedSnapshot()} />);
    expect(await screen.findByText("alice")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add credential" }));
    const dialog = await screen.findByRole("dialog", { name: "Add credential" });
    const username = within(dialog).getByRole("textbox", { name: "Username" });
    const plaintext = within(dialog).getByLabelText("Plaintext value");
    await user.type(username, "bob");
    await user.type(plaintext, "temporary-secret");

    await user.click(within(dialog).getByRole("button", { name: "Add credential" }));
    expect(plaintext).toHaveValue("");
    expect(addCredential).toHaveBeenCalledOnce();
    const input = addCredential.mock.calls[0]![0];
    expect(new TextDecoder().decode(input.plaintext)).toBe("temporary-secret");

    addition.resolve({ ok: true });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add credential" })).not.toBeInTheDocument());
    expect([...input.plaintext]).toEqual(new Array(input.plaintext.byteLength).fill(0));
    expect([...input.hash]).toEqual([]);
  });
});

function connectedSnapshot() {
  const snapshot = disconnectedSnapshot();
  snapshot.connection = {
    status: "connected",
    epoch: 7,
    incarnation: 2,
    server: "server.test",
    configName: "operator",
  };
  return snapshot;
}

function credentialPage(): CredentialCatalogPage {
  return {
    items: [{
      id: CREDENTIAL_ID,
      username: "alice",
      collection: "assessment",
      originHostId: "65c591f4-3a87-419f-bc26-c8598650742c",
      hashType: 1000,
      hashTypeName: "NTLM",
      isCracked: true,
      hasPlaintext: true,
      hasHash: true,
    }],
    page: { limit: 100, total: 1, truncated: false },
    collections: ["assessment"],
    hashTypes: [{ value: 1000, name: "NTLM", label: "NTLM" }],
  };
}

function installAPI(methods: Partial<SliverDesktopAPI>): void {
  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: methods as SliverDesktopAPI,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
