import { useCallback, useEffect, useRef, useState } from "react";
import type { BeagleAPI } from "../../../shared/beagle-contracts";
import {
  BEAGLE_HISTORY_LIMIT, BEAGLE_WORKSPACE_MAX_BYTES, emptyBeagleWorkspace, parseBeagleCustomQueries,
  type BeagleHistoryEntry, type BeagleWorkspace,
} from "../../../shared/beagle-workspace";
import { readCustomQueries } from "./beagle-model";

/** Keep result snapshots bounded without silently dropping saved queries. */
export function boundWorkspace(workspace: BeagleWorkspace): BeagleWorkspace {
  let entries = workspace.history.entries.slice(-BEAGLE_HISTORY_LIMIT);
  let index = workspace.history.index - (workspace.history.entries.length - entries.length);
  let next = { ...workspace, history: { entries, index: Math.max(entries.length ? 0 : -1, index) } };
  while (entries.length > 1 && new TextEncoder().encode(JSON.stringify(next)).length > BEAGLE_WORKSPACE_MAX_BYTES) {
    // Keep the current investigation, removing the oldest other snapshot first.
    const remove = index === 0 ? entries.length - 1 : 0;
    entries = entries.filter((_, position) => position !== remove);
    if (remove < index) index--;
    next = { ...workspace, history: { entries, index } };
  }
  return next;
}
export function appendInvestigation(workspace: BeagleWorkspace, entry: BeagleHistoryEntry): BeagleWorkspace {
  const entries = [...workspace.history.entries.slice(0, workspace.history.index + 1), entry];
  return boundWorkspace({ ...workspace, history: { entries, index: entries.length - 1 } });
}

export function useBeagleWorkspace(api: BeagleAPI | undefined, projectId: string, onError: (error: string) => void) {
  const [workspace, setWorkspace] = useState<BeagleWorkspace>();
  const [loading, setLoading] = useState(false);
  const current = useRef<BeagleWorkspace | undefined>(undefined);
  const generation = useRef(0);
  const pending = useRef(Promise.resolve());
  const saveError = useRef<Error | null>(null);
  const saveRevision = useRef(0);
  const errorRef = useRef(onError); errorRef.current = onError;
  const save = useCallback((next: BeagleWorkspace) => {
    current.current = next; setWorkspace(next);
    if (!api?.saveWorkspace) return;
    const epoch = generation.current;
    const revision = ++saveRevision.current;
    // Dispatch immediately: main serializes writes, so closing the window cannot
    // strand the newest snapshot behind a renderer-only promise queue.
    const write = api.saveWorkspace({ projectId: next.projectId, workspace: next }).then((response) => {
      if (!response.ok) throw new Error(response.error);
      if (epoch === generation.current && revision === saveRevision.current) saveError.current = null;
    }).catch((cause: unknown) => {
      if (epoch === generation.current && revision === saveRevision.current) {
        saveError.current = cause instanceof Error ? cause : new Error("Investigation save failed");
        errorRef.current(`Investigation could not be saved: ${saveError.current.message}`);
      }
    });
    pending.current = Promise.all([pending.current, write]).then(() => undefined);
  }, [api]);
  useEffect(() => {
    const epoch = ++generation.current;
    current.current = undefined; setWorkspace(undefined); saveError.current = null;
    if (!api || !projectId) return;
    setLoading(true);
    void (api.getWorkspace ? api.getWorkspace() : Promise.resolve({ ok: true as const, value: emptyBeagleWorkspace(projectId) })).then((response) => {
      if (epoch !== generation.current) return;
      if (!response.ok) throw new Error(response.error);
      if (response.value.projectId !== projectId) return;
      let next = response.value;
      if (!next.legacyMigrated) {
        const migrated = readCustomQueries(projectId).flatMap((query) => {
          try { return parseBeagleCustomQueries([{ ...query, description: "", category: "My queries" }]); } catch { return []; }
        });
        const ids = new Set(next.queries.map((query) => query.id));
        next = { ...next, legacyMigrated: true, queries: [...next.queries, ...migrated.filter((query) => !ids.has(query.id))].slice(0, 500) };
        save(next);
      } else { current.current = next; setWorkspace(next); }
    }).catch((cause: unknown) => { if (epoch === generation.current) errorRef.current(`Investigation could not be loaded: ${cause instanceof Error ? cause.message : "Unknown error"}`); })
      .finally(() => { if (epoch === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [api, projectId, save]);
  return { workspace, loading, update: (change: (previous: BeagleWorkspace) => BeagleWorkspace) => {
    if (current.current?.projectId === projectId) save(boundWorkspace(change(current.current)));
  }, flush: async () => { await pending.current; if (saveError.current) throw saveError.current; } };
}
