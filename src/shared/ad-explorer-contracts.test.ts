import { describe, expect, it } from "vitest";
import { parseAdCollectorRunInput, RUSTHOUND_ARMORY_COLLECTOR_ID } from "./ad-explorer-contracts.js";

const request = {
  target: { mode: "beacon", id: "beacon-1", backendEpoch: 1, domainRevision: 2, fingerprint: "a".repeat(64) },
  collectorId: "sharphound:armory:aliases/SharpHound CE",
  domain: " EXAMPLE.LOCAL ",
  collectionMethod: "DCOnly",
};

describe("AD collector input", () => {
  it("accepts an installed Armory alias with spaces and normalizes an explicit DNS domain", () => {
    expect(parseAdCollectorRunInput(request)).toMatchObject({
      collectorId: "sharphound:armory:aliases/SharpHound CE",
      domain: "example.local", collectionMethod: "DCOnly",
    });
    expect(parseAdCollectorRunInput({ ...request, collectorId: `sharphound:armory:aliases/${"a".repeat(180)}` })).toBeTruthy();
    expect(parseAdCollectorRunInput({ ...request, collectorId: "sharphound:verified:file" }).collectorId).toBe("sharphound:verified:file");
    expect(parseAdCollectorRunInput({ ...request, collectorId: "sharphound:verified:script" }).collectorId).toBe("sharphound:verified:script");
    expect(parseAdCollectorRunInput({ ...request, collectorId: "sharphound:custom:file" }).collectorId).toBe("sharphound:custom:file");
    expect(parseAdCollectorRunInput({ ...request, collectorId: "sharphound:custom:script" }).collectorId).toBe("sharphound:custom:script");
  });

  it("rejects path-like aliases, injected fields, invalid domains, and stale reference shapes", () => {
    for (const collectorId of [
      "sharphound:armory:aliases/../SharpHound", "sharphound:armory:aliases/SharpHound/other",
      "sharphound:armory:aliases/SharpHound.", "sharphound:armory:aliases/CON",
      "sharphound:file", "sharphound:custom:../../file", "sharphound:custom:script/extra", "sharphound:verified:unknown",
    ]) expect(() => parseAdCollectorRunInput({ ...request, collectorId })).toThrow();
    expect(() => parseAdCollectorRunInput({ ...request, argv: ["--arbitrary"] })).toThrow();
    expect(() => parseAdCollectorRunInput({ ...request, domain: "HOST-01" })).toThrow();
    expect(() => parseAdCollectorRunInput({ ...request, target: { ...request.target, fingerprint: "stale" } })).toThrow();
  });

  it("requires bounded transient credentials and a supported RustHound method", () => {
    const rust = { ...request, collectorId: RUSTHOUND_ARMORY_COLLECTOR_ID,
      collectionMethod: "LdapOnly", credentials: { username: "user@example.local", password: "secret" } };
    expect(parseAdCollectorRunInput(rust)).toMatchObject({
      collectorId: RUSTHOUND_ARMORY_COLLECTOR_ID, collectionMethod: "LdapOnly",
      credentials: { username: "user@example.local", password: "secret" },
    });
    expect(parseAdCollectorRunInput({ ...rust, ldapFqdn: " DC.EXAMPLE.LOCAL " }).ldapFqdn).toBe("dc.example.local");
    expect(parseAdCollectorRunInput({ ...rust, ldaps: true }).ldaps).toBe(true);
    expect(() => parseAdCollectorRunInput({ ...rust, ldaps: "true" })).toThrow();
    expect(() => parseAdCollectorRunInput({ ...rust, ldapFqdn: "dc\u0000.example.local" })).toThrow();
    expect(() => parseAdCollectorRunInput({ ...request, ldapFqdn: "dc.example.local" })).toThrow(/does not accept/u);
    expect(() => parseAdCollectorRunInput({ ...request, ldaps: true })).toThrow(/does not accept/u);
    expect(() => parseAdCollectorRunInput({ ...rust, credentials: undefined })).toThrow(/credentials/u);
    expect(() => parseAdCollectorRunInput({ ...rust, credentials: { username: "user", password: "" } })).toThrow();
    expect(() => parseAdCollectorRunInput({ ...rust, credentials: { username: "DOMAIN\\user", password: "secret" } })).toThrow();
    expect(() => parseAdCollectorRunInput({ ...rust, collectionMethod: "Session" })).toThrow(/method/u);
    expect(() => parseAdCollectorRunInput({ ...request, credentials: rust.credentials })).toThrow(/does not accept/u);
  });
});
