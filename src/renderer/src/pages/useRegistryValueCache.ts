import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { SessionRegistryHive, SessionRegistryReadResult } from "../../../shared/session-contracts";

export type RegistryValueState =
  | { status: "loading" }
  | { status: "ready"; result: SessionRegistryReadResult }
  | { status: "error" };

type ReadRegistryValue = (hive: SessionRegistryHive, path: string, key: string) => Promise<SessionRegistryReadResult>;

export function registryValueCacheKey(hive: SessionRegistryHive, path: string, key: string): string {
  return JSON.stringify([hive, path.toLowerCase(), key.toLowerCase()]);
}

class RegistryValueCache {
  private generation = 0;
  private snapshot = new Map<string, RegistryValueState>();
  private readonly requests = new Map<string, Promise<SessionRegistryReadResult | undefined>>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly readRemote: ReadRegistryValue) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = (): ReadonlyMap<string, RegistryValueState> => this.snapshot;

  readonly clear = (): void => {
    this.generation += 1;
    this.requests.clear();
    this.snapshot = new Map();
    this.notify();
  };

  readonly read = (hive: SessionRegistryHive, path: string, key: string, force = false): Promise<SessionRegistryReadResult | undefined> => {
    const id = registryValueCacheKey(hive, path, key);
    if (!force) {
      const entry = this.snapshot.get(id);
      if (entry?.status === "ready") return Promise.resolve(entry.result);
      const pending = this.requests.get(id);
      if (pending) return pending;
    }

    const generation = this.generation;
    // Each key's latest request owns its result. Refresh invalidates all keys,
    // while a forced read supersedes just this key's previous in-flight read.
    const isCurrent = () => generation === this.generation && this.requests.get(id) === request;
    const request: Promise<SessionRegistryReadResult | undefined> = Promise.resolve()
      .then(() => this.readRemote(hive, path, key))
      .then((result) => {
        if (!isCurrent()) return undefined;
        this.update(id, { status: "ready", result });
        return result;
      }, (error: unknown) => {
        if (!isCurrent()) return undefined;
        this.update(id, { status: "error" });
        throw error;
      })
      .finally(() => {
        if (isCurrent()) this.requests.delete(id);
      });
    this.requests.set(id, request);
    this.update(id, { status: "loading" });
    return request;
  };

  private update(id: string, value: RegistryValueState): void {
    this.snapshot = new Map(this.snapshot).set(id, value);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export function useRegistryValueCache(scope: string, readRemote: ReadRegistryValue): {
  cache: RegistryValueCache;
  snapshot: ReadonlyMap<string, RegistryValueState>;
} {
  // Each session/connection incarnation has an independent memory-only cache.
  const cache = useMemo(() => new RegistryValueCache(readRemote), [scope, readRemote]);
  const snapshot = useSyncExternalStore(cache.subscribe, cache.getSnapshot);
  useEffect(() => () => { cache.clear(); }, [cache]);
  return { cache, snapshot };
}
