// @vitest-environment node

import { describe, expect, it } from "vitest";
import { clientpb } from "sliver-script";

import {
  TARGET_CAPABILITY_IDS,
  type TargetCapabilityId,
  type TargetRef,
  type TargetServerSupport,
} from "../shared/target-contracts.js";
import {
  calculateTargetCapabilities,
  createWindowTargetContext,
  targetCapability,
} from "./target-capabilities.js";
import { normalizeBeaconSummary, normalizeSessionSummary, stableTargetFingerprint } from "./target-store.js";

const NOW_MS = Date.UTC(2026, 7, 9, 20, 0, 0);
const NOW_SECONDS = NOW_MS / 1_000;
const SUPPORT_ALL: TargetServerSupport = { supported: [...TARGET_CAPABILITY_IDS] };

describe("calculateTargetCapabilities", () => {
  it("enables supported live session actions and explains mode-only actions", () => {
    const target = normalizeSessionSummary(
      clientpb.Session.create({
        ID: "session-1",
        Name: "session",
        UUID: "host-1",
        OS: "windows",
        Arch: "amd64",
        Transport: "mtls",
        ActiveC2: "mtls://c2.example.test:8888",
        FirstContact: "1700000000",
      }),
    );
    const capabilities = calculateTargetCapabilities(target, SUPPORT_ALL);

    expect(targetCapability(capabilities, "target.ping")).toEqual({
      id: "target.ping",
      available: true,
    });
    expect(targetCapability(capabilities, "target.environment.write").available).toBe(true);
    expect(targetCapability(capabilities, "session.close").available).toBe(true);
    expect(targetCapability(capabilities, "beacon.reconfigure")).toMatchObject({
      available: false,
      reason: { code: "requires-beacon" },
    });
    expect(capabilities.map(({ id }) => id)).toEqual(TARGET_CAPABILITY_IDS);
  });

  it("changes live action availability with target liveness while preserving metadata actions", () => {
    const dead = normalizeSessionSummary(
      clientpb.Session.create({
        ID: "dead-session",
        UUID: "host-1",
        OS: "linux",
        Arch: "amd64",
        Transport: "https",
        IsDead: true,
      }),
    );
    const capabilities = calculateTargetCapabilities(dead, SUPPORT_ALL);

    expect(targetCapability(capabilities, "target.ping")).toMatchObject({
      available: false,
      reason: { code: "target-dead" },
    });
    expect(targetCapability(capabilities, "target.terminate").reason?.code).toBe("target-dead");
    expect(targetCapability(capabilities, "target.rename").available).toBe(true);
  });

  it("keeps queueable beacon actions available while surfacing overdue state separately", () => {
    const overdue = normalizeBeaconSummary(
      clientpb.Beacon.create({
        ID: "beacon-1",
        UUID: "host-1",
        OS: "linux",
        Arch: "amd64",
        Transport: "dns",
        IsDead: false,
        NextCheckin: String(NOW_SECONDS - 1),
      }),
      NOW_MS,
    );
    const unknown = normalizeBeaconSummary(
      clientpb.Beacon.create({
        ID: "beacon-2",
        UUID: "host-2",
        OS: "linux",
        Arch: "amd64",
        Transport: "dns",
        IsDead: false,
        NextCheckin: "0",
      }),
      NOW_MS,
    );

    const overdueCapabilities = calculateTargetCapabilities(overdue, SUPPORT_ALL);
    expect(targetCapability(overdueCapabilities, "beacon.reconfigure").available).toBe(true);
    expect(targetCapability(overdueCapabilities, "target.ping").available).toBe(true);
    expect(targetCapability(overdueCapabilities, "beacon.remove").available).toBe(true);
    expect(targetCapability(overdueCapabilities, "beacon.tasks.read").available).toBe(true);
    expect(targetCapability(overdueCapabilities, "beacon.tasks.cancel").available).toBe(true);
    expect(targetCapability(calculateTargetCapabilities(unknown, SUPPORT_ALL), "target.ping").available).toBe(true);
  });

  it("fails closed when the server or transport does not support an action", () => {
    const unknownTransport = normalizeSessionSummary(
      clientpb.Session.create({
        ID: "session-unknown",
        UUID: "host-1",
        OS: "linux",
        Arch: "amd64",
        Transport: "experimental-secret-transport",
      }),
    );
    const serverSupport: TargetServerSupport = { supported: ["target.ping", "target.rename"] };
    const capabilities = calculateTargetCapabilities(unknownTransport, serverSupport);

    expect(targetCapability(capabilities, "target.ping").reason?.code).toBe("unsupported-transport");
    expect(targetCapability(capabilities, "target.rename").available).toBe(true);
    expect(targetCapability(capabilities, "target.terminate").reason?.code).toBe("unsupported-by-server");

    const inconsistentDnsSession = {
      ...unknownTransport,
      transport: "dns" as const,
    };
    expect(
      targetCapability(calculateTargetCapabilities(inconsistentDnsSession, SUPPORT_ALL), "session.close").reason?.code,
    ).toBe("unsupported-transport");
  });

  it("returns an unavailable server reason for missing capability entries", () => {
    const state = targetCapability([], "target.ping");
    expect(state).toMatchObject({
      id: "target.ping",
      available: false,
      reason: { code: "unsupported-by-server" },
    });
  });
});

describe("createWindowTargetContext", () => {
  it("represents no selection without capabilities or beacon watch state", () => {
    expect(
      createWindowTargetContext({ activeTarget: null, serverSupport: SUPPORT_ALL, beaconWatch: true }),
    ).toEqual({
      status: "none",
      activeTarget: null,
      activeTargetSummary: null,
      selectableTargets: [],
      capabilities: [],
      beaconWatch: false,
    });
  });

  it("returns a selected target summary with calculated capabilities", () => {
    const target = normalizeBeaconSummary(
      clientpb.Beacon.create({
        ID: "selected-beacon",
        Name: "selected",
        UUID: "host-1",
        OS: "linux",
        Arch: "amd64",
        Transport: "https",
        NextCheckin: String(NOW_SECONDS + 60),
        FirstContact: "1700000000",
      }),
      NOW_MS,
    );
    const ref = targetRef(target, 4, 9);
    const context = createWindowTargetContext({
      activeTarget: ref,
      activeTargetSummary: target,
      serverSupport: SUPPORT_ALL,
      openSessionEndpointAvailable: true,
      beaconWatch: true,
    });

    expect(context.status).toBe("selected");
    expect(context.activeTarget).toEqual(ref);
    expect(context.activeTargetSummary?.id).toBe("selected-beacon");
    expect(context.beaconWatch).toBe(true);
    expect(targetCapability(context.capabilities, "beacon.open-session").available).toBe(true);
  });

  it("advertises session conversion only when main has validated the authoritative endpoint", () => {
    const target = normalizeBeaconSummary(
      clientpb.Beacon.create({
        ID: "endpoint-beacon",
        UUID: "host-1",
        OS: "linux",
        Arch: "amd64",
        Transport: "mtls",
        ActiveC2: "mtls://c2.example.test:8888",
        NextCheckin: String(NOW_SECONDS + 60),
      }),
      NOW_MS,
    );

    expect(targetCapability(
      calculateTargetCapabilities(target, SUPPORT_ALL, { openSessionEndpointAvailable: false }),
      "beacon.open-session",
    )).toMatchObject({ available: false, reason: { code: "unsupported-transport" } });
    expect(targetCapability(
      calculateTargetCapabilities(target, SUPPORT_ALL, { openSessionEndpointAvailable: true }),
      "beacon.open-session",
    )).toEqual({ id: "beacon.open-session", available: true });
  });

  it("retains selected detail while a non-authoritative refresh disables every action", () => {
    const target = normalizeBeaconSummary(
      clientpb.Beacon.create({
        ID: "refreshing-beacon",
        UUID: "host-1",
        Transport: "mtls",
        ActiveC2: "mtls://c2.example.test:8888",
        NextCheckin: String(NOW_SECONDS + 60),
      }),
      NOW_MS,
    );
    const ref = targetRef(target, 4, 9);
    const context = createWindowTargetContext({
      activeTarget: ref,
      activeTargetSummary: target,
      serverSupport: SUPPORT_ALL,
      authoritative: false,
      unavailableReason: "Refreshing target inventory.",
    });

    expect(context).toMatchObject({
      status: "unavailable",
      activeTarget: ref,
      activeTargetSummary: { id: target.id },
      unavailableReason: "Refreshing target inventory.",
    });
    expect(context.capabilities.every(({ available }) => !available)).toBe(true);
  });

  it("preserves a stale selection as unavailable instead of clearing or falling back", () => {
    const stale: TargetRef = {
      mode: "beacon",
      id: "disappeared",
      backendEpoch: 4,
      domainRevision: 9,
      fingerprint: "a".repeat(64),
    };
    const context = createWindowTargetContext({
      activeTarget: stale,
      activeTargetSummary: null,
      serverSupport: SUPPORT_ALL,
      beaconWatch: true,
      unavailableReason: `  disappeared\u0000 ${"x".repeat(400)}  `,
    });

    expect(context.status).toBe("unavailable");
    expect(context.activeTarget).toEqual(stale);
    expect(context.activeTargetSummary).toBeNull();
    expect(context.beaconWatch).toBe(true);
    expect(context.capabilities).toHaveLength(TARGET_CAPABILITY_IDS.length);
    expect(context.capabilities.every(({ available }) => !available)).toBe(true);
    expect(context.unavailableReason).not.toMatch(/\u0000/u);
    expect([...(context.unavailableReason ?? "")].length).toBeLessThanOrEqual(256);
  });

  it("treats a mismatched summary as unavailable rather than selecting another target", () => {
    const target = normalizeSessionSummary(
      clientpb.Session.create({ ID: "other", UUID: "host", OS: "linux", Arch: "amd64", Transport: "mtls" }),
    );
    const stale: TargetRef = {
      mode: "session",
      id: "wanted",
      backendEpoch: 2,
      domainRevision: 1,
      fingerprint: "b".repeat(64),
    };

    const context = createWindowTargetContext({
      activeTarget: stale,
      activeTargetSummary: target,
      serverSupport: SUPPORT_ALL,
    });
    expect(context.status).toBe("unavailable");
    expect(context.activeTarget?.id).toBe("wanted");
    expect(context.activeTargetSummary).toBeNull();
  });
});

function targetRef(
  target: ReturnType<typeof normalizeBeaconSummary>,
  backendEpoch: number,
  domainRevision: number,
): TargetRef {
  return {
    mode: target.mode,
    id: target.id,
    backendEpoch,
    domainRevision,
    fingerprint: stableTargetFingerprint(target),
  };
}

function expectCapabilityId(_id: TargetCapabilityId): void {}

expectCapabilityId("target.environment.write");
