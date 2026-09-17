import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type { SliverDesktopAPI, SliverSnapshot } from "../../../shared/contracts";
import type { LootCatalogPage, LootSummary } from "../../../shared/operator-data-contracts";
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
    renameLoot: vi.fn().mockResolvedValue({ ok: true, value: LOOT }),
    deleteLoot: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as Pick<SliverDesktopAPI, "listLoot" | "getLootDetail" | "downloadLoot" | "addLoot" | "renameLoot" | "deleteLoot">;
  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: api as SliverDesktopAPI,
  });
  return api;
}

describe("LootPage", () => {
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
