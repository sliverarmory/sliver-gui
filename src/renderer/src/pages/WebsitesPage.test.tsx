import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type { OperationResult, SliverDesktopAPI, SliverSnapshot } from "../../../shared/contracts";
import { WEBSITE_LIMITS, type ListWebsitesInput, type WebsiteCatalogPage, type WebsiteContentDetail, type WebsiteContentSummary, type WebsiteDetail } from "../../../shared/website-contracts";
import { renderWithApplicationContextMenu as render, type ApplicationContextMenuTestRender } from "../application-context-menu-test-utils";
import { WebsitesPage } from "./WebsitesPage";

vi.mock("../components/WebsiteSourceEditor", () => ({
  WebsiteSourceEditor: ({ text, ariaLabel }: { text: string; ariaLabel: string }) => <pre aria-label={ariaLabel}>{text}</pre>,
}));

const SOURCE = '<h1>Welcome</h1><script>window.alert("unsafe")</script>';
const ITEM: WebsiteContentSummary = { id: "content-1", path: "/index.html", contentType: "text/html", sizeBytes: String(SOURCE.length), sha256: "a".repeat(64), originalFile: "index.html" };
const SITE: WebsiteDetail = { site: { id: "site-1", name: "public", contentCount: 1, totalSizeBytes: ITEM.sizeBytes }, contents: [ITEM], truncated: false };
const OTHER_SITE: WebsiteDetail = { ...SITE, site: { ...SITE.site, id: "site-2", name: "other" }, contents: [{ ...ITEM, path: "/other.html" }] };
const HOSTED_PREVIEW = { name: "public", path: "/welcome.html", origin: "http://127.0.0.1:41234", url: "http://127.0.0.1:41234/welcome.html" };

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
    stopWebsiteRenderedPreview: vi.fn().mockResolvedValue({ ok: true }),
    openWebsiteTextEditor: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
  Object.defineProperty(window, "sliver", { configurable: true, value: api });
  return api;
}
function installWebsiteChoices(overrides: Partial<SliverDesktopAPI> = {}) {
  return installAPI({
    listWebsites: vi.fn().mockResolvedValue({ ok: true, value: catalog([SITE.site, OTHER_SITE.site]) }),
    getWebsite: vi.fn().mockImplementation(async ({ name }: { name: string }) => ({ ok: true, value: name === "other" ? OTHER_SITE : SITE })),
    ...overrides,
  });
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
async function openLocalPreview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Local preview" }));
  return screen.findByRole("dialog", { name: "Local preview" });
}
async function closeLocalPreview(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!);
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
}
async function chooseLocalPreview(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, name: string) {
  const select = within(dialog).getByRole("button", { name: /Preview website/i });
  await waitFor(() => expect(select).toBeEnabled());
  await user.click(select);
  await user.click(await screen.findByRole("option", { name }));
  return select;
}
async function openWebsiteContextMenu(view: ApplicationContextMenuTestRender, name: RegExp) {
  const selection = screen.getByRole("region", { name: "Website selection" });
  fireEvent.contextMenu(await within(selection).findByRole("button", { name }));
  view.contextMenu.emit();
  return screen.findByRole("menu", { name: "Application context menu" });
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

  it("creates a site and opens a standalone editor with new content metadata", async () => {
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
    expect(within(addDialog).queryByLabelText("Content source")).not.toBeInTheDocument();
    await user.click(within(addDialog).getByRole("button", { name: "Open editor" }));
    await waitFor(() => expect(api.openWebsiteTextEditor).toHaveBeenCalledExactlyOnceWith({ name: "new-site", path: "/new.html", contentType: "text/html; charset=utf-8", mode: "create" }));
    expect(api.saveWebsiteText).not.toHaveBeenCalled();
    await waitFor(() => expect(addDialog).not.toBeInTheDocument());
  });

  it("opens the standalone editor from inspection and clears source bytes", async () => {
    const user = userEvent.setup();
    const detail = contentDetail();
    const api = installAPI({ getWebsiteContent: vi.fn().mockResolvedValue({ ok: true, value: detail }) });
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    const previewDialog = await inspect(user);
    await waitFor(() => expect(within(previewDialog).getByRole("button", { name: "Edit text" })).toBeEnabled());
    await user.click(within(previewDialog).getByRole("button", { name: "Edit text" }));
    await waitFor(() => expect(api.openWebsiteTextEditor).toHaveBeenCalledExactlyOnceWith({ name: "public", path: "/index.html", mode: "edit" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect([...detail.preview]).toEqual(Array(detail.preview.byteLength).fill(0));
    expect(api.saveWebsiteText).not.toHaveBeenCalled();
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
    await user.click(await screen.findByRole("button", { name: "Actions for /index.html" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
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

  it("previews the right-clicked website without changing the editing selection", async () => {
    const user = userEvent.setup();
    const api = installWebsiteChoices();
    const view = render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await screen.findByRole("button", { name: "Inspect /index.html" });
    const menu = await openWebsiteContextMenu(view, /other/);
    const preview = within(menu).getByRole("menuitem", { name: "Preview website" });
    expect(preview.querySelector("svg[data-icon='eye']")).not.toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Delete website" }).querySelector("svg[data-icon='trash']")).not.toBeNull();
    expect(api.openWebsiteRenderedPreview).not.toHaveBeenCalled();
    await user.click(preview);
    await waitFor(() => expect(api.getWebsite).toHaveBeenCalledWith({ name: "other" }));
    await waitFor(() => expect(api.openWebsiteRenderedPreview).toHaveBeenCalledExactlyOnceWith({ name: "other", path: "/other.html" }));
    const selection = screen.getByRole("region", { name: "Website selection" });
    expect(within(selection).getByRole("button", { name: /public/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(selection).getByRole("button", { name: /other/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Inspect /index.html" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inspect /other.html" })).not.toBeInTheDocument();
    expect(api.getWebsiteContent).not.toHaveBeenCalled();
  });

  it("reopens the hosted website from its context menu while another website is selected", async () => {
    const user = userEvent.setup();
    const api = installWebsiteChoices();
    const view = render(<WebsitesPage snapshot={{ ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW }} />);
    await screen.findByRole("button", { name: "Inspect /index.html" });
    await user.click(await screen.findByRole("button", { name: /other/ }));
    await screen.findByRole("button", { name: "Inspect /other.html" });
    const menu = await openWebsiteContextMenu(view, /public/);
    await user.click(within(menu).getByRole("menuitem", { name: "Preview website" }));
    await waitFor(() => expect(api.openWebsiteRenderedPreview).toHaveBeenCalledExactlyOnceWith({ name: "public", path: "/index.html" }));
    expect(api.getWebsite).toHaveBeenLastCalledWith({ name: "public" });
    expect(within(screen.getByRole("region", { name: "Website selection" })).getByRole("button", { name: /other/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Inspect /other.html" })).toBeInTheDocument();
  });

  it("offers Stop preview server only on the currently hosted website", async () => {
    const user = userEvent.setup();
    installWebsiteChoices();
    const snapshot = { ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW };
    const view = render(<WebsitesPage snapshot={snapshot} />);
    let menu = await openWebsiteContextMenu(view, /public/);
    expect(within(menu).getByRole("menuitem", { name: "Stop preview server" }).querySelector("svg[data-icon='stop']")).not.toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(menu).not.toBeInTheDocument());
    menu = await openWebsiteContextMenu(view, /other/);
    expect(within(menu).queryByRole("menuitem", { name: "Stop preview server" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(menu).not.toBeInTheDocument());
    view.rerender(<WebsitesPage snapshot={{ ...snapshot, websitePreview: null }} />);
    menu = await openWebsiteContextMenu(view, /public/);
    expect(within(menu).queryByRole("menuitem", { name: "Stop preview server" })).not.toBeInTheDocument();
  });

  it("stops the right-clicked preview once without deleting it or changing the editing selection", async () => {
    const user = userEvent.setup();
    const stopping = deferred<OperationResult>();
    const api = installWebsiteChoices({ stopWebsiteRenderedPreview: vi.fn().mockReturnValue(stopping.promise) });
    const snapshot = { ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW };
    const view = render(<WebsitesPage snapshot={snapshot} />);
    await user.click(await screen.findByRole("button", { name: /other/ }));
    await screen.findByRole("button", { name: "Inspect /other.html" });
    let menu = await openWebsiteContextMenu(view, /public/);
    view.rerender(<WebsitesPage snapshot={{ ...snapshot, websitePreview: { ...HOSTED_PREVIEW } }} />);
    await user.click(within(menu).getByRole("menuitem", { name: "Stop preview server" }));
    await waitFor(() => expect(api.stopWebsiteRenderedPreview).toHaveBeenCalledExactlyOnceWith());
    menu = await openWebsiteContextMenu(view, /public/);
    const stop = within(menu).getByRole("menuitem", { name: "Stop preview server" });
    expect(stop).toHaveAttribute("aria-disabled", "true");
    await user.click(stop);
    expect(api.stopWebsiteRenderedPreview).toHaveBeenCalledOnce();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(menu).not.toBeInTheDocument());
    await act(async () => { stopping.resolve({ ok: true }); });
    view.rerender(<WebsitesPage snapshot={{ ...snapshot, websitePreview: null }} />);
    expect(screen.getByRole("button", { name: "Local preview" })).toHaveAccessibleDescription("Preview server stopped");
    const selection = screen.getByRole("region", { name: "Website selection" });
    expect(within(selection).getByRole("button", { name: /other/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(selection).getByRole("button", { name: /public/ })).toHaveAttribute("aria-pressed", "false");
    expect(within(selection).getByRole("button", { name: /public/ })).not.toHaveTextContent("Previewing");
    expect(screen.getByRole("button", { name: "Inspect /other.html" })).toBeInTheDocument();
    expect(api.deleteWebsite).not.toHaveBeenCalled();
    expect(api.openWebsiteRenderedPreview).not.toHaveBeenCalled();
  });

  it("can stop from the website context menu while opening the browser", async () => {
    const user = userEvent.setup();
    const opening = deferred<OperationResult>();
    const api = installWebsiteChoices({ openWebsiteRenderedPreview: vi.fn().mockReturnValue(opening.promise) });
    const snapshot = { ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW };
    const view = render(<WebsitesPage snapshot={snapshot} />);
    const preview = await screen.findByRole("button", { name: "Open preview" });
    await waitFor(() => expect(preview).toBeEnabled());
    await user.click(preview);
    const menu = await openWebsiteContextMenu(view, /public/);
    const stop = within(menu).getByRole("menuitem", { name: "Stop preview server" });
    expect(stop).not.toHaveAttribute("aria-disabled", "true");
    await user.click(stop);
    await waitFor(() => expect(api.stopWebsiteRenderedPreview).toHaveBeenCalledExactlyOnceWith());
    view.rerender(<WebsitesPage snapshot={{ ...snapshot, websitePreview: null }} />);
    await act(async () => { opening.resolve({ ok: false, error: "Opening was canceled" }); });
    expect(screen.queryByText("Opening was canceled")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Local preview" })).toHaveAccessibleDescription("Preview server stopped");
  });

  it("shows context-menu stop failures and allows retrying the same hosted website", async () => {
    const user = userEvent.setup();
    const api = installWebsiteChoices({ stopWebsiteRenderedPreview: vi.fn().mockResolvedValueOnce({ ok: false, error: "The preview server could not be stopped" }).mockResolvedValue({ ok: true }) });
    const view = render(<WebsitesPage snapshot={{ ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW }} />);
    let menu = await openWebsiteContextMenu(view, /public/);
    await user.click(within(menu).getByRole("menuitem", { name: "Stop preview server" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The preview server could not be stopped");
    expect(screen.getByRole("button", { name: "Local preview" })).toHaveAccessibleDescription("Hosting public");
    menu = await openWebsiteContextMenu(view, /public/);
    const stop = within(menu).getByRole("menuitem", { name: "Stop preview server" });
    expect(stop).not.toHaveAttribute("aria-disabled", "true");
    await user.click(stop);
    await waitFor(() => expect(api.stopWebsiteRenderedPreview).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["another website", "replacement listener", "stopped preview", "another backend"])("ignores a stale context-menu Stop action after switching to %s", async (transition) => {
    const user = userEvent.setup();
    const api = installWebsiteChoices();
    const snapshot = { ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW };
    const view = render(<WebsitesPage snapshot={snapshot} />);
    const menu = await openWebsiteContextMenu(view, /public/);
    const stop = within(menu).getByRole("menuitem", { name: "Stop preview server" });
    const nextPreview = transition === "another website" ? { ...HOSTED_PREVIEW, name: "other" }
      : transition === "replacement listener" ? { ...HOSTED_PREVIEW, origin: "http://127.0.0.1:41235", url: "http://127.0.0.1:41235/welcome.html" }
      : transition === "stopped preview" ? null : HOSTED_PREVIEW;
    view.rerender(<WebsitesPage snapshot={{ ...connectedSnapshot(transition === "another backend" ? 2 : 1), websitePreview: nextPreview }} />);
    await user.click(stop);
    await waitFor(() => expect(menu).not.toBeInTheDocument());
    expect(api.stopWebsiteRenderedPreview).not.toHaveBeenCalled();
    expect(api.deleteWebsite).not.toHaveBeenCalled();
  });

  it("confirms deletion of the right-clicked website and preserves the other editing selection", async () => {
    const user = userEvent.setup();
    let deleted = false;
    const api = installWebsiteChoices({
      listWebsites: vi.fn().mockImplementation(async () => ({ ok: true, value: catalog(deleted ? [SITE.site] : [SITE.site, OTHER_SITE.site]) })),
      deleteWebsite: vi.fn().mockImplementation(async () => { deleted = true; return { ok: true }; }),
    });
    const view = render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await screen.findByRole("button", { name: "Inspect /index.html" });
    let menu = await openWebsiteContextMenu(view, /other/);
    await user.click(within(menu).getByRole("menuitem", { name: "Delete website" }));
    let confirmation = await screen.findByRole("alertdialog", { name: "Delete website?" });
    expect(confirmation).toHaveTextContent("Delete other and all its hosted content?");
    expect(api.deleteWebsite).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    expect(api.deleteWebsite).not.toHaveBeenCalled();
    expect(within(screen.getByRole("region", { name: "Website selection" })).getByRole("button", { name: /public/ })).toHaveAttribute("aria-pressed", "true");
    menu = await openWebsiteContextMenu(view, /other/);
    await user.click(within(menu).getByRole("menuitem", { name: "Delete website" }));
    confirmation = await screen.findByRole("alertdialog", { name: "Delete website?" });
    await user.click(within(confirmation).getByRole("button", { name: "Delete website" }));
    await waitFor(() => expect(api.deleteWebsite).toHaveBeenCalledExactlyOnceWith({ name: "other" }));
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    const selection = screen.getByRole("region", { name: "Website selection" });
    await waitFor(() => expect(within(selection).queryByRole("button", { name: /other/ })).not.toBeInTheDocument());
    expect(within(selection).getByRole("button", { name: /public/ })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("button", { name: "Inspect /index.html" })).toBeInTheDocument();
    expect(api.getWebsite).not.toHaveBeenCalledWith({ name: "other" });
  });

  it("disables context-menu previews for websites without content", async () => {
    const user = userEvent.setup();
    const api = installWebsiteChoices({ listWebsites: vi.fn().mockResolvedValue({ ok: true, value: catalog([SITE.site, { ...OTHER_SITE.site, contentCount: 0, totalSizeBytes: "0" }]) }) });
    const view = render(<WebsitesPage snapshot={connectedSnapshot()} />);
    const menu = await openWebsiteContextMenu(view, /other/);
    const preview = within(menu).getByRole("menuitem", { name: "Preview website" });
    expect(preview).toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitem", { name: "Delete website" })).not.toHaveAttribute("aria-disabled", "true");
    await user.click(preview);
    expect(api.openWebsiteRenderedPreview).not.toHaveBeenCalled();
    expect(api.getWebsite).not.toHaveBeenCalledWith({ name: "other" });
  });

  it("disables context-menu previews while a browser request is pending", async () => {
    const user = userEvent.setup();
    const opening = deferred<OperationResult>();
    const api = installWebsiteChoices({ openWebsiteRenderedPreview: vi.fn().mockReturnValue(opening.promise) });
    const view = render(<WebsitesPage snapshot={connectedSnapshot()} />);
    const preview = await screen.findByRole("button", { name: "Preview website" });
    await waitFor(() => expect(preview).toBeEnabled());
    await user.click(preview);
    const menu = await openWebsiteContextMenu(view, /other/);
    const menuPreview = within(menu).getByRole("menuitem", { name: "Preview website" });
    expect(menuPreview).toHaveAttribute("aria-disabled", "true");
    await user.click(menuPreview);
    expect(api.openWebsiteRenderedPreview).toHaveBeenCalledOnce();
    expect(api.getWebsite).not.toHaveBeenCalledWith({ name: "other" });
    await act(async () => { opening.resolve({ ok: true }); });
  });

  it("does not retain website actions when right-clicking outside the website selector", async () => {
    const user = userEvent.setup();
    installWebsiteChoices();
    const view = render(<WebsitesPage snapshot={connectedSnapshot()} />);
    const menu = await openWebsiteContextMenu(view, /other/);
    expect(within(menu).getByRole("menuitem", { name: "Preview website" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(menu).not.toBeInTheDocument());
    fireEvent.contextMenu(screen.getByRole("heading", { name: "Websites", level: 1 }));
    view.contextMenu.emit();
    const backgroundMenu = await screen.findByRole("menu", { name: "Application context menu" });
    expect(within(backgroundMenu).queryByRole("menuitem", { name: "Preview website" })).not.toBeInTheDocument();
    expect(within(backgroundMenu).queryByRole("menuitem", { name: "Delete website" })).not.toBeInTheDocument();
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

  it("opens browser previews through the native boundary without sending renderer bytes", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    const dialog = await inspect(user);
    await user.click(within(dialog).getByRole("button", { name: "Preview in browser" }));
    await waitFor(() => expect(api.openWebsiteRenderedPreview).toHaveBeenCalledExactlyOnceWith({ name: "public", path: "/index.html" }));
    expect(dialog.querySelector("iframe, webview, img, object, embed")).toBeNull();
    expect(within(dialog).getByText(/default browser/)).toBeInTheDocument();
  });

  it.each(["image/svg+xml", "application/pdf", "application/octet-stream"])("offers direct browser preview for %s without opening the modal", async (contentType) => {
    const user = userEvent.setup();
    const item = { ...ITEM, contentType };
    const api = installAPI({ getWebsite: vi.fn().mockResolvedValue({ ok: true, value: { ...SITE, contents: [item] } }) });
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await user.click(await screen.findByRole("button", { name: "Preview /index.html" }));
    await waitFor(() => expect(api.openWebsiteRenderedPreview).toHaveBeenCalledExactlyOnceWith({ name: "public", path: "/index.html" }));
    expect(api.getWebsiteContent).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each<{
    description: string;
    entries: Array<[path: string, contentType: string]>;
    expectedPath: string;
  }>([
    {
      description: "the root path before index files and other HTML",
      entries: [["/welcome.html", "text/html"], ["/index.htm", "text/html"], ["/index.html", "text/html"], ["/", "text/html"]],
      expectedPath: "/",
    },
    {
      description: "index.html before index.htm and other HTML",
      entries: [["/welcome.html", "text/html"], ["/index.htm", "text/html"], ["/index.html", "text/html"]],
      expectedPath: "/index.html",
    },
    {
      description: "index.htm before other HTML",
      entries: [["/welcome.html", "text/html"], ["/index.htm", "text/html"]],
      expectedPath: "/index.htm",
    },
    {
      description: "the first HTML document when no root or index exists",
      entries: [["/logo.png", "image/png"], ["/welcome", "Text/HTML; charset=utf-8"], ["/later.html", "text/html"]],
      expectedPath: "/welcome",
    },
    {
      description: "an XHTML document when no root or index exists",
      entries: [["/logo.png", "image/png"], ["/welcome.xhtml", "application/xhtml+xml; charset=utf-8"]],
      expectedPath: "/welcome.xhtml",
    },
    {
      description: "the first content item when no HTML exists",
      entries: [["/guide.pdf", "application/pdf"], ["/logo.png", "image/png"]],
      expectedPath: "/guide.pdf",
    },
  ])("previews the website using $description", async ({ entries, expectedPath }) => {
    const user = userEvent.setup();
    const contents = entries.map(([path, contentType], index) => ({ ...ITEM, id: `entry-${index}`, path, contentType }));
    const api = installAPI({ getWebsite: vi.fn().mockResolvedValue({ ok: true, value: { ...SITE, contents } }) });
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    const button = await screen.findByRole("button", { name: "Preview website" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await waitFor(() => expect(api.openWebsiteRenderedPreview).toHaveBeenCalledExactlyOnceWith({ name: "public", path: expectedPath }));
    expect(api.getWebsiteContent).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disables website preview when the selected website has no content", async () => {
    const user = userEvent.setup();
    const api = installAPI({ getWebsite: vi.fn().mockResolvedValue({ ok: true, value: { ...SITE, contents: [] } }) });
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await screen.findByText("No content yet");
    const button = screen.getByRole("button", { name: "Preview website" });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(api.openWebsiteRenderedPreview).not.toHaveBeenCalled();
  });

  it("disables website preview while metadata loads or refreshes before choosing its current entry", async () => {
    const user = userEvent.setup();
    const initial = deferred<OperationResult<WebsiteDetail>>();
    const refresh = deferred<OperationResult<WebsiteDetail>>();
    const api = installAPI({ getWebsite: vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(refresh.promise) });
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    const button = await screen.findByRole("button", { name: "Preview website" });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(api.openWebsiteRenderedPreview).not.toHaveBeenCalled();
    await act(async () => { initial.resolve({ ok: true, value: SITE }); });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.getWebsite).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Preview website" })).toBeDisabled();
    expect(api.openWebsiteRenderedPreview).not.toHaveBeenCalled();
    await act(async () => { refresh.resolve({ ok: true, value: { ...SITE, contents: [{ ...ITEM, path: "/" }] } }); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview website" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Preview website" }));
    await waitFor(() => expect(api.openWebsiteRenderedPreview).toHaveBeenCalledExactlyOnceWith({ name: "public", path: "/" }));
  });

  it("disables website preview while another browser preview request is pending", async () => {
    const user = userEvent.setup();
    const opening = deferred<OperationResult>();
    const api = installAPI({ openWebsiteRenderedPreview: vi.fn().mockReturnValue(opening.promise) });
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    const button = await screen.findByRole("button", { name: "Preview website" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(button).toBeDisabled();
    await user.click(button);
    expect(api.openWebsiteRenderedPreview).toHaveBeenCalledOnce();
    await act(async () => { opening.resolve({ ok: true }); });
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("keeps preview controls in a closed dialog and closing it leaves the server running", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    render(<WebsitesPage snapshot={{ ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW }} />);
    const trigger = screen.getByRole("button", { name: "Local preview" });
    expect(trigger).toHaveAccessibleDescription("Hosting public");
    expect(trigger.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(screen.queryByRole("dialog", { name: "Local preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop server" })).not.toBeInTheDocument();
    const server = await openLocalPreview(user);
    expect(within(server).getByText("Running")).toBeInTheDocument();
    expect(within(server).getByRole("button", { name: "Stop server" }).querySelector("svg[aria-hidden='true']")).not.toBeNull();
    await closeLocalPreview(user, server);
    expect(api.stopWebsiteRenderedPreview).not.toHaveBeenCalled();
    expect(trigger).toHaveAccessibleDescription("Hosting public");
    expect(await openLocalPreview(user)).toHaveTextContent("Hosting public");
  });

  it("starts a preview when a website is selected in the stopped preview dialog", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await screen.findByRole("button", { name: "Inspect /index.html" });
    expect(screen.getByRole("button", { name: "Local preview" })).toHaveAccessibleDescription("Preview server stopped");
    const server = await openLocalPreview(user);
    expect(within(server).getByText("Stopped")).toBeInTheDocument();
    expect(within(server).getByRole("button", { name: /Preview website/i })).toHaveTextContent("Choose a website");
    await chooseLocalPreview(user, server, "public");
    await waitFor(() => expect(api.openWebsiteRenderedPreview).toHaveBeenCalledExactlyOnceWith({ name: "public", path: "/index.html" }));
  });

  it("switches the hosted website through its dropdown without changing the content selection", async () => {
    const user = userEvent.setup();
    const api = installWebsiteChoices();
    const snapshot = { ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW };
    const { rerender } = render(<WebsitesPage snapshot={snapshot} />);
    const selection = screen.getByRole("region", { name: "Website selection" });
    await screen.findByRole("button", { name: "Inspect /index.html" });
    const server = await openLocalPreview(user);
    expect(within(server).getByText("Running")).toBeInTheDocument();
    expect(server).toHaveTextContent("Hosting public");
    expect(within(server).getByText(HOSTED_PREVIEW.url)).toBeInTheDocument();
    expect(within(server).getByRole("button", { name: /Preview website/i })).toHaveTextContent("public");
    const select = await chooseLocalPreview(user, server, "other");
    await waitFor(() => expect(api.getWebsite).toHaveBeenCalledWith({ name: "other" }));
    await waitFor(() => expect(api.openWebsiteRenderedPreview).toHaveBeenCalledExactlyOnceWith({ name: "other", path: "/other.html" }));
    expect(server).toHaveTextContent("Hosting public");
    expect(select).toHaveTextContent("public");
    expect(api.getWebsiteContent).not.toHaveBeenCalled();
    rerender(<WebsitesPage snapshot={{ ...snapshot, websitePreview: { ...HOSTED_PREVIEW, name: "other", path: "/other.html", url: `${HOSTED_PREVIEW.origin}/other.html` } }} />);
    expect(server).toHaveTextContent("Hosting other");
    expect(select).toHaveTextContent("other");
    expect(within(server).getByText(`${HOSTED_PREVIEW.origin}/other.html`)).toBeInTheDocument();
    await closeLocalPreview(user, server);
    expect(within(selection).getByRole("button", { name: /other/ })).toHaveTextContent("Previewing");
    expect(within(selection).getByRole("button", { name: /other/ })).toHaveAttribute("aria-pressed", "false");
    expect(within(selection).getByRole("button", { name: /public/ })).not.toHaveTextContent("Previewing");
    expect(within(selection).getByRole("button", { name: /public/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Inspect /index.html" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inspect /other.html" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview website" })).toBeEnabled();
  });

  it("lists all unfiltered website pages in the preview dropdown and disables empty websites", async () => {
    const user = userEvent.setup();
    const secondPage = deferred<OperationResult<WebsiteCatalogPage>>();
    const empty = { ...SITE.site, id: "empty-site", name: "empty", contentCount: 0, totalSizeBytes: "0" };
    const api = installWebsiteChoices({
      listWebsites: vi.fn().mockImplementation(async (input: ListWebsitesInput) => {
        if (input.limit !== WEBSITE_LIMITS.maxPageSize) return { ok: true, value: catalog() };
        if (input.cursor === "preview-page-2") return secondPage.promise;
        return { ok: true, value: { items: [SITE.site], page: { total: 3, limit: WEBSITE_LIMITS.maxPageSize, truncated: false, nextCursor: "preview-page-2" } } };
      }),
    });
    render(<WebsitesPage snapshot={{ ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW }} />);
    await screen.findByRole("button", { name: "Inspect /index.html" });
    await user.type(screen.getByRole("searchbox", { name: "Search websites" }), "public");
    await waitFor(() => expect(api.listWebsites).toHaveBeenCalledWith({ query: "public", limit: WEBSITE_LIMITS.pageSize }));
    const server = await openLocalPreview(user);
    await waitFor(() => expect(api.listWebsites).toHaveBeenCalledWith(expect.objectContaining({ limit: WEBSITE_LIMITS.maxPageSize, cursor: "preview-page-2" })));
    const select = within(server).getByRole("button", { name: /Preview website/i });
    expect(select).toBeDisabled();
    expect(select).toHaveTextContent("public");
    const previewCalls = vi.mocked(api.listWebsites).mock.calls.filter(([input]) => input.limit === WEBSITE_LIMITS.maxPageSize);
    expect(previewCalls).toHaveLength(2);
    expect(previewCalls.every(([input]) => !input.query)).toBe(true);
    await act(async () => { secondPage.resolve({ ok: true, value: catalog([OTHER_SITE.site, empty]) }); });
    await waitFor(() => expect(select).toBeEnabled());
    await user.click(select);
    expect(screen.getByRole("option", { name: "public" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "other" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^empty/ })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("option", { name: /^empty/ }));
    expect(api.openWebsiteRenderedPreview).not.toHaveBeenCalled();
    await user.click(screen.getByRole("option", { name: "other" }));
    await waitFor(() => expect(api.openWebsiteRenderedPreview).toHaveBeenCalledExactlyOnceWith({ name: "other", path: "/other.html" }));
    await closeLocalPreview(user, server);
    expect(screen.getByRole("searchbox", { name: "Search websites" })).toHaveValue("public");
    const selection = screen.getByRole("region", { name: "Website selection" });
    expect(within(selection).getByRole("button", { name: /public/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(selection).queryByRole("button", { name: /other/ })).not.toBeInTheDocument();
    expect(api.getWebsiteContent).not.toHaveBeenCalled();
  });

  it("retains the hosted dropdown value and status if switching websites fails", async () => {
    const user = userEvent.setup();
    const api = installWebsiteChoices({ openWebsiteRenderedPreview: vi.fn().mockResolvedValue({ ok: false, error: "Could not switch the preview website" }) });
    render(<WebsitesPage snapshot={{ ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW }} />);
    const server = await openLocalPreview(user);
    const select = await chooseLocalPreview(user, server, "other");
    expect(await within(server).findByRole("alert")).toHaveTextContent("Could not switch the preview website");
    expect(api.openWebsiteRenderedPreview).toHaveBeenCalledExactlyOnceWith({ name: "other", path: "/other.html" });
    expect(select).toHaveTextContent("public");
    expect(select).toBeEnabled();
    expect(server).toHaveTextContent("Hosting public");
    expect(within(server).getByText(HOSTED_PREVIEW.url)).toBeInTheDocument();
    expect(within(server).getByRole("button", { name: "Stop server" })).toBeEnabled();
  });

  it.each([
    { failure: "request", error: "Website list unavailable" },
    { failure: "incomplete", error: "The server returned an incomplete website list." },
    { failure: "repeated cursor", error: "The server returned a repeated website page." },
  ])("keeps the hosted website visible and retries a $failure catalog failure", async ({ failure, error }) => {
    const user = userEvent.setup();
    let recovered = false;
    let previewRequests = 0;
    const api = installWebsiteChoices({
      listWebsites: vi.fn().mockImplementation(async (input: ListWebsitesInput) => {
        if (input.limit !== WEBSITE_LIMITS.maxPageSize) return { ok: true, value: catalog() };
        previewRequests += 1;
        if (recovered) return { ok: true, value: catalog([OTHER_SITE.site]) };
        if (failure === "request") return { ok: false, error };
        return { ok: true, value: { items: [SITE.site], page: { total: 2, limit: WEBSITE_LIMITS.maxPageSize, truncated: failure === "incomplete", ...(failure === "repeated cursor" ? { nextCursor: "repeated" } : {}) } } };
      }),
    });
    render(<WebsitesPage snapshot={{ ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW }} />);
    const server = await openLocalPreview(user);
    expect(await within(server).findByRole("alert")).toHaveTextContent(error);
    const select = within(server).getByRole("button", { name: /Preview website/i });
    expect(select).toHaveTextContent("public");
    expect(select).toBeDisabled();
    expect(server).toHaveTextContent("Hosting public");
    expect(within(server).getByRole("button", { name: "Stop server" })).toBeEnabled();
    expect(previewRequests).toBe(failure === "repeated cursor" ? 2 : 1);
    recovered = true;
    await user.click(within(server).getByRole("button", { name: "Retry website list" }));
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveTextContent("public");
    expect(within(server).queryByRole("alert")).not.toBeInTheDocument();
    await chooseLocalPreview(user, server, "other");
    await waitFor(() => expect(api.openWebsiteRenderedPreview).toHaveBeenCalledExactlyOnceWith({ name: "other", path: "/other.html" }));
  });

  it("ignores an old preview dropdown catalog after switching backends", async () => {
    const user = userEvent.setup();
    const oldCatalog = deferred<OperationResult<WebsiteCatalogPage>>();
    let previewRequests = 0;
    installWebsiteChoices({
      listWebsites: vi.fn().mockImplementation(async (input: ListWebsitesInput) => {
        if (input.limit !== WEBSITE_LIMITS.maxPageSize) return { ok: true, value: catalog() };
        previewRequests += 1;
        return previewRequests === 1 ? oldCatalog.promise : { ok: true, value: catalog([OTHER_SITE.site]) };
      }),
    });
    const { rerender } = render(<WebsitesPage snapshot={{ ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW }} />);
    const server = await openLocalPreview(user);
    await waitFor(() => expect(previewRequests).toBe(1));
    expect(within(server).getByRole("button", { name: /Preview website/i })).toHaveTextContent("public");
    rerender(<WebsitesPage snapshot={connectedSnapshot(2)} />);
    await waitFor(() => expect(previewRequests).toBe(2));
    const select = within(server).getByRole("button", { name: /Preview website/i });
    await waitFor(() => expect(select).toBeEnabled());
    await act(async () => { oldCatalog.resolve({ ok: true, value: catalog([{ ...SITE.site, name: "stale" }]) }); });
    expect(select).toHaveTextContent("Choose a website");
    await user.click(select);
    expect(screen.getByRole("option", { name: "other" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "stale" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "public" })).not.toBeInTheDocument();
  });

  it("keeps the current server running when fresh website metadata has no content", async () => {
    const user = userEvent.setup();
    const api = installWebsiteChoices({
      getWebsite: vi.fn().mockImplementation(async ({ name }: { name: string }) => ({ ok: true, value: name === "other" ? { ...OTHER_SITE, contents: [] } : SITE })),
    });
    render(<WebsitesPage snapshot={{ ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW }} />);
    const server = await openLocalPreview(user);
    const select = await chooseLocalPreview(user, server, "other");
    expect(await within(server).findByRole("alert")).toHaveTextContent("This website has no content to preview.");
    expect(select).toHaveTextContent("public");
    expect(server).toHaveTextContent("Hosting public");
    expect(api.openWebsiteRenderedPreview).not.toHaveBeenCalled();
    expect(api.stopWebsiteRenderedPreview).not.toHaveBeenCalled();
  });

  it.each(["stop", "switch backend", "unmount"])("cancels pending dropdown metadata after %s", async (transition) => {
    const user = userEvent.setup();
    const metadata = deferred<OperationResult<WebsiteDetail>>();
    const api = installWebsiteChoices({
      getWebsite: vi.fn().mockImplementation(async ({ name }: { name: string }) => name === "other" ? metadata.promise : { ok: true, value: SITE }),
    });
    const snapshot = { ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW };
    const { rerender, unmount } = render(<WebsitesPage snapshot={snapshot} />);
    const server = await openLocalPreview(user);
    const select = await chooseLocalPreview(user, server, "other");
    await waitFor(() => expect(api.getWebsite).toHaveBeenCalledWith({ name: "other" }));
    expect(select).toBeDisabled();
    expect(within(server).getByRole("button", { name: "Stop server" })).toBeEnabled();
    if (transition === "stop") {
      await user.click(within(server).getByRole("button", { name: "Stop server" }));
      await waitFor(() => expect(api.stopWebsiteRenderedPreview).toHaveBeenCalledExactlyOnceWith());
      rerender(<WebsitesPage snapshot={{ ...snapshot, websitePreview: null }} />);
    } else if (transition === "switch backend") rerender(<WebsitesPage snapshot={connectedSnapshot(2)} />);
    else unmount();
    await act(async () => { metadata.resolve({ ok: true, value: OTHER_SITE }); });
    expect(api.openWebsiteRenderedPreview).not.toHaveBeenCalled();
    if (transition === "stop") {
      expect(within(server).getByText("Stopped")).toBeInTheDocument();
      expect(within(server).getByRole("button", { name: /Preview website/i })).toBeEnabled();
    }
  });

  it("reopens the running website and path in the browser while another website is selected", async () => {
    const user = userEvent.setup();
    const api = installWebsiteChoices();
    render(<WebsitesPage snapshot={{ ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW }} />);
    await user.click(await screen.findByRole("button", { name: /other/ }));
    await screen.findByRole("button", { name: "Inspect /other.html" });
    const server = await openLocalPreview(user);
    await user.click(within(server).getByRole("button", { name: "Open in browser" }));
    await waitFor(() => expect(api.openWebsiteRenderedPreview).toHaveBeenCalledExactlyOnceWith({ name: "public", path: "/welcome.html" }));
  });

  it.each(["another website", "an empty catalog"])("can stop the preview server with %s displayed", async (display) => {
    const user = userEvent.setup();
    const stopping = deferred<OperationResult>();
    const api = installAPI({
      listWebsites: vi.fn().mockResolvedValue({ ok: true, value: catalog(display === "another website" ? [OTHER_SITE.site] : []) }),
      getWebsite: vi.fn().mockResolvedValue({ ok: true, value: OTHER_SITE }),
      stopWebsiteRenderedPreview: vi.fn().mockReturnValue(stopping.promise),
    });
    const snapshot = { ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW };
    const { rerender } = render(<WebsitesPage snapshot={snapshot} />);
    if (display === "another website") await screen.findByRole("button", { name: "Inspect /other.html" });
    else await screen.findByText("No websites yet. Create one to add content.");
    const server = await openLocalPreview(user);
    await user.click(within(server).getByRole("button", { name: "Stop server" }));
    expect(api.stopWebsiteRenderedPreview).toHaveBeenCalledExactlyOnceWith();
    expect(within(server).getByRole("button", { name: "Stopping…" })).toBeDisabled();
    expect(within(server).getByRole("button", { name: "Open in browser" })).toBeDisabled();
    expect(server).toHaveTextContent("Hosting public");
    await act(async () => { stopping.resolve({ ok: true }); });
    rerender(<WebsitesPage snapshot={{ ...snapshot, websitePreview: null }} />);
    expect(within(server).getByText("Stopped")).toBeInTheDocument();
    expect(within(server).queryByRole("button", { name: "Stop server" })).not.toBeInTheDocument();
    expect(within(server).queryByText(HOSTED_PREVIEW.url)).not.toBeInTheDocument();
    expect(api.openWebsiteRenderedPreview).not.toHaveBeenCalled();
  });

  it.each(["disconnect", "switch backend"])("reflects cleared preview state after %s", async (transition) => {
    const user = userEvent.setup();
    installAPI();
    const { rerender } = render(<WebsitesPage snapshot={{ ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW }} />);
    await screen.findByRole("button", { name: "Open preview" });
    rerender(<WebsitesPage snapshot={transition === "disconnect" ? disconnectedSnapshot() : connectedSnapshot(2)} />);
    expect(screen.getByRole("button", { name: "Local preview" })).toHaveAccessibleDescription("Preview server stopped");
    const server = await openLocalPreview(user);
    expect(within(server).getByText("Stopped")).toBeInTheDocument();
    expect(server).not.toHaveTextContent(HOSTED_PREVIEW.url);
    expect(within(server).queryByRole("button", { name: "Stop server" })).not.toBeInTheDocument();
  });

  it("keeps a stop error visible across website selection and clears it when retrying", async () => {
    const user = userEvent.setup();
    const retry = deferred<OperationResult>();
    const api = installWebsiteChoices({ stopWebsiteRenderedPreview: vi.fn().mockResolvedValueOnce({ ok: false, error: "Could not close the preview listener" }).mockReturnValueOnce(retry.promise) });
    render(<WebsitesPage snapshot={{ ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW }} />);
    let server = await openLocalPreview(user);
    await user.click(within(server).getByRole("button", { name: "Stop server" }));
    expect(await within(server).findByRole("alert")).toHaveTextContent("Could not close the preview listener");
    await closeLocalPreview(user, server);
    await user.click(await screen.findByRole("button", { name: /other/ }));
    await screen.findByRole("button", { name: "Inspect /other.html" });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not close the preview listener");
    server = await openLocalPreview(user);
    expect(within(server).getByRole("alert")).toHaveTextContent("Could not close the preview listener");
    await user.click(within(server).getByRole("button", { name: "Stop server" }));
    expect(api.stopWebsiteRenderedPreview).toHaveBeenCalledTimes(2);
    expect(within(server).queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => { retry.resolve({ ok: true }); });
    expect(within(server).getByRole("button", { name: "Stop server" })).toBeEnabled();
  });

  it("shows browser preview errors in source inspection and after closing its dialog", async () => {
    const user = userEvent.setup();
    installAPI({ openWebsiteRenderedPreview: vi.fn().mockResolvedValue({ ok: false, error: "The browser could not be opened" }) });
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    const source = await inspect(user);
    await user.click(within(source).getByRole("button", { name: "Preview in browser" }));
    expect(await within(source).findByRole("alert")).toHaveTextContent("The browser could not be opened");
    await user.click(within(source).getAllByRole("button", { name: "Close" }).at(-1)!);
    await waitFor(() => expect(source).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("The browser could not be opened");
    const server = await openLocalPreview(user);
    expect(within(server).getByRole("alert")).toHaveTextContent("The browser could not be opened");
  });

  it("retains pending preview guards and reports its error after selecting another website", async () => {
    const user = userEvent.setup();
    const opening = deferred<OperationResult>();
    const api = installWebsiteChoices({ openWebsiteRenderedPreview: vi.fn().mockReturnValue(opening.promise) });
    render(<WebsitesPage snapshot={{ ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW }} />);
    const open = await screen.findByRole("button", { name: "Open preview" });
    await waitFor(() => expect(open).toBeEnabled());
    await user.click(open);
    await user.click(screen.getByRole("button", { name: /other/ }));
    await screen.findByRole("button", { name: "Inspect /other.html" });
    const switchPreview = screen.getByRole("button", { name: "Preview website" });
    expect(switchPreview).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preview /other.html" })).toBeDisabled();
    await user.click(switchPreview);
    const server = await openLocalPreview(user);
    expect(within(server).getByRole("button", { name: /Preview website/i })).toBeDisabled();
    expect(within(server).getByRole("button", { name: "Open in browser" })).toBeDisabled();
    expect(within(server).getByRole("button", { name: "Stop server" })).toBeEnabled();
    expect(api.openWebsiteRenderedPreview).toHaveBeenCalledOnce();
    expect(api.stopWebsiteRenderedPreview).not.toHaveBeenCalled();
    await act(async () => { opening.resolve({ ok: false, error: "Browser could not open the preview" }); });
    expect(await within(server).findByRole("alert")).toHaveTextContent("Browser could not open the preview");
    expect(switchPreview).toBeEnabled();
    expect(within(server).getByRole("button", { name: "Stop server" })).toBeEnabled();
  });

  it("allows stopping during a pending browser request and ignores its superseded result", async () => {
    const user = userEvent.setup();
    const opening = deferred<OperationResult>();
    const stopping = deferred<OperationResult>();
    const api = installAPI({
      openWebsiteRenderedPreview: vi.fn().mockReturnValue(opening.promise),
      stopWebsiteRenderedPreview: vi.fn().mockReturnValue(stopping.promise),
    });
    const snapshot = { ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW };
    const { rerender } = render(<WebsitesPage snapshot={snapshot} />);
    const server = await openLocalPreview(user);
    await user.click(within(server).getByRole("button", { name: "Open in browser" }));
    expect(api.openWebsiteRenderedPreview).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Stop server" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Stop server" }));
    expect(api.stopWebsiteRenderedPreview).toHaveBeenCalledExactlyOnceWith();
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    await act(async () => { opening.resolve({ ok: false, error: "Preview opening was canceled" }); });
    expect(screen.queryByText("Preview opening was canceled")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open in browser" })).toBeDisabled();
    await act(async () => { stopping.resolve({ ok: true }); });
    rerender(<WebsitesPage snapshot={{ ...snapshot, websitePreview: null }} />);
    expect(within(server).getByText("Stopped")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    { operation: "open", transition: "switch backend" },
    { operation: "open", transition: "unmount" },
    { operation: "stop", transition: "switch backend" },
    { operation: "stop", transition: "unmount" },
  ])("ignores a late preview $operation error after $transition", async ({ operation, transition }) => {
    const user = userEvent.setup();
    const pending = deferred<OperationResult>();
    const api = installAPI({
      openWebsiteRenderedPreview: vi.fn().mockReturnValue(pending.promise),
      stopWebsiteRenderedPreview: vi.fn().mockReturnValue(pending.promise),
    });
    const { rerender, unmount } = render(<WebsitesPage snapshot={{ ...connectedSnapshot(), websitePreview: HOSTED_PREVIEW }} />);
    const server = await openLocalPreview(user);
    await user.click(within(server).getByRole("button", { name: operation === "open" ? "Open in browser" : "Stop server" }));
    expect(operation === "open" ? api.openWebsiteRenderedPreview : api.stopWebsiteRenderedPreview).toHaveBeenCalledOnce();
    if (transition === "switch backend") rerender(<WebsitesPage snapshot={connectedSnapshot(2)} />);
    else unmount();
    await act(async () => { pending.resolve({ ok: false, error: "Old preview server error" }); });
    expect(screen.queryByText("Old preview server error")).not.toBeInTheDocument();
    if (transition === "switch backend") {
      const dialog = screen.queryByRole("dialog", { name: "Local preview" });
      if (dialog) await closeLocalPreview(user, dialog);
      const preview = await screen.findByRole("button", { name: "Preview website" });
      await waitFor(() => expect(preview).toBeEnabled());
    }
  });

  it("opens a native editor directly from the row menu without retrieving source in the workspace", async () => {
    const user = userEvent.setup();
    const api = installAPI();
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await user.click(await screen.findByRole("button", { name: "Actions for /index.html" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    await waitFor(() => expect(api.openWebsiteTextEditor).toHaveBeenCalledExactlyOnceWith({ name: "public", path: "/index.html", mode: "edit" }));
    expect(api.getWebsiteContent).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["switch backend", "unmount"])("ignores a pending editor error after %s", async (transition) => {
    const user = userEvent.setup();
    const opening = deferred<OperationResult>();
    const api = installAPI({ openWebsiteTextEditor: vi.fn().mockReturnValue(opening.promise) });
    const { rerender, unmount } = render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await user.click(await screen.findByRole("button", { name: "Actions for /index.html" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    await waitFor(() => expect(api.openWebsiteTextEditor).toHaveBeenCalledOnce());
    if (transition === "switch backend") rerender(<WebsitesPage snapshot={connectedSnapshot(2)} />);
    else unmount();
    await act(async () => { opening.resolve({ ok: false, error: "Old backend error" }); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    if (transition === "switch backend") {
      expect(await screen.findByRole("button", { name: "Actions for /index.html" })).toBeEnabled();
    }
  });

  it.each(["Replace", "Change content type", "Save copy"])("exposes %s directly in the row menu", async (action) => {
    const user = userEvent.setup();
    const api = installAPI();
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await user.click(await screen.findByRole("button", { name: "Actions for /index.html" }));
    await user.click(screen.getByRole("menuitem", { name: action }));
    if (action === "Save copy") await waitFor(() => expect(api.exportWebsiteContent).toHaveBeenCalledExactlyOnceWith({ name: "public", path: "/index.html" }));
    else await screen.findByRole("dialog", { name: action === "Replace" ? "Replace content" : action });
    expect(api.getWebsiteContent).not.toHaveBeenCalled();
  });

  it("disables direct editing of binary content", async () => {
    const user = userEvent.setup();
    const item = { ...ITEM, contentType: "image/png" };
    const api = installAPI({ getWebsite: vi.fn().mockResolvedValue({ ok: true, value: { ...SITE, contents: [item] } }) });
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await user.click(await screen.findByRole("button", { name: "Actions for /index.html" }));
    expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(api.getWebsiteContent).not.toHaveBeenCalled();
  });

  it("shows native editor validation failures despite stale textual row metadata", async () => {
    const user = userEvent.setup();
    installAPI({ openWebsiteTextEditor: vi.fn().mockResolvedValue({ ok: false, error: "Website content is no longer textual" }) });
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await user.click(await screen.findByRole("button", { name: "Actions for /index.html" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Website content is no longer textual");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps creation metadata when opening fails and rejects nontextual types", async () => {
    const user = userEvent.setup();
    const api = installAPI({ openWebsiteTextEditor: vi.fn().mockResolvedValue({ ok: false, error: "Path already exists; use Edit" }) });
    render(<WebsitesPage snapshot={connectedSnapshot()} />);
    await screen.findByRole("button", { name: "Inspect /index.html" });
    await user.click(screen.getByRole("button", { name: "Add text" }));
    const dialog = await screen.findByRole("dialog", { name: "Add text content" });
    fireEvent.change(within(dialog).getByLabelText("URL path"), { target: { value: "/index.html" } });
    fireEvent.change(within(dialog).getByLabelText("Content type"), { target: { value: "image/png" } });
    await user.click(within(dialog).getByRole("button", { name: "Open editor" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("textual content type");
    expect(api.openWebsiteTextEditor).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText("Content type"), { target: { value: "text/html" } });
    await user.click(within(dialog).getByRole("button", { name: "Open editor" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Path already exists");
    expect(within(dialog).getByLabelText("URL path")).toHaveValue("/index.html");
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
    const lateWrite = deferred<OperationResult>();
    const api = installAPI({
      listWebsites: vi.fn().mockResolvedValue({ ok: true, value: catalog([SITE.site, { ...SITE.site, id: "site-2", name: "other" }]) }),
      getWebsiteContent: vi.fn().mockReturnValue(latePreview.promise),
      openWebsiteTextEditor: vi.fn().mockReturnValue(lateWrite.promise),
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
    await user.click(within(editor).getByRole("button", { name: "Open editor" }));
    await waitFor(() => expect(api.openWebsiteTextEditor).toHaveBeenCalledOnce());
    rerender(<WebsitesPage snapshot={connectedSnapshot(3)} />);
    await act(async () => { lateWrite.resolve({ ok: false, error: "stale-write" }); });
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
