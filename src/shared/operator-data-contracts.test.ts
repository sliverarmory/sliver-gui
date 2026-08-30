import { describe, expect, it } from "vitest";

import {
  OPERATOR_DATA_LIMITS,
  parseAddCredentialInput,
  parseCopyCredentialSecretInput,
  parseListCredentialsInput,
  parseListLootInput,
  parseRenameLootInput,
} from "./operator-data-contracts.js";

const ID = "80ae1382-e6e2-44d6-a663-537cafb60e74";

describe("operator-data contracts", () => {
  it("accepts only bounded, exact paged inventory requests", () => {
    expect(parseListLootInput({ query: "report", fileType: "text", cursor: "100", limit: 25 })).toEqual({
      query: "report",
      fileType: "text",
      cursor: "100",
      limit: 25,
    });
    expect(parseListCredentialsInput({ kind: "cracked" })).toEqual({ kind: "cracked" });

    expect(() => parseListLootInput({ limit: OPERATOR_DATA_LIMITS.maxPageSize + 1 })).toThrow(/limit/u);
    expect(() => parseListLootInput({ cursor: "9999999999999999" })).toThrow(/cursor/u);
    expect(() => parseListCredentialsInput({ kind: "all", secret: "leak" })).toThrow(/unexpected/u);
  });

  it("clones credential byte views only after validating metadata", () => {
    const plaintext = new Uint8Array([115, 101, 99, 114, 101, 116]);
    const hash = new Uint8Array([100, 105, 103, 101, 115, 116]);
    const parsed = parseAddCredentialInput({
      username: "alice",
      collection: "manual",
      plaintext,
      hash,
      hashType: 0,
    });

    expect(parsed.plaintext).not.toBe(plaintext);
    expect(parsed.hash).not.toBe(hash);
    parsed.plaintext.fill(0);
    parsed.hash.fill(0);
    expect([...plaintext]).toEqual([115, 101, 99, 114, 101, 116]);
    expect([...hash]).toEqual([100, 105, 103, 101, 115, 116]);

    expect(() => parseAddCredentialInput({
      username: "x".repeat(OPERATOR_DATA_LIMITS.usernameCharacters + 1),
      collection: "manual",
      plaintext,
      hash: new Uint8Array(),
      hashType: null,
    })).toThrow(/username/u);
    expect([...plaintext]).toEqual([115, 101, 99, 114, 101, 116]);
  });

  it("requires a secret and field-scoped UUID operations", () => {
    expect(() => parseAddCredentialInput({
      username: "alice",
      collection: "manual",
      plaintext: new Uint8Array(),
      hash: new Uint8Array(),
      hashType: null,
    })).toThrow(/required/u);
    expect(parseCopyCredentialSecretInput({ id: ID, field: "hash" })).toEqual({ id: ID, field: "hash" });
    expect(() => parseCopyCredentialSecretInput({ id: ID, field: "both" })).toThrow(/field/u);
    expect(parseRenameLootInput({ id: ID, name: "Operator report" })).toEqual({
      id: ID,
      name: "Operator report",
    });
  });
});
