// @vitest-environment node

import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  EXECUTION_ARTIFACT_DEFAULT_GLOBAL_BYTE_LIMIT,
  EXECUTION_ARTIFACT_DEFAULT_WINDOW_BYTE_LIMIT,
  EXECUTION_ARTIFACT_INPUT_TTL_MILLISECONDS,
  EXECUTION_ARTIFACT_MAX_BYTES,
  EXECUTION_ARTIFACT_RESULT_TTL_MILLISECONDS,
  ExecutionArtifactAccessError,
  ExecutionArtifactCapacityError,
  ExecutionArtifactStore,
  type ExecutionArtifactBackendBinding,
  type ExecutionArtifactOperationBinding,
  type ExecutionArtifactOwnerBinding,
  type ExecutionArtifactScope,
  type ExecutionArtifactStoreOptions,
  type ExecutionArtifactTargetBinding,
  type ExecutionArtifactTargetRef,
  type ExecutionArtifactTimerHandle,
  type ExecutionArtifactTimers,
} from "./execution-artifact-store.js";

const NOW = Date.UTC(2026, 7, 15, 18, 0, 0);
const stores: ExecutionArtifactStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("ExecutionArtifactStore", () => {
  it("returns opaque path-free metadata and clones sensitive input bytes", () => {
    const zeroized: Buffer[] = [];
    const store = createStore({
      now: () => NOW,
      autoPrune: false,
      onDidZeroize: (data) => zeroized.push(Buffer.from(data)),
    });
    const scope = executionScope();
    const source = Buffer.from("sensitive-executable");
    store.bindOwner(ownerBinding(scope));

    const metadata = store.storeInput({
      scope,
      data: source,
      mediaType: " APPLICATION/OCTET-STREAM ",
      suggestedBasename: "C:\\operator\\payloads\\bad?.exe",
    });

    expect(metadata).toEqual({
      handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      suggestedBasename: "bad_.exe",
      mediaType: "application/octet-stream",
      size: source.length,
      sha256: createHash("sha256").update(source).digest("hex"),
      createdAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + EXECUTION_ARTIFACT_INPUT_TTL_MILLISECONDS).toISOString(),
    });
    expect(Object.keys(metadata).sort()).toEqual([
      "createdAt",
      "expiresAt",
      "handle",
      "mediaType",
      "sha256",
      "size",
      "suggestedBasename",
    ]);
    expect(Object.isFrozen(metadata)).toBe(true);

    source.fill(0);
    const consumed = store.consumeInput(scope, metadata.handle);
    expect(consumed.metadata).toBe(metadata);
    expect(consumed.data.toString()).toBe("sensitive-executable");
    expect(consumed.data).not.toBe(source);
    expect(zeroized).toHaveLength(1);
    expect(zeroized[0]).toEqual(Buffer.alloc("sensitive-executable".length));
    expect(() => store.consumeInput(scope, metadata.handle)).toThrow(ExecutionArtifactAccessError);
    consumed.data.fill(0);
  });

  it("binds capabilities to the exact owner, backend, connection, TargetRef identity, operation, and role", () => {
    const store = createStore({ now: () => NOW, autoPrune: false });
    const scope = executionScope();
    const otherWindow = executionScope({ ownerWindowId: 8 });
    store.bindOwner(ownerBinding(scope));
    store.bindOwner(ownerBinding(otherWindow));
    const metadata = store.storeResult(resultInput(scope, Buffer.from("outcome")));

    const replayScopes: ExecutionArtifactScope[] = [
      otherWindow,
      executionScope({ backendId: "b".repeat(64) }),
      executionScope({ backendEpoch: 2, target: { backendEpoch: 2 } }),
      executionScope({ connectionIncarnation: 2 }),
      executionScope({ target: { mode: "beacon" } }),
      executionScope({ target: { id: "target-2" } }),
      executionScope({ target: { fingerprint: "c".repeat(64) } }),
      executionScope({ operationId: "operation-2" }),
      executionScope({ role: "result.stderr" }),
    ];
    for (const replayScope of replayScopes) {
      expect(() => store.metadata(replayScope, metadata.handle)).toThrow(ExecutionArtifactAccessError);
    }
    expect(() => store.metadata(scope, "A".repeat(43))).toThrow(ExecutionArtifactAccessError);
    expect(store.metadata(scope, metadata.handle)).toBe(metadata);
    expect(store.metadata(executionScope({ target: { domainRevision: 18 } }), metadata.handle)).toBe(metadata);
  });

  it("consumes inputs once while retaining results and cloning every returned buffer", () => {
    const store = createStore({ now: () => NOW, autoPrune: false });
    const inputScope = executionScope({ role: "input.assembly" });
    const resultScope = executionScope({ role: "result.stdout" });
    const inputSource = Buffer.from("assembly-input");
    const resultSource = Buffer.from("command-output");
    store.bindOwner(ownerBinding(inputScope));
    const input = store.storeInput(inputArtifact(inputScope, inputSource));
    const result = store.storeResult(resultInput(resultScope, resultSource));

    expect(() => store.getResult(inputScope, input.handle)).toThrow(ExecutionArtifactAccessError);
    expect(() => store.consumeInput(resultScope, result.handle)).toThrow(ExecutionArtifactAccessError);

    inputSource.fill(0xa5);
    resultSource.fill(0xa5);
    const consumed = store.consumeInput(inputScope, input.handle);
    expect(consumed.data.toString()).toBe("assembly-input");
    expect(() => store.consumeInput(inputScope, input.handle)).toThrow(ExecutionArtifactAccessError);

    const firstRead = store.getResult(resultScope, result.handle);
    firstRead.data.fill(0);
    const secondRead = store.getResult(resultScope, result.handle);
    expect(secondRead.data.toString()).toBe("command-output");
    expect(firstRead.data).not.toBe(secondRead.data);
    expect(store.metadata(resultScope, result.handle)).toBe(result);
    secondRead.data.fill(0);
  });

  it("uses injected clock and timers for fixed 60-second input and five-minute result expiry", () => {
    const scheduler = new FakeScheduler(NOW);
    const zeroized: Buffer[] = [];
    const store = createStore({
      now: scheduler.now,
      timers: scheduler,
      onDidZeroize: (data) => zeroized.push(Buffer.from(data)),
    });
    const inputScope = executionScope({ role: "input.shellcode" });
    const resultScope = executionScope({ role: "result.binary" });
    store.bindOwner(ownerBinding(inputScope));
    const input = store.storeInput(inputArtifact(inputScope, Buffer.from("input")));
    const result = store.storeResult(resultInput(resultScope, Buffer.from("result")));

    expect(Date.parse(input.expiresAt) - Date.parse(input.createdAt)).toBe(
      EXECUTION_ARTIFACT_INPUT_TTL_MILLISECONDS,
    );
    expect(Date.parse(result.expiresAt) - Date.parse(result.createdAt)).toBe(
      EXECUTION_ARTIFACT_RESULT_TTL_MILLISECONDS,
    );
    expect(scheduler.pendingCount).toBe(1);
    expect(scheduler.unrefCount).toBeGreaterThan(0);

    scheduler.advanceBy(EXECUTION_ARTIFACT_INPUT_TTL_MILLISECONDS - 1);
    expect(store.metadata(inputScope, input.handle)).toBe(input);
    scheduler.advanceBy(1);
    expect(() => store.metadata(inputScope, input.handle)).toThrow(ExecutionArtifactAccessError);
    expect(store.getResult(resultScope, result.handle).data.toString()).toBe("result");
    expect(zeroized).toHaveLength(1);

    scheduler.advanceBy(
      EXECUTION_ARTIFACT_RESULT_TTL_MILLISECONDS - EXECUTION_ARTIFACT_INPUT_TTL_MILLISECONDS,
    );
    expect(() => store.getResult(resultScope, result.handle)).toThrow(ExecutionArtifactAccessError);
    expect(store.usage()).toEqual({ itemCount: 0, byteCount: 0 });
    expect(zeroized).toHaveLength(2);
    expect(zeroized.every((data) => data.equals(Buffer.alloc(data.length)))).toBe(true);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("enforces per-artifact, per-window, and global byte ceilings without collateral eviction", () => {
    const store = createStore({
      now: () => NOW,
      autoPrune: false,
      maximumArtifactBytes: 8,
      perWindowByteLimit: 12,
      globalByteLimit: 16,
    });
    const ownerA = executionScope({ ownerWindowId: 7 });
    const ownerB = executionScope({ ownerWindowId: 8 });
    store.bindOwner(ownerBinding(ownerA));
    store.bindOwner(ownerBinding(ownerB));

    const a1Bytes = Buffer.alloc(8, 1);
    const a2Bytes = Buffer.alloc(4, 2);
    const aRejected = Buffer.alloc(1, 3);
    const b1Bytes = Buffer.alloc(4, 4);
    const bRejected = Buffer.alloc(1, 5);
    const oversized = Buffer.alloc(9, 6);
    const a1 = store.storeInput(inputArtifact(ownerA, a1Bytes));
    const a2 = store.storeResult(resultInput(ownerA, a2Bytes));

    expect(() => store.storeInput(inputArtifact(ownerA, aRejected))).toThrow(
      ExecutionArtifactCapacityError,
    );
    const b1 = store.storeResult(resultInput(ownerB, b1Bytes));
    expect(() => store.storeInput(inputArtifact(ownerB, bRejected))).toThrow(
      ExecutionArtifactCapacityError,
    );
    expect(() => store.storeInput(inputArtifact(ownerA, oversized))).toThrow(
      ExecutionArtifactCapacityError,
    );

    expect(aRejected).toEqual(Buffer.alloc(1, 3));
    expect(bRejected).toEqual(Buffer.alloc(1, 5));
    expect(oversized).toEqual(Buffer.alloc(9, 6));
    expect(store.metadata(ownerA, a1.handle)).toBe(a1);
    expect(store.metadata(ownerA, a2.handle)).toBe(a2);
    expect(store.metadata(ownerB, b1.handle)).toBe(b1);
    expect(store.usage(ownerA.ownerWindowId)).toEqual({ itemCount: 2, byteCount: 12 });
    expect(store.usage()).toEqual({ itemCount: 3, byteCount: 16 });

    store.consumeInput(ownerA, a1.handle).data.fill(0);
    const admitted = store.storeResult(resultInput(ownerB, Buffer.alloc(8, 7)));
    expect(store.metadata(ownerB, admitted.handle)).toBe(admitted);

    expect(() => createStore({ maximumArtifactBytes: EXECUTION_ARTIFACT_MAX_BYTES + 1 })).toThrow(
      /maximumArtifactBytes/u,
    );
    expect(() =>
      createStore({ perWindowByteLimit: EXECUTION_ARTIFACT_DEFAULT_WINDOW_BYTE_LIMIT + 1 }),
    ).toThrow(/perWindowByteLimit/u);
    expect(() => createStore({ globalByteLimit: EXECUTION_ARTIFACT_DEFAULT_GLOBAL_BYTE_LIMIT + 1 })).toThrow(
      /globalByteLimit/u,
    );
  });

  it("revokes an owner's artifacts on connection rebinding but preserves multiple targets on one connection", () => {
    const zeroized: Buffer[] = [];
    const store = createStore({
      now: () => NOW,
      autoPrune: false,
      onDidZeroize: (data) => zeroized.push(Buffer.from(data)),
    });
    const firstTarget = executionScope();
    const secondTarget = executionScope({
      target: { mode: "beacon", id: "beacon-2", domainRevision: 4, fingerprint: "d".repeat(64) },
      operationId: "operation-beacon",
    });
    store.bindOwner(ownerBinding(firstTarget));
    const first = store.storeResult(resultInput(firstTarget, Buffer.from("first")));
    const second = store.storeResult(resultInput(secondTarget, Buffer.from("second")));

    expect(store.metadata(firstTarget, first.handle)).toBe(first);
    expect(store.metadata(secondTarget, second.handle)).toBe(second);

    const replacement = executionScope({
      backendEpoch: 2,
      connectionIncarnation: 2,
      target: { backendEpoch: 2, domainRevision: 0, fingerprint: "e".repeat(64) },
    });
    store.bindOwner(ownerBinding(replacement));

    expect(store.usage()).toEqual({ itemCount: 0, byteCount: 0 });
    expect(zeroized).toHaveLength(2);
    expect(() => store.metadata(firstTarget, first.handle)).toThrow(ExecutionArtifactAccessError);
    expect(() => store.storeResult(resultInput(firstTarget, Buffer.from("late")))).toThrow(
      ExecutionArtifactAccessError,
    );
    expect(store.storeResult(resultInput(replacement, Buffer.from("current")))).toBeDefined();
  });

  it("zeroizes exact removal, operation, target, backend, owner, and close teardown paths", () => {
    const zeroized: Buffer[] = [];
    const scheduler = new FakeScheduler(NOW);
    const store = createStore({
      now: scheduler.now,
      timers: scheduler,
      onDidZeroize: (data) => zeroized.push(Buffer.from(data)),
    });
    const ownerA = executionScope();
    const ownerB = executionScope({ ownerWindowId: 8 });
    const ownerC = executionScope({
      ownerWindowId: 9,
      backendId: "b".repeat(64),
      target: { fingerprint: "c".repeat(64) },
    });
    store.bindOwner(ownerBinding(ownerA));
    store.bindOwner(ownerBinding(ownerB));
    store.bindOwner(ownerBinding(ownerC));

    const exact = store.storeInput(inputArtifact(ownerA, Buffer.from("exact")));
    store.remove(ownerA, exact.handle);

    const operationRoleA = executionScope({ operationId: "operation-two", role: "input.username" });
    const operationRoleB = executionScope({ operationId: "operation-two", role: "input.password" });
    store.storeInput(inputArtifact(operationRoleA, Buffer.from("username")));
    store.storeInput(inputArtifact(operationRoleB, Buffer.from("password")));
    expect(store.removeOperation(operationBinding(operationRoleA))).toBe(2);

    const targetTwo = executionScope({
      target: { id: "target-2", domainRevision: 2, fingerprint: "d".repeat(64) },
    });
    store.storeResult(resultInput(targetTwo, Buffer.from("target")));
    expect(store.removeTarget(targetBinding(targetTwo))).toBe(1);

    store.storeResult(resultInput(ownerA, Buffer.from("backend-a")));
    store.storeResult(resultInput(ownerB, Buffer.from("backend-b")));
    expect(store.removeBackend(backendBinding(ownerA))).toBe(2);
    expect(() => store.storeInput(inputArtifact(ownerA, Buffer.from("revoked")))).toThrow(
      ExecutionArtifactAccessError,
    );

    store.storeInput(inputArtifact(ownerC, Buffer.from("owner")));
    expect(store.removeOwner(ownerC.ownerWindowId)).toBe(1);
    store.bindOwner(ownerBinding(ownerC));
    store.storeResult(resultInput(ownerC, Buffer.from("close")));
    expect(scheduler.pendingCount).toBe(1);
    store.close();
    store.close();

    expect(zeroized).toHaveLength(8);
    expect(zeroized.every((data) => data.equals(Buffer.alloc(data.length)))).toBe(true);
    expect(scheduler.pendingCount).toBe(0);
    expect(() => store.usage()).toThrow(/closed/u);
  });

  it("rejects malformed scope identities and keeps empty artifacts valid", () => {
    const store = createStore({ now: () => NOW, autoPrune: false });
    const scope = executionScope();
    store.bindOwner(ownerBinding(scope));
    const empty = store.storeResult({
      scope,
      data: Buffer.alloc(0),
      mediaType: "application/octet-stream",
      suggestedBasename: "CON.txt",
    });
    expect(empty.size).toBe(0);
    expect(empty.suggestedBasename).toBe("_CON.txt");
    expect(store.getResult(scope, empty.handle).data).toHaveLength(0);

    expect(() =>
      store.storeInput(inputArtifact(executionScope({ target: { backendEpoch: 2 } }), Buffer.from("x"))),
    ).toThrow(/backendEpoch/u);
    expect(() =>
      store.storeInput(inputArtifact(executionScope({ role: "bad\u202erole" }), Buffer.from("x"))),
    ).toThrow(/role/u);
    expect(() =>
      store.storeInput({
        ...inputArtifact(scope, Buffer.from("x")),
        mediaType: "text/plain; charset=utf-8",
      }),
    ).toThrow(/media type/u);
  });
});

class FakeTimer implements ExecutionArtifactTimerHandle {
  unrefCalled = false;

  constructor(readonly id: number) {}

  unref(): void {
    this.unrefCalled = true;
  }
}

class FakeScheduler implements ExecutionArtifactTimers {
  private time: number;
  private nextId = 1;
  private readonly scheduled = new Map<number, { timer: FakeTimer; due: number; callback: () => void }>();

  constructor(start: number) {
    this.time = start;
  }

  readonly now = (): number => this.time;

  get pendingCount(): number {
    return this.scheduled.size;
  }

  get unrefCount(): number {
    return [...this.scheduled.values()].filter(({ timer }) => timer.unrefCalled).length;
  }

  setTimeout(callback: () => void, delayMilliseconds: number): ExecutionArtifactTimerHandle {
    const timer = new FakeTimer(this.nextId);
    this.nextId += 1;
    this.scheduled.set(timer.id, { timer, due: this.time + delayMilliseconds, callback });
    return timer;
  }

  clearTimeout(handle: ExecutionArtifactTimerHandle): void {
    if (handle instanceof FakeTimer) this.scheduled.delete(handle.id);
  }

  advanceBy(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new TypeError("Invalid timer advance");
    const target = this.time + milliseconds;
    while (true) {
      const next = [...this.scheduled.values()]
        .filter(({ due }) => due <= target)
        .sort((left, right) => left.due - right.due || left.timer.id - right.timer.id)[0];
      if (!next) break;
      this.time = next.due;
      this.scheduled.delete(next.timer.id);
      next.callback();
    }
    this.time = target;
  }
}

type ScopeOverrides = Omit<Partial<ExecutionArtifactScope>, "target"> & {
  readonly target?: Partial<ExecutionArtifactTargetRef>;
};

function createStore(options: ExecutionArtifactStoreOptions = {}): ExecutionArtifactStore {
  const store = new ExecutionArtifactStore(options);
  stores.push(store);
  return store;
}

function executionScope(overrides: ScopeOverrides = {}): ExecutionArtifactScope {
  const target: ExecutionArtifactTargetRef = {
    mode: "session",
    id: "target-1",
    backendEpoch: 1,
    domainRevision: 17,
    fingerprint: "f".repeat(64),
    ...overrides.target,
  };
  return {
    ownerWindowId: 7,
    backendId: "a".repeat(64),
    backendEpoch: 1,
    connectionIncarnation: 3,
    operationId: "operation-1",
    role: "result.stdout",
    ...overrides,
    target,
  };
}

function ownerBinding(scope: ExecutionArtifactScope): ExecutionArtifactOwnerBinding {
  return {
    ownerWindowId: scope.ownerWindowId,
    backendId: scope.backendId,
    backendEpoch: scope.backendEpoch,
    connectionIncarnation: scope.connectionIncarnation,
  };
}

function targetBinding(scope: ExecutionArtifactScope): ExecutionArtifactTargetBinding {
  return { ...ownerBinding(scope), target: scope.target };
}

function operationBinding(scope: ExecutionArtifactScope): ExecutionArtifactOperationBinding {
  return { ...targetBinding(scope), operationId: scope.operationId };
}

function backendBinding(scope: ExecutionArtifactScope): ExecutionArtifactBackendBinding {
  return { backendId: scope.backendId, backendEpoch: scope.backendEpoch };
}

function inputArtifact(scope: ExecutionArtifactScope, data: Buffer) {
  return {
    scope,
    data,
    mediaType: "application/octet-stream",
    suggestedBasename: "input.bin",
  };
}

function resultInput(scope: ExecutionArtifactScope, data: Buffer) {
  return {
    scope,
    data,
    mediaType: "application/octet-stream",
    suggestedBasename: "result.bin",
  };
}
