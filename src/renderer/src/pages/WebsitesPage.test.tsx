import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type { OperationResult, SliverDesktopAPI, SliverSnapshot } from "../../../shared/contracts";
import type { WebsiteCatalogPage, WebsiteContentDetail, WebsiteContentSummary, WebsiteDetail } from "../../../shared/website-contracts";
import { WebsitesPage } from "./WebsitesPage";

vi.mock("../components/WebsiteSourceEditor", () => ({
  WebsiteSourceEditor: ({ text, ariaLabel }: { text: string; ariaLabel: string }) => <pre aria-label={ariaLabel}>{text}</pre>,
}));

const SOURCE = '<h1>Welcome</h1><script>window.alert("unsafe")</script>';
const ITEM: WebsiteContentSummary = { id: "content-1", path: "/index.html", contentType: "text/html", sizeBytes: String(SOURCE.length), sha256: "a".repeat(64), originalFile: "index.html" };
const SITE: WebsiteDetail = { site: { id: "site-1", name: "public", contentCount: 1, totalSizeBytes: ITEM.sizeBytes }, contents: [ITEM], truncated: false };

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
afterAll(() => { vi.unstubAllGlobals(); });
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "sliver"); });

function connectedSnapshot(incarnation = 1): SliverSnapshot {
  const snapshot = disconnectedSnapshot();
  snapshot.connection = { managedServer: null, status: "connected", epoch: 1, incarnation, server: "127.0.0.1:31337", configName: "operator.cfg" };
  return snapshot;
}
function catalog(sites = [SITE.site]): WebsiteCatalogPage {
  return { items: sites, page: { total: sites.length, limit: 100, truncated: false } };
}
function contentDetail(): WebsiteContentDetail {
  return { item: ITEM, previewState: "text", preview: new TextEncoder().encode(SOURCE), truncated: false };
}
function installAPI(overrides: Partial<SliverDesktopAPI> = {}) {
  const api = {
    listWebsites: vi.fn().mockResolvedValue({ ok: true, value: catalog() }),
    getWebsite: vi.fn().mockResolvedValue({ ok: true, value: SITE }),
    createWebsite: vi.fn().mockResolvedValue({ ok: true, value: { ...SITE, site: { ...SITE.site, name: "new-site" } } }),
    deleteWebsite: vi.fn().mockResolvedValue({ ok: true }),
    saveWebsiteText: vi.fn().mockResolvedValue({ ok: true, value: SITE }),
    importWebsiteFiles: vi.fn().mockResolvedValue({ ok: true, value: SITE }),
    updateWebsiteContentType: vi.fn().mockResolvedValue({ ok: true, value: SITE }),
    deleteWebsiteContent: vi.fn().mockResolvedValue({ ok: true, value: SITE }),
    getWebsiteContent: vi.fn().mockImplementation(async () => ({ ok: true, value: contentDetail() })),
    exportWebsiteContent: vi.fn().mockResolvedValue({ ok: true, value: { saved: true, fileName: "index.html", size: SOURCE.length } }),
    openWebsiteRenderedPreview: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
  Object.defineProperty(window, "sliver", { configurable: true, value: api });
  return api;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
async function inspect(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Inspect /index.html" }));
  return screen.findByRole("dialog", { name: "/index.html" });
}

describe("WebsitesPage", () => {
  it("loads metadata only until inspection, renders hostile source inertly, and wipes the preview on close", async () => {
    const user = userEvent.setup();
    const detail = contentDetail();
    const api = installAPI({ getWebsiteContent: vi.fn().mockResolvedValue({ ok: true, value: detail }) });
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await screen.findByRole("button", { name: "Inspect /index.html" });
    expect(api.getWebsiteContent).not.toHaveBeenCalled();
    const dialog = await inspect(user);
    expect(await within(dialog).findByLabelText("Website content source")).toHaveTextContent(SOURCE);
    expect(dialog.querySelector("script, iframe, webview, object, embed")).toBeNull();
    expect(api.getWebsiteContent).toHaveBeenCalledExactlyOnceWith({ name: "public", path: "/index.html" });
    await user.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!);
    expect([...detail.preview]).toEqual(Array(detail.preview.byteLength).fill(0));
  });

  it("creates a site and adds nonempty text through typed operations", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await screen.findByRole("button", { name: "Inspect /index.html" });
    await user.click(screen.getByRole("button", { name: "Create website" }));
    const createDialog = await screen.findByRole("dialog", { name: "Create website" });
    await user.type(within(createDialog).getByLabelText("Website name"), "new-site");
    await user.click(within(createDialog).getByRole("button", { name: "Create website" }));
    await waitFor(() => expect(api.createWebsite).toHaveBeenCalledWith({ name: "new-site" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Add text" }));
    const addDialog = await screen.findByRole("dialog", { name: "Add text content" });
    await user.type(within(addDialog).getByLabelText("URL path"), "/new.html");
    await user.click(within(addDialog).getByRole("button", { name: "Save content" }));
    expect(await within(addDialog).findByRole("alert")).toHaveTextContent("Enter nonempty content");
    expect(api.saveWebsiteText).not.toHaveBeenCalled();
    fireEvent.change(within(addDialog).getByLabelText("Content source"), { target: { value: SOURCE } });
    await user.click(within(addDialog).getByRole("button", { name: "Save content" }));
    await waitFor(() => expect(api.saveWebsiteText).toHaveBeenCalledWith({ name: "new-site", path: "/new.html", contentType: "text/html; charset=utf-8", text: SOURCE, overwrite: false }));
  });

  it("requires confirmation before editing existing content and sends complete source", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    const previewDialog = await inspect(user);
    await waitFor(() => expect(within(previewDialog).getByRole("button", { name: "Edit text" })).toBeEnabled());
    await user.click(within(previewDialog).getByRole("button", { name: "Edit text" }));
    const editor = await screen.findByRole("dialog", { name: "Edit content" });
    expect(within(editor).getByLabelText("Content source")).toHaveValue(SOURCE);
    expect(within(editor).getByLabelText("URL path")).toBeDisabled();
    fireEvent.change(within(editor).getByLabelText("Content source"), { target: { value: "<h1>Changed</h1>" } });
    await user.click(within(editor).getByRole("button", { name: "Save content" }));
    expect(api.saveWebsiteText).not.toHaveBeenCalled();
    const confirmation = await screen.findByRole("alertdialog", { name: "Replace hosted content?" });
    await user.click(within(confirmation).getByRole("button", { name: "Replace content" }));
    await waitFor(() => expect(api.saveWebsiteText).toHaveBeenCalledExactlyOnceWith({ name: "public", path: "/index.html", contentType: "text/html", text: "<h1>Changed</h1>", overwrite: true }));
  });

  it("confirms adding to an existing path and importing replacement bytes", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await screen.findByRole("button", { name: "Inspect /index.html" });
    await user.click(screen.getByRole("button", { name: "Add local file" }));
    const dialog = await screen.findByRole("dialog", { name: "Add local file" });
    await user.type(within(dialog).getByLabelText("URL path"), "/index.html");
    await user.click(within(dialog).getByRole("button", { name: "Choose file and upload" }));
    expect(api.importWebsiteFiles).not.toHaveBeenCalled();
    const confirmation = await screen.findByRole("alertdialog", { name: "Replace hosted content?" });
    await user.click(within(confirmation).getByRole("button", { name: "Replace content" }));
    await waitFor(() => expect(api.importWebsiteFiles).toHaveBeenCalledExactlyOnceWith({ name: "public", path: "/index.html", contentType: "", overwrite: true, directory: false }));
  });

  it.each([false, true])("uses a native directory request with hidden directories opted in: %s", async (includeHiddenDirectories) => {
    const user = userEvent.setup();
    const api = installAPI();
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await screen.findByRole("button", { name: "Inspect /index.html" });
    await user.click(screen.getByRole("button", { name: "Import directory" }));
    const dialog = await screen.findByRole("dialog", { name: "Import directory" });
    const hiddenDirectories = within(dialog).getByRole("checkbox", { name: "Include hidden directories" });
    expect(hiddenDirectories).not.toBeChecked();
    if (includeHiddenDirectories) await user.click(hiddenDirectories);
    fireEvent.change(within(dialog).getByLabelText("Base URL path"), { target: { value: "/assets/" } });
    await user.click(within(dialog).getByRole("button", { name: "Choose directory and upload" }));
    await waitFor(() => expect(api.importWebsiteFiles).toHaveBeenCalledExactlyOnceWith({ name: "public", path: "/assets/", contentType: "", overwrite: false, directory: true, includeHiddenDirectories }));
    expect(document.querySelector('input[type="file"]')).toBeNull();
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Import directory" }));
    expect(within(await screen.findByRole("dialog", { name: "Import directory" })).getByRole("checkbox", { name: "Include hidden directories" })).not.toBeChecked();
  });

  it("changes MIME metadata without writing content bytes and exports with the native save operation", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    let dialog = await inspect(user);
    await user.click(within(dialog).getByRole("button", { name: "Save copy" }));
    await waitFor(() => expect(api.exportWebsiteContent).toHaveBeenCalledWith({ name: "public", path: "/index.html" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Change content type" })).toBeEnabled());
    await user.click(within(dialog).getByRole("button", { name: "Change content type" }));
    dialog = await screen.findByRole("dialog", { name: "Change content type" });
    fireEvent.change(within(dialog).getByLabelText("Content type"), { target: { value: "text/plain; charset=utf-8" } });
    await user.click(within(dialog).getByRole("button", { name: "Save content" }));
    await waitFor(() => expect(api.updateWebsiteContentType).toHaveBeenCalledExactlyOnceWith({ name: "public", path: "/index.html", contentType: "text/plain; charset=utf-8" }));
    expect(api.saveWebsiteText).not.toHaveBeenCalled();
  });

  it("requires destructive confirmations and makes a deletion error visible", async () => {
    const user = userEvent.setup();
    const api = installAPI({ deleteWebsiteContent: vi.fn().mockResolvedValue({ ok: false, error: "Permission denied" }) });
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await user.click(await screen.findByRole("button", { name: "Delete /index.html" }));
    const contentConfirm = await screen.findByRole("alertdialog", { name: "Delete hosted content?" });
    expect(api.deleteWebsiteContent).not.toHaveBeenCalled();
    await user.click(within(contentConfirm).getByRole("button", { name: "Delete content" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied");
    await user.click(screen.getByRole("button", { name: "Delete website" }));
    const siteConfirm = await screen.findByRole("alertdialog", { name: "Delete website?" });
    expect(api.deleteWebsite).not.toHaveBeenCalled();
    await user.click(within(siteConfirm).getByRole("button", { name: "Delete website" }));
    await waitFor(() => expect(api.deleteWebsite).toHaveBeenCalledExactlyOnceWith({ name: "public" }));
  });

  it("disables editing an incomplete preview", async () => {
    const user = userEvent.setup();
    installAPI({ getWebsiteContent: vi.fn().mockResolvedValue({ ok: true, value: { ...contentDetail(), truncated: true } }) });
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    const dialog = await inspect(user);
    expect(await within(dialog).findByText(/Text editing requires complete UTF-8/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Edit text" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Replace from file" })).toBeEnabled();
  });

  it("opens supported rendered previews through the native boundary without sending renderer bytes", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    const dialog = await inspect(user);
    await user.click(within(dialog).getByRole("button", { name: "Rendered preview" }));
    await waitFor(() => expect(api.openWebsiteRenderedPreview).toHaveBeenCalledExactlyOnceWith({ name: "public", path: "/index.html" }));
    expect(dialog.querySelector("iframe, webview, img, object, embed")).toBeNull();
    expect(within(dialog).getByText(/separate protected window/)).toBeInTheDocument();
  });

  it("does not offer a rendered preview for active SVG or PDF content", async () => {
    const user = userEvent.setup();
    const item = { ...ITEM, contentType: "image/svg+xml" };
    installAPI({ getWebsite: vi.fn().mockResolvedValue({ ok: true, value: { ...SITE, contents: [item] } }) });
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    const dialog = await inspect(user);
    expect(within(dialog).queryByRole("button", { name: "Rendered preview" })).not.toBeInTheDocument();
  });

  it("ignores an old backend catalog and does not request content when disconnected", async () => {
    const old = deferred<OperationResult<WebsiteCatalogPage>>();
    const api = installAPI({ listWebsites: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ ok: true, value: catalog([{ ...SITE.site, name: "current" }]) }) });
    const { rerender } = render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await waitFor(() => expect(api.listWebsites).toHaveBeenCalledOnce());
    rerender(<WebsitesPage snapshot={connectedSnapshot(2)} />);
    await screen.findByRole("button", { name: /current/ });
    await act(async () => { old.resolve({ ok: true, value: catalog([{ ...SITE.site, name: "stale" }]) }); });
    expect(screen.queryByRole("button", { name: /stale/ })).not.toBeInTheDocument();
    rerender(<WebsitesPage snapshot={disconnectedSnapshot()} />);
    expect(await screen.findByText("Connect to a server")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create website" })).toBeDisabled();
    expect(api.getWebsiteContent).not.toHaveBeenCalled();
  });

  it("wipes late preview bytes after switching backends and ignores a late mutation result", async () => {
    const user = userEvent.setup();
    const latePreview = deferred<OperationResult<WebsiteContentDetail>>();
    const lateWrite = deferred<OperationResult<WebsiteDetail>>();
    const api = installAPI({
      listWebsites: vi.fn().mockResolvedValue({ ok: true, value: catalog([SITE.site, { ...SITE.site, id: "site-2", name: "other" }]) }),
      getWebsiteContent: vi.fn().mockReturnValue(latePreview.promise),
      saveWebsiteText: vi.fn().mockReturnValue(lateWrite.promise),
    });
    const { rerender } = render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await inspect(user);
    rerender(<WebsitesPage snapshot={connectedSnapshot(2)} />);
    const bytes = contentDetail();
    await act(async () => { latePreview.resolve({ ok: true, value: bytes }); });
    expect([...bytes.preview]).toEqual(Array(bytes.preview.byteLength).fill(0));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await screen.findByRole("button", { name: "Inspect /index.html" });
    await user.click(screen.getByRole("button", { name: "Add text" }));
    const editor = await screen.findByRole("dialog", { name: "Add text content" });
    fireEvent.change(within(editor).getByLabelText("URL path"), { target: { value: "/fresh" } });
    fireEvent.change(within(editor).getByLabelText("Content source"), { target: { value: "Fresh" } });
    await user.click(within(editor).getByRole("button", { name: "Save content" }));
    await waitFor(() => expect(api.saveWebsiteText).toHaveBeenCalledOnce());
    rerender(<WebsitesPage snapshot={connectedSnapshot(3)} />);
    await act(async () => { lateWrite.resolve({ ok: true, value: { ...SITE, site: { ...SITE.site, name: "stale-write" } } }); });
    expect(screen.queryByText("stale-write")).not.toBeInTheDocument();
    expect(screen.queryByText("Website content saved.")).not.toBeInTheDocument();
  });

  it("ignores stale content metadata after selecting another website", async () => {
    const user = userEvent.setup();
    const staleDetail = deferred<OperationResult<WebsiteDetail>>();
    const current = { ...SITE, site: { ...SITE.site, id: "site-2", name: "other" }, contents: [{ ...ITEM, path: "/current.html" }] };
    const api = installAPI({
      listWebsites: vi.fn().mockResolvedValue({ ok: true, value: catalog([SITE.site, current.site]) }),
      getWebsite: vi.fn().mockReturnValueOnce(staleDetail.promise).mockResolvedValue({ ok: true, value: current }),
    });
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await waitFor(() => expect(api.getWebsite).toHaveBeenCalledWith({ name: "public" }));
    await user.click(screen.getByRole("button", { name: /other/ }));
    await screen.findByRole("button", { name: "Inspect /current.html" });
    await act(async () => { staleDetail.resolve({ ok: true, value: SITE }); });
    expect(screen.queryByRole("button", { name: "Inspect /index.html" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inspect /current.html" })).toBeInTheDocument();
  });

  it("keeps the native import form available when its picker is canceled", async () => {
    const user = userEvent.setup();
    const api = installAPI({ importWebsiteFiles: vi.fn().mockResolvedValue({ ok: false, error: "Website import canceled" }) });
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await screen.findByRole("button", { name: "Inspect /index.html" });
    await user.click(screen.getByRole("button", { name: "Add local file" }));
    const dialog = await screen.findByRole("dialog", { name: "Add local file" });
    await user.type(within(dialog).getByLabelText("URL path"), "/new.bin");
    await user.click(within(dialog).getByRole("button", { name: "Choose file and upload" }));
    await waitFor(() => expect(api.importWebsiteFiles).toHaveBeenCalledOnce());
    expect(within(dialog).getByLabelText("URL path")).toHaveValue("/new.bin");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Choose file and upload" })).toBeEnabled();
  });

  it("refreshes metadata and clears previews after external website events", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    const snapshot = connectedSnapshot();
    const { rerender } = render(<WebsitesPage snapshot={snapshot} />);
    await inspect(user);
    rerender(<WebsitesPage snapshot={{ ...snapshot, recentEvents: [{ id: "website-event", type: "website", message: "Changed", at: new Date().toISOString(), isError: false }] }} />);
    await waitFor(() => expect(api.listWebsites).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.getWebsite).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
