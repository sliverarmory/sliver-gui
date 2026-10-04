// @vitest-environment node

import { describe, expect, it } from "vitest";
import { clientpb } from "sliver-script";

import { MAX_TARGET_DOMAIN_ITEMS } from "../shared/target-contracts.js";
import {
  TargetStore,
  nanosecondsToMilliseconds,
  normalizeBeaconSummary,
  normalizeOperatorPresenceSummaries,
  normalizeSessionSummary,
  redactTargetEndpoint,
  unixSecondsToIso,
} from "./target-store.js";

const NOW_MS = Date.UTC(2026, 7, 9, 20, 0, 0);
const NOW_SECONDS = String(NOW_MS / 1_000);

describe("target summary normalization", () => {
  it("bounds text and removes endpoint credentials, queries, fragments, and paths", () => {
    const summary = normalizeSessionSummary(
      session({
        Name: `  operator\u0000 ${"x".repeat(400)}  `,
        RemoteAddress: "tcp://endpoint-remote-user:secret@10.20.30.40:4444/private?token=remote#fragment",
        ActiveC2: "https://endpoint-c2-user:password@c2.example.test:8443/private?token=c2#fragment",
        Filename: "/private/target/path/implant.bin",
        UID: "  501  ",
        GID: "20",
        LastCheckin: NOW_SECONDS,
        FirstContact: String(Number(NOW_SECONDS) - 60),
        ReconnectInterval: "1500000000",
      }),
    );

    expect(summary).toMatchObject({
      mode: "session",
      id: "session-1",
      transport: "mtls",
      remoteAddress: "tcp://10.20.30.40:4444",
      activeC2: "https://c2.example.test:8443",
      executable: "implant.bin",
      uid: "501",
      gid: "20",
      reconnectIntervalMs: 1_500,
      lastCheckinAt: new Date(NOW_MS).toISOString(),
      liveness: "active",
    });
    expect([...summary.name]).toHaveLength(256);
    expect(summary.name).not.toMatch(/[\u0000\u202e]/u);
    expect(`${summary.remoteAddress} ${summary.activeC2}`).not.toMatch(
      /endpoint-remote-user|endpoint-c2-user|secret|password|token|private|fragment/u,
    );
    expect(summary).not.toHaveProperty("ProxyURL");
    expect(summary).not.toHaveProperty("Extensions");
  });

  it("derives beacon check-in state from safe NextCheckin data and never trusts IsDead", () => {
    const onTime = normalizeBeaconSummary(
      beacon({
        IsDead: true,
        NextCheckin: String(Number(NOW_SECONDS) + 30),
        TasksCount: "12",
        TasksCountCompleted: "7",
      }),
      NOW_MS,
    );
    const overdue = normalizeBeaconSummary(
      beacon({ IsDead: false, NextCheckin: String(Number(NOW_SECONDS) - 1) }),
      NOW_MS,
    );
    const unknown = normalizeBeaconSummary(beacon({ IsDead: true, NextCheckin: "0" }), NOW_MS);

    expect(onTime).toMatchObject({
      checkinStatus: "on-time",
      taskCount: 12,
      completedTaskCount: 7,
      nonCompletedTaskCount: 5,
    });
    expect(overdue.checkinStatus).toBe("overdue");
    expect(unknown.checkinStatus).toBe("unknown");
    expect(onTime).not.toHaveProperty("isDead");
    expect(unknown).not.toHaveProperty("isDead");
  });

  it("omits invalid or unsafe timestamps, durations, PIDs, and task counts", () => {
    const summary = normalizeBeaconSummary(
      beacon({
        PID: Number.MAX_SAFE_INTEGER + 1,
        FirstContact: "-1",
        LastCheckin: "999999999999999999",
        NextCheckin: "not-a-time",
        ReconnectInterval: "9223372036854775808",
        Interval: "9223372036854775808",
        Jitter: "-10",
        TasksCount: "9007199254740992",
        TasksCountCompleted: "nan",
      }),
      NOW_MS,
    );

    expect(summary.checkinStatus).toBe("unknown");
    for (const property of [
      "pid",
      "firstContactAt",
      "lastCheckinAt",
      "nextCheckinAt",
      "reconnectIntervalMs",
      "intervalMs",
      "jitterMs",
      "taskCount",
      "completedTaskCount",
      "nonCompletedTaskCount",
    ]) {
      expect(summary).not.toHaveProperty(property);
    }
    expect(unixSecondsToIso("0")).toBeUndefined();
    expect(unixSecondsToIso("253402300800")).toBeUndefined();
    expect(nanosecondsToMilliseconds("-1")).toBeUndefined();
  });

  it("redacts malformed endpoints instead of reflecting their contents", () => {
    expect(redactTargetEndpoint("not a valid endpoint?token=secret")).toBe("[redacted endpoint]");
    expect(redactTargetEndpoint("mtls://user:pass@[broken?token=secret")).toBe("mtls://[redacted]");
  });

  it("normalizes exact Sliver http(s) and pivot transport labels from authoritative endpoint schemes", () => {
    expect(normalizeSessionSummary(session({ Transport: "http(s)", ActiveC2: "https://c2.example.test" })).transport)
      .toBe("https");
    expect(normalizeBeaconSummary(beacon({ Transport: "http(s)", ActiveC2: "http://c2.example.test" }), NOW_MS).transport)
      .toBe("http");
    expect(normalizeBeaconSummary(beacon({ Transport: "pivot", ActiveC2: "tcppivot://10.0.0.2:9001" }), NOW_MS).transport)
      .toBe("tcppivot");
    expect(normalizeBeaconSummary(beacon({ Transport: "pivot", ActiveC2: "namedpipe://server/pipe/name" }), NOW_MS).transport)
      .toBe("namedpipe");
  });
});

describe("operator presence normalization", () => {
  it("deduplicates operators deterministically without exposing account mutation data", () => {
    const summaries = normalizeOperatorPresenceSummaries([
      clientpb.Operator.create({ Name: " alice ", Online: false }),
      clientpb.Operator.create({ Name: "Alice", Online: true }),
      clientpb.Operator.create({ Name: "bob", Online: false }),
      clientpb.Operator.create({ Name: "\u0000", Online: true }),
    ]);

    expect(summaries).toEqual([
      { id: "alice", name: "Alice", online: true },
      { id: "bob", name: "bob", online: false },
    ]);
    expect(JSON.stringify(summaries)).not.toMatch(/certificate|token|permission/iu);
  });
});

describe("TargetStore", () => {
  it("sorts and caps domain collections deterministically at 500 items", () => {
    const store = new TargetStore({ now: () => NOW_MS });
    const records = Array.from({ length: MAX_TARGET_DOMAIN_ITEMS + 2 }, (_, index) =>
      session({ ID: `session-${String(MAX_TARGET_DOMAIN_ITEMS + 1 - index).padStart(4, "0")}` }),
    );

    const domain = store.replaceSessions(records);

    expect(domain.status).toBe("ready");
    expect(domain.items).toHaveLength(MAX_TARGET_DOMAIN_ITEMS);
    expect(domain.items[0]?.id).toBe("session-0000");
    expect(domain.items.at(-1)?.id).toBe("session-0499");
    expect(domain.page).toEqual({
      limit: MAX_TARGET_DOMAIN_ITEMS,
      total: MAX_TARGET_DOMAIN_ITEMS + 2,
      truncated: true,
    });
    expect(store.catalogPage("session", MAX_TARGET_DOMAIN_ITEMS, 100)).toMatchObject({
      total: MAX_TARGET_DOMAIN_ITEMS + 2,
      revision: 1,
      items: [
        { id: "session-0500" },
        { id: "session-0501" },
      ],
    });
    expect(store.catalogPage("session", 0, 100, " SESSION-0500 ")).toMatchObject({
      total: 1,
      revision: 1,
      items: [{ id: "session-0500" }],
    });
    expect(store.target("session", "session-0500")?.id).toBe("session-0500");
    expect(domain.revision).toBe(1);
    expect(domain.updatedAt).toBe(new Date(NOW_MS).toISOString());
  });

  it("preserves target revisions for identical refreshes and changes them for hidden catalog metadata", () => {
    const store = new TargetStore({ now: () => NOW_MS });
    const records = Array.from({ length: MAX_TARGET_DOMAIN_ITEMS + 1 }, (_, index) =>
      session({ ID: `session-${String(index).padStart(4, "0")}`, Name: `name-${index}` }),
    );
    const first = store.replaceSessions(records);
    const identical = store.replaceSessions(records.map((record) => clientpb.Session.create({ ...record })));

    expect(identical.revision).toBe(first.revision);
    const changed = records.map((record) => clientpb.Session.create({ ...record }));
    changed[MAX_TARGET_DOMAIN_ITEMS]!.Name = "changed-outside-snapshot-projection";
    const afterHiddenChange = store.replaceSessions(changed);
    expect(afterHiddenChange.revision).toBe(first.revision + 1);
  });

  it("fails duplicate IDs deterministically, including duplicates beyond the output cap", () => {
    const store = new TargetStore({ now: () => NOW_MS });
    const committed = store.replaceSessions([session({ ID: "original" })]);
    const crowded = Array.from({ length: MAX_TARGET_DOMAIN_ITEMS + 1 }, (_, index) =>
      session({ ID: `unique-${String(index).padStart(4, "0")}` }),
    );
    const failed = store.replaceSessions([
      ...crowded,
      session({ ID: "z-duplicate" }),
      session({ ID: "z-duplicate" }),
      session({ ID: "a-duplicate" }),
      session({ ID: "a-duplicate" }),
    ]);

    expect(failed.status).toBe("error");
    expect(failed.error).toBe("Duplicate session ID: a-duplicate");
    expect(failed.revision).toBe(committed.revision);
    expect(failed.items.map(({ id }) => id)).toEqual(["original"]);
  });

  it("deduplicates then caps operator presence collections", () => {
    const store = new TargetStore({ now: () => NOW_MS });
    const records = Array.from({ length: MAX_TARGET_DOMAIN_ITEMS + 2 }, (_, index) =>
      clientpb.Operator.create({ Name: `operator-${String(index).padStart(4, "0")}`, Online: false }),
    );
    records.push(clientpb.Operator.create({ Name: "OPERATOR-0000", Online: true }));

    const domain = store.replaceOperators(records);

    expect(domain.items).toHaveLength(MAX_TARGET_DOMAIN_ITEMS);
    expect(domain.page.total).toBe(MAX_TARGET_DOMAIN_ITEMS + 2);
    expect(domain.page.truncated).toBe(true);
    expect(domain.items[0]).toEqual({ id: "operator-0000", name: "OPERATOR-0000", online: true });
  });

  it("revalidates stable target identity across revisions but rejects epoch or identity replacement", () => {
    const store = new TargetStore({ now: () => NOW_MS });
    store.replaceSessions([
      session({ ID: "selected", UUID: "host-a", FirstContact: "1700000000", Name: "first-name" }),
    ]);
    const original = store.createTargetRef("session", "selected", 7);
    expect(original).toBeDefined();

    store.replaceSessions([
      session({
        ID: "selected",
        UUID: "host-a",
        FirstContact: "1700000000",
        Name: "renamed",
        LastCheckin: String(Number(NOW_SECONDS) + 1),
      }),
    ]);

    expect(store.isCurrentTargetRef(original!, 7)).toBe(false);
    const revalidated = store.revalidateTargetRef(original!, 7);
    expect(revalidated?.target.name).toBe("renamed");
    expect(revalidated?.ref.domainRevision).toBe(2);
    expect(revalidated?.ref.fingerprint).toBe(original?.fingerprint);
    expect(store.revalidateTargetRef(original!, 8)).toBeUndefined();

    store.replaceSessions([
      session({ ID: "selected", UUID: "host-b", FirstContact: "1800000000", Name: "replacement" }),
    ]);
    expect(store.revalidateTargetRef(original!, 7)).toBeUndefined();
  });

  it("retains exact ActiveC2 only in the main-owned index while snapshots stay redacted", () => {
    const store = new TargetStore({ now: () => NOW_MS });
    const exact = "https://operator:secret@c2.example.test:8443/private?token=hidden#fragment";
    store.replaceBeacons([beacon({ ID: "c2-safe", ActiveC2: exact })]);

    expect(store.target("beacon", "c2-safe")?.activeC2).toBe("https://c2.example.test:8443");
    expect(store.authoritativeActiveC2("beacon", "c2-safe")).toBe(exact);
    expect(JSON.stringify(store.snapshot())).not.toMatch(/operator:|secret|\/private|hidden|fragment/u);

    store.reset();
    expect(store.authoritativeActiveC2("beacon", "c2-safe")).toBeUndefined();
  });

  it("returns detached DTO copies and clears every target domain on reset", () => {
    const store = new TargetStore({ now: () => NOW_MS });
    const first = store.replaceSessions([session({ ID: "safe-copy" })]);
    first.items[0]!.name = "renderer mutation";
    first.page.total = 999;

    expect(store.target("session", "safe-copy")?.name).toBe("session-name");
    expect(store.snapshot().sessions.page.total).toBe(1);

    store.replaceBeacons([beacon({ ID: "beacon-safe" })]);
    store.replaceOperators([clientpb.Operator.create({ Name: "alice", Online: true })]);
    const reset = store.reset();
    expect(reset.sessions.status).toBe("empty");
    expect(reset.beacons.items).toEqual([]);
    expect(reset.operators.items).toEqual([]);
  });
});

function session(overrides: Partial<clientpb.Session> = {}): clientpb.Session {
  return clientpb.Session.create({
    ID: "session-1",
    Name: "session-name",
    Hostname: "host-one",
    UUID: "host-uuid",
    Username: "alice",
    UID: "501",
    GID: "20",
    OS: "Windows",
    Arch: "AMD64",
    Transport: "mtls",
    RemoteAddress: "10.0.0.2:4444",
    PID: 4242,
    Filename: "implant.exe",
    LastCheckin: NOW_SECONDS,
    ActiveC2: "mtls://c2.example.test:8888",
    Version: "1.0.0",
    IsDead: false,
    ReconnectInterval: "60000000000",
    ProxyURL: "https://secret:credential@proxy.example.test/?token=hidden",
    Burned: false,
    Extensions: ["extension-with-private-state"],
    Locale: "en-US",
    FirstContact: String(Number(NOW_SECONDS) - 3_600),
    Integrity: "High",
    ...overrides,
  });
}

function beacon(overrides: Partial<clientpb.Beacon> = {}): clientpb.Beacon {
  return clientpb.Beacon.create({
    ID: "beacon-1",
    Name: "beacon-name",
    Hostname: "host-two",
    UUID: "beacon-host-uuid",
    Username: "bob",
    OS: "linux",
    Arch: "amd64",
    Transport: "https",
    RemoteAddress: "10.0.0.3:443",
    PID: 4343,
    Filename: "implant",
    LastCheckin: NOW_SECONDS,
    ActiveC2: "https://c2.example.test:443",
    Version: "1.0.0",
    IsDead: false,
    ReconnectInterval: "60000000000",
    Interval: "30000000000",
    Jitter: "5000000000",
    Burned: false,
    NextCheckin: String(Number(NOW_SECONDS) + 30),
    TasksCount: "0",
    TasksCountCompleted: "0",
    Locale: "en-US",
    FirstContact: String(Number(NOW_SECONDS) - 3_600),
    Integrity: "High",
    ...overrides,
  });
}
