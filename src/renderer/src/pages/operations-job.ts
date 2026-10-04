import type { JobSummary } from "../../../shared/contracts";

const NAMED_PROTOCOLS: Readonly<Record<string, string>> = {
  dns: "dns",
  http: "http",
  https: "https",
  mtls: "mtls",
  wg: "wireguard",
  wireguard: "wireguard",
};

export function normalizedJobProtocol(job: JobSummary): string {
  const name = job.name.trim().toLowerCase();
  const namedProtocol = NAMED_PROTOCOLS[name];
  if (namedProtocol) return namedProtocol;
  if (name === "tcp" || name === "stage-listener") return "stage";

  const protocol = job.protocol.trim().toLowerCase();
  if (protocol === "wg") return "wireguard";
  if (protocol === "stage-listener") return "stage";
  if (protocol === "tcp" && job.profileName.trim()) return "stage";
  return protocol || name || "listener";
}

export function nonBlankJobDomains(job: JobSummary): string[] {
  return job.domains.map((domain) => domain.trim()).filter(Boolean);
}
