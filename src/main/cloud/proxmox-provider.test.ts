// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  ProxmoxProvider,
  evaluateProxmoxPermissions,
  formatCloudInitIpConfig,
  mergeNetworkConfig,
  mergeTags,
  parsePermissionGrants,
  type ProxmoxApiCredentials,
  type ProxmoxCreateInput,
  type ProxmoxTransport,
} from "./proxmox-provider.js";

const deploymentId = "8e577480-5dc2-4dde-aa58-23c8f1770627";
const credentials: ProxmoxApiCredentials = {
  endpoint: "https://pve.example.test:8006/",
  tokenId: "sliver@pve!gui",
  tokenSecret: "secret",
  tlsCaCertificate: null,
};

describe("Proxmox provider helpers", () => {
  it("preserves cloned network properties while enabling the selected bridge firewall", () => {
    expect(mergeNetworkConfig("virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr9,queues=4", "vmbr0"))
      .toBe("virtio=AA:BB:CC:DD:EE:FF,queues=4,bridge=vmbr0,firewall=1");
  });

  it("merges stable management tags without dropping existing tags", () => {
    expect(mergeTags("production;blue", deploymentId))
      .toBe(`blue;production;sliver-gui;sliver-guid-${deploymentId}`);
  });

  it("combines a separately supplied static gateway with cloud-init IP configuration", () => {
    expect(formatCloudInitIpConfig("ip=10.0.0.44/24", "10.0.0.1"))
      .toBe("ip=10.0.0.44/24,gw=10.0.0.1");
    expect(() => formatCloudInitIpConfig("ip=dhcp", "10.0.0.1"))
      .toThrow(/cannot be used with DHCP/u);
  });

  it("preserves effective ACL paths and treats narrow grants as resource-specific", () => {
    const grants = parsePermissionGrants({
      "/": { "Sys.Audit": 1, "VM.Allocate": 1, ignored: 0 },
      "/vms/9000": { "VM.Clone": 1 },
      "relative/path": { "VM.PowerMgmt": 1 },
    });
    const evaluation = evaluateProxmoxPermissions(grants);

    expect(grants).toEqual([
      { path: "/", permissions: ["Sys.Audit", "VM.Allocate"] },
      { path: "/vms/9000", permissions: ["VM.Clone"] },
    ]);
    expect(evaluation.verified).toEqual(expect.arrayContaining(["Sys.Audit", "VM.Allocate"]));
    expect(evaluation.unverifiable).toContain("VM.Clone");
    expect(evaluation.missing).toContain("VM.PowerMgmt");
  });
});

describe("Proxmox provider", () => {
  it("fails preflight when a token authenticates without effective ACLs", async () => {
    const transport = new FakeTransport((method, path) => {
      if (method === "GET" && path === "version") return { version: "9.0" };
      if (method === "GET" && path === "access/permissions") return {};
      if (method === "GET" && path === "nodes") return [{ node: "pve" }];
      if (method === "GET" && path === "cluster/firewall/options") return { enable: 1 };
      throw new Error(`unexpected ${method} ${path}`);
    });

    await expect(new ProxmoxProvider(credentials, { transport }).preflight())
      .rejects.toThrow(/no effective ACL permissions/);
  });

  it("reports provider-specific permission gaps without mutating Proxmox", async () => {
    const transport = new FakeTransport((method, path) => {
      if (method === "GET" && path === "version") return { version: "9.0" };
      if (method === "GET" && path === "access/permissions") {
        return {
          "/": { "Sys.Audit": 1, "VM.Audit": 1, "VM.PowerMgmt": 1 },
          "/vms/9000": { "VM.Clone": 1 },
        };
      }
      if (method === "GET" && path === "nodes") return [{ node: "pve" }];
      if (method === "GET" && path === "cluster/firewall/options") return { enable: 0 };
      throw new Error(`unexpected ${method} ${path}`);
    });

    const result = await new ProxmoxProvider(credentials, { transport }).checkPermissions();

    expect(result).toMatchObject({
      version: "9.0",
      nodes: ["pve"],
      clusterFirewallEnabled: false,
      permissions: {
        verified: expect.arrayContaining(["Sys.Audit", "VM.Audit", "VM.PowerMgmt"]),
        missing: expect.arrayContaining(["VM.Allocate", "VM.Config.Network", "SDN.Use"]),
        unverifiable: ["VM.Clone"],
      },
    });
    expect(transport.calls.every(({ method }) => method === "GET")).toBe(true);
  });

  it("clones, tags, firewalls, starts, and discovers a cloud-init VM", async () => {
    let clock = 0;
    const transport = new FakeTransport((method, path) => {
      if (method === "GET" && path === "version") return { version: "9.0" };
      if (method === "GET" && path === "access/permissions") return { "/": { "VM.Allocate": 1 } };
      if (method === "GET" && path === "nodes") return [{ node: "pve" }];
      if (method === "GET" && path === "cluster/firewall/options") return { enable: 1 };
      if (method === "GET" && path === "cluster/nextid") return "201";
      if (method === "POST" && path.endsWith("/clone")) return "UPID:clone";
      if (method === "GET" && path.includes("/tasks/")) return { status: "stopped", exitstatus: "OK" };
      if (method === "GET" && path.endsWith("/config")) {
        return {
          name: "team-red-8e577480",
          tags: "template",
          net0: "virtio=AA:BB:CC:DD:EE:FF,bridge=old",
          scsi0: "local:vm-201,size=8G",
        };
      }
      if (method === "GET" && path.endsWith("/firewall/rules")) return [];
      if (method === "POST" && path.endsWith("/status/start")) return "UPID:start";
      if (method === "GET" && path.endsWith("/agent/network-get-interfaces")) {
        return {
          result: [
            { name: "lo", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "127.0.0.1" }] },
            { name: "eth0", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "10.0.0.44" }] },
          ],
        };
      }
      if (method === "PUT" || method === "POST" || method === "DELETE") return null;
      throw new Error(`unexpected ${method} ${path}`);
    });
    const mutations: string[] = [];
    const provider = new ProxmoxProvider(credentials, {
      transport,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    });

    const result = await provider.create(createInput(), ({ phase }) => { mutations.push(phase); });

    expect(result).toEqual({
      address: "10.0.0.44",
      state: "running",
      resources: { node: "pve", vmId: 201, vmName: "team-red-8e577480" },
    });
    expect(mutations).toEqual(["allocated", "cloned", "configured", "firewall", "started"]);
    const metadataUpdate = transport.calls.findIndex((call) => (
      call.method === "PUT" &&
      call.path === "nodes/pve/qemu/201/config" &&
      call.form?.["description"] !== undefined
    ));
    const guestUpdate = transport.calls.findIndex((call) => (
      call.method === "PUT" &&
      call.path === "nodes/pve/qemu/201/config" &&
      call.form?.["net0"] !== undefined
    ));
    expect(metadataUpdate).toBeGreaterThan(-1);
    expect(guestUpdate).toBeGreaterThan(metadataUpdate);
    expect(transport.calls[metadataUpdate]).toEqual(expect.objectContaining({
      method: "PUT",
      path: "nodes/pve/qemu/201/config",
      form: {
        description: `Managed by Sliver GUI\nSliverGUID=${deploymentId}`,
        tags: `sliver-gui;sliver-guid-${deploymentId};template`,
      },
    }));
    expect(transport.calls[guestUpdate]).toEqual(expect.objectContaining({
      form: expect.objectContaining({
        net0: "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1",
      }),
    }));
    const firewallCreates = transport.calls.filter((call) => call.method === "POST" && call.path.endsWith("/firewall/rules"));
    expect(firewallCreates).toHaveLength(2);
    expect(firewallCreates.map((call) => call.form?.["source"])).toEqual(["203.0.113.4/32", "203.0.113.4/32"]);
  });

  it("rolls back its exact stopped clone when the initial ownership update fails", async () => {
    const transport = new FakeTransport((method, path, form) => {
      if (method === "GET" && path === "version") return { version: "9.0" };
      if (method === "GET" && path === "access/permissions") return { "/": { "VM.Allocate": 1 } };
      if (method === "GET" && path === "nodes") return [{ node: "pve" }];
      if (method === "GET" && path === "cluster/firewall/options") return { enable: 1 };
      if (method === "GET" && path === "cluster/nextid") return "201";
      if (method === "POST" && path.endsWith("/clone")) return "UPID:clone";
      if (method === "GET" && path.includes("/tasks/")) return { status: "stopped", exitstatus: "OK" };
      if (method === "GET" && path.endsWith("/config")) {
        return { name: "team-red-8e577480", tags: "template" };
      }
      if (method === "PUT" && path.endsWith("/config") && form?.["tags"] !== undefined) {
        throw new Error("metadata update failed");
      }
      if (method === "GET" && path.endsWith("/status/current")) return { status: "stopped" };
      if (method === "DELETE" && path === "nodes/pve/qemu/201") return "UPID:rollback";
      throw new Error(`unexpected ${method} ${path}`);
    });
    const mutations: string[] = [];
    const provider = new ProxmoxProvider(credentials, { transport });

    await expect(provider.create(createInput(), ({ phase }) => { mutations.push(phase); }))
      .rejects.toThrow(/metadata update failed/u);

    expect(mutations).toEqual(["allocated"]);
    expect(transport.calls.filter(({ method }) => method === "DELETE")).toEqual([{
      method: "DELETE",
      path: "nodes/pve/qemu/201",
      form: { purge: 1, "destroy-unreferenced-disks": 1 },
    }]);
  });

  it("uses GUID-gated destruction when creation fails after ownership was established", async () => {
    let tagged = false;
    const transport = new FakeTransport((method, path, form) => {
      if (method === "GET" && path === "version") return { version: "9.0" };
      if (method === "GET" && path === "access/permissions") return { "/": { "VM.Allocate": 1 } };
      if (method === "GET" && path === "nodes") return [{ node: "pve" }];
      if (method === "GET" && path === "cluster/firewall/options") return { enable: 1 };
      if (method === "GET" && path === "cluster/nextid") return "201";
      if (method === "POST" && path.endsWith("/clone")) return "UPID:clone";
      if (method === "GET" && path.includes("/tasks/")) return { status: "stopped", exitstatus: "OK" };
      if (method === "GET" && path.endsWith("/config")) {
        return {
          name: "team-red-8e577480",
          tags: tagged ? `sliver-gui;sliver-guid-${deploymentId}` : "template",
          net0: "virtio=AA:BB:CC:DD:EE:FF,bridge=old",
        };
      }
      if (method === "PUT" && path.endsWith("/config") && form?.["tags"] !== undefined) {
        tagged = true;
        return null;
      }
      if (method === "PUT" && path.endsWith("/config")) throw new Error("guest configuration failed");
      if (method === "GET" && path.endsWith("/status/current")) return { status: "stopped" };
      if (method === "DELETE" && path === "nodes/pve/qemu/201") return "UPID:rollback";
      throw new Error(`unexpected ${method} ${path}`);
    });
    const mutations: string[] = [];
    const provider = new ProxmoxProvider(credentials, { transport });

    await expect(provider.create(createInput(), ({ phase }) => { mutations.push(phase); }))
      .rejects.toThrow(/guest configuration failed/u);

    expect(mutations).toEqual(["allocated", "cloned"]);
    expect(transport.calls.filter(({ method }) => method === "DELETE")).toHaveLength(1);
  });

  it("does not roll back an untagged VM when the clone identity changed", async () => {
    let metadataFailed = false;
    const transport = new FakeTransport((method, path, form) => {
      if (method === "GET" && path === "version") return { version: "9.0" };
      if (method === "GET" && path === "access/permissions") return { "/": { "VM.Allocate": 1 } };
      if (method === "GET" && path === "nodes") return [{ node: "pve" }];
      if (method === "GET" && path === "cluster/firewall/options") return { enable: 1 };
      if (method === "GET" && path === "cluster/nextid") return "201";
      if (method === "POST" && path.endsWith("/clone")) return "UPID:clone";
      if (method === "GET" && path.includes("/tasks/")) return { status: "stopped", exitstatus: "OK" };
      if (method === "GET" && path.endsWith("/config")) {
        return { name: metadataFailed ? "user-owned-vm" : "team-red-8e577480", tags: "template" };
      }
      if (method === "PUT" && path.endsWith("/config") && form?.["tags"] !== undefined) {
        metadataFailed = true;
        throw new Error("metadata update failed");
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const provider = new ProxmoxProvider(credentials, { transport });

    await expect(provider.create(createInput())).rejects.toThrow(/metadata update failed/u);
    expect(transport.calls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
  });

  it("refuses lifecycle mutation when the remote VM lost its GUID tag", async () => {
    const transport = new FakeTransport((method, path) => {
      if (method === "GET" && path.endsWith("/config")) return { tags: "sliver-gui;some-other-tag" };
      throw new Error(`unexpected ${method} ${path}`);
    });
    const provider = new ProxmoxProvider(credentials, { transport });

    await expect(provider.stop({ node: "pve", vmId: 201, vmName: "team-red" }, deploymentId))
      .rejects.toThrow(/without the expected Sliver GUID tags/);
    expect(transport.calls).toHaveLength(1);
  });

  it("treats a missing managed VM as already destroyed", async () => {
    const transport = new FakeTransport((method, path) => {
      if (method === "GET" && path.endsWith("/config")) {
        throw new Error("Proxmox API request failed with HTTP 404");
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const provider = new ProxmoxProvider(credentials, { transport });

    await expect(provider.destroy(
      { node: "pve", vmId: 201, vmName: "team-red" },
      deploymentId,
    )).resolves.toBeUndefined();

    expect(transport.calls).toEqual([{
      method: "GET",
      path: "nodes/pve/qemu/201/config",
    }]);
  });

  it("can retry destruction after the delete succeeded but its response was lost", async () => {
    let exists = true;
    const transport = new FakeTransport((method, path) => {
      if (method === "GET" && path.endsWith("/config")) {
        if (!exists) throw new Error("Proxmox API request failed with HTTP 404");
        return { tags: `sliver-gui;sliver-guid-${deploymentId}` };
      }
      if (method === "GET" && path.endsWith("/status/current")) return { status: "stopped" };
      if (method === "DELETE" && path === "nodes/pve/qemu/201") {
        exists = false;
        throw new Error("connection interrupted after delete");
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const provider = new ProxmoxProvider(credentials, { transport });
    const resources = { node: "pve", vmId: 201, vmName: "team-red" };

    await expect(provider.destroy(resources, deploymentId)).rejects.toThrow(/connection interrupted/u);
    await expect(provider.destroy(resources, deploymentId)).resolves.toBeUndefined();

    expect(transport.calls.filter(({ method }) => method === "DELETE")).toHaveLength(1);
  });

  it("still refuses to destroy an existing VM with mismatched GUID tags", async () => {
    const transport = new FakeTransport((method, path) => {
      if (method === "GET" && path.endsWith("/config")) return { tags: "sliver-gui;sliver-guid-other" };
      throw new Error(`unexpected ${method} ${path}`);
    });
    const provider = new ProxmoxProvider(credentials, { transport });

    await expect(provider.destroy(
      { node: "pve", vmId: 201, vmName: "team-red" },
      deploymentId,
    )).rejects.toThrow(/without the expected Sliver GUID tags/u);
    expect(transport.calls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
  });

  it("removes only its own firewall entries and deletes shifting positions from the end", async () => {
    const transport = new FakeTransport((method, path) => {
      if (method === "GET" && path.endsWith("/config")) {
        return { tags: `sliver-gui;sliver-guid-${deploymentId}` };
      }
      if (method === "GET" && path.endsWith("/firewall/rules")) {
        return [
          { pos: 1, comment: `sliver-guid:${deploymentId}:ssh` },
          { pos: 2, comment: "owned-by-user" },
          { pos: 3, comment: `sliver-guid:${deploymentId}:operator` },
        ];
      }
      return null;
    });
    const provider = new ProxmoxProvider(credentials, { transport });

    await provider.updateFirewall(
      { node: "pve", vmId: 201, vmName: "team-red" },
      deploymentId,
      {
        sshPort: 22,
        multiplayerPort: 31_337,
        sshCidrs: ["192.0.2.1/32"],
        operatorCidrs: ["2001:db8::/64"],
      },
    );

    expect(transport.calls.filter((call) => call.method === "DELETE").map((call) => call.path))
      .toEqual([
        "nodes/pve/qemu/201/firewall/rules/3",
        "nodes/pve/qemu/201/firewall/rules/1",
      ]);
    expect(transport.calls.filter((call) => call.method === "POST").map((call) => call.form?.["source"]))
      .toEqual(["192.0.2.1/32", "2001:db8::/64"]);
  });
});

class FakeTransport implements ProxmoxTransport {
  readonly calls: Array<{
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    form?: Readonly<Record<string, string | number | boolean | undefined>>;
  }> = [];

  constructor(
    private readonly respond: (
      method: "GET" | "POST" | "PUT" | "DELETE",
      path: string,
      form?: Readonly<Record<string, string | number | boolean | undefined>>,
    ) => unknown,
  ) {}

  request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    form?: Readonly<Record<string, string | number | boolean | undefined>>,
  ): Promise<unknown> {
    this.calls.push({ method, path, ...(form ? { form } : {}) });
    return Promise.resolve(this.respond(method, path, form));
  }
}

function createInput(overrides: Partial<ProxmoxCreateInput> = {}): ProxmoxCreateInput {
  return {
    deploymentId,
    displayName: "Team Red",
    node: "pve",
    templateVmId: 9000,
    vmId: null,
    storage: "local-lvm",
    bridge: "vmbr0",
    cores: 4,
    memoryMiB: 4_096,
    diskGiB: 32,
    ipConfig: "ip=dhcp",
    gateway: null,
    sshUsername: "ubuntu",
    sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake",
    sshPort: 22,
    multiplayerPort: 31_337,
    sshCidrs: ["203.0.113.4/32"],
    operatorCidrs: ["203.0.113.4/32"],
    ...overrides,
  };
}

void vi;
