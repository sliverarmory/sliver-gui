import { describe, expect, it } from "vitest";

import {
  cloudDnsRecordName,
  parseCloudDnsRecordSpec,
  parseCreateCloudDnsRecordInput,
  parseDeleteCloudDnsRecordInput,
  parseDnsTextChunks,
  parseListCloudDnsRecordsInput,
  parseListCloudDnsZonesInput,
  parseUpdateCloudDnsRecordInput,
} from "./cloud-dns-contracts.js";

const credentialId = "0f24a4da-28c1-4d94-a66d-eb224892745d";
const zoneId = "ZEXAMPLE";
const record = { name: "www", type: "A", ttl: 300, values: ["192.0.2.1"] };

describe("DNS request contracts", () => {
  it("distinguishes the all-zone read from a specific zone", () => {
    expect(parseListCloudDnsZonesInput({ credentialId })).toEqual({ credentialId });
    expect(parseListCloudDnsRecordsInput({ credentialId, zoneId: null })).toEqual({ credentialId, zoneId: null });
    expect(parseListCloudDnsRecordsInput({ credentialId, zoneId })).toEqual({ credentialId, zoneId });
    expect(() => parseListCloudDnsRecordsInput({ credentialId })).toThrow();
  });

  it("requires a complete identity and viewed version for edit and delete", () => {
    const identity = { credentialId, zoneId, recordId: "A:www.example.test.:", expectedVersion: "a".repeat(64) };
    expect(parseCreateCloudDnsRecordInput({ credentialId, zoneId, record })).toEqual({ credentialId, zoneId, record });
    expect(parseUpdateCloudDnsRecordInput({ ...identity, record })).toEqual({ ...identity, record });
    expect(parseDeleteCloudDnsRecordInput(identity)).toEqual(identity);
    expect(() => parseDeleteCloudDnsRecordInput({ ...identity, expectedVersion: "" })).toThrow();
    expect(() => parseUpdateCloudDnsRecordInput({ ...identity, recordId: "", record })).toThrow();
  });

  it("rejects malformed credentials, extra fields, and unbounded identifiers", () => {
    expect(() => parseListCloudDnsZonesInput({ credentialId: "other-account" })).toThrow();
    expect(() => parseListCloudDnsZonesInput({ credentialId, accessToken: "must-not-cross-this-boundary" })).toThrow();
    for (const value of ["", " ZEXAMPLE", "ZEXAMPLE\n", "x".repeat(2049), 42]) {
      expect(() => parseListCloudDnsRecordsInput({ credentialId, zoneId: value })).toThrow();
    }
    expect(() => parseCreateCloudDnsRecordInput({ credentialId, zoneId, record: { ...record, providerOptions: {} } })).toThrow();
  });
});

describe("DNS record values", () => {
  it.each([
    ["A", "192.0.2.10"], ["AAAA", "2001:db8::10"], ["CNAME", "target.example.test."],
    ["NS", "ns1.example.test."], ["PTR", "host.example.test."], ["MX", "10 mail.example.test."],
    ["MX", "0 ."], ["TXT", '""'], ["TXT", '"v=spf1" " -all"'],
    ["SRV", "10 5 443 service.example.test."], ["SRV", "0 0 0 ."], ["CAA", '0 issue "ca.example"'],
  ])("accepts %s presentation value %s", (type, value) => {
    expect(parseCloudDnsRecordSpec({ name: "_service._tcp", type, ttl: 0, values: [value] })).toEqual({
      name: "_service._tcp", type, ttl: 0, values: [value],
    });
  });

  it.each([
    ["A", "999.0.0.1"], ["A", "192.000.2.1"], ["AAAA", "2001:::1"],
    ["CNAME", "https://example.test"], ["MX", "65536 mail.example.test."],
    ["MX", "mail.example.test."], ["SRV", "10 5 65536 service.example.test."],
    ["TXT", "unquoted"], ["TXT", '"unterminated'], ["TXT", '"bad\\999"'],
    ["CAA", '256 issue "ca.example"'], ["CAA", "0 issue ca.example"],
  ])("rejects invalid %s value %s", (type, value) => {
    expect(() => parseCloudDnsRecordSpec({ ...record, type, values: [value] })).toThrow();
  });

  it("bounds record counts, TTL, names, and provider-managed types", () => {
    for (const ttl of [-1, 0.5, Number.NaN, 2_147_483_648, "300"]) {
      expect(() => parseCloudDnsRecordSpec({ ...record, ttl })).toThrow();
    }
    expect(() => parseCloudDnsRecordSpec({ ...record, type: "SOA" })).toThrow();
    expect(() => parseCloudDnsRecordSpec({ ...record, values: [] })).toThrow();
    expect(() => parseCloudDnsRecordSpec({ ...record, values: Array.from({ length: 101 }, (_, i) => `192.0.2.${i}`) })).toThrow();
    expect(() => parseCloudDnsRecordSpec({ ...record, values: ["192.0.2.1", "192.0.2.1"] })).toThrow();
    expect(() => parseCloudDnsRecordSpec({ ...record, type: "CNAME", values: ["a.example.test.", "b.example.test."] })).toThrow();
    expect(() => parseCloudDnsRecordSpec({ ...record, name: "x".repeat(64) })).toThrow();
    expect(() => parseCloudDnsRecordSpec({ ...record, values: ["192.0.2.1\n192.0.2.2"] })).toThrow();
  });

  it("preserves TXT chunk boundaries, empty chunks, quotes, and backslashes", () => {
    expect(parseDnsTextChunks('"" "hello" "world"')).toEqual(["", "hello", "world"]);
    expect(parseDnsTextChunks('"a\\"b" "c\\\\d"')).toEqual(['a"b', "c\\d"]);
    expect(parseDnsTextChunks(`"${"x".repeat(255)}"`)).toEqual(["x".repeat(255)]);
    expect(() => parseDnsTextChunks(`"${"x".repeat(256)}"`)).toThrow();
    expect(() => parseDnsTextChunks(`"${"é".repeat(128)}"`)).toThrow();
  });
});

describe("DNS record name resolution", () => {
  it("handles apex, wildcard, relative, and fully-qualified record names", () => {
    expect(cloudDnsRecordName("@", "Example.Test.")).toBe("example.test.");
    expect(cloudDnsRecordName("*", "example.test")).toBe("*.example.test.");
    expect(cloudDnsRecordName("_service._tcp", "example.test")).toBe("_service._tcp.example.test.");
    expect(cloudDnsRecordName("WWW.EXAMPLE.TEST", "example.test")).toBe("www.example.test.");
    expect(cloudDnsRecordName("www.example.test.", "example.test")).toBe("www.example.test.");
  });

  it("rejects absolute names outside the selected zone and resolved overlength names", () => {
    expect(() => cloudDnsRecordName("other.test.", "example.test")).toThrow();
    expect(() => cloudDnsRecordName("notexample.test.", "example.test")).toThrow();
    const long = Array.from({ length: 4 }, () => "a".repeat(63)).join(".");
    expect(() => cloudDnsRecordName(long, "example.test")).toThrow();
  });
});
