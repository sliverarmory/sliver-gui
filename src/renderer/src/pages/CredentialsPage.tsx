import { useCallback, useEffect, useRef, useState } from "react";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faChevronDown,
  faCircleNotch,
  faCopy,
  faEye,
  faEyeSlash,
  faKey,
  faLock,
  faMagnifyingGlass,
  faPlus,
  faRotate,
  faShieldHalved,
  faTrash,
  faUnlockKeyhole,
} from "@fortawesome/free-solid-svg-icons";
import {
  Button,
  Card,
  Chip,
  Description,
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

import type { SliverSnapshot } from "../../../shared/contracts";
import {
  OPERATOR_DATA_LIMITS,
  type CredentialCatalogPage,
  type CredentialClipboardResult,
  type CredentialHashTypeOption,
  type CredentialKindFilter,
  type CredentialSecretField,
  type CredentialSecretReveal,
  type CredentialSummary,
  type OperatorDataPageSummary,
} from "../../../shared/operator-data-contracts";
import { ConfirmDialog } from "../components/ConfirmDialog";

interface CredentialsPageProps {
  snapshot: SliverSnapshot;
}

interface CredentialInventory {
  identity: string;
  items: CredentialSummary[];
  page: OperatorDataPageSummary;
  collections: string[];
  hashTypes: CredentialHashTypeOption[];
}

interface ClipboardNotice extends CredentialClipboardResult {
  field: CredentialSecretField;
}

const EMPTY_PAGE: OperatorDataPageSummary = {
  limit: OPERATOR_DATA_LIMITS.pageSize,
  total: 0,
  truncated: false,
};

const KIND_OPTIONS: readonly { value: CredentialKindFilter; label: string }[] = [
  { value: "all", label: "All credentials" },
  { value: "plaintext", label: "Plaintext available" },
  { value: "hash", label: "Hash available" },
  { value: "cracked", label: "Cracked hashes" },
];

const SECRET_DECODER = new TextDecoder();

export function CredentialsPage({ snapshot }: CredentialsPageProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<CredentialKindFilter>("all");
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [inventory, setInventory] = useState<CredentialInventory>(() => emptyInventory("initial"));
  const [inventoryError, setInventoryError] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [hashType, setHashType] = useState<number | null>(null);
  const [selectedCredential, setSelectedCredential] = useState<CredentialSummary>();
  const [deleteTarget, setDeleteTarget] = useState<CredentialSummary>();
  const [isDeleting, setIsDeleting] = useState(false);
  const [revealPending, setRevealPending] = useState<CredentialSecretField>();
  const [revealedSecret, setRevealedSecret] = useState<CredentialSecretReveal>();
  const [clipboardNotice, setClipboardNotice] = useState<ClipboardNotice>();

  const usernameInputRef = useRef<HTMLInputElement>(null);
  const collectionInputRef = useRef<HTMLInputElement>(null);
  const plaintextInputRef = useRef<HTMLInputElement>(null);
  const hashInputRef = useRef<HTMLInputElement>(null);
  const listRequestSequence = useRef(0);
  const revealRequestSequence = useRef(0);
  const revealedSecretRef = useRef<CredentialSecretReveal | undefined>(undefined);
  revealedSecretRef.current = revealedSecret;
  const selectedCredentialRef = useRef<CredentialSummary | undefined>(undefined);
  selectedCredentialRef.current = selectedCredential;

  const backendIdentity = credentialBackendIdentity(snapshot);
  const backendIdentityRef = useRef(backendIdentity);
  backendIdentityRef.current = backendIdentity;
  const catalogIdentity = `${backendIdentity}\0${query}\0${kind}`;
  const catalogIdentityRef = useRef(catalogIdentity);
  catalogIdentityRef.current = catalogIdentity;
  const isConnected = isUsableConnection(snapshot.connection.status);
  const visibleInventory = inventory.identity === catalogIdentity
    ? inventory
    : emptyInventory(catalogIdentity);

  const clearRevealedSecret = useCallback(() => {
    revealRequestSequence.current += 1;
    revealedSecretRef.current?.value.fill(0);
    revealedSecretRef.current = undefined;
    setRevealedSecret(undefined);
    setRevealPending(undefined);
  }, []);

  const clearAddInputs = useCallback(() => {
    clearNativeInput(usernameInputRef.current);
    clearNativeInput(collectionInputRef.current);
    clearNativeInput(plaintextInputRef.current);
    clearNativeInput(hashInputRef.current);
    setHashType(null);
  }, []);

  useEffect(() => {
    const requestIdentity = catalogIdentity;
    const requestSequence = ++listRequestSequence.current;
    const delay = query.length > 0 ? 180 : 0;

    if (!isConnected) {
      setInventory(emptyInventory(requestIdentity));
      setInventoryError(undefined);
      setIsLoading(false);
      setIsLoadingMore(false);
      return;
    }

    setIsLoading(true);
    setIsLoadingMore(false);
    setInventoryError(undefined);
    const timer = window.setTimeout(() => {
      void window.sliver.listCredentials({
        query,
        kind,
        limit: OPERATOR_DATA_LIMITS.pageSize,
      }).then((result) => {
        if (
          requestSequence !== listRequestSequence.current ||
          requestIdentity !== catalogIdentityRef.current
        ) return;
        if (!result.ok || !result.value) {
          setInventory(emptyInventory(requestIdentity));
          setInventoryError(result.error ?? "The credential inventory could not be loaded.");
          return;
        }
        setInventory(inventoryFromPage(requestIdentity, result.value));
      }).catch((error: unknown) => {
        if (
          requestSequence === listRequestSequence.current &&
          requestIdentity === catalogIdentityRef.current
        ) {
          setInventory(emptyInventory(requestIdentity));
          setInventoryError(errorMessage(error));
        }
      }).finally(() => {
        if (
          requestSequence === listRequestSequence.current &&
          requestIdentity === catalogIdentityRef.current
        ) setIsLoading(false);
      });
    }, delay);

    return () => window.clearTimeout(timer);
  }, [catalogIdentity, isConnected, kind, query, refreshSequence]);

  useEffect(() => {
    clearRevealedSecret();
    setSelectedCredential(undefined);
    setDeleteTarget(undefined);
    setClipboardNotice(undefined);
    clearAddInputs();
    setIsCreateOpen(false);
  }, [backendIdentity, clearAddInputs, clearRevealedSecret]);

  useEffect(() => {
    const onBlur = () => clearRevealedSecret();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [clearRevealedSecret]);

  useEffect(() => () => {
    clearRevealedSecret();
    clearAddInputs();
  }, [clearAddInputs, clearRevealedSecret]);

  useEffect(() => {
    if (!clipboardNotice) return;
    const expiresAt = Date.parse(clipboardNotice.expiresAt);
    const delay = Number.isFinite(expiresAt)
      ? Math.max(0, Math.min(expiresAt - Date.now(), 2_147_483_647))
      : 0;
    const timer = window.setTimeout(() => setClipboardNotice(undefined), delay);
    return () => window.clearTimeout(timer);
  }, [clipboardNotice]);

  async function loadMore(): Promise<void> {
    const cursor = visibleInventory.page.nextCursor;
    if (!cursor || isLoadingMore) return;
    const requestIdentity = catalogIdentityRef.current;
    const requestSequence = ++listRequestSequence.current;
    setIsLoadingMore(true);
    try {
      const result = await window.sliver.listCredentials({
        query,
        kind,
        cursor,
        limit: OPERATOR_DATA_LIMITS.pageSize,
      });
      if (
        requestSequence !== listRequestSequence.current ||
        requestIdentity !== catalogIdentityRef.current
      ) return;
      if (!result.ok || !result.value) {
        toast.danger("Could not load more credentials", {
          description: result.error ?? "The server rejected the inventory request.",
        });
        return;
      }
      setInventory((current) => current.identity === requestIdentity
        ? {
            identity: requestIdentity,
            items: appendUniqueCredentials(current.items, result.value.items),
            page: result.value.page,
            collections: result.value.collections,
            hashTypes: result.value.hashTypes,
          }
        : current);
    } catch (error) {
      if (
        requestSequence === listRequestSequence.current &&
        requestIdentity === catalogIdentityRef.current
      ) {
        toast.danger("Could not load more credentials", { description: errorMessage(error) });
      }
    } finally {
      if (
        requestSequence === listRequestSequence.current &&
        requestIdentity === catalogIdentityRef.current
      ) setIsLoadingMore(false);
    }
  }

  function openCredential(credential: CredentialSummary): void {
    clearRevealedSecret();
    setSelectedCredential(credential);
  }

  function closeCredential(): void {
    clearRevealedSecret();
    setSelectedCredential(undefined);
  }

  async function revealSecret(field: CredentialSecretField): Promise<void> {
    const credential = selectedCredentialRef.current;
    if (!credential || revealPending) return;
    clearRevealedSecret();
    const requestSequence = ++revealRequestSequence.current;
    const requestIdentity = backendIdentityRef.current;
    const credentialId = credential.id;
    setRevealPending(field);
    try {
      const result = await window.sliver.revealCredentialSecret({ id: credentialId, field });
      const value = result.value;
      if (
        requestSequence !== revealRequestSequence.current ||
        requestIdentity !== backendIdentityRef.current ||
        selectedCredentialRef.current?.id !== credentialId
      ) {
        value?.value.fill(0);
        return;
      }
      if (!result.ok || !value) {
        toast.danger("Secret could not be revealed", {
          description: result.error ?? "The server did not return this credential field.",
        });
        return;
      }
      if (value.item.id !== credentialId || value.field !== field) {
        value.value.fill(0);
        toast.danger("Secret could not be revealed", {
          description: "The response did not match the selected credential.",
        });
        return;
      }
      revealedSecretRef.current = value;
      setRevealedSecret(value);
    } catch (error) {
      if (
        requestSequence === revealRequestSequence.current &&
        requestIdentity === backendIdentityRef.current
      ) toast.danger("Secret could not be revealed", { description: errorMessage(error) });
    } finally {
      if (requestSequence === revealRequestSequence.current) setRevealPending(undefined);
    }
  }

  async function copySecret(field: CredentialSecretField): Promise<void> {
    const credential = selectedCredentialRef.current;
    if (!credential) return;
    const requestIdentity = backendIdentityRef.current;
    try {
      const result = await window.sliver.copyCredentialSecret({ id: credential.id, field });
      if (requestIdentity !== backendIdentityRef.current || selectedCredentialRef.current?.id !== credential.id) return;
      if (!result.ok || !result.value) {
        toast.danger("Secret could not be copied", {
          description: result.error ?? "The clipboard request was rejected.",
        });
        return;
      }
      setClipboardNotice({ ...result.value, field });
      toast.success(`${secretFieldLabel(field)} copied`, {
        description: `The clipboard will be cleared ${formatExpiry(result.value.expiresAt)}.`,
      });
    } catch (error) {
      if (requestIdentity === backendIdentityRef.current) {
        toast.danger("Secret could not be copied", { description: errorMessage(error) });
      }
    }
  }

  async function clearCredentialClipboard(): Promise<void> {
    try {
      const result = await window.sliver.clearCredentialClipboard();
      if (!result.ok) {
        toast.danger("Clipboard could not be cleared", { description: result.error });
        return;
      }
      setClipboardNotice(undefined);
      toast.success("Credential clipboard cleared");
    } catch (error) {
      toast.danger("Clipboard could not be cleared", { description: errorMessage(error) });
    }
  }

  async function addCredential(): Promise<void> {
    if (isAdding) return;
    const username = usernameInputRef.current?.value ?? "";
    const collection = collectionInputRef.current?.value ?? "";
    const plaintext = consumeSecretInput(plaintextInputRef.current);
    const hash = consumeSecretInput(hashInputRef.current);

    if (plaintext.byteLength === 0 && hash.byteLength === 0) {
      plaintext.fill(0);
      hash.fill(0);
      toast.danger("Credential value required", {
        description: "Enter a plaintext value, a hash, or both.",
      });
      return;
    }

    const requestIdentity = backendIdentityRef.current;
    setIsAdding(true);
    try {
      const result = await window.sliver.addCredential({
        username,
        collection,
        plaintext,
        hash,
        hashType,
      });
      if (requestIdentity !== backendIdentityRef.current) return;
      if (!result.ok) {
        toast.danger("Credential could not be added", {
          description: result.error ?? "The server rejected the credential.",
        });
        return;
      }
      clearAddInputs();
      setIsCreateOpen(false);
      setRefreshSequence((current) => current + 1);
      toast.success("Credential added", {
        description: username || collection || "The server credential store was updated.",
      });
    } catch (error) {
      if (requestIdentity === backendIdentityRef.current) {
        toast.danger("Credential could not be added", { description: errorMessage(error) });
      }
    } finally {
      plaintext.fill(0);
      hash.fill(0);
      setIsAdding(false);
    }
  }

  async function deleteCredential(): Promise<boolean> {
    if (!deleteTarget || isDeleting) return false;
    const target = deleteTarget;
    const requestIdentity = backendIdentityRef.current;
    setIsDeleting(true);
    try {
      const result = await window.sliver.deleteCredential(target.id);
      if (requestIdentity !== backendIdentityRef.current) return false;
      if (!result.ok) {
        toast.danger("Credential could not be deleted", {
          description: result.error ?? "The server rejected the delete request.",
        });
        return false;
      }
      if (selectedCredentialRef.current?.id === target.id) closeCredential();
      setDeleteTarget(undefined);
      setRefreshSequence((current) => current + 1);
      toast.success("Credential deleted", { description: credentialDisplayName(target) });
      return true;
    } catch (error) {
      if (requestIdentity === backendIdentityRef.current) {
        toast.danger("Credential could not be deleted", { description: errorMessage(error) });
      }
      return false;
    } finally {
      setIsDeleting(false);
    }
  }

  const columns: DataGridColumn<CredentialSummary>[] = [
    {
      id: "credential",
      header: "Credential",
      accessorKey: "username",
      isRowHeader: true,
      allowsSorting: true,
      minWidth: 210,
      cell: (credential) => (
        <div className="min-w-0 py-1">
          <p className="truncate font-medium text-foreground">{credential.username || "Unnamed credential"}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted">{credential.id}</p>
        </div>
      ),
    },
    {
      id: "kind",
      header: "Stored value",
      minWidth: 150,
      cell: (credential) => <CredentialKindChips credential={credential} />,
    },
    {
      id: "hashType",
      header: "Hash type",
      accessorKey: "hashTypeName",
      allowsSorting: true,
      minWidth: 150,
      cell: (credential) => (
        <span className="font-mono text-xs text-muted">
          {credential.hasHash ? credential.hashTypeName || `Type ${credential.hashType}` : "—"}
        </span>
      ),
    },
    {
      id: "collection",
      header: "Collection",
      accessorKey: "collection",
      allowsSorting: true,
      minWidth: 150,
      cell: (credential) => <span className="text-sm text-muted">{credential.collection || "Unassigned"}</span>,
    },
    {
      id: "origin",
      header: "Origin host",
      accessorKey: "originHostId",
      minWidth: 170,
      cell: (credential) => (
        <span className="block max-w-48 truncate font-mono text-[11px] text-muted">
          {credential.originHostId || "—"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "end",
      width: 96,
      cell: (credential) => (
        <div className="flex justify-end gap-1">
          <IconAction label="View credential" icon={faEye} onPress={() => openCredential(credential)} />
          <IconAction
            danger
            label="Delete credential"
            icon={faTrash}
            onPress={() => setDeleteTarget(credential)}
          />
        </div>
      ),
    },
  ];

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <h1>Credentials</h1>
          <p>Browse server-side credential metadata and reveal secret values only when they are needed.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Tooltip delay={350}>
            <Button
              aria-label="Refresh credentials"
              isIconOnly
              isPending={isLoading}
              variant="secondary"
              onPress={() => setRefreshSequence((current) => current + 1)}
            >
              <FontAwesomeIcon aria-hidden icon={faRotate} />
            </Button>
            <Tooltip.Content placement="bottom">Refresh credentials</Tooltip.Content>
          </Tooltip>
          <Button isDisabled={!isConnected} onPress={() => setIsCreateOpen(true)}>
            <FontAwesomeIcon aria-hidden icon={faPlus} /> Add credential
          </Button>
        </div>
      </section>

      <Card variant="secondary" className="overflow-hidden">
        <Card.Header className="flex-row items-center gap-3">
          <span aria-hidden="true" className="section-icon"><FontAwesomeIcon icon={faShieldHalved} /></span>
          <div className="min-w-0 flex-1">
            <Card.Title>Credential inventory</Card.Title>
            <Card.Description>
              {inventoryCountLabel(visibleInventory.items.length, visibleInventory.page.total)}. Secret values are redacted.
            </Card.Description>
          </div>
        </Card.Header>

        <Card.Content className="p-0">
          <div className="flex flex-col gap-3 border-b border-separator px-4 py-4 lg:flex-row lg:items-end lg:justify-between">
            <SearchField
              aria-label="Search credentials"
              className="w-full lg:max-w-md"
              value={query}
              variant="secondary"
              onChange={setQuery}
            >
              <SearchField.Group>
                <SearchField.SearchIcon><FontAwesomeIcon aria-hidden icon={faMagnifyingGlass} /></SearchField.SearchIcon>
                <SearchField.Input
                  maxLength={OPERATOR_DATA_LIMITS.queryCharacters}
                  placeholder="Search username, collection, host, type, or ID"
                />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>

            <Select
              aria-label="Filter credential type"
              className="w-full lg:w-56"
              value={kind}
              variant="secondary"
              onChange={(value) => {
                if (isCredentialKind(value)) setKind(value);
              }}
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator><FontAwesomeIcon aria-hidden className="size-3" icon={faChevronDown} /></Select.Indicator>
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {KIND_OPTIONS.map((option) => (
                    <ListBox.Item id={option.value} key={option.value} textValue={option.label}>
                      {option.label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>

          {inventoryError ? (
            <div className="border-b border-danger/25 bg-danger-soft px-4 py-3 text-sm text-danger-soft-foreground" role="alert">
              <p className="font-medium">Credential inventory unavailable</p>
              <p className="mt-0.5 text-xs opacity-85">{inventoryError}</p>
            </div>
          ) : null}

          <DataGrid
            aria-label="Sliver credentials"
            columns={columns}
            contentClassName="min-w-[940px]"
            data={visibleInventory.items}
            getRowId={(credential) => credential.id}
            scrollContainerClassName="max-h-[620px] overflow-auto"
            variant="secondary"
            renderEmptyState={() => (
              <CredentialEmptyState
                error={inventoryError}
                filtered={query.length > 0 || kind !== "all"}
                loading={isLoading}
              />
            )}
          />
        </Card.Content>

        {visibleInventory.page.nextCursor ? (
          <Card.Footer className="flex items-center justify-between border-t border-separator px-4 py-3">
            <p className="text-xs text-muted">
              Showing {visibleInventory.items.length} of {visibleInventory.page.total} metadata records.
            </p>
            <Button size="sm" variant="tertiary" isPending={isLoadingMore} onPress={() => void loadMore()}>
              Load more
            </Button>
          </Card.Footer>
        ) : null}
      </Card>

      <CredentialDetailModal
        clipboardNotice={clipboardNotice}
        credential={selectedCredential}
        pendingField={revealPending}
        revealedSecret={revealedSecret}
        onClearClipboard={() => void clearCredentialClipboard()}
        onCopy={(field) => void copySecret(field)}
        onDelete={(credential) => setDeleteTarget(credential)}
        onHide={clearRevealedSecret}
        onOpenChange={(open) => { if (!open) closeCredential(); }}
        onReveal={(field) => void revealSecret(field)}
      />

      <AddCredentialModal
        collectionInputRef={collectionInputRef}
        hashInputRef={hashInputRef}
        hashType={hashType}
        hashTypes={visibleInventory.hashTypes}
        isOpen={isCreateOpen}
        isPending={isAdding}
        plaintextInputRef={plaintextInputRef}
        usernameInputRef={usernameInputRef}
        onAdd={() => void addCredential()}
        onHashTypeChange={setHashType}
        onOpenChange={(open) => {
          if (isAdding) return;
          if (!open) clearAddInputs();
          setIsCreateOpen(open);
        }}
      />

      <ConfirmDialog
        isOpen={Boolean(deleteTarget)}
        title={deleteTarget ? `Delete ${credentialDisplayName(deleteTarget)}?` : "Delete credential?"}
        description="The credential and its stored secret values will be removed from the server. This cannot be undone."
        confirmLabel="Delete credential"
        isPending={isDeleting}
        onConfirm={deleteCredential}
        onOpenChange={(open) => { if (!open) setDeleteTarget(undefined); }}
      />
    </div>
  );
}

function CredentialDetailModal({
  credential,
  pendingField,
  revealedSecret,
  clipboardNotice,
  onOpenChange,
  onReveal,
  onHide,
  onCopy,
  onClearClipboard,
  onDelete,
}: {
  credential: CredentialSummary | undefined;
  pendingField: CredentialSecretField | undefined;
  revealedSecret: CredentialSecretReveal | undefined;
  clipboardNotice: ClipboardNotice | undefined;
  onOpenChange: (open: boolean) => void;
  onReveal: (field: CredentialSecretField) => void;
  onHide: () => void;
  onCopy: (field: CredentialSecretField) => void;
  onClearClipboard: () => void;
  onDelete: (credential: CredentialSummary) => void;
}): React.JSX.Element {
  return (
    <Modal.Backdrop isOpen={Boolean(credential)} variant="blur" onOpenChange={onOpenChange}>
      <Modal.Container placement="center" scroll="inside" size="lg">
        <Modal.Dialog className="sm:max-w-[720px]">
          <Modal.CloseTrigger />
          <Modal.Header className="flex-row items-start pr-8">
            <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
              <FontAwesomeIcon aria-hidden icon={faKey} className="size-4" />
            </Modal.Icon>
            <div className="min-w-0 flex-1">
              <Modal.Heading>{credential ? credentialDisplayName(credential) : "Credential"}</Modal.Heading>
              <p className="mt-0.5 truncate font-mono text-[11px] font-normal text-muted">{credential?.id}</p>
            </div>
          </Modal.Header>

          <Modal.Body className="flex flex-col gap-5">
            {credential ? (
              <>
                <dl className="grid gap-3 rounded-xl border border-separator bg-default/40 p-4 sm:grid-cols-2">
                  <Metadata label="Username" value={credential.username || "Unnamed"} />
                  <Metadata label="Collection" value={credential.collection || "Unassigned"} />
                  <Metadata label="Hash type" value={credential.hasHash ? credential.hashTypeName || `Type ${credential.hashType}` : "Not stored"} mono />
                  <Metadata label="Origin host" value={credential.originHostId || "Unknown"} mono />
                </dl>

                <div className="rounded-xl border border-warning/25 bg-warning-soft px-4 py-3 text-sm text-warning-soft-foreground">
                  <div className="flex gap-3">
                    <FontAwesomeIcon aria-hidden icon={faLock} className="mt-0.5 size-3.5 shrink-0" />
                    <div>
                      <p className="font-medium">Secret values stay redacted by default</p>
                      <p className="mt-0.5 text-xs leading-5 opacity-85">
                        Reveal one field temporarily, or copy it through the main process. Revealed bytes are discarded when this window loses focus.
                      </p>
                    </div>
                  </div>
                </div>

                <SecretFieldPanel
                  available={credential.hasPlaintext}
                  clipboardActive={clipboardNotice?.field === "plaintext"}
                  field="plaintext"
                  pending={pendingField === "plaintext"}
                  revealed={revealedSecret?.field === "plaintext" ? revealedSecret : undefined}
                  onClearClipboard={onClearClipboard}
                  onCopy={() => onCopy("plaintext")}
                  onHide={onHide}
                  onReveal={() => onReveal("plaintext")}
                />
                <SecretFieldPanel
                  available={credential.hasHash}
                  clipboardActive={clipboardNotice?.field === "hash"}
                  field="hash"
                  pending={pendingField === "hash"}
                  revealed={revealedSecret?.field === "hash" ? revealedSecret : undefined}
                  onClearClipboard={onClearClipboard}
                  onCopy={() => onCopy("hash")}
                  onHide={onHide}
                  onReveal={() => onReveal("hash")}
                />
              </>
            ) : null}
          </Modal.Body>

          <Modal.Footer className="items-center justify-between gap-3">
            <Button
              className="text-danger"
              isDisabled={!credential}
              variant="ghost"
              onPress={() => { if (credential) onDelete(credential); }}
            >
              <FontAwesomeIcon aria-hidden icon={faTrash} /> Delete
            </Button>
            <Button variant="secondary" onPress={() => onOpenChange(false)}>Done</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function SecretFieldPanel({
  field,
  available,
  pending,
  revealed,
  clipboardActive,
  onReveal,
  onHide,
  onCopy,
  onClearClipboard,
}: {
  field: CredentialSecretField;
  available: boolean;
  pending: boolean;
  revealed: CredentialSecretReveal | undefined;
  clipboardActive: boolean;
  onReveal: () => void;
  onHide: () => void;
  onCopy: () => void;
  onClearClipboard: () => void;
}): React.JSX.Element {
  const label = secretFieldLabel(field);
  return (
    <section className="rounded-xl border border-separator bg-surface p-4" aria-label={`${label} secret controls`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{label}</h3>
          <p className="mt-0.5 text-xs text-muted">
            {available ? "Stored on the connected server." : "This credential does not contain this field."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {revealed ? (
            <Button size="sm" variant="secondary" onPress={onHide}>
              <FontAwesomeIcon aria-hidden icon={faEyeSlash} /> Hide
            </Button>
          ) : (
            <Button size="sm" isDisabled={!available} isPending={pending} variant="secondary" onPress={onReveal}>
              <FontAwesomeIcon aria-hidden icon={faEye} /> Reveal
            </Button>
          )}
          {clipboardActive ? (
            <Button size="sm" variant="tertiary" onPress={onClearClipboard}>
              <FontAwesomeIcon aria-hidden icon={faUnlockKeyhole} /> Clear clipboard
            </Button>
          ) : (
            <Button size="sm" isDisabled={!available} variant="tertiary" onPress={onCopy}>
              <FontAwesomeIcon aria-hidden icon={faCopy} /> Copy
            </Button>
          )}
        </div>
      </div>
      <div className="mt-3 min-h-14 rounded-lg border border-separator bg-default/55 px-3 py-2.5">
        {revealed ? (
          <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-5 text-foreground">
            {SECRET_DECODER.decode(revealed.value)}
          </pre>
        ) : (
          <div className="flex min-h-9 items-center gap-2 text-xs text-muted">
            <FontAwesomeIcon aria-hidden icon={available ? faLock : faShieldHalved} />
            <span>{available ? "Redacted" : "Not stored"}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function AddCredentialModal({
  isOpen,
  isPending,
  hashType,
  hashTypes,
  usernameInputRef,
  collectionInputRef,
  plaintextInputRef,
  hashInputRef,
  onOpenChange,
  onHashTypeChange,
  onAdd,
}: {
  isOpen: boolean;
  isPending: boolean;
  hashType: number | null;
  hashTypes: CredentialHashTypeOption[];
  usernameInputRef: React.RefObject<HTMLInputElement | null>;
  collectionInputRef: React.RefObject<HTMLInputElement | null>;
  plaintextInputRef: React.RefObject<HTMLInputElement | null>;
  hashInputRef: React.RefObject<HTMLInputElement | null>;
  onOpenChange: (open: boolean) => void;
  onHashTypeChange: (hashType: number | null) => void;
  onAdd: () => void;
}): React.JSX.Element {
  const selection = hashType === null ? "auto" : String(hashType);
  const selectedHashType = hashTypes.find((option) => option.value === hashType);

  return (
    <Modal.Backdrop
      isDismissable={!isPending}
      isKeyboardDismissDisabled={isPending}
      isOpen={isOpen}
      variant="blur"
      onOpenChange={onOpenChange}
    >
      <Modal.Container placement="center" scroll="inside" size="lg">
        <Modal.Dialog className="sm:max-w-[680px]">
          <Modal.CloseTrigger isDisabled={isPending} />
          <Modal.Header className="flex-row items-start pr-8">
            <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
              <FontAwesomeIcon aria-hidden icon={faPlus} className="size-4" />
            </Modal.Icon>
            <div className="min-w-0 flex-1">
              <Modal.Heading>Add credential</Modal.Heading>
              <p className="mt-0.5 text-xs font-normal leading-relaxed text-muted">
                Store a plaintext value, a hash, or both. Secret inputs are cleared before the request crosses IPC.
              </p>
            </div>
          </Modal.Header>

          <Modal.Body className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField fullWidth variant="secondary">
                <Label>Username</Label>
                <Input
                  ref={usernameInputRef}
                  autoComplete="off"
                  maxLength={OPERATOR_DATA_LIMITS.usernameCharacters}
                  placeholder="DOMAIN\\operator"
                />
              </TextField>
              <TextField fullWidth variant="secondary">
                <Label>Collection</Label>
                <Input
                  ref={collectionInputRef}
                  autoComplete="off"
                  maxLength={OPERATOR_DATA_LIMITS.collectionCharacters}
                  placeholder="Engagement or source"
                />
              </TextField>
            </div>

            <TextField fullWidth variant="secondary">
              <Label>Plaintext value</Label>
              <Input
                ref={plaintextInputRef}
                autoComplete="new-password"
                maxLength={OPERATOR_DATA_LIMITS.secretBytes}
                placeholder="Optional"
                spellCheck={false}
                type="password"
                onChange={(event) => { plaintextInputRef.current = event.currentTarget; }}
              />
              <Description>The value remains uncontrolled and is removed from the input before submission.</Description>
            </TextField>

            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_220px]">
              <TextField fullWidth variant="secondary">
                <Label>Hash</Label>
                <Input
                  ref={hashInputRef}
                  autoComplete="new-password"
                  className="font-mono text-xs"
                  maxLength={OPERATOR_DATA_LIMITS.secretBytes}
                  placeholder="Optional"
                  spellCheck={false}
                  type="password"
                  onChange={(event) => { hashInputRef.current = event.currentTarget; }}
                />
              </TextField>
              <Select
                fullWidth
                aria-label="Hash type"
                value={selection}
                variant="secondary"
                onChange={(value) => {
                  if (value === "auto") onHashTypeChange(null);
                  else {
                    const parsed = Number(value);
                    if (Number.isSafeInteger(parsed)) onHashTypeChange(parsed);
                  }
                }}
              >
                <Label>Hash type</Label>
                <Select.Trigger>
                  <Select.Value>{selectedHashType?.label ?? "Detect automatically"}</Select.Value>
                  <Select.Indicator><FontAwesomeIcon aria-hidden className="size-3" icon={faChevronDown} /></Select.Indicator>
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="auto" textValue="Detect automatically">
                      Detect automatically
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    {hashTypes.map((option) => (
                      <ListBox.Item id={String(option.value)} key={option.value} textValue={option.label}>
                        {option.label}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>
          </Modal.Body>

          <Modal.Footer>
            <Button isDisabled={isPending} variant="tertiary" onPress={() => onOpenChange(false)}>Cancel</Button>
            <Button isPending={isPending} onPress={onAdd}>
              <FontAwesomeIcon aria-hidden icon={faKey} /> Add credential
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function CredentialKindChips({ credential }: { credential: CredentialSummary }): React.JSX.Element {
  if (credential.isCracked) {
    return <Chip size="sm" color="success" variant="soft">Cracked</Chip>;
  }
  if (credential.hasPlaintext && credential.hasHash) {
    return (
      <div className="flex flex-wrap gap-1">
        <Chip size="sm" variant="soft">Plaintext</Chip>
        <Chip size="sm" variant="soft">Hash</Chip>
      </div>
    );
  }
  if (credential.hasPlaintext) return <Chip size="sm" variant="soft">Plaintext</Chip>;
  if (credential.hasHash) return <Chip size="sm" variant="soft">Hash</Chip>;
  return <Chip size="sm" color="warning" variant="soft">Empty</Chip>;
}

function CredentialEmptyState({
  loading,
  filtered,
  error,
}: {
  loading: boolean;
  filtered: boolean;
  error: string | undefined;
}): React.JSX.Element {
  if (loading) {
    return (
      <EmptyState size="sm" className="py-14">
        <EmptyState.Media><FontAwesomeIcon icon={faCircleNotch} className="animate-spin" /></EmptyState.Media>
        <EmptyState.Content>
          <EmptyState.Title>Loading credentials</EmptyState.Title>
          <EmptyState.Description>Requesting redacted metadata from the connected server.</EmptyState.Description>
        </EmptyState.Content>
      </EmptyState>
    );
  }
  if (error) {
    return (
      <EmptyState size="sm" className="py-14">
        <EmptyState.Media><FontAwesomeIcon icon={faShieldHalved} /></EmptyState.Media>
        <EmptyState.Content>
          <EmptyState.Title>Credentials unavailable</EmptyState.Title>
          <EmptyState.Description>Refresh the inventory or reconnect to the server.</EmptyState.Description>
        </EmptyState.Content>
      </EmptyState>
    );
  }
  return (
    <EmptyState size="sm" className="py-14">
      <EmptyState.Media><FontAwesomeIcon icon={filtered ? faMagnifyingGlass : faKey} /></EmptyState.Media>
      <EmptyState.Content>
        <EmptyState.Title>{filtered ? "No matching credentials" : "No stored credentials"}</EmptyState.Title>
        <EmptyState.Description>
          {filtered ? "Adjust the search or credential type filter." : "Add a credential to create the first server-side record."}
        </EmptyState.Description>
      </EmptyState.Content>
    </EmptyState>
  );
}

function Metadata({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className={`mt-1 truncate text-sm text-foreground${mono ? " font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}

function IconAction({
  label,
  icon,
  onPress,
  danger = false,
}: {
  label: string;
  icon: IconDefinition;
  onPress: () => void;
  danger?: boolean;
}): React.JSX.Element {
  return (
    <Tooltip delay={350}>
      <Button
        aria-label={label}
        isIconOnly
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

function credentialBackendIdentity(snapshot: SliverSnapshot): string {
  const connection = snapshot.connection;
  return [
    connection.status,
    connection.epoch ?? "none",
    connection.incarnation ?? "none",
    connection.server ?? "none",
    connection.configName ?? "none",
  ].join(":");
}

function isUsableConnection(status: SliverSnapshot["connection"]["status"]): boolean {
  return status === "connected" || status === "degraded" || status === "reconnecting";
}

function emptyInventory(identity: string): CredentialInventory {
  return {
    identity,
    items: [],
    page: EMPTY_PAGE,
    collections: [],
    hashTypes: [],
  };
}

function inventoryFromPage(identity: string, page: CredentialCatalogPage): CredentialInventory {
  return {
    identity,
    items: page.items,
    page: page.page,
    collections: page.collections,
    hashTypes: page.hashTypes,
  };
}

function appendUniqueCredentials(current: CredentialSummary[], incoming: CredentialSummary[]): CredentialSummary[] {
  const ids = new Set(current.map((credential) => credential.id));
  const appended = [...current];
  for (const credential of incoming) {
    if (!ids.has(credential.id)) {
      ids.add(credential.id);
      appended.push(credential);
    }
  }
  return appended;
}

function isCredentialKind(value: unknown): value is CredentialKindFilter {
  return value === "all" || value === "plaintext" || value === "hash" || value === "cracked";
}

function credentialDisplayName(credential: CredentialSummary): string {
  return credential.username || credential.collection || "credential";
}

function secretFieldLabel(field: CredentialSecretField): string {
  return field === "plaintext" ? "Plaintext value" : "Hash";
}

function inventoryCountLabel(visible: number, total: number): string {
  if (total === 0) return "No credentials";
  if (total > visible) return `${visible} of ${total} credentials loaded`;
  return `${total} ${total === 1 ? "credential" : "credentials"}`;
}

function formatExpiry(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "after the configured safety interval";
  const seconds = Math.max(1, Math.ceil((timestamp - Date.now()) / 1_000));
  return `in about ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clearNativeInput(input: HTMLInputElement | null): void {
  if (!input || input.value.length === 0) return;
  const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (nativeValueSetter) nativeValueSetter.call(input, "");
  else input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

function consumeSecretInput(input: HTMLInputElement | null): Uint8Array {
  const bytes = new TextEncoder().encode(input?.value ?? "");
  clearNativeInput(input);
  return bytes;
}
