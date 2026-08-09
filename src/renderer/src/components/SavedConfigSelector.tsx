import type { Selection } from "@heroui/react";
import {
  AlertDialog,
  Button,
  Chip,
  Description,
  Input,
  Label,
  ListBox,
  Modal,
  ScrollShadow,
  Spinner,
  TextField,
  Tooltip,
} from "@heroui/react";
import { EmptyState } from "@heroui-pro/react/empty-state";
import {
  faCheck,
  faCircleExclamation,
  faClock,
  faFileCode,
  faFileImport,
  faFolderOpen,
  faRotate,
  faSatelliteDish,
  faServer,
  faTrashCan,
  faUnlink,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { SavedConfigSummary } from "../../../shared/contracts";
import { configEndpoint, formatConfigModifiedAt, safeConfigFilename } from "./saved-config-metadata";

export interface SavedConfigSelectorProps {
  isOpen: boolean;
  configs: readonly SavedConfigSummary[];
  isLoading?: boolean | undefined;
  isConnecting?: boolean | undefined;
  error?: string | undefined;
  onOpenChange: (isOpen: boolean) => void;
  onRefresh: () => void | Promise<void>;
  onConnect: (config: SavedConfigSummary) => void | Promise<void>;
  onChooseFile: () => void | Promise<void>;
  onImport: (displayName: string) => void | Promise<void>;
  onRemove: (config: SavedConfigSummary) => void | Promise<void>;
}

export function SavedConfigSelector({
  isOpen,
  configs,
  isLoading = false,
  isConnecting = false,
  error,
  onOpenChange,
  onRefresh,
  onConnect,
  onChooseFile,
  onImport,
  onRemove,
}: SavedConfigSelectorProps): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isChoosingFile, setIsChoosingFile] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isImportFormOpen, setIsImportFormOpen] = useState(false);
  const [importName, setImportName] = useState("");
  const [importError, setImportError] = useState<string>();
  const [removalCandidate, setRemovalCandidate] = useState<SavedConfigSummary | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string>();

  useEffect(() => {
    if (!isOpen) return;
    setSelectedId((current) => {
      if (current && configs.some((config) => config.id === current)) return current;
      return configs.find((config) => config.availability === "available")?.id ?? configs[0]?.id ?? null;
    });
  }, [configs, isOpen]);

  useEffect(() => {
    if (!removalCandidate || configs.some((config) => config.id === removalCandidate.id)) return;
    setRemovalCandidate(null);
    setRemoveError(undefined);
  }, [configs, removalCandidate]);

  const selectedConfig = useMemo(
    () => configs.find((config) => config.id === selectedId),
    [configs, selectedId],
  );
  const isBusy = isConnecting || isSubmitting || isChoosingFile || isImporting || isRemoving;
  const isCatalogRefreshing = isLoading || isRefreshing;

  const handleSelectionChange = useCallback((selection: Selection) => {
    if (selection === "all") return;
    const key = selection.values().next().value;
    setSelectedId(key === undefined ? null : String(key));
  }, []);

  const refresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, onRefresh]);

  const connect = useCallback(async () => {
    if (!selectedConfig || selectedConfig.availability !== "available" || isBusy || isCatalogRefreshing) return;
    setIsSubmitting(true);
    try {
      await onConnect(selectedConfig);
    } finally {
      setIsSubmitting(false);
    }
  }, [isBusy, isCatalogRefreshing, onConnect, selectedConfig]);

  const chooseFile = useCallback(async () => {
    if (isBusy) return;
    setIsChoosingFile(true);
    try {
      await onChooseFile();
    } finally {
      setIsChoosingFile(false);
    }
  }, [isBusy, onChooseFile]);

  const importConfig = useCallback(async () => {
    const displayName = importName.trim();
    if (!displayName) {
      setImportError("Enter a local name for the imported configuration.");
      return;
    }
    if (isBusy) return;
    setIsImporting(true);
    setImportError(undefined);
    try {
      await onImport(displayName);
      setImportName("");
      setIsImportFormOpen(false);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsImporting(false);
    }
  }, [importName, isBusy, onImport]);

  const removeConfig = useCallback(async () => {
    if (!removalCandidate || isBusy || isCatalogRefreshing) return;
    setIsRemoving(true);
    setRemoveError(undefined);
    try {
      await onRemove(removalCandidate);
      setRemovalCandidate(null);
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRemoving(false);
    }
  }, [isBusy, isCatalogRefreshing, onRemove, removalCandidate]);

  return (
    <>
      <Modal.Backdrop
      isDismissable={!isBusy}
      isKeyboardDismissDisabled={isBusy}
      isOpen={isOpen}
      variant="blur"
      onOpenChange={(nextOpen) => {
        if (!isBusy) onOpenChange(nextOpen);
      }}
    >
      <Modal.Container placement="center" scroll="inside" size="md">
        <Modal.Dialog className="sm:max-w-[600px]">
          <Modal.CloseTrigger isDisabled={isBusy} />
          <Modal.Header className="flex-row items-start pr-8">
            <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
              <FontAwesomeIcon aria-hidden icon={faSatelliteDish} className="size-4" />
            </Modal.Icon>
            <div className="min-w-0 flex-1">
              <Modal.Heading>Connect to Sliver</Modal.Heading>
              <p className="mt-0.5 text-xs font-normal leading-relaxed text-muted">
                Saved mTLS configurations; WireGuard operator transport is deferred
              </p>
            </div>
            <Tooltip delay={300}>
              <Tooltip.Trigger>
                <Button
                  aria-label="Refresh saved configurations"
                  isDisabled={isBusy}
                  isIconOnly
                  isPending={isLoading || isRefreshing}
                  size="sm"
                  variant="ghost"
                  onPress={() => void refresh()}
                >
                  <FontAwesomeIcon aria-hidden icon={faRotate} className="size-3.5" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content placement="bottom">Refresh saved configurations</Tooltip.Content>
            </Tooltip>
          </Modal.Header>

          <Modal.Body className="gap-3">
            {error && configs.length > 0 ? (
              <div
                className="flex items-start gap-2.5 rounded-xl bg-danger-soft px-3 py-2.5 text-sm text-danger-soft-foreground"
                role="alert"
              >
                <FontAwesomeIcon aria-hidden icon={faCircleExclamation} className="mt-0.5 size-3.5 shrink-0" />
                <p className="min-w-0 break-words">{error}</p>
              </div>
            ) : null}

            {isImportFormOpen ? (
              <div className="rounded-xl border border-separator bg-default p-3">
                <div className="flex items-start gap-2.5">
                  <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-soft-foreground">
                    <FontAwesomeIcon aria-hidden icon={faFileImport} className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <TextField
                      fullWidth
                      isInvalid={Boolean(importError)}
                      value={importName}
                      variant="secondary"
                      onChange={(value) => {
                        setImportName(value);
                        setImportError(undefined);
                      }}
                    >
                      <Label>Local configuration name</Label>
                      <Input autoComplete="off" placeholder="Production team" />
                      <Description>The GUI stores a private managed copy under this local name.</Description>
                    </TextField>
                    {importError ? <p className="mt-1 text-xs text-danger" role="alert">{importError}</p> : null}
                    <div className="mt-3 flex justify-end gap-2">
                      <Button
                        isDisabled={isImporting}
                        size="sm"
                        variant="tertiary"
                        onPress={() => {
                          setIsImportFormOpen(false);
                          setImportError(undefined);
                        }}
                      >
                        Cancel import
                      </Button>
                      <Button isPending={isImporting} size="sm" onPress={() => void importConfig()}>
                        Choose file and import
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {isLoading && configs.length === 0 ? (
              <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center" role="status">
                <Spinner aria-label="Loading saved configurations" />
                <div>
                  <p className="text-sm font-medium text-foreground">Finding configurations</p>
                  <p className="mt-1 text-xs text-muted">Scanning your Sliver client directory…</p>
                </div>
              </div>
            ) : error && configs.length === 0 ? (
              <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center" role="alert">
                <span className="grid size-10 place-items-center rounded-xl bg-danger-soft text-danger-soft-foreground">
                  <FontAwesomeIcon aria-hidden icon={faCircleExclamation} className="size-4" />
                </span>
                <p className="mt-3 text-sm font-medium text-foreground">Couldn&apos;t load configurations</p>
                <p className="mt-1 max-w-sm break-words text-xs leading-relaxed text-muted">{error}</p>
                <p className="mt-2 text-[11px] text-muted">Refresh the directory or choose a configuration file.</p>
              </div>
            ) : configs.length === 0 ? (
              <EmptyState size="sm" className="min-h-64">
                <EmptyState.Header>
                  <EmptyState.Media variant="icon">
                    <FontAwesomeIcon aria-hidden icon={faFolderOpen} className="size-4" />
                  </EmptyState.Media>
                  <EmptyState.Title>No saved configurations</EmptyState.Title>
                  <EmptyState.Description className="max-w-sm">
                    Add an operator configuration to ~/.sliver-client/configs, refresh this list, or choose one from another location.
                  </EmptyState.Description>
                </EmptyState.Header>
              </EmptyState>
            ) : (
              <ScrollShadow hideScrollBar className="max-h-[22rem] overflow-y-auto rounded-2xl bg-surface-secondary p-1">
                <ListBox
                  aria-label="Saved Sliver configurations"
                  className="w-full"
                  selectedKeys={selectedId ? new Set([selectedId]) : new Set()}
                  selectionMode="single"
                  onAction={(key) => setSelectedId(String(key))}
                  onSelectionChange={handleSelectionChange}
                >
                  {configs.map((config) => (
                    <ListBox.Item
                      className="rounded-xl px-3 py-3 data-[selected=true]:bg-surface"
                      id={config.id}
                      isDisabled={isCatalogRefreshing || config.availability !== "available"}
                      key={config.id}
                      textValue={`${config.operator} ${config.displayName} ${safeConfigFilename(config.fileName)} ${configEndpoint(config.lhost, config.lport)}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <Label className="truncate text-sm font-semibold text-foreground">
                            {config.operator || "Unknown operator"}
                          </Label>
                          <Chip size="sm" variant="soft" className="shrink-0">
                            <Chip.Label>{config.transport === "wireguard" ? "WireGuard" : "mTLS"}</Chip.Label>
                          </Chip>
                          <Chip
                            color={config.availability === "available" ? "default" : "warning"}
                            size="sm"
                            variant="soft"
                            className="shrink-0"
                          >
                            <Chip.Label>
                              {config.availability === "available"
                                ? config.origin === "managed" ? "Imported" : "Existing"
                                : "Deferred"}
                            </Chip.Label>
                          </Chip>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <FontAwesomeIcon aria-hidden icon={faFileCode} className="size-3 shrink-0" />
                            <span className="max-w-48 truncate" title={safeConfigFilename(config.fileName)}>
                              {safeConfigFilename(config.fileName)}
                            </span>
                          </span>
                          <span className="flex items-center gap-1.5 font-mono tabular-nums">
                            <FontAwesomeIcon aria-hidden icon={faServer} className="size-3 shrink-0" />
                            {configEndpoint(config.lhost, config.lport)}
                          </span>
                          <span className="flex items-center gap-1.5">
                            <FontAwesomeIcon aria-hidden icon={faClock} className="size-3 shrink-0" />
                            <time dateTime={config.modifiedAt}>{formatConfigModifiedAt(config.modifiedAt)}</time>
                          </span>
                        </div>
                        {config.unavailableReason ? (
                          <p className="mt-1.5 text-[11px] leading-relaxed text-warning-soft-foreground">
                            {config.unavailableReason}
                          </p>
                        ) : null}
                      </div>
                      <ListBox.ItemIndicator className="shrink-0 text-accent">
                        {({ isSelected }) => isSelected ? (
                          <FontAwesomeIcon aria-hidden icon={faCheck} className="size-3.5" />
                        ) : null}
                      </ListBox.ItemIndicator>
                    </ListBox.Item>
                  ))}
                </ListBox>
              </ScrollShadow>
            )}
          </Modal.Body>

          <Modal.Footer className="flex-wrap items-center gap-2">
            <Button
              isDisabled={isBusy || isImportFormOpen}
              size="sm"
              variant="outline"
              onPress={() => setIsImportFormOpen(true)}
            >
              <FontAwesomeIcon aria-hidden icon={faFileImport} className="size-3.5" />
              Import a copy
            </Button>
            <Button
              isDisabled={isBusy}
              isPending={isChoosingFile}
              size="sm"
              variant="tertiary"
              onPress={() => void chooseFile()}
            >
              <FontAwesomeIcon aria-hidden icon={faFolderOpen} className="size-3.5" />
              Connect external file
            </Button>
            {selectedConfig ? (
              <Button
                isDisabled={isBusy || isCatalogRefreshing}
                size="sm"
                variant="danger-soft"
                onPress={() => {
                  setRemoveError(undefined);
                  setRemovalCandidate(selectedConfig);
                }}
              >
                <FontAwesomeIcon
                  aria-hidden
                  icon={selectedConfig.removal === "delete-managed-copy" ? faTrashCan : faUnlink}
                  className="size-3.5"
                />
                {selectedConfig.removal === "delete-managed-copy" ? "Delete copy" : "Forget"}
              </Button>
            ) : null}
            <div className="ml-auto flex items-center gap-2">
              <Button isDisabled={isBusy} size="sm" variant="tertiary" onPress={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                isDisabled={
                  !selectedConfig ||
                  selectedConfig.availability !== "available" ||
                  isBusy ||
                  isCatalogRefreshing
                }
                isPending={isConnecting || isSubmitting}
                size="sm"
                variant="primary"
                onPress={() => void connect()}
              >
                Connect
              </Button>
            </div>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
      </Modal.Backdrop>

      <AlertDialog.Backdrop
        isOpen={removalCandidate !== null}
        onOpenChange={(open) => {
          if (!open && !isRemoving) {
            setRemovalCandidate(null);
            setRemoveError(undefined);
          }
        }}
      >
        <AlertDialog.Container placement="center" size="sm">
          <AlertDialog.Dialog className="sm:max-w-[440px]">
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger">
                <FontAwesomeIcon
                  aria-hidden
                  icon={removalCandidate?.removal === "delete-managed-copy" ? faTrashCan : faUnlink}
                  className="size-4"
                />
              </AlertDialog.Icon>
              <AlertDialog.Heading>
                {removalCandidate?.removal === "delete-managed-copy"
                  ? "Delete this imported copy?"
                  : "Forget this configuration?"}
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-sm leading-relaxed text-muted">
                {removalCandidate?.removal === "delete-managed-copy"
                  ? `Delete the GUI-managed private copy “${removalCandidate.displayName}”? This does not change the Sliver server.`
                  : `Detach “${removalCandidate?.displayName ?? "this configuration"}” from the GUI catalog? Its existing source file remains on disk.`}
              </p>
              {removeError ? <p className="mt-3 text-sm text-danger" role="alert">{removeError}</p> : null}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button
                isDisabled={isRemoving}
                size="sm"
                variant="tertiary"
                onPress={() => setRemovalCandidate(null)}
              >
                Cancel
              </Button>
              <Button
                isDisabled={isRemoving}
                isPending={isRemoving}
                size="sm"
                variant="danger"
                onPress={() => void removeConfig()}
              >
                {removalCandidate?.removal === "delete-managed-copy" ? "Delete managed copy" : "Forget only"}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  );
}
