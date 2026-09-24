import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type { SliverDesktopAPI, SliverSnapshot } from "../../../shared/contracts";
import { OPERATOR_DATA_LIMITS, type LootCatalogPage, type LootSummary } from "../../../shared/operator-data-contracts";
import { LootPage } from "./LootPage";

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

const LOOT: LootSummary = {
  id: "591a16d2-e138-4a21-b38f-f166aa23e044",
  name: "operator-notes",
  fileName: "notes.txt",
  fileType: "text",
  originHostId: "76955e80-e700-4bc1-84d0-4e8090d5b900",
  sizeBytes: "13",
};

function connectedSnapshot(incarnation = 1): SliverSnapshot {
  const snapshot = disconnectedSnapshot();
  snapshot.connection = {
    managedServer: null,
    status: "connected",
    epoch: 7,
    incarnation,
    server: "127.0.0.1:31337",
    configName: "operator.cfg",
  };
  return snapshot;
}

function lootPage(items: LootSummary[] = [LOOT]): LootCatalogPage {
  return {
    items,
    page: { limit: 100, total: items.length, truncated: false },
  };
}

function installAPI(overrides: Partial<SliverDesktopAPI> = {}) {
  const api = {
    listLoot: vi.fn().mockResolvedValue({ ok: true, value: lootPage() }),
    getLootDetail: vi.fn().mockResolvedValue({
      ok: true,
      value: { item: LOOT, previewState: "text", preview: new Uint8Array([110, 111, 116, 101, 115]) },
    }),
    downloadLoot: vi.fn().mockResolvedValue({ ok: true, value: { saved: false, fileName: "notes.txt", size: 0 } }),
    addLoot: vi.fn().mockResolvedValue({ ok: false, error: "cancelled" }),
    addDroppedLoot: vi.fn().mockResolvedValue({ ok: true, value: LOOT }),
    renameLoot: vi.fn().mockResolvedValue({ ok: true, value: LOOT }),
    deleteLoot: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as Pick<SliverDesktopAPI, "listLoot" | "getLootDetail" | "downloadLoot" | "addLoot" | "addDroppedLoot" | "renameLoot" | "deleteLoot">;
  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: api as SliverDesktopAPI,
  });
  return api;
}

function droppedFilesDataTransfer(files: readonly File[]): DataTransfer {
  return {
    dropEffect: "none",
    effectAllowed: "all",
    files,
    items: files.map((file) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file,
    })),
    types: ["Files"],
    clearData: () => undefined,
    getData: () => "",
    setData: () => undefined,
    setDragImage: () => undefined,
  } as unknown as DataTransfer;
}

function dropFiles(target: HTMLElement, files: readonly File[]): void {
  const dataTransfer = droppedFilesDataTransfer(files);
  fireEvent.dragEnter(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}

describe("LootPage", () => {
  it("reports the unfiltered server total after the first page and a successful add refresh", async () => {
    const onInventoryTotal = vi.fn();
    const firstPage = { ...lootPage(), page: { limit: 100, total: 125, truncated: true, nextCursor: "1" } };
    const refreshedPage = { ...lootPage(), page: { limit: 100, total: 126, truncated: true, nextCursor: "1" } };
    const listLoot = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: firstPage })
      .mockResolvedValueOnce({ ok: true, value: refreshedPage });
    installAPI({ listLoot });
    render(<LootPage snapshot={connectedSnapshot()} onInventoryTotal={onInventoryTotal} />);

    await waitFor(() => expect(onInventoryTotal).toHaveBeenCalledExactlyOnceWith(125));
    expect(listLoot).toHaveBeenNthCalledWith(1, { fileType: "all", limit: 100 });

    dropFiles(screen.getByLabelText("Drop a local file into loot"), [new File(["new loot"], "new.txt")]);

    await waitFor(() => expect(onInventoryTotal).toHaveBeenLastCalledWith(126));
    expect(onInventoryTotal).toHaveBeenCalledTimes(2);
    expect(listLoot).toHaveBeenNthCalledWith(2, { fileType: "all", limit: 100 });
  });

  it("does not report filtered inventory totals or a failed unfiltered refresh", async () => {
    const user = userEvent.setup();
    const onInventoryTotal = vi.fn();
    const listLoot = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { ...lootPage(), page: { limit: 100, total: 12, truncated: false } } })
      .mockResolvedValueOnce({ ok: true, value: { ...lootPage([]), page: { limit: 100, total: 0, truncated: false } } })
      .mockResolvedValueOnce({ ok: false, error: "loot inventory unavailable" });
    installAPI({ listLoot });
    render(<LootPage snapshot={connectedSnapshot()} onInventoryTotal={onInventoryTotal} />);

    await waitFor(() => expect(onInventoryTotal).toHaveBeenCalledExactlyOnceWith(12));
    const search = screen.getByRole("searchbox", { name: "Search loot" });
    await user.type(search, "missing");
    await waitFor(() => expect(listLoot).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No loot matches")).toBeInTheDocument();
    expect(listLoot).toHaveBeenNthCalledWith(2, { query: "missing", fileType: "all", limit: 100 });
    expect(onInventoryTotal).toHaveBeenCalledTimes(1);

    await user.clear(search);
    expect(await screen.findByText("loot inventory unavailable")).toBeInTheDocument();
    expect(listLoot).toHaveBeenNthCalledWith(3, { fileType: "all", limit: 100 });
    expect(onInventoryTotal).toHaveBeenCalledTimes(1);
  });

  it("ignores an old connection's first-page response after switching connections", async () => {
    const onInventoryTotal = vi.fn();
    let resolveOld: (value: { ok: true; value: LootCatalogPage }) => void = () => undefined;
    const oldResponse = new Promise<{ ok: true; value: LootCatalogPage }>((resolve) => {
      resolveOld = resolve;
    });
    const listLoot = vi.fn()
      .mockReturnValueOnce(oldResponse)
      .mockResolvedValueOnce({
        ok: true,
        value: { ...lootPage(), page: { limit: 100, total: 7, truncated: false } },
      });
    installAPI({ listLoot });
    const { rerender } = render(<LootPage snapshot={connectedSnapshot(1)} onInventoryTotal={onInventoryTotal} />);
    await waitFor(() => expect(listLoot).toHaveBeenCalledTimes(1));

    rerender(<LootPage snapshot={connectedSnapshot(2)} onInventoryTotal={onInventoryTotal} />);
    await waitFor(() => expect(onInventoryTotal).toHaveBeenCalledExactlyOnceWith(7));

    await act(async () => {
      resolveOld({ ok: true, value: { ...lootPage(), page: { limit: 100, total: 99, truncated: false } } });
      await oldResponse;
    });
    expect(onInventoryTotal).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("adds one dropped local file and refreshes the inventory after success", async () => {
    let completeUpload: (result: { ok: true; value: LootSummary }) => void = () => undefined;
    const pendingUpload = new Promise<{ ok: true; value: LootSummary }>((resolve) => {
      completeUpload = resolve;
    });
    const addDroppedLoot = vi.fn().mockReturnValue(pendingUpload);
    const api = installAPI({ addDroppedLoot });
    render(<LootPage snapshot={connectedSnapshot()} />);
    await screen.findByText("operator-notes");

    const dropArea = screen.getByLabelText("Drop a local file into loot");
    const file = new File(["local notes"], "notes.txt", { type: "text/plain" });
    const dataTransfer = droppedFilesDataTransfer([file]);
    fireEvent.dragEnter(dropArea, { dataTransfer });
    expect(screen.getByText("Drop to add loot")).toBeInTheDocument();
    expect(screen.getByText("One local file, up to 64 MiB")).toBeInTheDocument();
    fireEvent.drop(dropArea, { dataTransfer });

    await waitFor(() => expect(addDroppedLoot).toHaveBeenCalledExactlyOnceWith(file));
    expect(api.addLoot).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add local file" })).toBeDisabled();

    dropFiles(dropArea, [new File(["another"], "another.txt")]);
    expect(addDroppedLoot).toHaveBeenCalledTimes(1);

    completeUpload({ ok: true, value: LOOT });
    await waitFor(() => expect(api.listLoot).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Add local file" })).toBeEnabled();
  });

  it("ignores multiple and oversized dropped files", async () => {
    const api = installAPI();
    render(<LootPage snapshot={connectedSnapshot()} />);
    await screen.findByText("operator-notes");
    const dropArea = screen.getByLabelText("Drop a local file into loot");
    dropFiles(dropArea, [
      new File(["first"], "first.txt"),
      new File(["second"], "second.txt"),
    ]);
    expect(api.addDroppedLoot).not.toHaveBeenCalled();

    const oversized = new File(["sample"], "oversized.bin");
    Object.defineProperty(oversized, "size", { value: OPERATOR_DATA_LIMITS.artifactBytes + 1 });
    dropFiles(dropArea, [oversized]);
    await Promise.resolve();
    expect(api.addDroppedLoot).not.toHaveBeenCalled();
  });

  it("loads paged metadata without fetching file content and refreshes on loot events", async () => {
    const listLoot = vi.fn().mockResolvedValue({ ok: true, value: lootPage() });
    const getLootDetail = vi.fn();
    installAPI({ listLoot, getLootDetail });
    const snapshot = connectedSnapshot();
    const { rerender } = render(<LootPage snapshot={snapshot} />);

    expect(await screen.findByText("operator-notes")).toBeInTheDocument();
    expect(listLoot).toHaveBeenCalledWith({ fileType: "all", limit: 100 });
    expect(getLootDetail).not.toHaveBeenCalled();

    rerender(<LootPage snapshot={{
      ...snapshot,
      recentEvents: [{
        id: "loot-event-1",
        type: "loot-added",
        at: "2026-08-30T12:00:00.000Z",
        message: "Loot added",
        isError: false,
      }],
    }} />);

    await waitFor(() => expect(listLoot).toHaveBeenCalledTimes(2));
  });

  it("reloads the first page when the event stream recovers without exposing a refresh control", async () => {
    const recoveredLoot: LootSummary = {
      ...LOOT,
      id: "eb06aaea-1865-45ed-abdb-fbb6ed32376f",
      name: "recovered-event-loot",
      fileName: "recovered.txt",
    };
    const listLoot = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: lootPage() })
      .mockResolvedValueOnce({ ok: true, value: lootPage([recoveredLoot]) });
    installAPI({ listLoot });
    const retryingSnapshot: SliverSnapshot = {
      ...connectedSnapshot(),
      eventStream: { status: "retrying", attempt: 1, error: "event stream interrupted" },
    };
    const { rerender } = render(<LootPage snapshot={retryingSnapshot} />);

    expect(await screen.findByText("operator-notes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh loot" })).not.toBeInTheDocument();

    rerender(<LootPage snapshot={{
      ...retryingSnapshot,
      eventStream: { status: "connected", attempt: 0 },
    }} />);

    expect(await screen.findByText("recovered-event-loot")).toBeInTheDocument();
    expect(listLoot).toHaveBeenCalledTimes(2);
    expect(listLoot).toHaveBeenNthCalledWith(2, { fileType: "all", limit: 100 });
    expect(screen.queryByRole("button", { name: "Refresh loot" })).not.toBeInTheDocument();
  });

  it("wipes preview bytes when the detail dialog closes", async () => {
    const user = userEvent.setup();
    const preview = new Uint8Array([115, 101, 99, 114, 101, 116]);
    installAPI({
      getLootDetail: vi.fn().mockResolvedValue({
        ok: true,
        value: { item: LOOT, previewState: "text", preview },
      }),
    });
    render(<LootPage snapshot={connectedSnapshot()} />);

    await user.click(await screen.findByRole("button", { name: "Inspect operator-notes" }));
    expect(await screen.findByText("Text preview")).toBeInTheDocument();
    expect(preview.some((byte) => byte !== 0)).toBe(true);

    const closeButtons = screen.getAllByRole("button", { name: "Close" });
    const footerClose = closeButtons.at(-1);
    if (!footerClose) throw new Error("Loot detail close button was not rendered");
    await user.click(footerClose);

    await waitFor(() => expect(screen.queryByText("Text preview")).not.toBeInTheDocument());
    expect([...preview]).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
