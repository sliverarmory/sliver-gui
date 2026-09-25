export const SOFTWARE_DEPLOYMENT_STATE_VERSION = 1 as const;
export const LOCAL_REDIRECTOR_RECIPES = ["caddy", "nginx"] as const;

export type LocalRedirectorRecipe = typeof LOCAL_REDIRECTOR_RECIPES[number];
export type SoftwareDeploymentStatus = "installing" | "active" | "degraded" | "failed" | "removing" | "outcome-unknown";

/** Session-only installation progress. Command text and credentials never cross this boundary. */
export interface SoftwareInstallProgress {
  readonly deploymentId: string;
  readonly step: "dns" | "listener" | "firewall" | "ssh" | "verify";
  readonly status: "running" | "complete" | "failed";
  readonly message?: string;
  readonly output?: { readonly stream: "stdout" | "stderr"; readonly chunk: Uint8Array };
}

/** Bounded progress history retained in the main process for the current app session. */
export interface SoftwareInstallProgressSnapshot {
  readonly deploymentId: string;
  readonly recipeId: LocalRedirectorRecipe;
  readonly status: "running" | "complete" | "failed";
  readonly truncated: boolean;
  /** Number of earlier output chunks dropped from the bounded event history. */
  readonly outputSequenceStart: number;
  readonly events: readonly SoftwareInstallProgress[];
}

export type RedirectorListenerSelection =
  | { readonly mode: "create"; readonly port: number }
  | { readonly mode: "existing"; readonly jobId: number };

export interface InstallLocalRedirectorInput {
  readonly deploymentId: string;
  readonly expectedRevision: number;
  readonly recipeId: LocalRedirectorRecipe;
  /** The advertised public IP for an IP-only HTTP deployment. */
  readonly publicIp: string | null;
  /** Public DNS names. A nonempty list requires automatic HTTPS. */
  readonly domains: readonly string[];
  /** Public-zone A records to create at deployment time when absent. */
  readonly dnsRecords?: { readonly zoneId: string; readonly names: readonly string[] };
  readonly listener: RedirectorListenerSelection;
}

export interface RemoveLocalRedirectorInput {
  readonly deploymentId: string;
  readonly installationId: string;
  readonly expectedRevision: number;
}

export interface ListLocalRedirectorListenersInput {
  readonly deploymentId: string;
}

export interface LocalRedirectorListenerOption {
  readonly jobId: number;
  readonly kind: "http" | "https";
  readonly port: number;
  readonly domain: string;
  readonly eligible: boolean;
  readonly reason: string | null;
}

export interface LocalRedirectorListenerBinding {
  readonly ownership: "managed" | "existing";
  readonly kind: "http" | "https";
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly jobId: number;
  readonly domain: string;
}

export interface LocalRedirectorRecord {
  readonly id: string;
  readonly deploymentId: string;
  readonly recipeId: LocalRedirectorRecipe;
  readonly category: "HTTP Redirectors";
  readonly subcategory: "local";
  readonly status: SoftwareDeploymentStatus;
  readonly publicIp: string | null;
  readonly domains: readonly string[];
  readonly publicUrl: string;
  readonly frontendPorts: readonly number[];
  /** Cloud firewall ports to reconcile on removal. Identity checks only delete our managed rules. */
  readonly ingressPortsOwned: readonly number[];
  readonly listener: LocalRedirectorListenerBinding;
  readonly serviceName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastCheckedAt: string | null;
  readonly lastError: string | null;
}

export interface SoftwareDeploymentState {
  readonly v: typeof SOFTWARE_DEPLOYMENT_STATE_VERSION;
  readonly revision: number;
  readonly records: readonly LocalRedirectorRecord[];
}

export interface LocalRedirectorOverview {
  readonly id: string;
  readonly recipeId: LocalRedirectorRecipe;
  readonly status: SoftwareDeploymentStatus;
  readonly publicUrl: string;
  readonly publicIp: string | null;
  readonly domains: readonly string[];
  readonly listener: LocalRedirectorListenerBinding;
  readonly lastCheckedAt: string | null;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** Resolve public record names for one zone; dotted names outside it are relative unless absolute. */
export function resolveLocalRedirectorDnsNames(zoneName: string, names: readonly string[]): readonly string[] {
  const zone = zoneName.toLowerCase().replace(/\.$/u, "");
  if (!DNS_NAME.test(zone) || !Array.isArray(names) || names.length < 1 || names.length > 8) {
    throw new TypeError("Choose one to eight public DNS record names in a valid zone.");
  }
  const domains = names.map((name) => {
    if (typeof name !== "string" || name.length < 1 || name.length > 253 || name !== name.trim()) {
      throw new TypeError("Enter a valid DNS record name.");
    }
    const normalized = name.toLowerCase();
    const absolute = normalized.endsWith(".");
    const plain = absolute ? normalized.slice(0, -1) : normalized;
    let domain: string;
    if (plain === "@" && !absolute) domain = zone;
    else if (plain === zone || plain.endsWith(`.${zone}`)) domain = plain;
    else {
      const labels = plain.split(".");
      if (absolute || labels.some((label) => !DNS_LABEL.test(label))) {
        throw new TypeError("DNS record names must be relative subdomains or names inside the selected public zone.");
      }
      domain = `${plain}.${zone}`;
    }
    if (!DNS_NAME.test(domain)) throw new TypeError("Enter a valid public DNS record name.");
    return domain;
  });
  if (new Set(domains).size !== domains.length) throw new TypeError("Remove duplicate public DNS record names.");
  return Object.freeze(domains);
}

export function parseInstallLocalRedirectorInput(value: unknown): InstallLocalRedirectorInput {
  const hasDnsRecords = typeof value === "object" && value !== null && Object.hasOwn(value, "dnsRecords");
  const input = record(value, hasDnsRecords
    ? ["deploymentId", "expectedRevision", "recipeId", "publicIp", "domains", "dnsRecords", "listener"]
    : ["deploymentId", "expectedRevision", "recipeId", "publicIp", "domains", "listener"]);
  if (!UUID_V4.test(input["deploymentId"] as string)) throw new TypeError("Invalid deployment ID");
  if (!revision(input["expectedRevision"])) throw new TypeError("Invalid software revision");
  if (!LOCAL_REDIRECTOR_RECIPES.includes(input["recipeId"] as LocalRedirectorRecipe)) throw new TypeError("Unsupported redirector");
  const publicIp = input["publicIp"];
  if (publicIp !== null && (typeof publicIp !== "string" || !isIPv4Address(publicIp))) throw new TypeError("Invalid public IPv4");
  if (!Array.isArray(input["domains"]) || input["domains"].length > 8) throw new TypeError("Invalid domains");
  const domains = input["domains"].map((domain: unknown) => {
    if (typeof domain !== "string" || !DNS_NAME.test(domain.toLowerCase()) || domain !== domain.trim()) {
      throw new TypeError("Invalid public domain");
    }
    return domain.toLowerCase();
  });
  if (new Set(domains).size !== domains.length) throw new TypeError("Duplicate public domain");
  if (domains.length === 0 && publicIp === null) throw new TypeError("Provide a public IP or domain");
  let dnsRecords: InstallLocalRedirectorInput["dnsRecords"];
  if (hasDnsRecords) {
    const dns = record(input["dnsRecords"], ["zoneId", "names"]);
    if (typeof dns["zoneId"] !== "string" || dns["zoneId"].length < 1 || dns["zoneId"].length > 2_048 || dns["zoneId"] !== dns["zoneId"].trim() || /[\u0000-\u001f\u007f]/u.test(dns["zoneId"])) {
      throw new TypeError("Invalid public DNS zone ID");
    }
    if (!Array.isArray(dns["names"]) || dns["names"].length < 1 || dns["names"].length > 8 || domains.length === 0) {
      throw new TypeError("Choose one to eight DNS records for public domains");
    }
    const names = dns["names"].map((name: unknown) => {
      if (typeof name !== "string" || name.length < 1 || name.length > 253 || name !== name.trim() ||
          (name !== "@" && !name.toLowerCase().replace(/\.$/u, "").split(".").every((label) => DNS_LABEL.test(label)))) {
        throw new TypeError("Invalid public DNS record name");
      }
      return name.toLowerCase();
    });
    dnsRecords = Object.freeze({ zoneId: dns["zoneId"], names: Object.freeze(names) });
  }
  const listener = parseRedirectorListenerSelection(input["listener"]);
  return Object.freeze({
    deploymentId: input["deploymentId"] as string,
    expectedRevision: input["expectedRevision"] as number,
    recipeId: input["recipeId"] as LocalRedirectorRecipe,
    publicIp: publicIp as string | null,
    domains: Object.freeze(domains),
    ...(dnsRecords ? { dnsRecords } : {}),
    listener,
  });
}

export function parseRemoveLocalRedirectorInput(value: unknown): RemoveLocalRedirectorInput {
  const input = record(value, ["deploymentId", "installationId", "expectedRevision"]);
  if (!UUID_V4.test(input["deploymentId"] as string) || !UUID_V4.test(input["installationId"] as string) || !revision(input["expectedRevision"])) {
    throw new TypeError("Invalid redirector removal request");
  }
  return Object.freeze(input) as unknown as RemoveLocalRedirectorInput;
}

export function parseListLocalRedirectorListenersInput(value: unknown): ListLocalRedirectorListenersInput {
  const input = record(value, ["deploymentId"]);
  if (!UUID_V4.test(input["deploymentId"] as string)) throw new TypeError("Invalid deployment ID");
  return Object.freeze(input) as unknown as ListLocalRedirectorListenersInput;
}

export function parseSoftwareDeploymentState(value: unknown): SoftwareDeploymentState {
  const state = record(value, ["v", "revision", "records"]);
  if (state["v"] !== SOFTWARE_DEPLOYMENT_STATE_VERSION || !revision(state["revision"]) || !Array.isArray(state["records"]) || state["records"].length > 256) {
    throw new TypeError("Invalid software deployment state");
  }
  const records = state["records"].map(parseLocalRedirectorRecord);
  if (new Set(records.map(({ id }) => id)).size !== records.length) throw new TypeError("Duplicate software deployment ID");
  return Object.freeze({ v: SOFTWARE_DEPLOYMENT_STATE_VERSION, revision: state["revision"] as number, records: Object.freeze(records) });
}

export function parseLocalRedirectorRecord(value: unknown): LocalRedirectorRecord {
  const input = record(value, ["id", "deploymentId", "recipeId", "category", "subcategory", "status", "publicIp", "domains", "publicUrl", "frontendPorts", "ingressPortsOwned", "listener", "serviceName", "createdAt", "updatedAt", "lastCheckedAt", "lastError"]);
  if (!UUID_V4.test(input["id"] as string) || !UUID_V4.test(input["deploymentId"] as string) || !LOCAL_REDIRECTOR_RECIPES.includes(input["recipeId"] as LocalRedirectorRecipe) || input["category"] !== "HTTP Redirectors" || input["subcategory"] !== "local") throw new TypeError("Invalid redirector record");
  if (!["installing", "active", "degraded", "failed", "removing", "outcome-unknown"].includes(input["status"] as string)) throw new TypeError("Invalid redirector status");
  if (input["publicIp"] !== null && (typeof input["publicIp"] !== "string" || !isIPv4Address(input["publicIp"]))) throw new TypeError("Invalid redirector IPv4");
  if (!Array.isArray(input["domains"]) || input["domains"].length > 8 || input["domains"].some((domain) => typeof domain !== "string" || !DNS_NAME.test(domain))) throw new TypeError("Invalid redirector domains");
  if (typeof input["publicUrl"] !== "string" || input["publicUrl"].length > 512 || !/^https?:\/\//u.test(input["publicUrl"])) throw new TypeError("Invalid redirector URL");
  if (!Array.isArray(input["frontendPorts"]) || input["frontendPorts"].length < 1 || input["frontendPorts"].length > 2 || input["frontendPorts"].some((port) => !validPort(port))) throw new TypeError("Invalid redirector ports");
  if (!Array.isArray(input["ingressPortsOwned"]) || input["ingressPortsOwned"].length > 2 || input["ingressPortsOwned"].some((port) => !validPort(port) || !(input["frontendPorts"] as number[]).includes(port))) throw new TypeError("Invalid redirector ingress ownership");
  if (new Set(input["ingressPortsOwned"] as number[]).size !== input["ingressPortsOwned"].length) throw new TypeError("Duplicate redirector ingress ownership");
  const domains = input["domains"] as string[];
  const advertisedIp = input["publicIp"] as string | null;
  if (domains.length === 0 && advertisedIp === null) throw new TypeError("Redirector has no public endpoint");
  const expectedUrl = domains.length > 0 ? `https://${domains[0]}` : `http://${advertisedIp}`;
  if (input["publicUrl"] !== expectedUrl ||
      JSON.stringify(input["frontendPorts"]) !== JSON.stringify(domains.length > 0 ? [80, 443] : [80])) {
    throw new TypeError("Redirector public endpoint does not match its recipe inputs");
  }
  const listener = record(input["listener"], ["ownership", "kind", "host", "port", "jobId", "domain"]);
  if ((listener["ownership"] !== "managed" && listener["ownership"] !== "existing") || (listener["kind"] !== "http" && listener["kind"] !== "https") || listener["host"] !== "127.0.0.1" || !validPort(listener["port"]) || !Number.isSafeInteger(listener["jobId"]) || (listener["jobId"] as number) < 0 || typeof listener["domain"] !== "string") throw new TypeError("Invalid redirector listener");
  if (listener["jobId"] === 0 && (listener["ownership"] !== "managed" || !["installing", "outcome-unknown", "removing"].includes(input["status"] as string))) {
    throw new TypeError("Only an unfinished managed listener may have an unconfirmed job ID");
  }
  if (listener["kind"] !== "http" || listener["domain"] !== "" || listener["port"] === 80 || listener["port"] === 443) throw new TypeError("Redirector backend must be a host-only localhost HTTP listener");
  if (typeof input["serviceName"] !== "string" || !/^sliver-gui-(?:caddy|nginx)-[0-9a-f-]{36}\.service$/u.test(input["serviceName"])) throw new TypeError("Invalid redirector service");
  for (const key of ["createdAt", "updatedAt"] as const) if (typeof input[key] !== "string" || !Number.isFinite(Date.parse(input[key]))) throw new TypeError("Invalid redirector timestamp");
  if (input["lastCheckedAt"] !== null && (typeof input["lastCheckedAt"] !== "string" || !Number.isFinite(Date.parse(input["lastCheckedAt"])))) throw new TypeError("Invalid redirector check time");
  if (input["lastError"] !== null && (typeof input["lastError"] !== "string" || input["lastError"].length > 4096)) throw new TypeError("Invalid redirector error");
  return Object.freeze({ ...input, domains: Object.freeze([...(input["domains"] as string[])]), frontendPorts: Object.freeze([...(input["frontendPorts"] as number[])]), ingressPortsOwned: Object.freeze([...(input["ingressPortsOwned"] as number[])]), listener: Object.freeze(listener) }) as unknown as LocalRedirectorRecord;
}

function parseRedirectorListenerSelection(value: unknown): RedirectorListenerSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Invalid listener selection");
  const mode = (value as Record<string, unknown>)["mode"];
  if (mode === "create") {
    const input = record(value, ["mode", "port"]);
    if (!validPort(input["port"])) throw new TypeError("Invalid listener port");
    return Object.freeze({ mode, port: input["port"] as number });
  }
  if (mode === "existing") {
    const input = record(value, ["mode", "jobId"]);
    if (!Number.isSafeInteger(input["jobId"]) || (input["jobId"] as number) < 1) throw new TypeError("Invalid listener job");
    return Object.freeze({ mode, jobId: input["jobId"] as number });
  }
  throw new TypeError("Invalid listener selection");
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Invalid record");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))) throw new TypeError("Unexpected record fields");
  return input;
}

function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65535;
}

function isIPv4Address(value: string): boolean {
  const octets = value.split(".");
  return octets.length === 4 && octets.every((octet) => /^(?:0|[1-9][0-9]{0,2})$/u.test(octet) && Number(octet) <= 255);
}
