import { describe, expect, it } from "vitest";

import {
  parseInstallLocalRedirectorInput,
  parseListLocalRedirectorListenersInput,
  parseLocalRedirectorRecord,
  parseRemoveLocalRedirectorInput,
  parseSoftwareDeploymentState,
  resolveLocalRedirectorDnsNames,
  type LocalRedirectorRecord,
} from "./software-deployment-contracts.js";

const deploymentId = "5d759d8a-18e4-4a8c-83bb-d618169d5bc8";
const installationId = "7bfdb74e-9267-4f14-a29c-c5fc858347ab";
const timestamp = "2026-09-24T12:00:00.000Z";

const installInput = {
  deploymentId, expectedRevision: 0, recipeId: "caddy", publicIp: "203.0.113.10",
  domains: ["C2.Example.Test"], listener: { mode: "create", port: 8000 },
};

function record(): LocalRedirectorRecord {
  return {
    id: installationId, deploymentId, recipeId: "caddy", category: "HTTP Redirectors", subcategory: "local",
    status: "active", publicIp: "203.0.113.10", domains: ["c2.example.test"],
    publicUrl: "https://c2.example.test", frontendPorts: [80, 443], ingressPortsOwned: [80, 443],
    listener: { ownership: "managed", kind: "http", host: "127.0.0.1", port: 8000, jobId: 8, domain: "" },
    serviceName: `sliver-gui-caddy-${installationId}.service`,
    createdAt: timestamp, updatedAt: timestamp, lastCheckedAt: timestamp, lastError: null,
  };
}

describe("managed software IPC contracts", () => {
  it("normalizes public domains and freezes validated install input", () => {
    const parsed = parseInstallLocalRedirectorInput(installInput);
    expect(parsed).toMatchObject({ recipeId: "caddy", domains: ["c2.example.test"], listener: { mode: "create", port: 8000 } });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.domains)).toBe(true);
    expect(Object.isFrozen(parsed.listener)).toBe(true);
    expect(parseInstallLocalRedirectorInput({ ...installInput, recipeId: "nginx", domains: [], listener: { mode: "existing", jobId: 8 } })).toMatchObject({
      recipeId: "nginx", publicIp: "203.0.113.10", domains: [], listener: { mode: "existing", jobId: 8 },
    });
  });

  it("accepts optional public DNS creation without changing legacy request shape", () => {
    const legacy = parseInstallLocalRedirectorInput(installInput);
    expect(legacy).not.toHaveProperty("dnsRecords");
    const parsed = parseInstallLocalRedirectorInput({
      ...installInput,
      dnsRecords: { zoneId: "ZEXAMPLE", names: ["C2", "edge.c2"] },
    });
    expect(parsed.dnsRecords).toEqual({ zoneId: "ZEXAMPLE", names: ["c2", "edge.c2"] });
    expect(Object.isFrozen(parsed.dnsRecords)).toBe(true);
    expect(Object.isFrozen(parsed.dnsRecords?.names)).toBe(true);
  });

  it("resolves zone-apex, relative, and same-zone DNS names for redirectors", () => {
    expect(resolveLocalRedirectorDnsNames("Example.Test", ["@", "C2", "Edge.C2", "api.example.test."]))
      .toEqual(["example.test", "c2.example.test", "edge.c2.example.test", "api.example.test"]);
    expect(Object.isFrozen(resolveLocalRedirectorDnsNames("example.test", ["c2"]))).toBe(true);
  });

  it.each([
    ["wildcard", ["*.example.test"]],
    ["underscore", ["bad_name"]],
    ["outside absolute zone", ["c2.other.test."]],
    ["duplicate final domain", ["c2", "C2.EXAMPLE.TEST"]],
    ["too many names", Array.from({ length: 9 }, (_, index) => `c${index}`)],
    ["empty names", []],
  ])("rejects %s DNS creation names", (_description, names) => {
    expect(() => resolveLocalRedirectorDnsNames("example.test", names)).toThrow();
  });

  it.each([
    ["unsupported recipe", { ...installInput, recipeId: "cloudflared" }],
    ["unexpected shell field", { ...installInput, script: "curl evil.example" }],
    ["bad deployment identity", { ...installInput, deploymentId: "../other" }],
    ["invalid public address", { ...installInput, publicIp: "127.0.0.1; touch /tmp/unsafe" }],
    ["unsupported IPv6 address", { ...installInput, publicIp: "2001:db8::10" }],
    ["invalid domain", { ...installInput, domains: ["c2.example.test; curl evil.example"] }],
    ["duplicate domain", { ...installInput, domains: ["C2.Example.Test", "c2.example.test"] }],
    ["no public address", { ...installInput, publicIp: null, domains: [] }],
    ["invalid revision", { ...installInput, expectedRevision: -1 }],
    ["invalid create port", { ...installInput, listener: { mode: "create", port: 0 } }],
    ["invalid existing job", { ...installInput, listener: { mode: "existing", jobId: 0 } }],
    ["unexpected listener field", { ...installInput, listener: { mode: "create", port: 8000, command: "true" } }],
    ["missing DNS zone", { ...installInput, dnsRecords: { zoneId: "", names: ["c2"] } }],
    ["empty DNS names", { ...installInput, dnsRecords: { zoneId: "ZEXAMPLE", names: [] } }],
    ["unexpected DNS field", { ...installInput, dnsRecords: { zoneId: "ZEXAMPLE", names: ["c2"], command: "true" } }],
  ])("rejects %s", (_description, value) => {
    expect(() => parseInstallLocalRedirectorInput(value)).toThrow();
  });

  it("requires exact removal and listener-listing identities", () => {
    expect(parseRemoveLocalRedirectorInput({ deploymentId, installationId, expectedRevision: 2 })).toEqual({ deploymentId, installationId, expectedRevision: 2 });
    expect(parseListLocalRedirectorListenersInput({ deploymentId })).toEqual({ deploymentId });
    expect(() => parseRemoveLocalRedirectorInput({ deploymentId, installationId: "other", expectedRevision: 2 })).toThrow();
    expect(() => parseRemoveLocalRedirectorInput({ deploymentId, installationId, expectedRevision: 2, force: true })).toThrow();
    expect(() => parseListLocalRedirectorListenersInput({ deploymentId, includeSecrets: true })).toThrow();
  });
});

describe("managed software persisted contracts", () => {
  it("freezes exact, bounded state and preserves redirector ownership fields", () => {
    const parsed = parseSoftwareDeploymentState({ v: 1, revision: 3, records: [record()] });
    expect(parsed).toMatchObject({ v: 1, revision: 3, records: [{ ingressPortsOwned: [80, 443], listener: { host: "127.0.0.1", jobId: 8 } }] });
    expect(Object.isFrozen(parsed.records)).toBe(true);
    expect(Object.isFrozen(parsed.records[0]?.domains)).toBe(true);
    expect(Object.isFrozen(parsed.records[0]?.ingressPortsOwned)).toBe(true);
    expect(Object.isFrozen(parsed.records[0]?.listener)).toBe(true);
  });

  it("allows an unconfirmed managed job only while recovery is pending", () => {
    const pending = { ...record(), status: "outcome-unknown", listener: { ...record().listener, jobId: 0 } };
    expect(parseLocalRedirectorRecord(pending).listener.jobId).toBe(0);
    expect(() => parseLocalRedirectorRecord({ ...pending, status: "active" })).toThrow(/unconfirmed/u);
    expect(() => parseLocalRedirectorRecord({ ...pending, listener: { ...pending.listener, ownership: "existing" } })).toThrow(/unconfirmed/u);
  });

  it.each([
    ["wrong category", { ...record(), category: "Other" }],
    ["public listener bind", { ...record(), listener: { ...record().listener, host: "0.0.0.0" } }],
    ["unowned frontend ingress", { ...record(), ingressPortsOwned: [8080] }],
    ["invalid service name", { ...record(), serviceName: "../../caddy.service" }],
    ["invalid timestamp", { ...record(), updatedAt: "yesterday" }],
    ["unknown status", { ...record(), status: "running" }],
    ["unexpected field", { ...record(), secret: "private" }],
  ])("rejects a persisted record with %s", (_description, value) => {
    expect(() => parseLocalRedirectorRecord(value)).toThrow();
  });

  it("rejects duplicate, unsupported, and unexpectedly shaped state", () => {
    expect(() => parseSoftwareDeploymentState({ v: 1, revision: 0, records: [record(), record()] })).toThrow(/Duplicate/u);
    expect(() => parseSoftwareDeploymentState({ v: 2, revision: 0, records: [] })).toThrow();
    expect(() => parseSoftwareDeploymentState({ v: 1, revision: 0, records: [], credentials: {} })).toThrow();
    expect(() => parseSoftwareDeploymentState({ v: 1, revision: -1, records: [] })).toThrow();
    expect(() => parseSoftwareDeploymentState({ v: 1, revision: 0, records: Array.from({ length: 257 }, record) })).toThrow();
  });
});
