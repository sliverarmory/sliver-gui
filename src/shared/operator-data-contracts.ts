export const OPERATOR_DATA_LIMITS = Object.freeze({
  pageSize: 100,
  maxPageSize: 200,
  queryCharacters: 256,
  nameCharacters: 256,
  collectionCharacters: 256,
  usernameCharacters: 256,
  secretBytes: 64 * 1024,
  previewBytes: 1024 * 1024,
  artifactBytes: 64 * 1024 * 1024,
} as const);

export type LootFileType = "text" | "binary";
export type LootFileTypeFilter = LootFileType | "all";

export interface OperatorDataPageSummary {
  limit: number;
  total: number;
  truncated: boolean;
  nextCursor?: string;
}

export interface LootSummary {
  id: string;
  name: string;
  fileName: string;
  fileType: LootFileType;
  originHostId: string;
  sizeBytes: string;
}

export interface ListLootInput {
  query?: string;
  fileType?: LootFileTypeFilter;
  cursor?: string;
  limit?: number;
}

export interface LootCatalogPage {
  items: LootSummary[];
  page: OperatorDataPageSummary;
}

export interface AddLootInput {
  name: string;
  fileType: "auto" | LootFileType;
}

export interface RenameLootInput {
  id: string;
  name: string;
}

export type LootPreviewState = "text" | "binary" | "too-large" | "empty";

export interface LootDetail {
  item: LootSummary;
  previewState: LootPreviewState;
  preview: Uint8Array;
}

export interface LootDownloadResult {
  saved: boolean;
  fileName: string;
  size: number;
}

export type CredentialKindFilter = "all" | "plaintext" | "hash" | "cracked";

export interface CredentialSummary {
  id: string;
  username: string;
  collection: string;
  originHostId: string;
  hashType: number;
  hashTypeName: string;
  isCracked: boolean;
  hasPlaintext: boolean;
  hasHash: boolean;
}

export interface CredentialHashTypeOption {
  value: number;
  name: string;
  label: string;
}

export interface ListCredentialsInput {
  query?: string;
  kind?: CredentialKindFilter;
  cursor?: string;
  limit?: number;
}

export interface CredentialCatalogPage {
  items: CredentialSummary[];
  page: OperatorDataPageSummary;
  collections: string[];
  hashTypes: CredentialHashTypeOption[];
}

export interface CredentialSecretReveal {
  item: CredentialSummary;
  field: CredentialSecretField;
  value: Uint8Array;
}

export interface AddCredentialInput {
  username: string;
  collection: string;
  plaintext: Uint8Array;
  hash: Uint8Array;
  /** Null asks the main process to detect a supplied hash type. */
  hashType: number | null;
}

export type CredentialSecretField = "plaintext" | "hash";

export interface CopyCredentialSecretInput {
  id: string;
  field: CredentialSecretField;
}

export type RevealCredentialSecretInput = CopyCredentialSecretInput;

export interface CredentialClipboardResult {
  expiresAt: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CURSOR_PATTERN = /^(0|[1-9][0-9]{0,15})$/u;

export function parseListLootInput(value: unknown): ListLootInput {
  const record = plainRecord(value, "loot list input");
  exactKeys(record, [], ["query", "fileType", "cursor", "limit"]);
  const parsed: ListLootInput = {};
  if (record["query"] !== undefined) parsed.query = boundedString(record["query"], "query", OPERATOR_DATA_LIMITS.queryCharacters);
  if (record["fileType"] !== undefined) {
    const fileType = record["fileType"];
    if (fileType !== "all" && fileType !== "text" && fileType !== "binary") {
      throw new TypeError("fileType must be all, text, or binary");
    }
    parsed.fileType = fileType;
  }
  parsePageFields(record, parsed);
  return parsed;
}

export function parseListCredentialsInput(value: unknown): ListCredentialsInput {
  const record = plainRecord(value, "credential list input");
  exactKeys(record, [], ["query", "kind", "cursor", "limit"]);
  const parsed: ListCredentialsInput = {};
  if (record["query"] !== undefined) parsed.query = boundedString(record["query"], "query", OPERATOR_DATA_LIMITS.queryCharacters);
  if (record["kind"] !== undefined) {
    const kind = record["kind"];
    if (kind !== "all" && kind !== "plaintext" && kind !== "hash" && kind !== "cracked") {
      throw new TypeError("kind must be all, plaintext, hash, or cracked");
    }
    parsed.kind = kind;
  }
  parsePageFields(record, parsed);
  return parsed;
}

export function parseAddLootInput(value: unknown): AddLootInput {
  const record = plainRecord(value, "add loot input");
  exactKeys(record, ["name", "fileType"]);
  const fileType = record["fileType"];
  if (fileType !== "auto" && fileType !== "text" && fileType !== "binary") {
    throw new TypeError("fileType must be auto, text, or binary");
  }
  return {
    name: boundedString(record["name"], "name", OPERATOR_DATA_LIMITS.nameCharacters),
    fileType,
  };
}

export function parseRenameLootInput(value: unknown): RenameLootInput {
  const record = plainRecord(value, "rename loot input");
  exactKeys(record, ["id", "name"]);
  return {
    id: identifier(record["id"], "loot ID"),
    name: nonemptyString(record["name"], "name", OPERATOR_DATA_LIMITS.nameCharacters),
  };
}

export function parseAddCredentialInput(value: unknown): AddCredentialInput {
  const record = plainRecord(value, "add credential input");
  exactKeys(record, ["username", "collection", "plaintext", "hash", "hashType"]);
  const username = boundedString(record["username"], "username", OPERATOR_DATA_LIMITS.usernameCharacters);
  const collection = boundedString(record["collection"], "collection", OPERATOR_DATA_LIMITS.collectionCharacters);
  const hashTypeValue = record["hashType"];
  if (
    hashTypeValue !== null &&
    (typeof hashTypeValue !== "number" || !Number.isSafeInteger(hashTypeValue) || hashTypeValue < 0 || hashTypeValue > 100_000)
  ) {
    throw new TypeError("hashType must be null or a supported numeric hash type");
  }
  const plaintextView = secretBytesView(record["plaintext"], "plaintext");
  const hashView = secretBytesView(record["hash"], "hash");
  if (plaintextView.byteLength === 0 && hashView.byteLength === 0) {
    throw new TypeError("a plaintext value or hash is required");
  }
  return {
    username,
    collection,
    plaintext: new Uint8Array(plaintextView),
    hash: new Uint8Array(hashView),
    hashType: hashTypeValue,
  };
}

export function parseCopyCredentialSecretInput(value: unknown): CopyCredentialSecretInput {
  const record = plainRecord(value, "copy credential secret input");
  exactKeys(record, ["id", "field"]);
  const field = record["field"];
  if (field !== "plaintext" && field !== "hash") {
    throw new TypeError("field must be plaintext or hash");
  }
  return { id: identifier(record["id"], "credential ID"), field };
}

export function parseOperatorDataId(value: unknown, label: string): string {
  return identifier(value, label);
}

function parsePageFields(
  record: Record<string, unknown>,
  parsed: { cursor?: string; limit?: number },
): void {
  if (record["cursor"] !== undefined) {
    const cursor = boundedString(record["cursor"], "cursor", 16);
    if (!CURSOR_PATTERN.test(cursor) || !Number.isSafeInteger(Number(cursor))) {
      throw new TypeError("cursor is invalid");
    }
    parsed.cursor = cursor;
  }
  if (record["limit"] !== undefined) {
    const limit = record["limit"];
    if (
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > OPERATOR_DATA_LIMITS.maxPageSize
    ) {
      throw new TypeError(`limit must be between 1 and ${OPERATOR_DATA_LIMITS.maxPageSize}`);
    }
    parsed.limit = limit;
  }
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in record)) || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new TypeError("operator data input contains unexpected fields");
  }
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function nonemptyString(value: unknown, label: string, maximum: number): string {
  const parsed = boundedString(value, label, maximum).trim();
  if (!parsed) throw new TypeError(`${label} is required`);
  return parsed;
}

function identifier(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 64);
  if (!UUID_PATTERN.test(parsed)) throw new TypeError(`${label} is invalid`);
  return parsed;
}

function secretBytesView(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > OPERATOR_DATA_LIMITS.secretBytes) {
    throw new TypeError(`${label} must be a bounded byte array`);
  }
  return value;
}
