import { useEffect, useMemo, useState } from "react";
import { Button, Card, Chip, Tooltip, toast } from "@heroui/react";
import { DataGrid } from "@heroui-pro/react/data-grid";
import type { DataGridColumn, DataGridSelection } from "@heroui-pro/react/data-grid";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBoxArchive,
  faBoxesStacked,
  faDownload,
  faFileShield,
  faLayerGroup,
  faPlay,
  faServer,
  faTrash,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";
import type { BuildSummary, ProfileSummary, SliverSnapshot } from "../../../shared/contracts";
import { ConfirmDialog } from "../components/ConfirmDialog";

interface BuildsPageProps {
  snapshot: SliverSnapshot;
}

type DeleteTarget =
  | { kind: "build"; name: string }
  | { kind: "profile"; name: string }
  | undefined;

export function BuildsPage({ snapshot }: BuildsPageProps) {
  const buildInventory = snapshot.domains.builds;
  const stagingAuthoritative =
    (buildInventory.status === "ready" || buildInventory.status === "empty") && !buildInventory.page.truncated;
  const serverStaged = useMemo(
    () => new Set(snapshot.builds.filter((build) => build.staged).map((build) => build.name)),
    [snapshot.builds],
  );
  const serverStagedKey = [...serverStaged].sort().join("\u0000");
  const [draftStaged, setDraftStaged] = useState<Set<string>>(() => new Set(serverStaged));
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>();
  const [isDeleting, setIsDeleting] = useState(false);
  const [isUpdatingStage, setIsUpdatingStage] = useState(false);
  const isStageDirty = stagingAuthoritative && setKey(draftStaged) !== serverStagedKey;

  useEffect(() => {
    setDraftStaged(new Set(serverStaged));
  }, [serverStagedKey]);

  async function downloadBuild(name: string) {
    const result = await window.sliver.downloadBuild(name);
    if (!result.ok || !result.value) {
      toast.danger("Download failed", { description: result.error });
      return;
    }
    if (result.value.saved) {
      toast.success("Archived build saved", { description: result.value.fileName });
    } else {
      toast.info("Save cancelled", { description: "The archived build remains on the server." });
    }
  }

  async function generateFromProfile(name: string) {
    const loadingToastId = toast("Generating implant", {
      description: `Building from ${name}. This can take several minutes.`,
      isLoading: true,
      timeout: 0,
    });
    try {
      const result = await window.sliver.generateFromProfile({ profileName: name, name: "" });
      toast.close(loadingToastId);
      if (!result.ok || !result.value) {
        toast.danger("Profile generation failed", {
          description: result.error ?? "The server rejected the request.",
        });
        return;
      }
      if (result.value.saved) {
        toast.success("Artifact generated", { description: result.value.fileName });
      } else {
        toast.info("Artifact generated", { description: "Saving was cancelled." });
      }
    } catch (error) {
      toast.close(loadingToastId);
      toast.danger("Profile generation failed", {
        description: error instanceof Error ? error.message : "The generation request could not be completed.",
      });
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const result = deleteTarget.kind === "build"
        ? await window.sliver.deleteBuild(deleteTarget.name)
        : await window.sliver.deleteProfile(deleteTarget.name);
      if (!result.ok) {
        toast.danger(`Could not delete ${deleteTarget.kind}`, { description: result.error });
        return;
      }
      toast.success(`${deleteTarget.kind === "build" ? "Build" : "Profile"} deleted`, {
        description: deleteTarget.name,
      });
      setDeleteTarget(undefined);
    } finally {
      setIsDeleting(false);
    }
  }

  async function applyStagedBuilds() {
    if (!stagingAuthoritative) {
      toast.danger("Build inventory incomplete", {
        description: "Refresh the complete build inventory before replacing the HTTP staging allowlist.",
      });
      return;
    }
    setIsUpdatingStage(true);
    try {
      const result = await window.sliver.setStagedBuilds([...draftStaged]);
      if (!result.ok) {
        toast.danger("Could not update staged builds", { description: result.error });
        return;
      }
      toast.success("HTTP stage selection updated", {
        description: `${draftStaged.size} ${draftStaged.size === 1 ? "build" : "builds"} available to staging endpoints.`,
      });
    } finally {
      setIsUpdatingStage(false);
    }
  }

  const buildColumns: DataGridColumn<BuildSummary>[] = [
    {
      id: "name",
      header: "Build",
      accessorKey: "name",
      isRowHeader: true,
      allowsSorting: true,
      minWidth: 190,
      cell: (build) => (
        <div className="min-w-0 py-1">
          <p className="truncate font-medium text-foreground">{build.name}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted">{build.configId || "ad hoc"}</p>
        </div>
      ),
    },
    {
      id: "target",
      header: "Target",
      accessorKey: "target",
      allowsSorting: true,
      minWidth: 140,
      cell: (build) => <span className="font-mono text-xs text-muted">{build.target}</span>,
    },
    {
      id: "format",
      header: "Format",
      accessorKey: "format",
      minWidth: 120,
      cell: (build) => <Chip size="sm" variant="soft">{build.format}</Chip>,
    },
    {
      id: "type",
      header: "Mode",
      accessorKey: "implantType",
      minWidth: 110,
      cell: (build) => <span className="capitalize text-sm text-muted">{build.implantType}</span>,
    },
    {
      id: "staged",
      header: "HTTP stage",
      accessorKey: "staged",
      minWidth: 120,
      cell: (build) => (
        <Chip size="sm" color={build.staged ? "success" : "default"} variant="soft">
          {build.staged ? "Staged" : "Not staged"}
        </Chip>
      ),
    },
    {
      id: "c2",
      header: "C2",
      minWidth: 180,
      cell: (build) => <span className="line-clamp-2 font-mono text-[11px] text-muted">{build.c2.join(", ") || "—"}</span>,
    },
    {
      id: "actions",
      header: "",
      align: "end",
      width: 100,
      cell: (build) => (
        <div className="flex justify-end gap-1">
          <IconAction label="Download archived build" icon={faDownload} onPress={() => void downloadBuild(build.name)} />
          <IconAction label="Delete build" icon={faTrash} danger onPress={() => setDeleteTarget({ kind: "build", name: build.name })} />
        </div>
      ),
    },
  ];

  const profileColumns: DataGridColumn<ProfileSummary>[] = [
    {
      id: "name",
      header: "Profile",
      accessorKey: "name",
      isRowHeader: true,
      allowsSorting: true,
      minWidth: 190,
      cell: (profile) => (
        <div className="min-w-0 py-1">
          <p className="truncate font-medium text-foreground">{profile.name}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted">{profile.id}</p>
        </div>
      ),
    },
    { id: "target", header: "Target", accessorKey: "target", minWidth: 150, cell: (profile) => <span className="font-mono text-xs text-muted">{profile.target}</span> },
    { id: "format", header: "Format", accessorKey: "format", minWidth: 120, cell: (profile) => <Chip size="sm" variant="soft">{profile.format}</Chip> },
    { id: "type", header: "Mode", accessorKey: "implantType", minWidth: 110, cell: (profile) => <span className="capitalize text-sm text-muted">{profile.implantType}</span> },
    { id: "c2", header: "C2", minWidth: 200, cell: (profile) => <span className="line-clamp-2 font-mono text-[11px] text-muted">{profile.c2.join(", ") || "—"}</span> },
    {
      id: "actions",
      header: "",
      align: "end",
      width: 100,
      cell: (profile) => (
        <div className="flex justify-end gap-1">
          <IconAction label="Generate from profile" icon={faPlay} onPress={() => void generateFromProfile(profile.name)} />
          <IconAction label="Delete profile" icon={faTrash} danger onPress={() => setDeleteTarget({ kind: "profile", name: profile.name })} />
        </div>
      ),
    },
  ];

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <div className="eyebrow"><FontAwesomeIcon icon={faBoxesStacked} /> Artifact library</div>
          <h1>Builds and profiles</h1>
          <p>Download archived artifacts, choose HTTP staging candidates, and reuse server-side configurations.</p>
        </div>
        <div className="flex gap-2">
          <Chip size="sm" variant="soft">{inventoryCountLabel(snapshot.builds.length, buildInventory.page.total, "build")}</Chip>
          <Chip size="sm" variant="soft">{inventoryCountLabel(snapshot.profiles.length, snapshot.domains.profiles.page.total, "profile")}</Chip>
        </div>
      </section>

      <Card variant="secondary" className="overflow-hidden">
        <Card.Header className="flex-row items-center gap-3">
          <span aria-hidden="true" className="section-icon"><FontAwesomeIcon icon={faBoxArchive} /></span>
          <div className="min-w-0 flex-1">
            <Card.Title>Archived builds</Card.Title>
            <Card.Description>
              {stagingAuthoritative
                ? "Selection controls the server's complete HTTP staging allowlist."
                : "HTTP staging changes are unavailable until the complete build inventory is loaded."}
            </Card.Description>
          </div>
          {isStageDirty ? <Chip size="sm" color="warning" variant="soft">Unsaved staging changes</Chip> : null}
        </Card.Header>
        <Card.Content className="p-0">
          <DataGrid
            aria-label="Archived Sliver builds"
            data={snapshot.builds}
            columns={buildColumns}
            getRowId={(build) => build.name}
            {...(stagingAuthoritative
              ? {
                  selectionMode: "multiple" as const,
                  selectionBehavior: "toggle" as const,
                  showSelectionCheckboxes: true,
                  selectedKeys: draftStaged,
                  onSelectionChange: (selection: DataGridSelection) => setDraftStaged(selectionToSet(selection, snapshot.builds)),
                }
              : {})}
            variant="secondary"
            contentClassName="min-w-[1040px]"
            renderEmptyState={() => <BuildEmptyState />}
          />
        </Card.Content>
        {!stagingAuthoritative ? (
          <Card.Footer className="border-t border-warning/30 bg-warning/10 px-5 py-4" role="status">
            <p className="text-xs text-warning">
              Showing {snapshot.builds.length} of {buildInventory.page.total} builds. Staging selection is read-only because
              a replace-all update could remove unseen server builds.
            </p>
          </Card.Footer>
        ) : isStageDirty ? (
          <Card.Footer className="flex items-center justify-between border-t border-border px-5 py-4">
            <p className="text-xs text-muted">This is a replace-all operation; unchecked builds stop being stageable.</p>
            <div className="flex gap-2">
              <Button size="sm" variant="tertiary" onPress={() => setDraftStaged(new Set(serverStaged))}>
                <FontAwesomeIcon icon={faXmark} /> Discard
              </Button>
              <Button size="sm" isPending={isUpdatingStage} onPress={() => void applyStagedBuilds()}>
                <FontAwesomeIcon icon={faLayerGroup} /> Apply staging set
              </Button>
            </div>
          </Card.Footer>
        ) : null}
      </Card>

      <Card variant="secondary" className="overflow-hidden">
        <Card.Header className="flex-row items-center gap-3">
          <span aria-hidden="true" className="section-icon"><FontAwesomeIcon icon={faFileShield} /></span>
          <div className="min-w-0 flex-1">
            <Card.Title>Generation profiles</Card.Title>
            <Card.Description>Reusable configurations stored on the connected server.</Card.Description>
          </div>
        </Card.Header>
        <Card.Content className="p-0">
          <DataGrid
            aria-label="Sliver generation profiles"
            data={snapshot.profiles}
            columns={profileColumns}
            getRowId={(profile) => profile.name}
            variant="secondary"
            contentClassName="min-w-[860px]"
            renderEmptyState={() => <ProfileEmptyState />}
          />
        </Card.Content>
      </Card>

      <ConfirmDialog
        isOpen={Boolean(deleteTarget)}
        onOpenChange={(open) => { if (!open) setDeleteTarget(undefined); }}
        title={deleteTarget ? `Delete ${deleteTarget.name}?` : "Delete item?"}
        description={deleteTarget?.kind === "profile"
          ? "Deleting this server-side profile also deletes every build associated with it. This cannot be undone."
          : "The archived artifact will be removed from the server. Any copies already saved to disk are not affected."}
        confirmLabel={deleteTarget?.kind === "profile" ? "Delete profile and builds" : "Delete build"}
        isPending={isDeleting}
        onConfirm={confirmDelete}
      />
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
  icon: typeof faDownload;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Tooltip delay={350}>
      <Tooltip.Trigger>
        <Button
          aria-label={label}
          isIconOnly
          size="sm"
          variant="ghost"
          {...(danger ? { className: "text-danger" } : {})}
          onPress={onPress}
        >
          <FontAwesomeIcon icon={icon} />
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content placement="top">{label}</Tooltip.Content>
    </Tooltip>
  );
}

function BuildEmptyState() {
  return (
    <EmptyState size="sm" className="py-14">
      <EmptyState.Media><FontAwesomeIcon icon={faServer} /></EmptyState.Media>
      <EmptyState.Content>
        <EmptyState.Title>No archived builds</EmptyState.Title>
        <EmptyState.Description>Generate an implant to create the first server-side archive.</EmptyState.Description>
      </EmptyState.Content>
    </EmptyState>
  );
}

function ProfileEmptyState() {
  return (
    <EmptyState size="sm" className="py-14">
      <EmptyState.Media><FontAwesomeIcon icon={faFileShield} /></EmptyState.Media>
      <EmptyState.Content>
        <EmptyState.Title>No saved profiles</EmptyState.Title>
        <EmptyState.Description>Save the current Generate form as a reusable profile.</EmptyState.Description>
      </EmptyState.Content>
    </EmptyState>
  );
}

function selectionToSet(selection: DataGridSelection, builds: BuildSummary[]): Set<string> {
  if (selection === "all") return new Set(builds.map((build) => build.name));
  return new Set([...selection].map(String));
}

function setKey(values: Set<string>): string {
  return [...values].sort().join("\u0000");
}

function inventoryCountLabel(visible: number, total: number, singular: string): string {
  const count = total > visible ? `${visible} of ${total}` : String(total);
  return `${count} ${total === 1 ? singular : `${singular}s`}`;
}
