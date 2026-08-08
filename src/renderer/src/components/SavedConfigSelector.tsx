import type { Selection } from "@heroui/react";
import {
  Button,
  Chip,
  Label,
  ListBox,
  Modal,
  ScrollShadow,
  Spinner,
  Tooltip,
} from "@heroui/react";
import { EmptyState } from "@heroui-pro/react/empty-state";
import {
  faCheck,
  faCircleExclamation,
  faClock,
  faFileCode,
  faFolderOpen,
  faRotate,
  faSatelliteDish,
  faServer,
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
}: SavedConfigSelectorProps): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isChoosingFile, setIsChoosingFile] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedId((current) => {
      if (current && configs.some((config) => config.id === current)) return current;
      return configs[0]?.id ?? null;
    });
  }, [configs, isOpen]);

  const selectedConfig = useMemo(
    () => configs.find((config) => config.id === selectedId),
    [configs, selectedId],
  );
  const isBusy = isConnecting || isSubmitting || isChoosingFile;

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
    if (!selectedConfig || isBusy) return;
    setIsSubmitting(true);
    try {
      await onConnect(selectedConfig);
    } finally {
      setIsSubmitting(false);
    }
  }, [isBusy, onConnect, selectedConfig]);

  const chooseFile = useCallback(async () => {
    if (isBusy) return;
    setIsChoosingFile(true);
    try {
      await onChooseFile();
    } finally {
      setIsChoosingFile(false);
    }
  }, [isBusy, onChooseFile]);

  return (
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
                Saved operator configurations from ~/.sliver-client/configs
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

          <Modal.Footer className="flex-wrap items-center justify-between gap-3">
            <Button
              isDisabled={isBusy}
              isPending={isChoosingFile}
              size="sm"
              variant="outline"
              onPress={() => void chooseFile()}
            >
              <FontAwesomeIcon aria-hidden icon={faFolderOpen} className="size-3.5" />
              Choose configuration file
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Button isDisabled={isBusy} size="sm" variant="tertiary" onPress={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                isDisabled={!selectedConfig || isBusy}
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
  );
}
