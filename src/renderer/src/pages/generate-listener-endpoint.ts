import type {
  JobSummary,
  LocalNetworkInterfaceAddress,
  LocalNetworkInterfaceInventory,
  NetworkInterfaceAddressScope,
} from "../../../shared/contracts";
import {
  parseGenerateC2Endpoints,
  splitList,
} from "../../../shared/generate-validation";
import { nonBlankJobDomains, normalizedJobProtocol } from "./operations-job";

export type ListenerEndpointProtocol = "dns" | "http" | "https" | "mtls" | "wireguard";

export interface ListenerEndpointOption {
  id: string;
  jobId: number;
  protocol: ListenerEndpointProtocol;
  description: string;
  endpoint?: string;
  unavailableReason?: string;
  wildcardBinding?: ListenerWildcardBinding;
}

export interface ListenerWildcardBinding {
  family: LocalNetworkInterfaceAddress["family"];
  port: number;
}

export interface ListenerInterfaceEndpointOption {
  id: string;
  endpoint: string;
  interfaceName: string;
  family: LocalNetworkInterfaceAddress["family"];
  scope: NetworkInterfaceAddressScope;
}

export interface ListenerInterfaceEndpointResolution {
  options: ListenerInterfaceEndpointOption[];
  unavailableReason?: string;
}

export interface AppendListenerEndpointResult {
  value: string;
  added: boolean;
}

const WILDCARD_HOSTS = new Set([
  "*",
  "0.0.0.0",
  "::",
  "0:0:0:0:0:0:0:0",
]);

export function listenerEndpointOptions(jobs: readonly JobSummary[]): ListenerEndpointOption[] {
  return [...jobs]
    .sort((left, right) => left.id - right.id)
    .flatMap((job) => optionsForJob(job));
}

export function listenerEndpointAlreadyAdded(
  raw: string,
  endpoint: string,
  targetOs: string,
): boolean {
  const candidate = canonicalC2Endpoint(endpoint, targetOs);
  if (!candidate) return false;

  return splitList(raw).some((value) => canonicalC2Endpoint(value, targetOs) === candidate);
}

export function resolveWildcardListenerEndpoints(
  option: ListenerEndpointOption,
  inventory: LocalNetworkInterfaceInventory,
  connectionServer: string | undefined,
): ListenerInterfaceEndpointResolution {
  const binding = option.wildcardBinding;
  const protocol = option.protocol;
  if (!binding || protocol === "wireguard") return { options: [] };
  if (!serverIsOnLocalMachine(connectionServer, inventory)) {
    return {
      options: [],
      unavailableReason:
        "This Sliver server is remote, and this server version does not expose its network interfaces. Enter the callback endpoint manually.",
    };
  }

  const seen = new Set<string>();
  const addresses = [...inventory.addresses]
    .filter(({ family }) => family === binding.family)
    .sort(compareInterfaceAddresses);
  const options = addresses.flatMap((address) => {
    const endpoint = endpointUrl(protocol, address.address, binding.port);
    if (seen.has(endpoint)) return [];
    seen.add(endpoint);
    return [{
      id: `${option.id}:interface:${address.name}:${address.address}`,
      endpoint,
      interfaceName: address.name,
      family: address.family,
      scope: address.scope,
    } satisfies ListenerInterfaceEndpointOption];
  });

  return options.length > 0
    ? { options }
    : {
        options,
        unavailableReason: `This machine has no usable configured ${binding.family} addresses.`,
      };
}

export function resolveManagedWildcardListenerEndpoint(
  option: ListenerEndpointOption,
  publicIpAddress: string | null | undefined,
): ListenerInterfaceEndpointResolution {
  const binding = option.wildcardBinding;
  const protocol = option.protocol;
  if (!binding || protocol === "wireguard") return { options: [] };

  const address = normalizedIpAddress(publicIpAddress);
  if (!address) {
    return {
      options: [],
      unavailableReason:
        "This managed server does not have an available public IP address. Enter the callback endpoint manually.",
    };
  }
  if (address.family !== binding.family) {
    return {
      options: [],
      unavailableReason:
        `This ${binding.family} listener cannot use the managed server's ${address.family} public IP address. Enter the callback endpoint manually.`,
    };
  }

  return {
    options: [{
      id: `${option.id}:managed-public:${address.value}`,
      endpoint: endpointUrl(protocol, address.value, binding.port),
      interfaceName: "Managed server",
      family: address.family,
      scope: "global",
    }],
  };
}

export function appendListenerEndpoint(
  raw: string,
  endpoint: string,
  targetOs: string,
): AppendListenerEndpointResult {
  if (listenerEndpointAlreadyAdded(raw, endpoint, targetOs)) {
    return { value: raw, added: false };
  }

  const candidate = canonicalC2Endpoint(endpoint, targetOs);
  if (!candidate) return { value: raw, added: false };
  if (raw.trim() === "") return { value: endpoint, added: true };

  return {
    value: `${raw}${raw.endsWith("\n") ? "" : "\n"}${endpoint}`,
    added: true,
  };
}

function optionsForJob(job: JobSummary): ListenerEndpointOption[] {
  const protocol = normalizedJobProtocol(job);
  if (protocol === "stage" || !isListenerEndpointProtocol(protocol)) return [];

  const description = job.description.trim() || `${protocolLabel(protocol)} listener`;
  if (protocol === "wireguard") {
    return [
      unavailableOption(
        job,
        protocol,
        description,
        "Running job metadata does not expose the callback host or WireGuard auxiliary ports.",
      ),
    ];
  }

  if (protocol === "dns") {
    const domains = normalizedAdvertisedHosts(job);
    if (domains.length === 0) {
      return [
        unavailableOption(
          job,
          protocol,
          description,
          "This listener does not advertise a usable callback domain.",
        ),
      ];
    }
    return domains.map((host, index) => availableOption(job, protocol, description, host, index));
  }

  if (!validPort(job.port)) {
    return [
      unavailableOption(
        job,
        protocol,
        description,
        "The listener reports an invalid callback port.",
      ),
    ];
  }

  if (protocol === "http" || protocol === "https") {
    const domains = normalizedAdvertisedHosts(job);
    if (domains.length === 0) {
      return [
        unavailableOption(
          job,
          protocol,
          description,
          "This listener does not advertise a usable callback domain.",
        ),
      ];
    }
    return domains.map((host, index) =>
      availableOption(job, protocol, description, host, index, job.port),
    );
  }

  const advertisedHosts = normalizedAdvertisedHosts(job);
  if (advertisedHosts.length > 0) {
    return advertisedHosts.map((host, index) =>
      availableOption(job, protocol, description, host, index, job.port),
    );
  }

  const describedListener = parseMtlsDescription(job.description);
  if (!describedListener || describedListener.port !== job.port) {
    return [
      unavailableOption(
        job,
        protocol,
        description,
        "Running job metadata does not expose a concrete mTLS callback host.",
      ),
    ];
  }
  const wildcardFamily = wildcardHostFamily(describedListener.host.trim());
  if (wildcardFamily) {
    return [{
      id: `${job.id}:${protocol}:wildcard:${wildcardFamily}:${job.port}`,
      jobId: job.id,
      protocol,
      description,
      wildcardBinding: { family: wildcardFamily, port: job.port },
    }];
  }
  const host = normalizeHost(describedListener.host);
  if (!host) {
    return [
      unavailableOption(
        job,
        protocol,
        description,
        "Running job metadata does not expose a concrete mTLS callback host.",
      ),
    ];
  }
  return [availableOption(job, protocol, description, host, 0, job.port)];
}

function availableOption(
  job: JobSummary,
  protocol: Exclude<ListenerEndpointProtocol, "wireguard">,
  description: string,
  host: string,
  index: number,
  port?: number,
): ListenerEndpointOption {
  const endpoint = endpointUrl(protocol, host, port);
  return {
    id: `${job.id}:${protocol}:${index}:${endpoint}`,
    jobId: job.id,
    protocol,
    description,
    endpoint,
  };
}

function unavailableOption(
  job: JobSummary,
  protocol: ListenerEndpointProtocol,
  description: string,
  unavailableReason: string,
): ListenerEndpointOption {
  return {
    id: `${job.id}:${protocol}:unavailable`,
    jobId: job.id,
    protocol,
    description,
    unavailableReason,
  };
}

function normalizedAdvertisedHosts(job: JobSummary): string[] {
  return [
    ...new Set(
      nonBlankJobDomains(job)
        .map((domain) => normalizeHost(domain))
        .filter((host): host is string => host !== undefined && !isWildcardHost(host)),
    ),
  ];
}

function normalizeHost(value: string): string | undefined {
  let host = value.trim();
  if (!host || /[\s/?#@*\\]/u.test(host)) return undefined;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host.includes(":")) host = host.replace(/\.+$/u, "");
  if (!host) return undefined;

  try {
    const parsed = new URL(`https://${hostForUrl(host)}`);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.port) return undefined;
    return parsed.hostname.replace(/^\[|\]$/gu, "");
  } catch {
    return undefined;
  }
}

function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host.toLowerCase().replace(/^\[|\]$/gu, ""));
}

function wildcardHostFamily(host: string): LocalNetworkInterfaceAddress["family"] | undefined {
  const normalized = host.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "0.0.0.0" || normalized === "*") return "IPv4";
  if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return "IPv6";
  return undefined;
}

function endpointUrl(
  protocol: Exclude<ListenerEndpointProtocol, "wireguard">,
  host: string,
  port?: number,
): string {
  const includePort =
    port !== undefined &&
    !((protocol === "http" && port === 80) || (protocol === "https" && port === 443));
  return `${protocol}://${hostForUrl(host)}${includePort ? `:${port}` : ""}`;
}

function hostForUrl(host: string): string {
  return host.includes(":") ? `[${host.replace(/^\[|\]$/gu, "")}]` : host;
}

function parseMtlsDescription(description: string): { host: string; port: number } | undefined {
  const match = /^mutual tls listener\s+(.+)$/iu.exec(description.trim());
  if (!match?.[1]) return undefined;
  const address = match[1].trim();
  const bracketed = /^\[([^\]]+)\]:(\d+)$/u.exec(address);
  if (bracketed?.[1] && bracketed[2]) {
    return { host: bracketed[1], port: Number(bracketed[2]) };
  }
  const separator = address.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const port = Number(address.slice(separator + 1));
  if (!Number.isInteger(port)) return undefined;
  return { host: address.slice(0, separator), port };
}

function canonicalC2Endpoint(value: string, targetOs: string): string | undefined {
  try {
    const endpoints = parseGenerateC2Endpoints(value, targetOs);
    return endpoints.length === 1 ? endpoints[0]?.url : undefined;
  } catch {
    return undefined;
  }
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function serverIsOnLocalMachine(
  connectionServer: string | undefined,
  inventory: LocalNetworkInterfaceInventory,
): boolean {
  const host = connectionHost(connectionServer);
  if (!host) return false;
  if (host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host)) return true;
  if (inventory.hostname && host === inventory.hostname.toLowerCase().replace(/\.+$/u, "")) return true;
  return inventory.addresses.some(({ address }) => address.toLowerCase() === host);
}

function connectionHost(connectionServer: string | undefined): string | undefined {
  const value = connectionServer?.trim();
  if (!value) return undefined;
  try {
    const parsed = new URL(value.includes("://") ? value : `tcp://${value}`);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.+$/u, "");
    return host || undefined;
  } catch {
    return undefined;
  }
}

function normalizedIpAddress(
  value: string | null | undefined,
): { value: string; family: LocalNetworkInterfaceAddress["family"] } | undefined {
  const address = value?.trim().replace(/^\[|\]$/gu, "");
  if (!address) return undefined;

  const octets = address.split(".");
  if (
    octets.length === 4 &&
    octets.every((octet) =>
      /^(?:0|[1-9]\d{0,2})$/u.test(octet) && Number(octet) <= 255)
  ) {
    return { value: address, family: "IPv4" };
  }

  if (!address.includes(":")) return undefined;
  try {
    const parsed = new URL(`http://[${address}]/`);
    if (parsed.hostname.replace(/^\[|\]$/gu, "") === "") return undefined;
    return { value: address, family: "IPv6" };
  } catch {
    return undefined;
  }
}

function compareInterfaceAddresses(
  left: LocalNetworkInterfaceAddress,
  right: LocalNetworkInterfaceAddress,
): number {
  return interfaceScopeRank(left.scope) - interfaceScopeRank(right.scope) ||
    left.name.localeCompare(right.name, undefined, { numeric: true }) ||
    (left.family === right.family ? 0 : left.family === "IPv4" ? -1 : 1) ||
    left.address.localeCompare(right.address, undefined, { numeric: true });
}

function interfaceScopeRank(scope: NetworkInterfaceAddressScope): number {
  if (scope === "global") return 0;
  if (scope === "private") return 1;
  return 2;
}

function isListenerEndpointProtocol(value: string): value is ListenerEndpointProtocol {
  return value === "dns" || value === "http" || value === "https" || value === "mtls" || value === "wireguard";
}

export function listenerProtocolLabel(protocol: ListenerEndpointProtocol): string {
  return protocolLabel(protocol);
}

function protocolLabel(protocol: ListenerEndpointProtocol): string {
  if (protocol === "mtls") return "mTLS";
  if (protocol === "wireguard") return "WireGuard";
  return protocol.toUpperCase();
}
