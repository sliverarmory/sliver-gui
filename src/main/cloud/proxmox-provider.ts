import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import {
  cloudRequiredPermissions,
  createCloudPermissionEvaluation,
  type CloudPermissionEvaluation,
} from "../../shared/cloud-provider-permissions.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_TASK_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_GUEST_TIMEOUT_MS = 10 * 60 * 1000;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const NODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u;
const STORAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const BRIDGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u;
const VM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export interface ProxmoxApiCredentials {
  readonly endpoint: string;
  readonly tokenId: string;
  readonly tokenSecret: string;
  readonly tlsCaCertificate: string | null;
}

export interface ProxmoxCreateInput {
  readonly deploymentId: string;
  readonly displayName: string;
  readonly node: string;
  readonly templateVmId: number;
  readonly vmId: number | null;
  readonly storage: string;
  readonly bridge: string;
  readonly cores: number;
  readonly memoryMiB: number;
  readonly diskGiB: number;
  readonly ipConfig: string;
  readonly gateway: string | null;
  readonly sshUsername: string;
  readonly sshPublicKey: string;
  readonly sshPort: number;
  readonly multiplayerPort: number;
  readonly sshCidrs: readonly string[];
  readonly operatorCidrs: readonly string[];
}

export interface ProxmoxResources {
  readonly node: string;
  readonly vmId: number;
  readonly vmName: string;
}

export interface ProxmoxDeploymentResult {
  readonly resources: ProxmoxResources;
  readonly address: string;
  readonly state: string;
}

export interface ProxmoxInventory {
  readonly version: string;
  readonly nodes: readonly string[];
  readonly permissions: readonly string[];
  readonly permissionGrants: readonly ProxmoxPermissionGrant[];
  readonly clusterFirewallEnabled: boolean;
}

export interface ProxmoxPermissionGrant {
  readonly path: string;
  readonly permissions: readonly string[];
}

export interface ProxmoxPermissionCheckResult {
  readonly version: string;
  readonly nodes: readonly string[];
  readonly clusterFirewallEnabled: boolean | null;
  readonly permissions: CloudPermissionEvaluation;
}

export interface ProxmoxMutationEvent {
  readonly phase: "allocated" | "cloned" | "configured" | "firewall" | "started";
  readonly resources: ProxmoxResources;
}

type ProxmoxMethod = "GET" | "POST" | "PUT" | "DELETE";
type ProxmoxForm = Readonly<Record<string, string | number | boolean | undefined>>;

export interface ProxmoxTransport {
  request(method: ProxmoxMethod, path: string, form?: ProxmoxForm): Promise<unknown>;
}

interface ProxmoxProviderOptions {
  readonly transport?: ProxmoxTransport;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly taskTimeoutMs?: number;
  readonly guestTimeoutMs?: number;
}

export class ProxmoxRestClient implements ProxmoxTransport {
  private readonly baseUrl: URL;

  constructor(
    private readonly credentials: ProxmoxApiCredentials,
    private readonly timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.baseUrl = parseEndpoint(credentials.endpoint);
    validateToken(credentials.tokenId, "API token ID");
    validateToken(credentials.tokenSecret, "API token secret");
    if (credentials.tlsCaCertificate !== null && !isPemCertificate(credentials.tlsCaCertificate)) {
      throw new Error("The Proxmox CA certificate is not a PEM certificate");
    }
  }

  request(method: ProxmoxMethod, path: string, form: ProxmoxForm = {}): Promise<unknown> {
    const relativePath = path.replace(/^\/+/, "");
    if (!relativePath || relativePath.includes("\0") || relativePath.includes("..")) {
      return Promise.reject(new Error("Invalid Proxmox API path"));
    }
    const url = new URL(`api2/json/${relativePath}`, this.baseUrl);
    const body = method === "GET" || method === "DELETE" ? undefined : encodeForm(form);
    if (method === "GET" || method === "DELETE") {
      for (const [key, value] of Object.entries(form)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    return new Promise((resolve, reject) => {
      const request = httpsRequest(url, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `PVEAPIToken=${this.credentials.tokenId}=${this.credentials.tokenSecret}`,
          ...(body
            ? {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
        },
        rejectUnauthorized: true,
        ...(this.credentials.tlsCaCertificate === null
          ? {}
          : { ca: this.credentials.tlsCaCertificate }),
      }, (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.length;
          if (total > MAX_RESPONSE_BYTES) {
            request.destroy(new Error("Proxmox returned an oversized response"));
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () => {
          const bytes = Buffer.concat(chunks, total);
          try {
            const statusCode = response.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              throw new Error(`Proxmox API request failed with HTTP ${statusCode}`);
            }
            let envelope: unknown;
            try {
              envelope = JSON.parse(bytes.toString("utf8"));
            } catch {
              throw new Error("Proxmox returned invalid JSON");
            }
            if (!isRecord(envelope) || !("data" in envelope)) {
              throw new Error("Proxmox returned an invalid API envelope");
            }
            resolve(envelope["data"]);
          } catch (error) {
            reject(error);
          } finally {
            bytes.fill(0);
            for (const chunk of chunks) chunk.fill(0);
          }
        });
      });
      request.setTimeout(this.timeoutMs, () => request.destroy(new Error("Proxmox API request timed out")));
      request.on("error", (error) => reject(sanitizeProxmoxError(error)));
      if (body) request.write(body);
      request.end();
    });
  }
}

export class ProxmoxProvider {
  private readonly api: ProxmoxTransport;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly taskTimeoutMs: number;
  private readonly guestTimeoutMs: number;

  constructor(credentials: ProxmoxApiCredentials, options: ProxmoxProviderOptions = {}) {
    this.api = options.transport ?? new ProxmoxRestClient(credentials);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    this.guestTimeoutMs = options.guestTimeoutMs ?? DEFAULT_GUEST_TIMEOUT_MS;
  }

  async preflight(): Promise<ProxmoxInventory> {
    const [versionValue, permissionsValue, nodesValue, firewallValue] = await Promise.all([
      this.api.request("GET", "version"),
      this.api.request("GET", "access/permissions"),
      this.api.request("GET", "nodes"),
      this.api.request("GET", "cluster/firewall/options"),
    ]);
    const permissionGrants = parsePermissionGrants(permissionsValue);
    const permissions = flattenPermissionGrants(permissionGrants);
    if (permissions.length === 0) {
      throw new Error("The Proxmox API token authenticates but has no effective ACL permissions");
    }
    const nodes = arrayRecords(nodesValue)
      .map((node) => stringValue(node["node"]))
      .filter((node): node is string => Boolean(node));
    if (nodes.length === 0) throw new Error("The Proxmox API token cannot access any nodes");
    return {
      version: isRecord(versionValue) ? stringValue(versionValue["version"]) ?? "unknown" : "unknown",
      nodes: [...new Set(nodes)].sort(),
      permissions,
      permissionGrants,
      clusterFirewallEnabled: isRecord(firewallValue) && truthyFlag(firewallValue["enable"]),
    };
  }

  /**
   * Inspects the token's effective ACLs without attempting a provider mutation.
   * Missing read privileges are represented in the returned permission report
   * instead of being mistaken for invalid credentials.
   */
  async checkPermissions(): Promise<ProxmoxPermissionCheckResult> {
    const versionValue = await this.api.request("GET", "version");
    const permissionsValue = await this.api.request("GET", "access/permissions");
    const [nodesResult, firewallResult] = await Promise.allSettled([
      this.api.request("GET", "nodes"),
      this.api.request("GET", "cluster/firewall/options"),
    ]);
    const nodes = nodesResult.status === "fulfilled"
      ? arrayRecords(nodesResult.value)
        .map((node) => stringValue(node["node"]))
        .filter((node): node is string => Boolean(node))
      : [];
    return {
      version: isRecord(versionValue) ? stringValue(versionValue["version"]) ?? "unknown" : "unknown",
      nodes: [...new Set(nodes)].sort(),
      clusterFirewallEnabled: firewallResult.status === "fulfilled" && isRecord(firewallResult.value)
        ? truthyFlag(firewallResult.value["enable"])
        : null,
      permissions: evaluateProxmoxPermissions(parsePermissionGrants(permissionsValue)),
    };
  }

  async create(
    input: ProxmoxCreateInput,
    onMutation: (event: ProxmoxMutationEvent) => void | Promise<void> = () => undefined,
  ): Promise<ProxmoxDeploymentResult> {
    validateCreateInput(input);
    const inventory = await this.preflight();
    if (!inventory.nodes.includes(input.node)) throw new Error("The selected Proxmox node is unavailable");
    if (!inventory.clusterFirewallEnabled) {
      throw new Error("The Proxmox cluster firewall must be enabled before deploying a managed server");
    }

    const vmId = input.vmId ?? parseVmId(await this.api.request("GET", "cluster/nextid"));
    const vmName = proxmoxVmName(input.displayName, input.deploymentId);
    const resources = { node: input.node, vmId, vmName } satisfies ProxmoxResources;
    await onMutation({ phase: "allocated", resources });

    let cloneRequestAccepted = false;
    let cloneConfirmed = false;
    let ownershipEstablished = false;
    try {
      const cloneTaskValue = await this.api.request(
        "POST",
        `nodes/${encodeURIComponent(input.node)}/qemu/${input.templateVmId}/clone`,
        {
          newid: vmId,
          name: vmName,
          full: 1,
          target: input.node,
          ...(input.storage ? { storage: input.storage } : {}),
        },
      );
      cloneRequestAccepted = true;
      const cloneTask = requireTaskId(cloneTaskValue);
      await this.waitForTask(input.node, cloneTask);
      cloneConfirmed = true;

      const configPath = `nodes/${encodeURIComponent(input.node)}/qemu/${vmId}/config`;
      const currentConfig = recordValue(await this.api.request("GET", configPath), "VM configuration");
      const tags = mergeTags(stringValue(currentConfig["tags"]), input.deploymentId);
      const description = managedVmDescription(input.deploymentId);
      // Establish provider-side ownership before applying any mutable guest,
      // network, disk, or firewall configuration.
      await this.api.request("PUT", configPath, { tags, description });
      ownershipEstablished = true;
      await onMutation({ phase: "cloned", resources });

      const net0 = mergeNetworkConfig(stringValue(currentConfig["net0"]), input.bridge);
      await this.api.request("PUT", configPath, {
        agent: "enabled=1",
        cores: input.cores,
        memory: input.memoryMiB,
        ciuser: input.sshUsername,
        sshkeys: input.sshPublicKey,
        ipconfig0: formatCloudInitIpConfig(input.ipConfig, input.gateway),
        net0,
        onboot: 1,
      });
      await this.resizePrimaryDisk(input, currentConfig, vmId);
      await onMutation({ phase: "configured", resources });

      await this.replaceFirewall(resources, input.deploymentId, {
        sshPort: input.sshPort,
        multiplayerPort: input.multiplayerPort,
        sshCidrs: input.sshCidrs,
        operatorCidrs: input.operatorCidrs,
      });
      await onMutation({ phase: "firewall", resources });

      const startTask = requireTaskId(await this.api.request(
        "POST",
        `nodes/${encodeURIComponent(input.node)}/qemu/${vmId}/status/start`,
      ));
      await this.waitForTask(input.node, startTask);
      await onMutation({ phase: "started", resources });
      const address = await this.waitForGuestAddress(resources);
      return { resources, address, state: "running" };
    } catch (error) {
      if (cloneRequestAccepted) {
        await this.rollbackCreate(resources, input.deploymentId, cloneConfirmed, ownershipEstablished);
      }
      throw error;
    }
  }

  async refresh(resources: ProxmoxResources, deploymentId: string): Promise<ProxmoxDeploymentResult> {
    await this.requireManagedVm(resources, deploymentId);
    const state = recordValue(await this.api.request(
      "GET",
      `nodes/${encodeURIComponent(resources.node)}/qemu/${resources.vmId}/status/current`,
    ), "VM status");
    const address = stringValue(state["status"]) === "running"
      ? await this.currentGuestAddress(resources).catch(() => "")
      : "";
    return { resources, address, state: stringValue(state["status"]) ?? "unknown" };
  }

  async start(resources: ProxmoxResources, deploymentId: string): Promise<void> {
    await this.requireManagedVm(resources, deploymentId);
    const task = requireTaskId(await this.api.request(
      "POST",
      `nodes/${encodeURIComponent(resources.node)}/qemu/${resources.vmId}/status/start`,
    ));
    await this.waitForTask(resources.node, task);
  }

  async stop(resources: ProxmoxResources, deploymentId: string): Promise<void> {
    await this.requireManagedVm(resources, deploymentId);
    const task = requireTaskId(await this.api.request(
      "POST",
      `nodes/${encodeURIComponent(resources.node)}/qemu/${resources.vmId}/status/shutdown`,
      { timeout: 180 },
    ));
    await this.waitForTask(resources.node, task);
  }

  async reboot(resources: ProxmoxResources, deploymentId: string): Promise<void> {
    await this.requireManagedVm(resources, deploymentId);
    const task = requireTaskId(await this.api.request(
      "POST",
      `nodes/${encodeURIComponent(resources.node)}/qemu/${resources.vmId}/status/reboot`,
      { timeout: 180 },
    ));
    await this.waitForTask(resources.node, task);
  }

  async updateFirewall(
    resources: ProxmoxResources,
    deploymentId: string,
    policy: FirewallPolicy,
  ): Promise<void> {
    await this.requireManagedVm(resources, deploymentId);
    validateFirewallPolicy(policy);
    await this.replaceFirewall(resources, deploymentId, policy);
  }

  async destroy(resources: ProxmoxResources, deploymentId: string): Promise<void> {
    if (!(await this.findManagedVm(resources, deploymentId))) return;
    let currentValue: unknown;
    try {
      currentValue = await this.api.request(
        "GET",
        `nodes/${encodeURIComponent(resources.node)}/qemu/${resources.vmId}/status/current`,
      );
    } catch (error) {
      if (isProxmoxNotFound(error)) return;
      throw error;
    }
    const current = recordValue(currentValue, "VM status");
    if (stringValue(current["status"]) === "running") {
      let shutdownTaskValue: unknown;
      try {
        shutdownTaskValue = await this.api.request(
          "POST",
          `nodes/${encodeURIComponent(resources.node)}/qemu/${resources.vmId}/status/shutdown`,
          { timeout: 180 },
        );
      } catch (error) {
        if (isProxmoxNotFound(error)) return;
        throw error;
      }
      const shutdownTask = requireTaskId(shutdownTaskValue);
      await this.waitForTask(resources.node, shutdownTask);
    }
    if (!(await this.findManagedVm(resources, deploymentId))) return;
    let deleteTaskValue: unknown;
    try {
      deleteTaskValue = await this.api.request(
        "DELETE",
        `nodes/${encodeURIComponent(resources.node)}/qemu/${resources.vmId}`,
        { purge: 1, "destroy-unreferenced-disks": 1 },
      );
    } catch (error) {
      if (isProxmoxNotFound(error)) return;
      throw error;
    }
    const deleteTask = requireTaskId(deleteTaskValue);
    await this.waitForTask(resources.node, deleteTask);
  }

  private async rollbackCreate(
    resources: ProxmoxResources,
    deploymentId: string,
    cloneConfirmed: boolean,
    ownershipEstablished: boolean,
  ): Promise<void> {
    try {
      const configPath = `nodes/${encodeURIComponent(resources.node)}/qemu/${resources.vmId}/config`;
      const config = recordValue(await this.api.request("GET", configPath), "VM configuration");
      if (hasManagedVmTags(config, deploymentId)) {
        await this.destroy(resources, deploymentId);
        return;
      }
      // Public destruction always requires GUID tags. This narrower fallback is
      // available only while the same create call holds proof that its clone
      // task completed, and only for the exact generated, still-stopped VM.
      if (
        !cloneConfirmed ||
        ownershipEstablished ||
        stringValue(config["name"]) !== resources.vmName ||
        hasSliverManagementTag(config)
      ) return;
      const current = recordValue(await this.api.request(
        "GET",
        `nodes/${encodeURIComponent(resources.node)}/qemu/${resources.vmId}/status/current`,
      ), "VM status");
      if (stringValue(current["status"]) !== "stopped") return;

      const confirmation = recordValue(await this.api.request("GET", configPath), "VM configuration");
      if (hasManagedVmTags(confirmation, deploymentId)) {
        await this.destroy(resources, deploymentId);
        return;
      }
      if (
        stringValue(confirmation["name"]) !== resources.vmName ||
        hasSliverManagementTag(confirmation)
      ) return;
      const deleteTask = requireTaskId(await this.api.request(
        "DELETE",
        `nodes/${encodeURIComponent(resources.node)}/qemu/${resources.vmId}`,
        { purge: 1, "destroy-unreferenced-disks": 1 },
      ));
      await this.waitForTask(resources.node, deleteTask);
    } catch {
      // Rollback is best effort; preserve the original create failure.
    }
  }

  private async resizePrimaryDisk(
    input: ProxmoxCreateInput,
    config: Record<string, unknown>,
    vmId: number,
  ): Promise<void> {
    const diskKey = ["scsi0", "virtio0", "sata0", "ide0"].find((key) => typeof config[key] === "string");
    if (!diskKey) return;
    const disk = stringValue(config[diskKey]) ?? "";
    const currentGiB = parseDiskSizeGiB(disk);
    if (currentGiB !== undefined && input.diskGiB <= currentGiB) return;
    await this.api.request("PUT", `nodes/${encodeURIComponent(input.node)}/qemu/${vmId}/resize`, {
      disk: diskKey,
      size: `${input.diskGiB}G`,
    });
  }

  private async replaceFirewall(
    resources: ProxmoxResources,
    deploymentId: string,
    policy: FirewallPolicy,
  ): Promise<void> {
    validateFirewallPolicy(policy);
    const base = `nodes/${encodeURIComponent(resources.node)}/qemu/${resources.vmId}/firewall`;
    await this.api.request("PUT", `${base}/options`, {
      enable: 1,
      policy_in: "DROP",
      policy_out: "ACCEPT",
    });
    const existing = arrayRecords(await this.api.request("GET", `${base}/rules`));
    const prefix = firewallCommentPrefix(deploymentId);
    const positions = existing
      .filter((rule) => stringValue(rule["comment"])?.startsWith(prefix))
      .map((rule) => numberValue(rule["pos"]))
      .filter((position): position is number => position !== undefined)
      .sort((left, right) => right - left);
    for (const position of positions) await this.api.request("DELETE", `${base}/rules/${position}`);
    for (const [purpose, port, cidrs] of [
      ["ssh", policy.sshPort, policy.sshCidrs],
      ["operator", policy.multiplayerPort, policy.operatorCidrs],
    ] as const) {
      for (const cidr of cidrs) {
        await this.api.request("POST", `${base}/rules`, {
          enable: 1,
          type: "in",
          action: "ACCEPT",
          proto: "tcp",
          dport: port,
          source: cidr,
          comment: `${prefix}${purpose}`,
        });
      }
    }
  }

  private async requireManagedVm(resources: ProxmoxResources, deploymentId: string): Promise<void> {
    if (!(await this.findManagedVm(resources, deploymentId))) {
      throw new Error("The tracked Proxmox VM was not found");
    }
  }

  private async findManagedVm(resources: ProxmoxResources, deploymentId: string): Promise<boolean> {
    if (!GUID_PATTERN.test(deploymentId)) throw new Error("Invalid deployment identity");
    let configValue: unknown;
    try {
      configValue = await this.api.request(
        "GET",
        `nodes/${encodeURIComponent(resources.node)}/qemu/${resources.vmId}/config`,
      );
    } catch (error) {
      if (isProxmoxNotFound(error)) return false;
      throw error;
    }
    const config = recordValue(configValue, "VM configuration");
    if (!hasManagedVmTags(config, deploymentId)) {
      throw new Error("Refusing to manage a Proxmox VM without the expected Sliver GUID tags");
    }
    return true;
  }

  private async waitForTask(node: string, taskId: string): Promise<void> {
    const deadline = this.now() + this.taskTimeoutMs;
    while (this.now() < deadline) {
      const status = recordValue(await this.api.request(
        "GET",
        `nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(taskId)}/status`,
      ), "task status");
      if (stringValue(status["status"]) === "stopped") {
        if (stringValue(status["exitstatus"]) !== "OK") throw new Error("The Proxmox task did not complete successfully");
        return;
      }
      await this.sleep(1_000);
    }
    throw new Error("The Proxmox task timed out");
  }

  private async waitForGuestAddress(resources: ProxmoxResources): Promise<string> {
    const deadline = this.now() + this.guestTimeoutMs;
    while (this.now() < deadline) {
      const address = await this.currentGuestAddress(resources).catch(() => undefined);
      if (address) return address;
      await this.sleep(2_000);
    }
    throw new Error("The Proxmox guest agent did not report a usable IPv4 address");
  }

  private async currentGuestAddress(resources: ProxmoxResources): Promise<string> {
    const response = await this.api.request(
      "GET",
      `nodes/${encodeURIComponent(resources.node)}/qemu/${resources.vmId}/agent/network-get-interfaces`,
    );
    const root = recordValue(response, "guest-agent response");
    const interfaces = arrayRecords(root["result"]);
    for (const networkInterface of interfaces) {
      const name = stringValue(networkInterface["name"]);
      if (name === "lo") continue;
      for (const rawAddress of arrayRecords(networkInterface["ip-addresses"])) {
        const address = stringValue(rawAddress["ip-address"]);
        if (stringValue(rawAddress["ip-address-type"]) === "ipv4" && address && !address.startsWith("127.")) {
          return address;
        }
      }
    }
    throw new Error("No usable guest IPv4 address is available");
  }
}

interface FirewallPolicy {
  readonly sshPort: number;
  readonly multiplayerPort: number;
  readonly sshCidrs: readonly string[];
  readonly operatorCidrs: readonly string[];
}

export function mergeNetworkConfig(current: string | undefined, bridge: string): string {
  if (!BRIDGE_PATTERN.test(bridge)) throw new Error("Invalid Proxmox bridge");
  const parts = (current ?? "virtio").split(",").map((part) => part.trim()).filter(Boolean);
  const retained = parts.filter((part) => !part.startsWith("bridge=") && !part.startsWith("firewall="));
  return [...retained, `bridge=${bridge}`, "firewall=1"].join(",");
}

export function mergeTags(current: string | undefined, deploymentId: string): string {
  if (!GUID_PATTERN.test(deploymentId)) throw new Error("Invalid deployment identity");
  const tags = new Set((current ?? "").split(";").map((tag) => tag.trim()).filter(Boolean));
  tags.add("sliver-gui");
  tags.add(guidTag(deploymentId));
  return [...tags].sort().join(";");
}

export function formatCloudInitIpConfig(ipConfig: string, gateway: string | null): string {
  if (!/^ip=(?:dhcp|[0-9.]+\/[0-9]{1,2})(?:,gw=[0-9.]+)?$/u.test(ipConfig)) {
    throw new Error("Invalid Proxmox cloud-init IPv4 configuration");
  }
  if (gateway === null) return ipConfig;
  if (ipConfig === "ip=dhcp") throw new Error("A static gateway cannot be used with DHCP");
  if (ipConfig.includes(",gw=")) throw new Error("The Proxmox gateway was specified twice");
  if (!isIpv4Address(gateway)) throw new Error("Invalid Proxmox IPv4 gateway");
  return `${ipConfig},gw=${gateway}`;
}

function validateCreateInput(input: ProxmoxCreateInput): void {
  if (!GUID_PATTERN.test(input.deploymentId)) throw new Error("Invalid deployment identity");
  if (!NODE_PATTERN.test(input.node)) throw new Error("Invalid Proxmox node");
  if (input.storage && !STORAGE_PATTERN.test(input.storage)) throw new Error("Invalid Proxmox storage");
  if (!BRIDGE_PATTERN.test(input.bridge)) throw new Error("Invalid Proxmox bridge");
  if (!Number.isInteger(input.templateVmId) || input.templateVmId < 100 || input.templateVmId > 999_999_999) {
    throw new Error("Invalid Proxmox template VM ID");
  }
  if (input.vmId !== null && (!Number.isInteger(input.vmId) || input.vmId < 100 || input.vmId > 999_999_999)) {
    throw new Error("Invalid Proxmox VM ID");
  }
  if (!Number.isInteger(input.cores) || input.cores < 1 || input.cores > 128) throw new Error("Invalid core count");
  if (!Number.isInteger(input.memoryMiB) || input.memoryMiB < 1_024 || input.memoryMiB > 1_048_576) {
    throw new Error("Invalid memory size");
  }
  if (!Number.isInteger(input.diskGiB) || input.diskGiB < 16 || input.diskGiB > 16_384) {
    throw new Error("Invalid disk size");
  }
  if (!/^[a-z_][a-z0-9_-]{0,31}$/u.test(input.sshUsername)) throw new Error("Invalid SSH username");
  if (!input.sshPublicKey.startsWith("ssh-") || input.sshPublicKey.length > 16_384) throw new Error("Invalid SSH public key");
  formatCloudInitIpConfig(input.ipConfig, input.gateway);
  validateFirewallPolicy(input);
}

function validateFirewallPolicy(policy: FirewallPolicy): void {
  validatePort(policy.sshPort, "SSH port");
  validatePort(policy.multiplayerPort, "multiplayer port");
  validateCidrs(policy.sshCidrs, "SSH CIDR list");
  validateCidrs(policy.operatorCidrs, "operator CIDR list");
}

function validatePort(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`Invalid ${label}`);
}

function validateCidrs(values: readonly string[], label: string): void {
  if (values.length < 1 || values.length > 32 || !values.every(isIpCidr)) throw new Error(`Invalid ${label}`);
}

function isIpCidr(value: string): boolean {
  const slash = value.lastIndexOf("/");
  if (slash < 1 || !/^\d{1,3}$/u.test(value.slice(slash + 1))) return false;
  const family = isIP(value.slice(0, slash));
  const prefix = Number(value.slice(slash + 1));
  return family === 4 ? prefix > 0 && prefix <= 32 : family === 6 && prefix > 0 && prefix <= 128;
}

function isIpv4Address(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

function parseEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Proxmox endpoint");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("The Proxmox endpoint must be an HTTPS origin without credentials");
  }
  url.pathname = url.pathname.replace(/\/*$/u, "/");
  return url;
}

function validateToken(value: string, label: string): void {
  if (!value || value.length > 512 || /[\r\n\0]/u.test(value)) throw new Error(`Invalid ${label}`);
}

function isPemCertificate(value: string): boolean {
  return value.length <= 1024 * 1024 && value.includes("-----BEGIN CERTIFICATE-----") && value.includes("-----END CERTIFICATE-----");
}

function encodeForm(form: ProxmoxForm): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) if (value !== undefined) params.set(key, String(value));
  return params.toString();
}

function sanitizeProxmoxError(error: unknown): Error {
  if (error instanceof Error && /^(?:Proxmox|The Proxmox|Invalid|Unable|No usable)/u.test(error.message)) return error;
  return new Error("Unable to communicate with the Proxmox API");
}

function isProxmoxNotFound(error: unknown): boolean {
  return error instanceof Error && error.message === "Proxmox API request failed with HTTP 404";
}

function requireTaskId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || value.includes("\0")) {
    throw new Error("Proxmox returned an invalid task ID");
  }
  return value;
}

function parseVmId(value: unknown): number {
  const vmId = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(vmId) || vmId < 100 || vmId > 999_999_999) throw new Error("Proxmox returned an invalid VM ID");
  return vmId;
}

function proxmoxVmName(displayName: string, deploymentId: string): string {
  const normalized = displayName.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 45);
  const name = `${normalized || "sliver"}-${deploymentId.slice(0, 8)}`;
  if (!VM_NAME_PATTERN.test(name)) throw new Error("Unable to derive a valid Proxmox VM name");
  return name;
}

function guidTag(deploymentId: string): string {
  return `sliver-guid-${deploymentId}`;
}

function managedVmDescription(deploymentId: string): string {
  return `Managed by Sliver GUI\nSliverGUID=${deploymentId}`;
}

function vmTags(config: Record<string, unknown>): Set<string> {
  return new Set((stringValue(config["tags"]) ?? "").split(";").filter(Boolean));
}

function hasManagedVmTags(config: Record<string, unknown>, deploymentId: string): boolean {
  const tags = vmTags(config);
  return tags.has("sliver-gui") && tags.has(guidTag(deploymentId));
}

function hasSliverManagementTag(config: Record<string, unknown>): boolean {
  const tags = vmTags(config);
  return tags.has("sliver-gui") || [...tags].some((tag) => tag.startsWith("sliver-guid-"));
}

function firewallCommentPrefix(deploymentId: string): string {
  return `sliver-guid:${deploymentId}:`;
}

export function parsePermissionGrants(value: unknown): readonly ProxmoxPermissionGrant[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .flatMap(([path, entry]) => {
      if (!isAbsoluteProxmoxAclPath(path) || !isRecord(entry)) return [];
      const permissions = Object.entries(entry)
        .flatMap(([name, enabled]) => truthyFlag(enabled) && isProxmoxPrivilege(name) ? [name] : [])
        .sort();
      return permissions.length > 0 ? [{ path, permissions: Object.freeze(permissions) }] : [];
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function evaluateProxmoxPermissions(
  grants: readonly ProxmoxPermissionGrant[],
): CloudPermissionEvaluation {
  const statuses = new Map<string, "verified" | "missing" | "unverifiable">();
  for (const { id } of cloudRequiredPermissions("proxmox")) {
    const relevantPaths = grants
      .filter(({ permissions }) => permissions.includes(id))
      .map(({ path }) => path);
    if (relevantPaths.length === 0) {
      statuses.set(id, "missing");
    } else if (relevantPaths.some((path) => broadAclPaths(id).includes(path))) {
      statuses.set(id, "verified");
    } else {
      // A privilege restricted to one VM, storage, node, pool, or network may
      // be sufficient after the user selects that exact resource, but a
      // credential-only check cannot prove it.
      statuses.set(id, "unverifiable");
    }
  }
  return createCloudPermissionEvaluation("proxmox", statuses);
}

function flattenPermissionGrants(grants: readonly ProxmoxPermissionGrant[]): string[] {
  return [...new Set(grants.flatMap(({ permissions }) => permissions))].sort();
}

function broadAclPaths(privilege: string): readonly string[] {
  if (privilege.startsWith("VM.")) return ["/", "/vms"];
  if (privilege.startsWith("Datastore.")) return ["/", "/storage"];
  if (privilege.startsWith("SDN.")) return ["/", "/sdn"];
  if (privilege.startsWith("Sys.")) return ["/", "/nodes"];
  return ["/"];
}

function isAbsoluteProxmoxAclPath(value: string): boolean {
  return value === "/" || (/^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(value) && value.length <= 1_024);
}

function isProxmoxPrivilege(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/u.test(value) && value.length <= 128;
}

function parseDiskSizeGiB(value: string): number | undefined {
  const match = /(?:^|,)size=([0-9]+(?:\.[0-9]+)?)([KMGT])(?:,|$)/u.exec(value);
  if (!match?.[1] || !match[2]) return undefined;
  const size = Number(match[1]);
  const multiplier = { K: 1 / 1024 / 1024, M: 1 / 1024, G: 1, T: 1024 }[match[2]];
  if (multiplier === undefined) return undefined;
  return size * multiplier;
}

function truthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Proxmox returned an invalid ${label}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) return Number(value);
  return undefined;
}
