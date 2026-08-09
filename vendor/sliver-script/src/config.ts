import { readdir, readFile } from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";

export interface SliverClientWireGuardConfig {
  server_pub_key: string;
  client_private_key: string;
  client_pub_key?: string;
  client_ip: string;
  server_ip?: string;
}

export interface SliverClientConfig {
  operator: string;
  lhost: string;
  lport: number;
  ca_certificate: string;
  certificate: string;
  private_key: string;
  token: string;
  wg?: SliverClientWireGuardConfig;
}

export async function parseConfigFile(filePath: string): Promise<SliverClientConfig> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Config file does not exist: ${filePath}`);
  }
  const data = await readFile(filePath);
  return parseConfig(data);
}

export function parseConfig(data: Buffer): SliverClientConfig {
  const raw = JSON.parse(data.toString("utf8")) as Partial<SliverClientConfig>;
  validateConfig(raw);
  return raw as SliverClientConfig;
}

export async function listConfigs(configDir: string): Promise<SliverClientConfig[]> {
  try {
    const items = await readdir(configDir);
    const configs: SliverClientConfig[] = [];

    for (const item of items) {
      const filePath = path.join(configDir, item);
      if (!fs.existsSync(filePath) || fs.lstatSync(filePath).isDirectory()) {
        continue;
      }
      try {
        configs.push(await parseConfigFile(filePath));
      } catch {
        // Best-effort: ignore invalid config files in the directory.
      }
    }

    return configs;
  } catch {
    return [];
  }
}

function validateConfig(config: Partial<SliverClientConfig>): asserts config is SliverClientConfig {
  const mustBeString = [
    "operator",
    "lhost",
    "ca_certificate",
    "certificate",
    "private_key",
    "token",
  ] as const;

  for (const key of mustBeString) {
    if (typeof config[key] !== "string") {
      throw new Error(`Invalid sliver config: missing/invalid ${key}`);
    }
  }
  if (typeof config.lport !== "number" || !Number.isFinite(config.lport)) {
    throw new Error("Invalid sliver config: missing/invalid lport");
  }

  if (config.wg !== undefined) {
    if (!config.wg || typeof config.wg !== "object" || Array.isArray(config.wg)) {
      throw new Error("Invalid sliver config: missing/invalid wg");
    }

    const wgKeys = [
      "server_pub_key",
      "client_private_key",
      "client_pub_key",
      "client_ip",
      "server_ip",
    ] as const;

    for (const key of wgKeys) {
      const value = config.wg[key];
      if (value !== undefined && typeof value !== "string") {
        throw new Error(`Invalid sliver config: missing/invalid wg.${key}`);
      }
    }
  }
}

// Back-compat exports (v1.x API)
export const ParseConfigFile = parseConfigFile;
export const ParseConfig = parseConfig;
export const ListConfigs = listConfigs;
