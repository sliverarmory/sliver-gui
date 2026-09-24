import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertDialog,
  Button,
  Card,
  Chip,
  Description,
  FieldError,
  Input,
  Label,
  ListBox,
  Modal,
  SearchField,
  Select,
  TextField,
  Tooltip,
  toast,
} from "@heroui/react";
import { DataGrid } from "@heroui-pro/react/data-grid";
import type { DataGridColumn } from "@heroui-pro/react/data-grid";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { DropZone } from "@heroui-pro/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faBoxOpen,
  faCircleExclamation,
  faDownload,
  faEye,
  faFile,
  faFileLines,
  faMagnifyingGlass,
  faPen,
  faPlus,
  faRotate,
  faTrash,
  faTriangleExclamation,
  faUpload,
} from "@fortawesome/free-solid-svg-icons";

import type { SliverSnapshot } from "../../../shared/contracts";
import {
  OPERATOR_DATA_LIMITS,
  type LootCatalogPage,
  type LootDetail,
  type LootFileType,
  type LootFileTypeFilter,
  type LootSummary,
} from "../../../shared/operator-data-contracts";

interface LootPageProps {
  snapshot: SliverSnapshot;
  onInventoryTotal?: (total: number) => void;
}

interface LootInventoryState extends LootCatalogPage {
  error?: string;
}

const EMPTY_INVENTORY: LootInventoryState = {
  items: [],
  page: {
    limit: OPERATOR_DATA_LIMITS.pageSize,
    total: 0,
    truncated: false,
  },
};

const FILE_TYPE_OPTIONS: ReadonlyArray<{ id: LootFileTypeFilter; label: string }> = [
  { id: "all", label: "All file types" },
  { id: "text", label: "Text" },
  { id: "binary", label: "Binary" },
];

const ADD_FILE_TYPE_OPTIONS: ReadonlyArray<{ id: "auto" | LootFileType; label: string }> = [
  { id: "auto", label: "Detect automatically" },
  { id: "text", label: "Text" },
  { id: "binary", label: "Binary" },
];

interface NativeFileDropItem {
  kind: "file";
  getFile: () => Promise<File>;
}

export function LootPage({ snapshot, onInventoryTotal }: LootPageProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [fileType, setFileType] = useState<LootFileTypeFilter>("all");
  const [inventory, setInventory] = useState<LootInventoryState>(EMPTY_INVENTORY);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addFileType, setAddFileType] = useState<"auto" | LootFileType>("auto");
  const [isAdding, setIsAdding] = useState(false);
  const [isDropAdding, setIsDropAdding] = useState(false);
  const dropPendingRef = useRef(false);
  const [detailTarget, setDetailTarget] = useState<LootSummary>();
  const [detail, setDetail] = useState<LootDetail>();
  const [detailError, setDetailError] = useState<string>();
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [downloadingIds, setDownloadingIds] = useState<ReadonlySet<string>>(new Set());
  const [renameTarget, setRenameTarget] = useState<LootSummary>();
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState<string>();
  const [isRenaming, setIsRenaming] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LootSummary>();
  const [isDeleting, setIsDeleting] = useState(false);

  const backendIdentity = connectionIdentity(snapshot);
  const backendIdentityRef = useRef(backendIdentity);
  backendIdentityRef.current = backendIdentity;
  const listRequestSequence = useRef(0);
  const inventoryQueryIdentityRef = useRef("");
  const detailRequestSequence = useRef(0);
  const normalizedQuery = query.trim();
  const latestLootEvent = useMemo(
    () => snapshot.recentEvents.find((event) => event.type === "loot-added" || event.type === "loot-removed"),
    [snapshot.recentEvents],
  );
  const latestLootEventId = latestLootEvent?.id ?? "";
  const latestLootEventType = latestLootEvent?.type;

  const wipeDetail = useCallback(() => {
    detailRequestSequence.current += 1;
    setDetail((current) => {
      current?.preview.fill(0);
      return undefined;
    });
    setDetailError(undefined);
    setIsLoadingDetail(false);
  }, []);

  const closeDetail = useCallback(() => {
    wipeDetail();
    setDetailTarget(undefined);
  }, [wipeDetail]);

  useEffect(() => () => {
    detailRequestSequence.current += 1;
    detail?.preview.fill(0);
  }, [detail]);

  useEffect(() => {
    closeDetail();
    setRenameTarget(undefined);
    setDeleteTarget(undefined);
  }, [backendIdentity, closeDetail]);

  useEffect(() => {
    if (latestLootEventType === "loot-removed") closeDetail();
  }, [closeDetail, latestLootEventId, latestLootEventType]);

  const loadFirstPage = useCallback(async () => {
    const expectedIdentity = backendIdentityRef.current;
    const inventoryQueryIdentity = `${expectedIdentity}\0${fileType}\0${normalizedQuery}`;
    const request = ++listRequestSequence.current;
    if (inventoryQueryIdentityRef.current !== inventoryQueryIdentity) {
      inventoryQueryIdentityRef.current = inventoryQueryIdentity;
      setInventory(EMPTY_INVENTORY);
    }
    setIsLoading(true);
    setIsLoadingMore(false);
    try {
      const result = await window.sliver.listLoot({
        ...(normalizedQuery ? { query: normalizedQuery } : {}),
        fileType,
        limit: OPERATOR_DATA_LIMITS.pageSize,
      });
      if (request !== listRequestSequence.current || expectedIdentity !== backendIdentityRef.current) return;
      if (!result.ok || !result.value) {
        setInventory((current) => ({
          ...current,
          error: result.error ?? "The loot inventory could not be loaded.",
        }));
        return;
      }
      setInventory(result.value);
      if (!normalizedQuery && fileType === "all") onInventoryTotal?.(result.value.page.total);
    } catch (error) {
      if (request !== listRequestSequence.current || expectedIdentity !== backendIdentityRef.current) return;
      setInventory((current) => ({ ...current, error: errorMessage(error) }));
    } finally {
      if (request === listRequestSequence.current && expectedIdentity === backendIdentityRef.current) {
        setIsLoading(false);
      }
    }
  }, [fileType, normalizedQuery, onInventoryTotal]);

  useEffect(() => {
    const delay = normalizedQuery ? 180 : 0;
    const timeout = window.setTimeout(() => void loadFirstPage(), delay);
    return () => window.clearTimeout(timeout);
  }, [
    backendIdentity,
    latestLootEventId,
    loadFirstPage,
    normalizedQuery,
    refreshSequence,
    snapshot.eventStream.status,
  ]);

  const loadMore = useCallback(async () => {
    const cursor = inventory.page.nextCursor;
    if (!cursor || isLoading || isLoadingMore) return;
    const expectedIdentity = backendIdentityRef.current;
    const request = ++listRequestSequence.current;
    setIsLoadingMore(true);
    try {
      const result = await window.sliver.listLoot({
        ...(normalizedQuery ? { query: normalizedQuery } : {}),
        fileType,
        cursor,
        limit: OPERATOR_DATA_LIMITS.pageSize,
      });
      if (request !== listRequestSequence.current || expectedIdentity !== backendIdentityRef.current) return;
      if (!result.ok || !result.value) {
        setInventory((current) => ({
          ...current,
          error: result.error ?? "More loot could not be loaded.",
        }));
        return;
      }
      setInventory((current) => ({
        items: mergeLoot(current.items, result.value?.items ?? []),
        page: result.value?.page ?? current.page,
      }));
    } catch (error) {
      if (request !== listRequestSequence.current || expectedIdentity !== backendIdentityRef.current) return;
      setInventory((current) => ({ ...current, error: errorMessage(error) }));
    } finally {
      if (request === listRequestSequence.current && expectedIdentity === backendIdentityRef.current) {
        setIsLoadingMore(false);
      }
    }
  }, [fileType, inventory.page.nextCursor, isLoading, isLoadingMore, normalizedQuery]);

  const refresh = useCallback(() => setRefreshSequence((current) => current + 1), []);

  const addLoot = useCallback(async () => {
    setIsAdding(true);
    try {
      const result = await window.sliver.addLoot({ name: addName.trim(), fileType: addFileType });
      if (!result.ok || !result.value) {
        if (!/cancel/iu.test(result.error ?? "")) {
          toast.danger("Could not add loot", { description: result.error });
        }
        return;
      }
      toast.success("Loot added", { description: displayName(result.value) });
      setIsAddOpen(false);
      setAddName("");
      setAddFileType("auto");
      refresh();
    } catch (error) {
      toast.danger("Could not add loot", { description: errorMessage(error) });
    } finally {
      setIsAdding(false);
    }
  }, [addFileType, addName, refresh]);

  const addDroppedLoot = useCallback(async (items: readonly unknown[]) => {
    if (dropPendingRef.current || isAdding || isAddOpen) return;
    if (items.length !== 1 || !isNativeFileDropItem(items[0])) {
      toast.danger("Choose one file", { description: "Drop exactly one local file at a time." });
      return;
    }

    dropPendingRef.current = true;
    setIsDropAdding(true);
    const expectedIdentity = backendIdentityRef.current;
    try {
      const file = await items[0].getFile();
      if (expectedIdentity !== backendIdentityRef.current) return;
      if (file.size > OPERATOR_DATA_LIMITS.artifactBytes) {
        toast.danger("File is too large", {
          description: `Drop a file no larger than ${formatBytes(String(OPERATOR_DATA_LIMITS.artifactBytes))}.`,
        });
        return;
      }
      const result = await window.sliver.addDroppedLoot(file);
      if (expectedIdentity !== backendIdentityRef.current) return;
      if (!result.ok || !result.value) {
        toast.danger("Could not add loot", { description: result.error });
        return;
      }
      toast.success("Loot added", { description: displayName(result.value) });
      refresh();
    } catch (error) {
      if (expectedIdentity === backendIdentityRef.current) {
        toast.danger("Could not add loot", { description: errorMessage(error) });
      }
    } finally {
      dropPendingRef.current = false;
      setIsDropAdding(false);
    }
  }, [isAdding, isAddOpen, refresh]);

  const openDetail = useCallback(async (item: LootSummary) => {
    wipeDetail();
    setDetailTarget(item);
    setIsLoadingDetail(true);
    const expectedIdentity = backendIdentityRef.current;
    const request = ++detailRequestSequence.current;
    try {
      const result = await window.sliver.getLootDetail(item.id);
      if (
        request !== detailRequestSequence.current ||
        expectedIdentity !== backendIdentityRef.current
      ) return;
      if (!result.ok || !result.value) {
        setDetailError(result.error ?? "The loot preview could not be loaded.");
        return;
      }
      setDetail(result.value);
    } catch (error) {
      if (request === detailRequestSequence.current && expectedIdentity === backendIdentityRef.current) {
        setDetailError(errorMessage(error));
      }
    } finally {
      if (request === detailRequestSequence.current && expectedIdentity === backendIdentityRef.current) {
        setIsLoadingDetail(false);
      }
    }
  }, [wipeDetail]);

  const downloadLoot = useCallback(async (item: LootSummary) => {
    setDownloadingIds((current) => new Set(current).add(item.id));
    try {
      const result = await window.sliver.downloadLoot(item.id);
      if (!result.ok || !result.value) {
        toast.danger("Could not save loot", { description: result.error });
        return;
      }
      if (result.value.saved) {
        toast.success("Loot saved", {
          description: `${result.value.fileName} · ${formatBytes(String(result.value.size))}`,
        });
      } else {
        toast.info("Save cancelled", { description: "The server-side loot was not changed." });
      }
    } catch (error) {
      toast.danger("Could not save loot", { description: errorMessage(error) });
    } finally {
      setDownloadingIds((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  }, []);

  const openRename = useCallback((item: LootSummary) => {
    if (detailTarget?.id === item.id) closeDetail();
    setRenameTarget(item);
    setRenameName(item.name);
    setRenameError(undefined);
  }, [closeDetail, detailTarget?.id]);

  const renameLoot = useCallback(async () => {
    if (!renameTarget) return;
    const nextName = renameName.trim();
    if (!nextName) {
      setRenameError("Enter a server-side display name.");
      return;
    }
    setIsRenaming(true);
    setRenameError(undefined);
    try {
      const result = await window.sliver.renameLoot({ id: renameTarget.id, name: nextName });
      if (!result.ok || !result.value) {
        setRenameError(result.error ?? "The loot item could not be renamed.");
        return;
      }
      toast.success("Loot renamed", { description: displayName(result.value) });
      setRenameTarget(undefined);
      refresh();
    } catch (error) {
      setRenameError(errorMessage(error));
    } finally {
      setIsRenaming(false);
    }
  }, [refresh, renameName, renameTarget]);

  const deleteLoot = useCallback(async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const result = await window.sliver.deleteLoot(deleteTarget.id);
      if (!result.ok) {
        toast.danger("Could not delete loot", { description: result.error });
        return;
      }
      toast.success("Loot deleted", { description: displayName(deleteTarget) });
      if (detailTarget?.id === deleteTarget.id) closeDetail();
      setDeleteTarget(undefined);
      refresh();
    } catch (error) {
      toast.danger("Could not delete loot", { description: errorMessage(error) });
    } finally {
      setIsDeleting(false);
    }
  }, [closeDetail, deleteTarget, detailTarget?.id, refresh]);

  const columns = useMemo<DataGridColumn<LootSummary>[]>(() => [
    {
      id: "name",
      header: "Loot",
      isRowHeader: true,
      allowsSorting: true,
      minWidth: 230,
      sortFn: (left, right) => displayName(left).localeCompare(displayName(right)),
      cell: (item) => (
        <div className="min-w-0 py-1">
          <p className="truncate text-sm font-medium text-foreground">{displayName(item)}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
            {item.fileName && item.fileName !== item.name ? item.fileName : item.id}
          </p>
        </div>
      ),
    },
    {
      id: "type",
      header: "Type",
      accessorKey: "fileType",
      allowsSorting: true,
      minWidth: 110,
      cell: (item) => <Chip size="sm" variant="soft">{item.fileType === "text" ? "Text" : "Binary"}</Chip>,
    },
    {
      id: "size",
      header: "Size",
      allowsSorting: true,
      minWidth: 110,
      sortFn: (left, right) => compareByteStrings(left.sizeBytes, right.sizeBytes),
      cell: (item) => <span className="font-mono text-xs tabular-nums text-muted">{formatBytes(item.sizeBytes)}</span>,
    },
    {
      id: "origin",
      header: "Origin host",
      accessorKey: "originHostId",
      minWidth: 210,
      cell: (item) => (
        <span className="block truncate font-mono text-[11px] text-muted" title={item.originHostId || undefined}>
          {item.originHostId || "Not reported"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "end",
      width: 170,
      cell: (item) => (
        <div className="flex justify-end gap-1">
          <IconAction label={`Inspect ${displayName(item)}`} icon={faEye} onPress={() => void openDetail(item)} />
          <IconAction
            label={`Save ${displayName(item)}`}
            icon={faDownload}
            pending={downloadingIds.has(item.id)}
            onPress={() => void downloadLoot(item)}
          />
          <IconAction label={`Rename ${displayName(item)}`} icon={faPen} onPress={() => openRename(item)} />
          <IconAction label={`Delete ${displayName(item)}`} danger icon={faTrash} onPress={() => setDeleteTarget(item)} />
        </div>
      ),
    },
  ], [downloadLoot, downloadingIds, openDetail, openRename]);

  const previewText = useMemo(
    () => detail?.previewState === "text" ? new TextDecoder().decode(detail.preview) : "",
    [detail],
  );
  const isFiltered = Boolean(normalizedQuery) || fileType !== "all";

  return (
    <section className="page-stack loot-page" aria-labelledby="loot-page-heading">
      <header className="page-heading">
        <div className="min-w-0">
          <h1 id="loot-page-heading">Loot</h1>
          <p>Inspect server-collected files, preview bounded text safely, and save deliberate local copies.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button isDisabled={isDropAdding} variant="primary" onPress={() => setIsAddOpen(true)}>
            <FontAwesomeIcon aria-hidden icon={faPlus} /> Add local file
          </Button>
        </div>
      </header>

      <DropZone className="w-full">
        <DropZone.Area
          aria-label="Drop a local file into loot"
          className="relative w-full items-stretch justify-start gap-0 rounded-2xl border-0 p-0 text-start"
          isDisabled={isAdding || isDropAdding || isAddOpen}
          onDrop={(event) => void addDroppedLoot(event.items)}
        >
          {({ isDropTarget }) => (
            <>
              <Card className="w-full overflow-hidden" variant="secondary">
                <Card.Header className="flex-row items-center gap-3">
                  <span aria-hidden="true" className="section-icon"><FontAwesomeIcon icon={faBoxOpen} /></span>
                  <div className="min-w-0 flex-1">
                    <Card.Title>Server inventory</Card.Title>
                    <Card.Description>
                      {isDropAdding
                        ? "Adding dropped file…"
                        : "Metadata is paged; file contents are fetched only when you inspect or save an item. Drop one local file here to add it."}
                    </Card.Description>
                  </div>
                </Card.Header>

                <Card.Content className="p-0">
                  <div className="flex flex-col gap-3 border-b border-separator px-4 py-4 lg:flex-row lg:items-end lg:justify-between">
                    <SearchField
                      aria-label="Search loot"
                      className="w-full lg:max-w-md"
                      value={query}
                      variant="secondary"
                      onChange={setQuery}
                    >
                      <SearchField.Group>
                        <SearchField.SearchIcon><FontAwesomeIcon aria-hidden icon={faMagnifyingGlass} /></SearchField.SearchIcon>
                        <SearchField.Input
                          maxLength={OPERATOR_DATA_LIMITS.queryCharacters}
                          placeholder="Search name, ID, or origin host"
                        />
                        <SearchField.ClearButton />
                      </SearchField.Group>
                    </SearchField>
                    <LootTypeSelect value={fileType} onChange={setFileType} />
                  </div>

                  {inventory.error ? <InlineError message={inventory.error} /> : null}

                  <DataGrid
                    aria-label="Sliver loot"
                    columns={columns}
                    contentClassName="min-w-[860px]"
                    data={inventory.items}
                    getRowId={(item) => item.id}
                    scrollContainerClassName="max-h-[620px] overflow-auto"
                    variant="secondary"
                    onRowAction={(key) => {
                      const item = inventory.items.find((candidate) => candidate.id === String(key));
                      if (item) void openDetail(item);
                    }}
                    renderEmptyState={() => (
                      <LootEmptyState
                        error={inventory.error}
                        filtered={isFiltered}
                        loading={isLoading}
                      />
                    )}
                  />
                </Card.Content>

                {inventory.page.nextCursor ? (
                  <Card.Footer className="flex items-center justify-between border-t border-separator px-4 py-3">
                    <p className="text-xs text-muted">
                      Showing {inventory.items.length} of {inventory.page.total} {inventory.page.total === 1 ? "item" : "items"}
                    </p>
                    <Button
                      isPending={isLoadingMore}
                      size="sm"
                      variant="secondary"
                      onPress={() => void loadMore()}
                    >
                      Load more
                    </Button>
                  </Card.Footer>
                ) : null}
              </Card>
              {isDropTarget ? (
                <div
                  className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-xl border border-accent bg-accent-soft px-6 py-4 text-center text-accent-soft-foreground"
                  role="status"
                >
                  <FontAwesomeIcon aria-hidden className="text-xl" icon={faUpload} />
                  <p className="text-sm font-semibold">Drop to add loot</p>
                  <p className="text-xs">One local file, up to {formatBytes(String(OPERATOR_DATA_LIMITS.artifactBytes))}</p>
                </div>
              ) : null}
            </>
          )}
        </DropZone.Area>
      </DropZone>

      <AddLootDialog
        fileType={addFileType}
        isOpen={isAddOpen}
        isPending={isAdding}
        name={addName}
        onFileTypeChange={setAddFileType}
        onNameChange={setAddName}
        onOpenChange={(open) => {
          if (isAdding) return;
          setIsAddOpen(open);
          if (!open) {
            setAddName("");
            setAddFileType("auto");
          }
        }}
        onSubmit={() => void addLoot()}
      />

      <LootDetailDialog
        detail={detail}
        error={detailError}
        isDownloading={detailTarget ? downloadingIds.has(detailTarget.id) : false}
        isLoading={isLoadingDetail}
        item={detailTarget}
        previewText={previewText}
        onDelete={(item) => {
          closeDetail();
          setDeleteTarget(item);
        }}
        onDownload={(item) => void downloadLoot(item)}
        onOpenChange={(open) => { if (!open) closeDetail(); }}
        onRename={openRename}
      />

      <RenameLootDialog
        error={renameError}
        isOpen={Boolean(renameTarget)}
        isPending={isRenaming}
        item={renameTarget}
        name={renameName}
        onNameChange={(value) => {
          setRenameName(value);
          if (renameError) setRenameError(undefined);
        }}
        onOpenChange={(open) => {
          if (!open && !isRenaming) {
            setRenameTarget(undefined);
            setRenameError(undefined);
          }
        }}
        onSubmit={() => void renameLoot()}
      />

      <DeleteLootDialog
        isPending={isDeleting}
        item={deleteTarget}
        onOpenChange={(open) => { if (!open && !isDeleting) setDeleteTarget(undefined); }}
        onConfirm={() => void deleteLoot()}
      />
    </section>
  );
}

function AddLootDialog({
  fileType,
  isOpen,
  isPending,
  name,
  onFileTypeChange,
  onNameChange,
  onOpenChange,
  onSubmit,
}: {
  fileType: "auto" | LootFileType;
  isOpen: boolean;
  isPending: boolean;
  name: string;
  onFileTypeChange: (value: "auto" | LootFileType) => void;
  onNameChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
}): React.JSX.Element {
  return (
    <Modal.Backdrop
      isDismissable={!isPending}
      isKeyboardDismissDisabled={isPending}
      isOpen={isOpen}
      variant="blur"
      onOpenChange={onOpenChange}
    >
      <Modal.Container placement="center" size="sm">
        <Modal.Dialog>
          <Modal.CloseTrigger isDisabled={isPending} />
          <Modal.Header className="flex-row items-start pr-10">
            <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
              <FontAwesomeIcon aria-hidden icon={faPlus} className="size-4" />
            </Modal.Icon>
            <div>
              <Modal.Heading>Add local loot</Modal.Heading>
              <p className="mt-0.5 text-xs text-muted">Choose a bounded local file in the native picker, then upload it to the connected server.</p>
            </div>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-4">
            <TextField fullWidth value={name} variant="secondary" onChange={onNameChange}>
              <Label>Display name</Label>
              <Input maxLength={OPERATOR_DATA_LIMITS.nameCharacters} placeholder="Use the selected file name" />
              <Description>Optional. The local path is never exposed to this page.</Description>
            </TextField>
            <Select
              fullWidth
              value={fileType}
              variant="secondary"
              onChange={(value) => {
                if (value === "auto" || value === "text" || value === "binary") onFileTypeChange(value);
              }}
            >
              <Label>File type</Label>
              <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {ADD_FILE_TYPE_OPTIONS.map((option) => (
                    <ListBox.Item id={option.id} key={option.id} textValue={option.label}>
                      {option.label}<ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </Modal.Body>
          <Modal.Footer>
            <Button isDisabled={isPending} size="sm" variant="tertiary" onPress={() => onOpenChange(false)}>Cancel</Button>
            <Button isPending={isPending} size="sm" variant="primary" onPress={onSubmit}>
              <FontAwesomeIcon aria-hidden icon={faPlus} /> Choose file and add
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function LootDetailDialog({
  detail,
  error,
  isDownloading,
  isLoading,
  item,
  previewText,
  onDelete,
  onDownload,
  onOpenChange,
  onRename,
}: {
  detail?: LootDetail | undefined;
  error?: string | undefined;
  isDownloading: boolean;
  isLoading: boolean;
  item?: LootSummary | undefined;
  previewText: string;
  onDelete: (item: LootSummary) => void;
  onDownload: (item: LootSummary) => void;
  onOpenChange: (open: boolean) => void;
  onRename: (item: LootSummary) => void;
}): React.JSX.Element {
  return (
    <Modal.Backdrop isOpen={Boolean(item)} variant="blur" onOpenChange={onOpenChange}>
      <Modal.Container placement="center" scroll="inside" size="lg">
        <Modal.Dialog className="sm:max-w-[780px]">
          <Modal.CloseTrigger />
          <Modal.Header className="flex-row items-start pr-10">
            <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
              <FontAwesomeIcon aria-hidden icon={item?.fileType === "text" ? faFileLines : faFile} className="size-4" />
            </Modal.Icon>
            <div className="min-w-0">
              <Modal.Heading>{item ? displayName(item) : "Loot details"}</Modal.Heading>
              <p className="mt-0.5 truncate font-mono text-[11px] text-muted">{item?.id}</p>
            </div>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-4">
            {item ? (
              <dl className="grid gap-3 rounded-xl border border-separator bg-default p-4 text-xs sm:grid-cols-3">
                <Metadata label="File type" value={item.fileType === "text" ? "Text" : "Binary"} />
                <Metadata label="Size" value={formatBytes(item.sizeBytes)} />
                <Metadata label="Origin host" value={item.originHostId || "Not reported"} mono />
              </dl>
            ) : null}

            {isLoading ? <PreviewMessage icon={faRotate} title="Loading preview" description="Fetching bounded content from the server…" spin /> : null}
            {error ? <InlineError message={error} /> : null}
            {!isLoading && !error && detail?.previewState === "text" ? (
              <div>
                <p className="mb-2 text-xs font-medium text-foreground">Text preview</p>
                <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-separator bg-default p-4 font-mono text-xs leading-5 text-foreground">{previewText}</pre>
              </div>
            ) : null}
            {!isLoading && !error && detail?.previewState === "binary" ? (
              <PreviewMessage icon={faFile} title="Binary content" description="Binary loot is metadata-only here. Save a copy to inspect it with a suitable local tool." />
            ) : null}
            {!isLoading && !error && detail?.previewState === "too-large" ? (
              <PreviewMessage icon={faFile} title="Preview limit reached" description={`This text file exceeds the ${formatBytes(String(OPERATOR_DATA_LIMITS.previewBytes))} preview limit. Save a copy to inspect it.`} />
            ) : null}
            {!isLoading && !error && detail?.previewState === "empty" ? (
              <PreviewMessage icon={faFileLines} title="Empty file" description="This loot item has no content to preview." />
            ) : null}
          </Modal.Body>
          <Modal.Footer className="flex-wrap justify-between gap-2">
            <div className="flex gap-1">
              {item ? (
                <>
                  <IconAction label="Rename loot" icon={faPen} onPress={() => onRename(item)} />
                  <IconAction label="Delete loot" danger icon={faTrash} onPress={() => onDelete(item)} />
                </>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="tertiary" onPress={() => onOpenChange(false)}>Close</Button>
              <Button
                isDisabled={!item}
                isPending={isDownloading}
                size="sm"
                variant="primary"
                onPress={() => { if (item) onDownload(item); }}
              >
                <FontAwesomeIcon aria-hidden icon={faDownload} /> Save a copy
              </Button>
            </div>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function RenameLootDialog({
  error,
  isOpen,
  isPending,
  item,
  name,
  onNameChange,
  onOpenChange,
  onSubmit,
}: {
  error?: string | undefined;
  isOpen: boolean;
  isPending: boolean;
  item?: LootSummary | undefined;
  name: string;
  onNameChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
}): React.JSX.Element {
  return (
    <Modal.Backdrop
      isDismissable={!isPending}
      isKeyboardDismissDisabled={isPending}
      isOpen={isOpen}
      variant="blur"
      onOpenChange={onOpenChange}
    >
      <Modal.Container placement="center" size="sm">
        <Modal.Dialog>
          <Modal.CloseTrigger isDisabled={isPending} />
          <Modal.Header className="flex-row items-start pr-10">
            <Modal.Icon><FontAwesomeIcon aria-hidden icon={faPen} className="size-4" /></Modal.Icon>
            <div>
              <Modal.Heading>Rename loot</Modal.Heading>
              <p className="mt-0.5 text-xs text-muted">The source file name stays unchanged.</p>
            </div>
          </Modal.Header>
          <Modal.Body>
            <TextField fullWidth isInvalid={Boolean(error)} value={name} variant="secondary" onChange={onNameChange}>
              <Label>Display name</Label>
              <Input maxLength={OPERATOR_DATA_LIMITS.nameCharacters} autoFocus />
              <Description>{item?.fileName || item?.id}</Description>
              {error ? <FieldError>{error}</FieldError> : null}
            </TextField>
          </Modal.Body>
          <Modal.Footer>
            <Button isDisabled={isPending} size="sm" variant="tertiary" onPress={() => onOpenChange(false)}>Cancel</Button>
            <Button isPending={isPending} size="sm" variant="primary" onPress={onSubmit}>Rename</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function DeleteLootDialog({
  isPending,
  item,
  onOpenChange,
  onConfirm,
}: {
  isPending: boolean;
  item?: LootSummary | undefined;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <AlertDialog.Backdrop isOpen={Boolean(item)} variant="blur" onOpenChange={onOpenChange}>
      <AlertDialog.Container placement="center" size="sm">
        <AlertDialog.Dialog>
          <AlertDialog.Header>
            <AlertDialog.Icon status="danger">
              <FontAwesomeIcon aria-hidden icon={faTriangleExclamation} className="size-5" />
            </AlertDialog.Icon>
            <AlertDialog.Heading>{item ? `Delete ${displayName(item)}?` : "Delete loot?"}</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <p className="text-sm leading-6 text-muted">
              This removes the server-side file for every operator. Copies already saved locally are not affected. This cannot be undone.
            </p>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button isDisabled={isPending} variant="tertiary" onPress={() => onOpenChange(false)}>Cancel</Button>
            <Button isPending={isPending} variant="danger" onPress={onConfirm}>Delete loot</Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

function LootTypeSelect({
  value,
  onChange,
}: {
  value: LootFileTypeFilter;
  onChange: (value: LootFileTypeFilter) => void;
}): React.JSX.Element {
  return (
    <Select
      aria-label="Filter loot by file type"
      className="w-full lg:w-56"
      value={value}
      variant="secondary"
      onChange={(next) => {
        if (next === "all" || next === "text" || next === "binary") onChange(next);
      }}
    >
      <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
      <Select.Popover>
        <ListBox>
          {FILE_TYPE_OPTIONS.map((option) => (
            <ListBox.Item id={option.id} key={option.id} textValue={option.label}>
              {option.label}<ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

function LootEmptyState({
  error,
  filtered,
  loading,
}: {
  error?: string | undefined;
  filtered: boolean;
  loading: boolean;
}): React.JSX.Element {
  return (
    <EmptyState className="py-14" size="sm">
      <EmptyState.Media><FontAwesomeIcon aria-hidden icon={loading ? faRotate : error ? faCircleExclamation : faBoxOpen} className={loading ? "animate-spin" : undefined} /></EmptyState.Media>
      <EmptyState.Content>
        <EmptyState.Title>{loading ? "Loading loot" : error ? "Loot unavailable" : filtered ? "No loot matches" : "No loot collected"}</EmptyState.Title>
        <EmptyState.Description>
          {loading
            ? "Loading paged metadata from the server…"
            : error
              ? "The inventory will update after the connection recovers."
              : filtered
                ? "Clear the search or choose another file type."
                : "Collected files and local uploads appear here."}
        </EmptyState.Description>
      </EmptyState.Content>
    </EmptyState>
  );
}

function PreviewMessage({
  description,
  icon,
  spin = false,
  title,
}: {
  description: string;
  icon: IconDefinition;
  spin?: boolean;
  title: string;
}): React.JSX.Element {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center rounded-xl border border-separator bg-default px-6 py-10 text-center">
      <FontAwesomeIcon aria-hidden icon={icon} className={`mb-3 size-5 text-muted${spin ? " animate-spin" : ""}`} />
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-md text-xs leading-5 text-muted">{description}</p>
    </div>
  );
}

function InlineError({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 border-b border-danger/20 bg-danger-soft px-4 py-3 text-sm text-danger-soft-foreground" role="alert">
      <FontAwesomeIcon aria-hidden icon={faCircleExclamation} className="mt-0.5 size-3.5 shrink-0" />
      <p>{message}</p>
    </div>
  );
}

function Metadata({ label, mono = false, value }: { label: string; mono?: boolean; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className={`mt-1 truncate text-foreground${mono ? " font-mono text-[11px]" : " font-medium"}`} title={value}>{value}</dd>
    </div>
  );
}

function IconAction({
  danger = false,
  icon,
  label,
  onPress,
  pending = false,
}: {
  danger?: boolean;
  icon: IconDefinition;
  label: string;
  onPress: () => void;
  pending?: boolean;
}): React.JSX.Element {
  return (
    <Tooltip delay={300}>
      <Button
        aria-label={label}
        isIconOnly
        isPending={pending}
        size="sm"
        variant="ghost"
        {...(danger ? { className: "text-danger" } : {})}
        onPress={onPress}
      >
        <FontAwesomeIcon aria-hidden icon={icon} />
      </Button>
      <Tooltip.Content placement="top">{label}</Tooltip.Content>
    </Tooltip>
  );
}

function displayName(item: LootSummary): string {
  return item.name || item.fileName || "Unnamed loot";
}

function mergeLoot(current: readonly LootSummary[], incoming: readonly LootSummary[]): LootSummary[] {
  const items = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) items.set(item.id, item);
  return [...items.values()];
}

function isNativeFileDropItem(value: unknown): value is NativeFileDropItem {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NativeFileDropItem>;
  return candidate.kind === "file" && typeof candidate.getFile === "function";
}

function compareByteStrings(left: string, right: string): number {
  try {
    const leftBytes = BigInt(left);
    const rightBytes = BigInt(right);
    return leftBytes < rightBytes ? -1 : leftBytes > rightBytes ? 1 : 0;
  } catch {
    return left.localeCompare(right);
  }
}

function formatBytes(value: string): string {
  try {
    const bytes = BigInt(value);
    if (bytes < 0n) return value;
    if (bytes < 1024n) return `${bytes} B`;
    const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
    let divisor = 1024n;
    for (const unit of units) {
      const next = divisor * 1024n;
      if (bytes < next || unit === units.at(-1)) {
        const tenths = (bytes * 10n) / divisor;
        return `${tenths / 10n}${tenths % 10n === 0n ? "" : `.${tenths % 10n}`} ${unit}`;
      }
      divisor = next;
    }
    return `${bytes} B`;
  } catch {
    return value || "Unknown";
  }
}

function connectionIdentity(snapshot: SliverSnapshot): string {
  return snapshot.connection.epoch === undefined
    ? "disconnected"
    : `${snapshot.connection.epoch}:${snapshot.connection.incarnation ?? 0}:${snapshot.connection.server ?? ""}:${snapshot.connection.configName ?? ""}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}
