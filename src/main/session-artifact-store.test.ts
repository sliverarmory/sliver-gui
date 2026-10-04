// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_ARTIFACT_MAX_BYTES,
  SessionArtifactAccessError,
  SessionArtifactCapacityError,
  SessionArtifactStore,
  type SessionArtifactScope,
  type SessionArtifactStoreOptions,
} from "./session-artifact-store.js";

const NOW = Date.UTC(2026, 7, 9, 22, 0, 0);
const stores: SessionArtifactStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
});

describe("SessionArtifactStore", () => {
  it("returns opaque path-free metadata and stores a clone by default", () => {
    const store = createStore({ now: () => NOW, autoPrune: false });
    const scope = sessionScope();
    const source = Buffer.from("sensitive-output");
    store.bind(scope);

    const metadata = store.store({
      scope,
      data: source,
      mediaType: " APPLICATION/OCTET-STREAM ",
      suggestedBasename: "C:\\operator\\downloads\\bad?.bin",
      ttlMilliseconds: 1_000,
    });

    expect(metadata).toEqual({
      handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      mediaType: "application/octet-stream",
      suggestedBasename: "bad_.bin",
      size: source.length,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      createdAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 1_000).toISOString(),
    });
    expect(metadata).not.toHaveProperty("path");
    expect(Object.isFrozen(metadata)).toBe(true);

    source.fill(0);
    const consumed = store.consume(scope, metadata.handle);
    expect(consumed.metadata).toBe(metadata);
    expect(consumed.data.toString()).toBe("sensitive-output");
    expect(() => store.metadata(scope, metadata.handle)).toThrow(SessionArtifactAccessError);
    consumed.data.fill(0);
  });

  it("binds handles to the exact window, backend epoch, connection, and session identity", () => {
    const store = createStore({ now: () => NOW, autoPrune: false });
    const scope = sessionScope();
    const anotherWindow = sessionScope({ ownerWindowId: 8 });
    store.bind(scope);
    store.bind(anotherWindow);
    const metadata = store.store({
      scope,
      data: Buffer.from("artifact"),
      mediaType: "application/octet-stream",
      suggestedBasename: "artifact.bin",
    });

    const replayScopes = [
      anotherWindow,
      sessionScope({ backendId: "b".repeat(64) }),
      sessionScope({ backendEpoch: 2 }),
      sessionScope({ connectionIncarnation: 2 }),
      sessionScope({ sessionId: "session-2" }),
      sessionScope({ sessionFingerprint: "c".repeat(64) }),
    ];
    for (const replayScope of replayScopes) {
      expect(() => store.metadata(replayScope, metadata.handle)).toThrow(SessionArtifactAccessError);
    }
    expect(() => store.metadata(scope, "A".repeat(43))).toThrow(SessionArtifactAccessError);
    expect(store.metadata(scope, metadata.handle)).toBe(metadata);
  });

  it("revokes an old binding and rejects and clears late artifacts from it", () => {
    const store = createStore({ now: () => NOW, autoPrune: false });
    const oldScope = sessionScope();
    const newScope = sessionScope({
      backendEpoch: 2,
      connectionIncarnation: 2,
      sessionId: "replacement-session",
      sessionFingerprint: "d".repeat(64),
    });
    const oldBuffer = Buffer.from("old-response");
    const lateBuffer = Buffer.from("late-response");
    store.bind(oldScope);
    const oldMetadata = store.store({
      scope: oldScope,
      data: oldBuffer,
      mediaType: "application/octet-stream",
      suggestedBasename: "old.bin",
      ownership: "take",
    });

    store.bind(newScope);

    expect(oldBuffer.equals(Buffer.alloc(oldBuffer.length))).toBe(true);
    expect(() => store.metadata(oldScope, oldMetadata.handle)).toThrow(SessionArtifactAccessError);
    expect(() =>
      store.store({
        scope: oldScope,
        data: lateBuffer,
        mediaType: "application/octet-stream",
        suggestedBasename: "late.bin",
        ownership: "take",
      }),
    ).toThrow(SessionArtifactAccessError);
    expect(lateBuffer.equals(Buffer.alloc(lateBuffer.length))).toBe(true);
    expect(store.usage()).toEqual({ itemCount: 0, byteCount: 0 });
  });

  it("automatically expires and zeroizes owned artifact buffers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = createStore();
    const scope = sessionScope();
    const owned = Buffer.from("short-lived");
    store.bind(scope);
    const metadata = store.store({
      scope,
      data: owned,
      mediaType: "application/octet-stream",
      suggestedBasename: "short-lived.bin",
      ttlMilliseconds: 25,
      ownership: "take",
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(owned.equals(Buffer.alloc(owned.length))).toBe(true);
    expect(store.usage()).toEqual({ itemCount: 0, byteCount: 0 });
    expect(() => store.metadata(scope, metadata.handle)).toThrow(SessionArtifactAccessError);
  });

  it("evicts only the admitting owner and rejects global overflow without collateral eviction", () => {
    const store = createStore({
      now: () => NOW,
      autoPrune: false,
      maximumArtifactBytes: 8,
      maximumPreviewBytes: 4,
      perOwnerItemLimit: 2,
      perOwnerByteLimit: 8,
      globalItemLimit: 3,
      globalByteLimit: 12,
    });
    const ownerA = sessionScope({ ownerWindowId: 7 });
    const ownerB = sessionScope({ ownerWindowId: 8 });
    store.bind(ownerA);
    store.bind(ownerB);
    const first = Buffer.alloc(4, 1);
    const second = Buffer.alloc(4, 2);
    const third = Buffer.alloc(4, 3);
    const other = Buffer.alloc(4, 4);
    const rejected = Buffer.alloc(4, 5);
    const firstMetadata = store.store(artifact(ownerA, first));
    const secondMetadata = store.store(artifact(ownerA, second));
    const thirdMetadata = store.store(artifact(ownerA, third));

    expect(first.equals(Buffer.alloc(first.length))).toBe(true);
    expect(() => store.metadata(ownerA, firstMetadata.handle)).toThrow(SessionArtifactAccessError);
    expect(store.metadata(ownerA, secondMetadata.handle)).toBe(secondMetadata);
    expect(store.metadata(ownerA, thirdMetadata.handle)).toBe(thirdMetadata);

    const otherMetadata = store.store(artifact(ownerB, other));
    expect(() => store.store(artifact(ownerB, rejected))).toThrow(SessionArtifactCapacityError);
    expect(rejected.equals(Buffer.alloc(rejected.length))).toBe(true);
    expect(store.metadata(ownerA, secondMetadata.handle)).toBe(secondMetadata);
    expect(store.metadata(ownerA, thirdMetadata.handle)).toBe(thirdMetadata);
    expect(store.metadata(ownerB, otherMetadata.handle)).toBe(otherMetadata);
    expect(store.usage()).toEqual({ itemCount: 3, byteCount: 12 });
  });

  it("enforces the hard per-artifact ceiling and clears rejected transferred buffers", () => {
    expect(() =>
      createStore({ maximumArtifactBytes: SESSION_ARTIFACT_MAX_BYTES + 1 }),
    ).toThrow(/maximumArtifactBytes/u);

    const store = createStore({ maximumArtifactBytes: 4, autoPrune: false });
    const scope = sessionScope();
    const oversized = Buffer.alloc(5, 0xa5);
    store.bind(scope);

    expect(() => store.store(artifact(scope, oversized))).toThrow(SessionArtifactCapacityError);
    expect(oversized.equals(Buffer.alloc(oversized.length))).toBe(true);
  });

  it("preserves legitimate empty-file artifacts", () => {
    const store = createStore({ now: () => NOW, autoPrune: false });
    const scope = sessionScope();
    store.bind(scope);
    const metadata = store.store({
      scope,
      data: Buffer.alloc(0),
      mediaType: "application/octet-stream",
      suggestedBasename: "empty.txt",
      ownership: "take",
    });

    expect(metadata.size).toBe(0);
    expect(store.consume(scope, metadata.handle).data).toHaveLength(0);
  });

  it("produces bounded data URLs only for allowlisted images with matching signatures", () => {
    const store = createStore({
      now: () => NOW,
      autoPrune: false,
      maximumArtifactBytes: 64,
      maximumPreviewBytes: 32,
    });
    const scope = sessionScope();
    store.bind(scope);
    const png = Buffer.from([
      137, 80, 78, 71, 13, 10, 26, 10,
      0, 0, 0, 13, 73, 72, 68, 82,
      0, 0, 0, 1, 0, 0, 0, 1,
    ]);
    const pngMetadata = store.store({
      scope,
      data: png,
      mediaType: "image/png",
      suggestedBasename: "screen.png",
    });
    const svgMetadata = store.store({
      scope,
      data: Buffer.from("<svg/>", "utf8"),
      mediaType: "image/svg+xml",
      suggestedBasename: "screen.svg",
    });
    const invalidPngMetadata = store.store({
      scope,
      data: Buffer.alloc(8, 1),
      mediaType: "image/png",
      suggestedBasename: "invalid.png",
    });
    const oversizedPngMetadata = store.store({
      scope,
      data: Buffer.concat([png, Buffer.alloc(9)]),
      mediaType: "image/png",
      suggestedBasename: "oversized.png",
    });
    const hostileDimensions = Buffer.from(png);
    hostileDimensions.writeUInt32BE(65_535, 16);
    hostileDimensions.writeUInt32BE(65_535, 20);
    const hostilePngMetadata = store.store({
      scope,
      data: hostileDimensions,
      mediaType: "image/png",
      suggestedBasename: "hostile.png",
    });

    expect(store.previewDataUrl(scope, pngMetadata.handle)).toBe(
      `data:image/png;base64,${png.toString("base64")}`,
    );
    expect(() => store.previewDataUrl(scope, svgMetadata.handle)).toThrow(/allowed bounded image/u);
    expect(() => store.previewDataUrl(scope, invalidPngMetadata.handle)).toThrow(/allowed bounded image/u);
    expect(() => store.previewDataUrl(scope, oversizedPngMetadata.handle)).toThrow(/allowed bounded image/u);
    expect(() => store.previewDataUrl(scope, hostilePngMetadata.handle)).toThrow(/allowed bounded image/u);
  });

  it("zeroizes internal ownership on consume and returns an independent caller buffer", () => {
    const store = createStore({ now: () => NOW, autoPrune: false });
    const scope = sessionScope();
    const owned = Buffer.from("one-shot");
    store.bind(scope);
    const metadata = store.store({
      scope,
      data: owned,
      mediaType: "application/octet-stream",
      suggestedBasename: "one-shot.bin",
      ownership: "take",
    });

    const consumed = store.consume(scope, metadata.handle);

    expect(owned.equals(Buffer.alloc(owned.length))).toBe(true);
    expect(consumed.data.toString()).toBe("one-shot");
    expect(consumed.data).not.toBe(owned);
    expect(() => store.consume(scope, metadata.handle)).toThrow(SessionArtifactAccessError);
    consumed.data.fill(0);
  });

  it("clears owner artifacts and all remaining artifacts on idempotent close", () => {
    const store = createStore({ now: () => NOW, autoPrune: false });
    const ownerA = sessionScope({ ownerWindowId: 7 });
    const ownerB = sessionScope({ ownerWindowId: 8 });
    const ownerABuffer = Buffer.from("owner-a");
    const ownerBBuffer = Buffer.from("owner-b");
    store.bind(ownerA);
    store.bind(ownerB);
    const ownerAMetadata = store.store(artifact(ownerA, ownerABuffer));
    store.store(artifact(ownerB, ownerBBuffer));

    expect(store.removeOwner(ownerA.ownerWindowId)).toBe(1);
    expect(ownerABuffer.equals(Buffer.alloc(ownerABuffer.length))).toBe(true);
    expect(ownerBBuffer.toString()).toBe("owner-b");
    expect(() => store.metadata(ownerA, ownerAMetadata.handle)).toThrow(SessionArtifactAccessError);

    store.close();
    expect(ownerBBuffer.equals(Buffer.alloc(ownerBBuffer.length))).toBe(true);
    expect(() => store.usage()).toThrow(/closed/u);
    expect(() => store.bind(ownerA)).toThrow(/closed/u);
    expect(() => store.close()).not.toThrow();
  });
});

function createStore(options: SessionArtifactStoreOptions = {}): SessionArtifactStore {
  const store = new SessionArtifactStore(options);
  stores.push(store);
  return store;
}

function sessionScope(overrides: Partial<SessionArtifactScope> = {}): SessionArtifactScope {
  return {
    ownerWindowId: 7,
    backendId: "a".repeat(64),
    backendEpoch: 1,
    connectionIncarnation: 1,
    sessionId: "session-1",
    sessionFingerprint: "f".repeat(64),
    ...overrides,
  };
}

function artifact(scope: SessionArtifactScope, data: Buffer) {
  return {
    scope,
    data,
    mediaType: "application/octet-stream",
    suggestedBasename: "artifact.bin",
    ownership: "take" as const,
  };
}
