import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Checkbox, Description, Dropdown, Input, Label, Modal, ScrollShadow, SearchField, TextField, Tooltip } from "@heroui/react";
import { DataGrid } from "@heroui-pro/react/data-grid";
import type { DataGridColumn } from "@heroui-pro/react/data-grid";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faArrowRightArrowLeft, faDownload, faEllipsisVertical, faEye, faFileArrowUp,
  faFileLines, faFloppyDisk, faFolderOpen, faGlobe, faMagnifyingGlass,
  faPenToSquare, faPlus, faRotate, faTag, faTrash,
} from "@fortawesome/free-solid-svg-icons";

import type { OperationResult, SliverSnapshot } from "../../../shared/contracts";
import { WEBSITE_LIMITS, isWebsiteTextContentType, type WebsiteCatalogPage, type WebsiteContentDetail, type WebsiteContentSummary, type WebsiteDetail } from "../../../shared/website-contracts";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { WebsiteContentPreview } from "../components/WebsiteContentPreview";
import { decodeWebsiteEditableText } from "../components/website-content-preview";

interface WebsitesPageProps {
  snapshot: SliverSnapshot;
}

type FormKind = "create" | "text" | "file" | "directory" | "replace" | "mime";
interface ContentForm {
  kind: FormKind;
  path: string;
  contentType: string;
  name: string;
  includeHiddenDirectories: boolean;
}
type DeleteTarget = { kind: "website"; name: string } | { kind: "content"; name: string; path: string };

const EMPTY_CATALOG: WebsiteCatalogPage = { items: [], page: { limit: WEBSITE_LIMITS.pageSize, total: 0, truncated: false } };
const FORM_TITLES: Record<FormKind, string> = {
  create: "Create website", text: "Add text content", file: "Add local file", directory: "Import directory",
  replace: "Replace content", mime: "Change content type",
};

export function WebsitesPage({ snapshot }: WebsitesPageProps): React.JSX.Element {
  const identity = websiteBackendIdentity(snapshot);
  const connected = ["connected", "degraded", "reconnecting"].includes(snapshot.connection.status);
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState({ identity: "", value: EMPTY_CATALOG });
  const [selection, setSelection] = useState({ identity: "", name: "" });
  const name = selection.identity === identity ? selection.name : "";
  const context = `${identity}\0${name}`;
  const catalogContext = `${identity}\0${query}`;
  const [detail, setDetail] = useState<{ context: string; value: WebsiteDetail }>();
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [catalogError, setCatalogError] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [form, setForm] = useState<ContentForm>();
  const [formError, setFormError] = useState<string>();
  const [overwriteConfirmation, setOverwriteConfirmation] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>();
  const [previewTarget, setPreviewTarget] = useState<WebsiteContentSummary>();
  const [preview, setPreview] = useState<WebsiteContentDetail>();
  const previewRef = useRef<WebsiteContentDetail | undefined>(undefined);
  const [previewError, setPreviewError] = useState<string>();
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [pending, setPending] = useState(false);
  const contextRef = useRef(context);
  contextRef.current = context;
  const catalogContextRef = useRef(catalogContext);
  catalogContextRef.current = catalogContext;
  const catalogSequence = useRef(0);
  const detailSequence = useRef(0);
  const previewSequence = useRef(0);
  const mutationSequence = useRef(0);
  const pendingRef = useRef(false);
  const mounted = useRef(true);
  const visibleCatalog = catalog.identity === catalogContext ? catalog.value : EMPTY_CATALOG;
  const visibleDetail = detail?.context === context ? detail.value : undefined;
  const previewEntry = websitePreviewEntry(visibleDetail?.contents ?? []);
  const websiteEventId = snapshot.recentEvents.find((event) => event.type === "website")?.id;

  const closePreview = useCallback(() => {
    previewSequence.current += 1;
    previewRef.current?.preview.fill(0);
    previewRef.current = undefined;
    setPreviewTarget(undefined);
    setPreview(undefined);
    setPreviewError(undefined);
    setLoadingPreview(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      catalogSequence.current += 1;
      detailSequence.current += 1;
      previewSequence.current += 1;
      mutationSequence.current += 1;
      previewRef.current?.preview.fill(0);
    };
  }, []);

  useEffect(() => {
    closePreview();
    setForm(undefined);
    setFormError(undefined);
    setDeleteTarget(undefined);
    setOverwriteConfirmation(false);
    setActionError(undefined);
    setNotice(undefined);
    mutationSequence.current += 1;
    pendingRef.current = false;
    setPending(false);
  }, [closePreview, context]);

  useEffect(() => { closePreview(); }, [closePreview, websiteEventId]);

  useEffect(() => {
    const request = ++catalogSequence.current;
    const expectedContext = catalogContext;
    setCatalogError(undefined);
    setLoadingMore(false);
    if (!connected) {
      setCatalog({ identity: expectedContext, value: EMPTY_CATALOG });
      setLoadingCatalog(false);
      return;
    }
    setLoadingCatalog(true);
    const timer = window.setTimeout(() => {
      void window.sliver.listWebsites({ query, limit: WEBSITE_LIMITS.pageSize }).then((result) => {
        if (request !== catalogSequence.current || expectedContext !== catalogContextRef.current) return;
        if (!result.ok) {
          setCatalogError(result.error);
          setCatalog({ identity: expectedContext, value: EMPTY_CATALOG });
          return;
        }
        setCatalog({ identity: expectedContext, value: result.value });
        setSelection((current) => current.identity === identity && current.name
          ? current
          : { identity, name: result.value.items[0]?.name ?? "" });
      }).catch((error: unknown) => {
        if (request === catalogSequence.current && expectedContext === catalogContextRef.current) setCatalogError(errorMessage(error));
      }).finally(() => {
        if (request === catalogSequence.current && expectedContext === catalogContextRef.current) setLoadingCatalog(false);
      });
    }, query ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [catalogContext, connected, identity, query, revision, websiteEventId]);

  useEffect(() => {
    const request = ++detailSequence.current;
    const expectedContext = context;
    setDetailError(undefined);
    if (!connected || !name) {
      setDetail(undefined);
      setLoadingDetail(false);
      return;
    }
    setLoadingDetail(true);
    void window.sliver.getWebsite({ name }).then((result) => {
      if (request !== detailSequence.current || expectedContext !== contextRef.current) return;
      if (!result.ok) {
        setDetail(undefined);
        setDetailError(result.error);
        return;
      }
      setDetail({ context: expectedContext, value: result.value });
    }).catch((error: unknown) => {
      if (request === detailSequence.current && expectedContext === contextRef.current) setDetailError(errorMessage(error));
    }).finally(() => {
      if (request === detailSequence.current && expectedContext === contextRef.current) setLoadingDetail(false);
    });
  }, [connected, context, name, revision, websiteEventId]);

  const loadMore = async () => {
    const cursor = visibleCatalog.page.nextCursor;
    if (!cursor || loadingMore || loadingCatalog) return;
    const expectedContext = catalogContext;
    const request = ++catalogSequence.current;
    setLoadingMore(true);
    try {
      const result = await window.sliver.listWebsites({ query, cursor, limit: WEBSITE_LIMITS.pageSize });
      if (request !== catalogSequence.current || expectedContext !== catalogContextRef.current) return;
      if (!result.ok) { setCatalogError(result.error); return; }
      setCatalog((current) => ({ identity: expectedContext, value: {
        ...result.value,
        items: [...new Map([...current.value.items, ...result.value.items].map((item) => [item.name, item])).values()],
      } }));
    } catch (error) {
      if (request === catalogSequence.current && expectedContext === catalogContextRef.current) setCatalogError(errorMessage(error));
    } finally {
      if (request === catalogSequence.current && expectedContext === catalogContextRef.current) setLoadingMore(false);
    }
  };

  const openPreview = async (item: WebsiteContentSummary) => {
    closePreview();
    const expectedContext = context;
    const request = ++previewSequence.current;
    setPreviewTarget(item);
    setPreview(undefined);
    setPreviewError(undefined);
    setLoadingPreview(true);
    try {
      const result = await window.sliver.getWebsiteContent({ name, path: item.path });
      if (request !== previewSequence.current || expectedContext !== contextRef.current) {
        if (result.ok) result.value.preview.fill(0);
        return;
      }
      if (!result.ok) { setPreviewError(result.error); return; }
      previewRef.current = result.value;
      setPreview(result.value);
    } catch (error) {
      if (request === previewSequence.current && expectedContext === contextRef.current) setPreviewError(errorMessage(error));
    } finally {
      if (request === previewSequence.current && expectedContext === contextRef.current) setLoadingPreview(false);
    }
  };

  const openForm = (kind: FormKind, item?: WebsiteContentSummary) => {
    closePreview();
    setForm({ kind, name: "", path: item?.path ?? (kind === "directory" ? "/" : ""), contentType: item?.contentType ?? (kind === "text" ? "text/html; charset=utf-8" : ""), includeHiddenDirectories: false });
    setFormError(undefined);
    setActionError(undefined);
  };

  const runOperation = async <T,>(operation: () => Promise<OperationResult<T>>, onSuccess: (value: T) => void, isForm = false): Promise<boolean> => {
    if (pendingRef.current || !connected) return false;
    const expectedContext = context;
    const request = ++mutationSequence.current;
    pendingRef.current = true;
    setPending(true);
    setActionError(undefined);
    setFormError(undefined);
    setNotice(undefined);
    const isCurrent = () => mounted.current && expectedContext === contextRef.current && request === mutationSequence.current;
    try {
      const result = await operation();
      if (!isCurrent()) return false;
      if (!result.ok) {
        if (isForm && result.error === "Website import canceled") return false;
        (isForm ? setFormError : setActionError)(result.error);
        return false;
      }
      onSuccess(result.value as T);
      return true;
    } catch (error) {
      if (isCurrent()) (isForm ? setFormError : setActionError)(errorMessage(error));
      return false;
    } finally {
      if (isCurrent()) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  };

  const submitForm = async (confirmed = false): Promise<boolean> => {
    if (!form) return false;
    const { kind, path, contentType } = form;
    if (kind === "create" && !form.name.trim()) { setFormError("Enter a website name."); return false; }
    if (kind !== "create" && (!path.startsWith("/") || /[\r\n]/u.test(path))) {
      setFormError("Enter an absolute URL path beginning with /."); return false;
    }
    if (["text", "mime"].includes(kind) && !contentType.trim()) { setFormError("Enter a content type."); return false; }
    if (kind === "text") {
      if (!isWebsiteTextContentType(contentType)) { setFormError("Choose a textual content type to open the editor."); return false; }
      return runOperation(async () => {
        const result = await window.sliver.openWebsiteTextEditor({ name, path, mode: "create", contentType });
        return result.ok ? { ok: true, value: true } : result;
      }, () => setForm(undefined), true);
    }
    const replacing = kind === "replace" || (kind === "file" && visibleDetail?.contents.some((item) => item.path === path));
    if (replacing && !confirmed) { setOverwriteConfirmation(true); return false; }
    return runOperation<WebsiteDetail>(async () => {
      if (kind === "create") return window.sliver.createWebsite({ name: form.name.trim() });
      if (kind === "mime") return window.sliver.updateWebsiteContentType({ name, path, contentType });
      return window.sliver.importWebsiteFiles({ name, path, contentType, overwrite: Boolean(replacing), directory: kind === "directory",
        ...(kind === "directory" ? { includeHiddenDirectories: form.includeHiddenDirectories } : {}),
      });
    }, (value) => {
      setForm(undefined);
      setOverwriteConfirmation(false);
      setQuery("");
      setSelection({ identity, name: value.site.name });
      setDetail({ context: `${identity}\0${value.site.name}`, value });
      setRevision((current) => current + 1);
      setNotice(kind === "create" ? "Website created." : "Website content saved.");
    }, true);
  };

  const deleteSelected = async (): Promise<boolean> => {
    if (!deleteTarget) return false;
    const target = deleteTarget;
    const deleted = await runOperation(async () => {
      const result = target.kind === "website"
        ? await window.sliver.deleteWebsite({ name: target.name })
        : await window.sliver.deleteWebsiteContent({ name: target.name, path: target.path });
      return result.ok ? { ok: true, value: true } : result;
    }, () => {
      setDeleteTarget(undefined);
      closePreview();
      if (target.kind === "website") setSelection({ identity, name: "" });
      setRevision((current) => current + 1);
      setNotice(target.kind === "website" ? "Website deleted." : "Content deleted.");
    });
    if (!deleted && contextRef.current === context) setDeleteTarget(undefined);
    return deleted;
  };

  const exportContent = async (item: WebsiteContentSummary) => runOperation(
    () => window.sliver.exportWebsiteContent({ name, path: item.path }),
    (result) => { if (result.saved) setNotice(`Saved ${result.fileName}.`); },
  );

  const openRenderedPreview = async (item: WebsiteContentSummary) => runOperation(async () => {
    const result = await window.sliver.openWebsiteRenderedPreview({ name, path: item.path });
    return result.ok ? { ok: true, value: true } : result;
  }, () => undefined);

  const editContent = async (item: WebsiteContentSummary) => runOperation(async () => {
    const result = await window.sliver.openWebsiteTextEditor({ name, path: item.path, mode: "edit" });
    return result.ok ? { ok: true, value: true } : result;
  }, closePreview);

  const contentAction = (action: string, item: WebsiteContentSummary) => {
    if (pendingRef.current) return;
    if (action === "edit") void editContent(item);
    else if (action === "replace") openForm("replace", item);
    else if (action === "mime") openForm("mime", item);
    else if (action === "copy") void exportContent(item);
    else if (action === "delete") setDeleteTarget({ kind: "content", name, path: item.path });
  };

  const columns: DataGridColumn<WebsiteContentSummary>[] = [
    { id: "path", header: "URL path", accessorKey: "path", isRowHeader: true, allowsSorting: true, minWidth: 200, cell: (item) => (
      <Button aria-label={`Inspect ${item.path}`} className="h-auto min-h-8 max-w-full justify-start whitespace-normal break-all px-0 text-start font-mono text-xs" variant="ghost" size="sm" isDisabled={pending} onPress={() => void openPreview(item)}>{item.path}</Button>
    ) },
    { id: "contentType", header: "Content type", accessorKey: "contentType", allowsSorting: true, minWidth: 180 },
    { id: "sizeBytes", header: "Size", align: "end", minWidth: 90, cell: (item) => <span className="tabular-nums">{formatBytes(item.sizeBytes)}</span> },
    { id: "actions", header: "Actions", align: "end", width: 112, cell: (item) => (
      <div className="flex justify-end gap-1">
        <IconButton label={`Preview ${item.path}`} icon={faEye} disabled={pending} onPress={() => void openRenderedPreview(item)} />
        <Dropdown>
          <Tooltip><Button aria-label={`Actions for ${item.path}`} isIconOnly isDisabled={pending} size="sm" variant="ghost"><FontAwesomeIcon aria-hidden icon={faEllipsisVertical} /></Button><Tooltip.Content>Content actions</Tooltip.Content></Tooltip>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu aria-label={`Actions for ${item.path}`} disabledKeys={isWebsiteTextContentType(item.contentType) && Number(item.sizeBytes) <= WEBSITE_LIMITS.previewBytes ? [] : ["edit"]} onAction={(key) => contentAction(String(key), item)}>
              <Dropdown.Item id="edit" textValue="Edit"><FontAwesomeIcon aria-hidden icon={faPenToSquare} className="size-4 shrink-0 text-muted" /><Label>Edit</Label></Dropdown.Item>
              <Dropdown.Item id="replace" textValue="Replace"><FontAwesomeIcon aria-hidden icon={faArrowRightArrowLeft} className="size-4 shrink-0 text-muted" /><Label>Replace</Label></Dropdown.Item>
              <Dropdown.Item id="mime" textValue="Change content type"><FontAwesomeIcon aria-hidden icon={faTag} className="size-4 shrink-0 text-muted" /><Label>Change content type</Label></Dropdown.Item>
              <Dropdown.Item id="copy" textValue="Save copy"><FontAwesomeIcon aria-hidden icon={faDownload} className="size-4 shrink-0 text-muted" /><Label>Save copy</Label></Dropdown.Item>
              <Dropdown.Item id="delete" textValue="Delete" variant="danger"><FontAwesomeIcon aria-hidden icon={faTrash} className="size-4 shrink-0" /><Label>Delete</Label></Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>
    ) },
  ];
  const editableText = useMemo(() => preview ? decodeWebsiteEditableText(preview) : null, [preview]);

  return (
    <section className="page-stack websites-page" aria-labelledby="websites-page-heading">
      <header className="page-heading websites-page__header">
        <div className="min-w-0">
          <div className="eyebrow"><FontAwesomeIcon aria-hidden icon={faGlobe} /> Hosted content</div>
          <h1 id="websites-page-heading">Websites</h1>
          <p>Manage content served by HTTP and HTTPS listeners.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" isDisabled={!connected || pending} onPress={() => setRevision((current) => current + 1)}><FontAwesomeIcon aria-hidden icon={faRotate} /> Refresh</Button>
          <Button isDisabled={!connected || pending} onPress={() => openForm("create")}><FontAwesomeIcon aria-hidden icon={faPlus} /> Create website</Button>
        </div>
      </header>
      <ScrollShadow
        aria-label="Hosted website content"
        className="websites-page__viewport min-h-0 flex-1 overflow-y-auto overscroll-contain"
        hideScrollBar={false}
        orientation="vertical"
        role="region"
        size={28}
        tabIndex={0}
      >
        <div className="page-stack websites-page__content">
          {actionError ? <InlineError message={actionError} /> : null}
          {notice ? <p role="status" className="text-sm text-success">{notice}</p> : null}
          {!connected ? <WebsiteEmpty title="Connect to a server" description="Hosted websites are available after connecting to a Sliver server." /> : (
            <div className="websites-page__columns grid min-w-0">
              <Card className="websites-page__selector min-h-0 min-w-0 self-start xl:sticky xl:top-0 xl:max-h-[100cqh]" variant="secondary">
                <Card.Header className="shrink-0"><Card.Title>Websites</Card.Title><Card.Description>{visibleCatalog.page.total} available</Card.Description></Card.Header>
                <Card.Content className="flex min-h-0 flex-col gap-3">
                  <SearchField aria-label="Search websites" className="shrink-0" value={query} onChange={setQuery} variant="secondary">
                    <SearchField.Group><SearchField.SearchIcon><FontAwesomeIcon aria-hidden icon={faMagnifyingGlass} /></SearchField.SearchIcon><SearchField.Input maxLength={256} placeholder="Search websites" /><SearchField.ClearButton /></SearchField.Group>
                  </SearchField>
                  {catalogError ? <InlineError message={catalogError} /> : null}
                  {loadingCatalog ? <p role="status" className="text-sm text-muted">Loading websites…</p> : null}
                  <ScrollShadow aria-label="Website selection" className="min-h-0 max-h-[520px] overflow-y-auto overscroll-contain" hideScrollBar={false} orientation="vertical" role="region" size={24} tabIndex={0}>
                    <div className="flex flex-col gap-1">
                      {visibleCatalog.items.map((site) => <Button key={site.name} className="h-auto min-h-12 w-full justify-start px-3 py-2 text-start" variant={name === site.name ? "secondary" : "ghost"} aria-pressed={name === site.name} onPress={() => setSelection({ identity, name: site.name })}>
                        <span className="min-w-0"><span className="block truncate">{site.name}</span><span className="block text-xs font-normal tabular-nums text-muted">{site.contentCount} {site.contentCount === 1 ? "file" : "files"} · {formatBytes(site.totalSizeBytes)}</span></span>
                      </Button>)}
                    </div>
                  </ScrollShadow>
                  {!loadingCatalog && visibleCatalog.items.length === 0 && !catalogError ? <p className="py-4 text-sm text-muted">{query ? "No matching websites." : "No websites yet. Create one to add content."}</p> : null}
                  {visibleCatalog.page.nextCursor ? <Button className="shrink-0" variant="secondary" size="sm" isPending={loadingMore} onPress={() => void loadMore()}>Load more websites</Button> : null}
                </Card.Content>
              </Card>
              <Card className="mb-20 min-w-0 self-start" variant="secondary">
                <Card.Header className="flex-row flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0"><Card.Title className="break-all">{name || "Website content"}</Card.Title><Card.Description>{name ? "Preview in your browser or use the actions menu. Select a path to inspect its source." : "Select a website to manage its content."}</Card.Description></div>
                  {name ? <div className="flex shrink-0 flex-wrap gap-2">
                    <Button size="sm" variant="secondary" isDisabled={pending || loadingDetail || !previewEntry} onPress={() => { if (previewEntry) void openRenderedPreview(previewEntry); }}><FontAwesomeIcon aria-hidden icon={faEye} /> Preview website</Button>
                    <Button size="sm" variant="danger-soft" isDisabled={pending} onPress={() => setDeleteTarget({ kind: "website", name })}><FontAwesomeIcon aria-hidden icon={faTrash} /> Delete website</Button>
                  </div> : null}
                </Card.Header>
                <Card.Content className="min-w-0 p-0">
                  {name ? <div className="flex flex-wrap gap-2 px-4 pb-4">
                    <Button size="sm" isDisabled={pending || loadingDetail} onPress={() => openForm("text")}><FontAwesomeIcon aria-hidden icon={faFileLines} /> Add text</Button>
                    <Button size="sm" variant="secondary" isDisabled={pending || loadingDetail} onPress={() => openForm("file")}><FontAwesomeIcon aria-hidden icon={faFileArrowUp} /> Add local file</Button>
                    <Button size="sm" variant="secondary" isDisabled={pending || loadingDetail} onPress={() => openForm("directory")}><FontAwesomeIcon aria-hidden icon={faFolderOpen} /> Import directory</Button>
                  </div> : null}
                  {detailError ? <div className="px-4 pb-4"><InlineError message={detailError} /></div> : null}
                  {loadingDetail ? <p role="status" className="px-4 pb-3 text-sm text-muted">Loading content…</p> : null}
                  {name ? <DataGrid aria-label="Website content" columns={columns} contentClassName="min-w-[620px]" data={visibleDetail?.contents ?? []} getRowId={(item) => item.path} variant="secondary" onRowAction={(key) => { const item = visibleDetail?.contents.find((entry) => entry.path === key); if (item) void openPreview(item); }} renderEmptyState={() => <WebsiteEmpty title={loadingDetail ? "Loading content" : detailError ? "Content unavailable" : "No content yet"} description={loadingDetail ? "Fetching website metadata…" : detailError ? "Refresh to try again." : "Add text, a local file, or a directory to this website."} />} /> : <WebsiteEmpty title="Select a website" description="Your website’s paths, content types, and sizes will appear here." />}
                  {visibleDetail?.truncated ? <p role="status" className="px-4 py-3 text-sm text-warning">This website exceeds the content listing limit. Some paths are omitted.</p> : null}
                </Card.Content>
              </Card>
            </div>
          )}
        </div>
      </ScrollShadow>

      <EditorDialog form={form} error={formError} pending={pending} onChange={(next) => { setForm(next); setFormError(undefined); }} onClose={() => { if (!pending) setForm(undefined); }} onSubmit={() => void submitForm()} />

      <Modal.Backdrop isOpen={Boolean(previewTarget)} variant="blur" onOpenChange={(open) => { if (!open && !pending) closePreview(); }}>
        <Modal.Container placement="center" scroll="inside" size="lg">
          <Modal.Dialog className="sm:max-w-[900px]">
            <Modal.CloseTrigger isDisabled={pending} />
            <Modal.Header className="pr-10"><Modal.Heading className="break-all">{previewTarget?.path ?? "Content preview"}</Modal.Heading><p className="text-xs text-muted">{previewTarget?.contentType} · {formatBytes(previewTarget?.sizeBytes ?? "0")}</p></Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              {loadingPreview ? <p role="status">Loading content preview…</p> : null}
              {previewError ? <InlineError message={previewError} /> : null}
              {preview ? <WebsiteContentPreview content={preview} /> : null}
              {previewTarget?.sha256 ? <dl className="text-xs"><dt className="text-muted">SHA-256</dt><dd className="break-all font-mono">{previewTarget.sha256}</dd></dl> : null}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" isDisabled={pending} onPress={() => { if (previewTarget) void openRenderedPreview(previewTarget); }}><FontAwesomeIcon aria-hidden icon={faEye} /> Preview in browser</Button>
                <Button size="sm" variant="secondary" isDisabled={pending || editableText === null} onPress={() => { if (previewTarget && editableText !== null) void editContent(previewTarget); }}><FontAwesomeIcon aria-hidden icon={faPenToSquare} /> Edit text</Button>
                <Button size="sm" variant="secondary" isDisabled={pending} onPress={() => { if (previewTarget) openForm("replace", previewTarget); }}><FontAwesomeIcon aria-hidden icon={faArrowRightArrowLeft} /> Replace from file</Button>
                <Button size="sm" variant="secondary" isDisabled={pending} onPress={() => { if (previewTarget) openForm("mime", previewTarget); }}><FontAwesomeIcon aria-hidden icon={faTag} /> Change content type</Button>
                <Button size="sm" variant="secondary" isPending={pending} onPress={() => { if (previewTarget) void exportContent(previewTarget); }}><FontAwesomeIcon aria-hidden icon={faDownload} /> Save copy</Button>
                <Button size="sm" variant="danger-soft" isDisabled={pending} onPress={() => { if (previewTarget) setDeleteTarget({ kind: "content", name, path: previewTarget.path }); }}><FontAwesomeIcon aria-hidden icon={faTrash} /> Delete</Button>
              </div>
              <p className="text-xs text-muted">Preview opens in your default browser. Refresh the browser after saving to see the latest hosted content.</p>
              {preview && editableText === null ? <p className="text-xs text-muted">Text editing requires complete UTF-8 content within the editor limit. Use Replace from file for other content.</p> : null}
              {actionError ? <InlineError message={actionError} /> : null}
            </Modal.Body>
            <Modal.Footer><Button variant="tertiary" isDisabled={pending} onPress={closePreview}>Close</Button></Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <ConfirmDialog isOpen={overwriteConfirmation} title="Replace hosted content?" description={`The existing content at ${form?.path ?? "this path"} will be overwritten on the connected server.`} confirmLabel="Replace content" isPending={pending} onOpenChange={(open) => { if (!pending) setOverwriteConfirmation(open); }} onConfirm={async () => { setOverwriteConfirmation(false); return submitForm(true); }} />
      <ConfirmDialog isOpen={Boolean(deleteTarget)} title={deleteTarget?.kind === "website" ? "Delete website?" : "Delete hosted content?"} description={deleteTarget?.kind === "website" ? `Delete ${deleteTarget.name} and all its hosted content? Listeners using this website will no longer serve its content.` : `Delete ${deleteTarget?.kind === "content" ? deleteTarget.path : "this path"} from ${name}? This cannot be undone.`} confirmLabel={deleteTarget?.kind === "website" ? "Delete website" : "Delete content"} isPending={pending} onOpenChange={(open) => { if (!open && !pending) setDeleteTarget(undefined); }} onConfirm={deleteSelected} />
    </section>
  );
}

function EditorDialog({ form, error, pending, onChange, onClose, onSubmit }: { form: ContentForm | undefined; error: string | undefined; pending: boolean; onChange: (value: ContentForm) => void; onClose: () => void; onSubmit: () => void }): React.JSX.Element {
  const kind = form?.kind;
  const update = <K extends keyof ContentForm,>(key: K, value: ContentForm[K]) => { if (form) onChange({ ...form, [key]: value }); };
  return <Modal.Backdrop isOpen={Boolean(form)} isDismissable={!pending} isKeyboardDismissDisabled={pending} variant="blur" onOpenChange={(open) => { if (!open) onClose(); }}>
    <Modal.Container placement="center" scroll="inside" size="sm">
      <Modal.Dialog>
        <Modal.CloseTrigger isDisabled={pending} />
        <Modal.Header className="pr-10"><Modal.Heading>{kind ? FORM_TITLES[kind] : "Website content"}</Modal.Heading></Modal.Header>
        <Modal.Body className="flex flex-col gap-4">
          {kind === "create" ? <TextField fullWidth isDisabled={pending} value={form?.name ?? ""} variant="secondary" onChange={(value) => update("name", value)}><Label>Website name</Label><Input maxLength={256} autoFocus placeholder="public-site" /><Description>Use this name in the listener’s Website profile field.</Description></TextField> : <>
            <TextField fullWidth isDisabled={pending || kind === "replace" || kind === "mime"} value={form?.path ?? ""} variant="secondary" onChange={(value) => update("path", value)}><Label>{kind === "directory" ? "Base URL path" : "URL path"}</Label><Input maxLength={2048} placeholder={kind === "directory" ? "/assets/" : "/index.html"} /><Description>{kind === "directory" ? "Files retain their relative paths. Existing paths are not overwritten." : "The exact path to serve, beginning with /."}</Description></TextField>
            <TextField fullWidth isDisabled={pending} value={form?.contentType ?? ""} variant="secondary" onChange={(value) => update("contentType", value)}><Label>Content type</Label><Input maxLength={256} placeholder={kind === "text" ? "text/html; charset=utf-8" : "Detect from file"} /><Description>{kind === "file" || kind === "directory" ? "Optional. Leave blank to detect each file’s content type." : "The HTTP Content-Type sent to visitors."}</Description></TextField>
            {kind === "directory" ? <Checkbox isDisabled={pending} isSelected={form?.includeHiddenDirectories ?? false} variant="secondary" onChange={(value) => update("includeHiddenDirectories", value)}>
              <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>Include hidden directories</Checkbox.Content>
              <Description>Include folders with a leading dot, such as .git.</Description>
            </Checkbox> : null}
            {kind === "text" ? <p className="text-sm text-muted">Write content in a separate editor window. Saving publishes it to this website.</p> : null}
          </>}
          {error ? <InlineError message={error} /> : null}
        </Modal.Body>
        <Modal.Footer><Button variant="tertiary" isDisabled={pending} onPress={onClose}>Cancel</Button><Button isPending={pending} onPress={onSubmit}><FontAwesomeIcon aria-hidden icon={kind === "create" ? faPlus : kind === "file" || kind === "replace" ? faFileArrowUp : kind === "directory" ? faFolderOpen : kind === "text" ? faPenToSquare : faFloppyDisk} />{kind === "create" ? "Create website" : kind === "file" || kind === "replace" ? "Choose file and upload" : kind === "directory" ? "Choose directory and upload" : kind === "text" ? "Open editor" : "Save content"}</Button></Modal.Footer>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}

function WebsiteEmpty({ title, description }: { title: string; description: string }): React.JSX.Element {
  return <EmptyState className="py-8"><EmptyState.Header><EmptyState.Media variant="icon"><FontAwesomeIcon aria-hidden icon={faGlobe} /></EmptyState.Media><EmptyState.Title>{title}</EmptyState.Title><EmptyState.Description>{description}</EmptyState.Description></EmptyState.Header></EmptyState>;
}

function InlineError({ message }: { message: string }): React.JSX.Element {
  return <p role="alert" className="break-words text-sm text-danger">{message}</p>;
}

function IconButton({ label, icon, disabled, danger = false, onPress }: { label: string; icon: IconDefinition; disabled: boolean; danger?: boolean; onPress: () => void }): React.JSX.Element {
  return <Tooltip><Button aria-label={label} isIconOnly isDisabled={disabled} size="sm" variant="ghost" {...(danger ? { className: "text-danger" } : {})} onPress={onPress}><FontAwesomeIcon aria-hidden icon={icon} /></Button><Tooltip.Content>{label}</Tooltip.Content></Tooltip>;
}

function formatBytes(value: string): string {
  const size = Number(value);
  if (!Number.isFinite(size)) return value;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function websiteBackendIdentity(snapshot: SliverSnapshot): string {
  const connection = snapshot.connection;
  return [connection.status, connection.epoch, connection.incarnation, connection.server, connection.configName].join(":");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The website operation failed.";
}

function websitePreviewEntry(contents: WebsiteContentSummary[]): WebsiteContentSummary | undefined {
  for (const path of ["/", "/index.html", "/index.htm"]) {
    const entry = contents.find((item) => item.path === path);
    if (entry) return entry;
  }
  return contents.find((item) => ["text/html", "application/xhtml+xml"].includes(item.contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "")) ?? contents[0];
}
