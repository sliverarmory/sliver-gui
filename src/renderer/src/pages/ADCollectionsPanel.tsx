import { useEffect, useState } from "react";
import { Button, Card, Tooltip } from "@heroui/react";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faDatabase, faRotate, faUpRightFromSquare } from "@fortawesome/free-solid-svg-icons";
import type { AdCollectionSummary } from "../../../shared/ad-explorer-contracts";

export function ADCollectionsPanel({ onChooseTarget }: { onChooseTarget: () => void }): React.JSX.Element {
  const [collections, setCollections] = useState<AdCollectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [openingId, setOpeningId] = useState<string>();

  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    void window.sliver.listAdCollections().then((result) => {
      if (!active) return;
      if (!result.ok) throw new Error(result.error);
      setCollections(result.value);
      setLoaded(true);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load collections.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [revision]);

  async function openCollection(projectId: string): Promise<void> {
    setOpeningId(projectId);
    setError(undefined);
    try {
      const result = await window.sliver.openBeagleWindow({ projectId });
      if (!result.ok) throw new Error(result.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open this collection.");
    } finally {
      setOpeningId(undefined);
    }
  }

  return (
    <Card className="gap-6 p-6 sm:p-8">
      <Card.Header className="flex-row items-start justify-between gap-4 p-0">
        <div className="min-w-0 space-y-2">
          <Card.Title>Saved Collections</Card.Title>
          <Card.Description>Open a dataset in its own Explorer window.</Card.Description>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {loaded ? <span className="text-sm tabular-nums text-muted">{collections.length} {collections.length === 1 ? "collection" : "collections"}</span> : null}
          <Tooltip delay={250}>
            <Button aria-label="Refresh collections" isIconOnly variant="ghost" isDisabled={loading} onPress={() => setRevision((value) => value + 1)}>
              <FontAwesomeIcon aria-hidden icon={faRotate} />
            </Button>
            <Tooltip.Content>Refresh collections</Tooltip.Content>
          </Tooltip>
        </div>
      </Card.Header>
      <Card.Content className="gap-4 p-0" aria-busy={loading}>
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        {loading && !loaded ? <p role="status" className="text-sm text-muted">Loading collections…</p> : null}
        {collections.length ? (
          <div className="space-y-1">
            {collections.map((collection) => (
              <Button key={collection.id} aria-label={`Open collection ${collection.name}`} variant="ghost"
                className="h-auto min-h-16 w-full justify-start gap-3 rounded-xl px-3 py-3 text-left"
                isDisabled={openingId !== undefined} isPending={openingId === collection.id}
                onPress={() => void openCollection(collection.id)}>
                <FontAwesomeIcon aria-hidden icon={faDatabase} className="text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{collection.name}</span>
                  <span className="block text-xs tabular-nums text-muted">Created {formatCreatedAt(collection.createdAt)}</span>
                </span>
                <FontAwesomeIcon aria-hidden icon={faUpRightFromSquare} className="text-xs text-muted" />
              </Button>
            ))}
          </div>
        ) : loaded && !loading && !error ? (
          <EmptyState>
            <EmptyState.Header>
              <EmptyState.Media variant="icon"><FontAwesomeIcon icon={faDatabase} className="text-muted" /></EmptyState.Media>
              <EmptyState.Title>No collections yet</EmptyState.Title>
              <EmptyState.Description>Collect from a Windows target or import a dataset in Explorer.</EmptyState.Description>
            </EmptyState.Header>
            <EmptyState.Content>
              <Button variant="outline" onPress={onChooseTarget}>View Windows Targets</Button>
            </EmptyState.Content>
          </EmptyState>
        ) : null}
      </Card.Content>
    </Card>
  );
}

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "date unavailable";
}
