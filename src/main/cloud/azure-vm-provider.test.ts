// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type {
  Disk,
  DiskUpdate,
  ResourceSku,
  VirtualMachine,
} from "@azure/arm-compute";
import type {
  NetworkInterface,
  NetworkSecurityGroup,
  PublicIPAddress,
  SecurityRule,
  Subnet,
  VirtualNetwork,
} from "@azure/arm-network";
import type { GenericResourceExpanded, ResourceGroup } from "@azure/arm-resources";
import type { TokenCredential } from "@azure/identity";

import {
  AZURE_GUID_TAG_KEY,
  AZURE_MANAGED_TAG_KEY,
  AZURE_MANAGED_TAG_VALUE,
  AZURE_NAME_TAG_KEY,
  AZURE_UBUNTU_IMAGE_OPTIONS,
  AzureVmProvider,
  type AzureFirewallRuleSpec,
  type AzureVmClientConfiguration,
  type AzureVmClientSet,
  type AzureVmCreateInput,
  type AzureVmCreatePhase,
  type AzureVmDestroyResource,
} from "./azure-vm-provider.js";

const subscriptionId = "00000000-1111-2222-3333-444444444444";
const tenantId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const guid = "8e577480-5dc2-4dde-aa58-23c8f1770627";
const location = "westus2";
const resourceGroupName = `sliver-gui-${guid}`;
const resourceGroupId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}`;
const vnetName = `sliver-vnet-${guid}`;
const subnetName = `sliver-subnet-${guid}`;
const nsgName = `sliver-nsg-${guid}`;
const publicIpName = `sliver-ip-${guid}`;
const nicName = `sliver-nic-${guid}`;
const vmName = `sliver-vm-${guid}`;
const diskName = `sliver-os-${guid}`;
const vnetId = networkId(resourceGroupName, "virtualNetworks", vnetName);
const subnetId = `${vnetId}/subnets/${subnetName}`;
const nsgId = networkId(resourceGroupName, "networkSecurityGroups", nsgName);
const publicIpId = networkId(resourceGroupName, "publicIPAddresses", publicIpName);
const nicId = networkId(resourceGroupName, "networkInterfaces", nicName);
const vmId = computeId(resourceGroupName, "virtualMachines", vmName);
const diskId = computeId(resourceGroupName, "disks", diskName);
const sshPublicKeyBlob = Buffer.from(
  "\0\0\0\u000bssh-ed25519\0\0\0\u001f0123456789012345678901234567890",
  "binary",
).toString("base64");
const sshPublicKey = `ssh-ed25519 ${sshPublicKeyBlob} sliver-gui`;
const credential: TokenCredential = {
  getToken: vi.fn(async () => ({ token: "arm-token", expiresOnTimestamp: Date.now() + 60_000 })),
};

describe("Azure VM provider", () => {
  it("binds every official client to the explicit subscription, tenant, location, and TokenCredential", async () => {
    const fake = new FakeAzureClients();
    const configurations: AzureVmClientConfiguration[] = [];
    const provider = new AzureVmProvider(
      {
        subscriptionId: subscriptionId.toUpperCase(),
        tenantId: tenantId.toUpperCase(),
        location,
        credential,
      },
      {
        clientFactory: (configuration) => {
          configurations.push(configuration);
          return fake.clients;
        },
      },
    );

    await provider.discover();

    expect(configurations).toEqual([{ subscriptionId, tenantId, location, credential }]);
  });

  it.each([
    "1", "123", "a", "actuser", "adm", "admin", "admin1", "admin2", "administrator",
    "aspnet", "backup", "console", "david", "guest", "john", "owner", "root", "server", "sql",
    "support_388945a0", "support", "sys", "test", "test1", "test2", "test3", "user", "user1",
    "user2", "user3", "user4", "user5", "video",
  ])("rejects Microsoft's reserved Azure SSH username %s before any mutation", async (sshUsername) => {
    const fake = new FakeAzureClients();

    await expect(providerFor(fake).create({
      ...managedCreateInput(),
      sshUsername,
    })).rejects.toThrow("invalid or reserved");

    expect(fake.mutations).toEqual([]);
  });

  it("rejects a nonstandard SSH port before any Azure mutation", async () => {
    const fake = new FakeAzureClients();
    const input = {
      ...managedCreateInput(),
      firewall: { ...managedCreateInput().firewall, sshPort: 2_222 },
    } as unknown as AzureVmCreateInput;

    await expect(providerFor(fake).create(input)).rejects.toThrow(
      "Azure deployments require SSH port 22",
    );

    expect(fake.mutations).toEqual([]);
  });

  it("discovers bounded regional VM SKUs, existing virtual networks and subnets, and curated Ubuntu images", async () => {
    const fake = new FakeAzureClients();
    const existingResourceGroup = "operator-network";
    const existingVnetId = networkId(existingResourceGroup, "virtualNetworks", "operator-vnet");
    fake.virtualNetworks.set(existingVnetId, {
      id: existingVnetId,
      name: "operator-vnet",
      location,
      addressSpace: { addressPrefixes: ["10.42.0.0/16"] },
    });
    fake.subnets.set(`${existingVnetId}/subnets/operator-subnet`, {
      id: `${existingVnetId}/subnets/operator-subnet`,
      name: "operator-subnet",
      addressPrefix: "10.42.1.0/24",
    });
    fake.resourceSkus.push(armSku(), {
      ...x64Sku(),
      name: "Standard_D8s_v5",
      locations: ["eastus"],
    });
    const provider = providerFor(fake);

    const result = await provider.discover();

    expect(result).toMatchObject({ subscriptionId, tenantId, location });
    expect(result.vmSizes).toEqual([
      {
        name: "Standard_D2ps_v5",
        architecture: "arm64",
        vCpuCount: 2,
        memoryMiB: 8_192,
        maxDataDiskCount: 4,
        osDiskSizeMiB: 1_048_576,
        premiumIo: true,
      },
      {
        name: "Standard_D2s_v5",
        architecture: "x64",
        vCpuCount: 2,
        memoryMiB: 8_192,
        maxDataDiskCount: 4,
        osDiskSizeMiB: 1_048_576,
        premiumIo: true,
      },
    ]);
    expect(result.virtualNetworks).toEqual([{
      id: existingVnetId,
      name: "operator-vnet",
      resourceGroupName: existingResourceGroup,
      location,
      addressPrefixes: ["10.42.0.0/16"],
    }]);
    expect(result.subnets).toEqual([{
      id: `${existingVnetId}/subnets/operator-subnet`,
      name: "operator-subnet",
      resourceGroupName: existingResourceGroup,
      virtualNetworkName: "operator-vnet",
      addressPrefixes: ["10.42.1.0/24"],
    }]);
    expect(result.images).toEqual(AZURE_UBUNTU_IMAGE_OPTIONS);
  });

  it("creates and journals a fully tagged managed deployment with baseline access", async () => {
    const fake = new FakeAzureClients();
    const phases: AzureVmCreatePhase[] = [];
    const provider = providerFor(fake);
    const createMutationByPhase: Partial<Record<AzureVmCreatePhase, string>> = {
      "resource-group": "rg.create",
      "virtual-network": "vnet.create",
      subnet: "subnet.create",
      "network-security-group": "nsg.create",
      firewall: "rule.write",
      "public-ip-address": "pip.create",
      "network-interface": "nic.create",
      "virtual-machine": "vm.create",
    };

    const resource = await provider.create(managedCreateInput(), (event) => {
      phases.push(event.phase);
      expect(event.resources.resourceGroupId).toBe(resourceGroupId);
      const pendingMutation = createMutationByPhase[event.phase];
      if (pendingMutation) expect(fake.mutations).not.toContain(pendingMutation);
      if (event.phase === "virtual-network" || event.phase === "subnet") {
        expect(event.resources.managedNetwork).toEqual({ virtualNetworkId: vnetId, subnetId });
      } else if (event.phase === "network-security-group") {
        expect(event.resources.networkSecurityGroupId).toBe(nsgId);
      } else if (event.phase === "public-ip-address") {
        expect(event.resources.publicIpAddressId).toBe(publicIpId);
      } else if (event.phase === "network-interface") {
        expect(event.resources.networkInterfaceId).toBe(nicId);
      } else if (event.phase === "virtual-machine") {
        expect(event.resources).toMatchObject({ virtualMachineId: vmId, osDiskId: diskId });
      }
    });

    expect(phases).toEqual([
      "resource-group",
      "virtual-network",
      "subnet",
      "network-security-group",
      "firewall",
      "public-ip-address",
      "network-interface",
      "virtual-machine",
      "os-disk",
    ]);
    expect(resource).toMatchObject({
      subscriptionId,
      tenantId,
      location,
      guid,
      name: "Azure test",
      resourceGroupId,
      virtualNetworkId: vnetId,
      subnetId,
      managedNetwork: { virtualNetworkId: vnetId, subnetId },
      networkSecurityGroupId: nsgId,
      publicIpAddressId: publicIpId,
      networkInterfaceId: nicId,
      virtualMachineId: vmId,
      osDiskId: diskId,
      instanceState: "running",
      privateIpAddress: "10.0.1.4",
      publicIpAddress: "203.0.113.42",
    });
    for (const tagged of [
      fake.resourceGroups.get(resourceGroupName),
      fake.virtualNetworks.get(vnetId),
      fake.networkSecurityGroups.get(nsgId),
      fake.publicIpAddresses.get(publicIpId),
      fake.networkInterfaces.get(nicId),
      fake.virtualMachines.get(vmId),
      fake.disks.get(diskId),
    ]) {
      expect(tagged?.tags).toEqual(managedTags());
    }
    expect(fake.subnets.get(subnetId)?.addressPrefix).toBe("10.0.1.0/24");
    expect(fake.publicIpAddresses.get(publicIpId)).toMatchObject({
      sku: { name: "Standard", tier: "Regional" },
      publicIPAllocationMethod: "Static",
      publicIPAddressVersion: "IPv4",
    });
    expect(fake.virtualMachines.get(vmId)).toMatchObject({
      location,
      hardwareProfile: { vmSize: "Standard_D2s_v5" },
      storageProfile: {
        imageReference: {
          publisher: "Canonical",
          offer: "ubuntu-24_04-lts",
          sku: "server",
          version: "latest",
        },
        osDisk: { name: diskName, deleteOption: "Delete" },
      },
      osProfile: {
        adminUsername: "azureuser",
        linuxConfiguration: {
          disablePasswordAuthentication: true,
          ssh: { publicKeys: [{ keyData: sshPublicKey }] },
        },
      },
    });
    expect([...fake.securityRules.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "sliver-gui-ssh-001",
        priority: 1_000,
        direction: "Inbound",
        access: "Allow",
        destinationPortRange: "22",
      }),
      expect.objectContaining({
        name: "sliver-gui-operator-001",
        priority: 1_001,
        direction: "Inbound",
        access: "Allow",
        destinationPortRange: "31337",
      }),
    ]));
  });

  it("rolls back a remotely-created tagged asset when LRO completion throws after the candidate was journaled", async () => {
    const fake = new FakeAzureClients();
    const provider = providerFor(fake);
    const journaledNetworkInterfaces: string[] = [];
    const createNetworkInterface = fake.clients.networkInterfaces.createOrUpdate;
    vi.spyOn(fake.clients.networkInterfaces, "createOrUpdate").mockImplementationOnce(async (
      group,
      name,
      parameters,
    ) => {
      await createNetworkInterface(group, name, parameters);
      throw Object.assign(new Error("polling failed"), { statusCode: 503, code: "ServiceUnavailable" });
    });

    await expect(provider.create(managedCreateInput(), (event) => {
      if (event.phase === "network-interface" && event.resources.networkInterfaceId) {
        journaledNetworkInterfaces.push(event.resources.networkInterfaceId);
      }
    })).rejects.toThrow("create the deployment network interface");

    expect(journaledNetworkInterfaces).toEqual([nicId]);
    expect(fake.mutations).toEqual(expect.arrayContaining(["nic.create", "nic.delete"]));
    expect(fake.networkInterfaces.has(nicId)).toBe(false);
    expect(fake.resourceGroups.size).toBe(0);
  });

  it("rolls back a journaled owned asset when the create response fails configuration validation", async () => {
    const fake = new FakeAzureClients();
    const provider = providerFor(fake);
    const journaledPublicIps: string[] = [];
    const createPublicIp = fake.clients.publicIpAddresses.createOrUpdate;
    vi.spyOn(fake.clients.publicIpAddresses, "createOrUpdate").mockImplementationOnce(async (
      group,
      name,
      parameters,
    ) => {
      const created = await createPublicIp(group, name, parameters);
      const invalid = { ...created, sku: { name: "Basic" as const } };
      fake.publicIpAddresses.set(publicIpId, invalid);
      return invalid;
    });

    await expect(provider.create(managedCreateInput(), (event) => {
      if (event.phase === "public-ip-address" && event.resources.publicIpAddressId) {
        journaledPublicIps.push(event.resources.publicIpAddressId);
      }
    })).rejects.toThrow("required Standard static configuration");

    expect(journaledPublicIps).toEqual([publicIpId]);
    expect(fake.mutations).toEqual(expect.arrayContaining(["pip.create", "pip.delete"]));
    expect(fake.publicIpAddresses.has(publicIpId)).toBe(false);
    expect(fake.resourceGroups.size).toBe(0);
  });

  it("journals a validation-failing candidate but refuses rollback deletion when ownership tags do not match", async () => {
    const fake = new FakeAzureClients();
    const provider = providerFor(fake);
    const journaledPublicIps: string[] = [];
    const createPublicIp = fake.clients.publicIpAddresses.createOrUpdate;
    vi.spyOn(fake.clients.publicIpAddresses, "createOrUpdate").mockImplementationOnce(async (
      group,
      name,
      parameters,
    ) => {
      const created = await createPublicIp(group, name, parameters);
      const unowned = {
        ...created,
        tags: { ...created.tags, [AZURE_GUID_TAG_KEY]: "another-deployment" },
      };
      fake.publicIpAddresses.set(publicIpId, unowned);
      return unowned;
    });

    await expect(provider.create(managedCreateInput(), (event) => {
      if (event.phase === "public-ip-address" && event.resources.publicIpAddressId) {
        journaledPublicIps.push(event.resources.publicIpAddressId);
      }
    })).rejects.toThrow("ownership tags do not match");

    expect(journaledPublicIps).toEqual([publicIpId]);
    expect(fake.publicIpAddresses.has(publicIpId)).toBe(true);
    expect(fake.mutations).not.toContain("pip.delete");
  });

  it("cascades the untagged OS disk when disk tagging fails after VM creation", async () => {
    const fake = new FakeAzureClients();
    const provider = providerFor(fake);
    const journaledOsDisks: string[] = [];
    vi.spyOn(fake.clients.disks, "update").mockRejectedValueOnce(
      Object.assign(new Error("tagging failed"), { statusCode: 503, code: "ServiceUnavailable" }),
    );

    await expect(provider.create(managedCreateInput(), (event) => {
      if (event.phase === "virtual-machine" && event.resources.osDiskId) {
        journaledOsDisks.push(event.resources.osDiskId);
      }
    })).rejects.toThrow("tag the managed OS disk");

    expect(journaledOsDisks).toEqual([diskId]);
    expect(fake.mutations).toEqual(expect.arrayContaining([
      "vm.create",
      "vm.delete",
      "disk.cascade-delete",
    ]));
    expect(fake.virtualMachines.has(vmId)).toBe(false);
    expect(fake.disks.has(diskId)).toBe(false);
    expect(fake.resourceGroups.size).toBe(0);
  });

  it("refuses VM deletion when its attached OS disk does not match the tracked disk", async () => {
    const fake = new FakeAzureClients();
    const provider = providerFor(fake);
    const resource = await provider.create(managedCreateInput());
    const virtualMachine = fake.virtualMachines.get(vmId)!;
    fake.virtualMachines.set(vmId, {
      ...virtualMachine,
      storageProfile: {
        ...virtualMachine.storageProfile,
        osDisk: {
          ...virtualMachine.storageProfile?.osDisk,
          createOption: "FromImage",
          managedDisk: {
            ...virtualMachine.storageProfile?.osDisk?.managedDisk,
            id: computeId(resourceGroupName, "disks", "unexpected-os-disk"),
          },
        },
      },
    });
    const mutationStart = fake.mutations.length;

    await expect(provider.destroy(resource)).rejects.toThrow("unexpected OS disk ID");

    expect(fake.mutations.slice(mutationStart)).not.toContain("vm.delete");
    expect(fake.virtualMachines.has(vmId)).toBe(true);
    expect(fake.disks.has(diskId)).toBe(true);
  });

  it("keeps standalone tagged disk deletion idempotent after the VM is already absent", async () => {
    const fake = new FakeAzureClients();
    const provider = providerFor(fake);
    const resource = await provider.create(managedCreateInput());
    fake.virtualMachines.delete(vmId);
    const mutationStart = fake.mutations.length;
    const partial: AzureVmDestroyResource = {
      subscriptionId,
      tenantId,
      location,
      guid,
      name: "Azure test",
      osDiskId: resource.osDiskId,
    };

    await provider.destroy(partial);
    await provider.destroy(partial);

    expect(fake.mutations.slice(mutationStart)).toEqual(["disk.delete"]);
    expect(fake.disks.has(diskId)).toBe(false);
  });

  it("starts, deallocates, and restarts only after re-reading ownership tags", async () => {
    const fake = new FakeAzureClients();
    const provider = providerFor(fake);
    const resource = await provider.create(managedCreateInput());

    await provider.stop(resource);
    await provider.start(resource);
    await provider.reboot(resource);

    expect(fake.mutations.filter((entry) => ["vm.deallocate", "vm.start", "vm.restart"].includes(entry)))
      .toEqual(["vm.deallocate", "vm.start", "vm.restart"]);
    expect(fake.reads.filter((entry) => entry === "vm.get").length).toBeGreaterThanOrEqual(6);
  });

  it("keeps the working baseline intact when a replacement upsert fails", async () => {
    const fake = new FakeAzureClients();
    const provider = providerFor(fake);
    const resource = await provider.create(managedCreateInput());
    const baselineBefore = [...fake.securityRules.entries()];
    const mutationStart = fake.mutations.length;
    vi.spyOn(fake.clients.securityRules, "createOrUpdate").mockRejectedValueOnce(
      Object.assign(new Error("transient write failure"), { statusCode: 503, code: "ServiceUnavailable" }),
    );

    await expect(provider.replaceFirewall(resource, {
      sshPort: 22,
      sshSourceCidrs: ["203.0.113.9/32"],
      operatorPort: 31_338,
      operatorSourceCidrs: ["203.0.113.9/32"],
    })).rejects.toThrow("create a baseline Azure firewall rule");

    expect([...fake.securityRules.entries()]).toEqual(baselineBefore);
    expect(fake.mutations.slice(mutationStart)).not.toContain("rule.delete");
  });

  it("lists realistic Azure default rules through priority 65500 while user writes remain capped", async () => {
    const fake = new FakeAzureClients();
    const provider = providerFor(fake);
    const resource = await provider.create(managedCreateInput());
    const networkSecurityGroup = fake.networkSecurityGroups.get(nsgId)!;
    fake.networkSecurityGroups.set(nsgId, {
      ...networkSecurityGroup,
      defaultSecurityRules: [{
        id: `${nsgId}/defaultSecurityRules/DenyAllInBound`,
        name: "DenyAllInBound",
        description: "Deny all inbound traffic",
        protocol: "*",
        sourcePortRange: "*",
        destinationPortRange: "*",
        sourceAddressPrefix: "*",
        destinationAddressPrefix: "*",
        access: "Deny",
        priority: 65_500,
        direction: "Inbound",
      }],
    });

    const snapshot = await provider.listFirewallRules(resource);

    expect(snapshot.rules).toContainEqual({
      id: `${nsgId}/defaultSecurityRules/DenyAllInBound`,
      name: "DenyAllInBound",
      description: "Deny all inbound traffic",
      protocol: "*",
      sourcePortRanges: ["*"],
      destinationPortRanges: ["*"],
      sourceAddressPrefixes: ["*"],
      destinationAddressPrefixes: ["*"],
      access: "deny",
      priority: 65_500,
      direction: "ingress",
      managed: false,
      isDefault: true,
      sourceApplicationSecurityGroupIds: [],
      destinationApplicationSecurityGroupIds: [],
      editUnsupportedReason: null,
    });
    await expect(provider.createFirewallRule(resource, {
      ...customFirewallRule(),
      name: "custom-too-high",
      priority: 65_500,
    })).rejects.toThrow("Azure firewall priority");
  });

  it("lists, creates, updates, and deletes full Azure NSG rule specs", async () => {
    const fake = new FakeAzureClients();
    const provider = providerFor(fake);
    const resource = await provider.create(managedCreateInput());
    const initialSpec = customFirewallRule();

    const created = await provider.createFirewallRule(resource, initialSpec);
    const snapshot = await provider.listFirewallRules(resource);
    const storedAfterCreate = fake.securityRules.get(`${nsgId}/securityRules/${initialSpec.name}`);
    const updated = await provider.updateFirewallRule(resource, initialSpec.name, {
      ...initialSpec,
      priority: 350,
      access: "deny",
      direction: "egress",
      protocol: "udp",
      sourceAddressPrefixes: ["VirtualNetwork"],
      sourcePortRanges: ["1024-65535"],
      destinationAddressPrefixes: ["Internet"],
      destinationPortRanges: ["53"],
      description: "Deny external DNS",
    });
    await provider.deleteFirewallRule(resource, initialSpec.name);

    expect(created).toEqual({
      ...initialSpec,
      id: `${nsgId}/securityRules/${initialSpec.name}`,
      managed: true,
      isDefault: false,
      sourceApplicationSecurityGroupIds: [],
      destinationApplicationSecurityGroupIds: [],
      editUnsupportedReason: null,
    });
    expect(snapshot).toMatchObject({
      provider: "azure",
      networkSecurityGroupId: nsgId,
      networkSecurityGroupName: nsgName,
      resourceGroupName,
    });
    expect(snapshot.rules).toContainEqual(created);
    expect(storedAfterCreate).toMatchObject({
      sourceAddressPrefixes: initialSpec.sourceAddressPrefixes,
      destinationPortRanges: initialSpec.destinationPortRanges,
    });
    expect(storedAfterCreate?.sourceAddressPrefix).toBeUndefined();
    expect(storedAfterCreate?.destinationPortRange).toBeUndefined();
    expect(updated).toMatchObject({
      name: initialSpec.name,
      priority: 350,
      access: "deny",
      direction: "egress",
      protocol: "udp",
      sourceAddressPrefixes: ["VirtualNetwork"],
      sourcePortRanges: ["1024-65535"],
      destinationAddressPrefixes: ["Internet"],
      destinationPortRanges: ["53"],
      description: "Deny external DNS",
    });
    expect(fake.securityRules.has(`${nsgId}/securityRules/${initialSpec.name}`)).toBe(false);
  });

  it("preserves ASG-backed rules for viewing, blocks unsafe edits, and permits identity-checked deletion", async () => {
    const fake = new FakeAzureClients();
    const provider = providerFor(fake);
    const resource = await provider.create(managedCreateInput());
    const ruleName = "external-asg-rule";
    const ruleId = `${nsgId}/securityRules/${ruleName}`;
    const sourceAsgId = networkId(resourceGroupName, "applicationSecurityGroups", "operator-clients");
    const destinationAsgId = networkId(resourceGroupName, "applicationSecurityGroups", "sliver-servers");
    fake.securityRules.set(ruleId, {
      id: ruleId,
      name: ruleName,
      priority: 300,
      direction: "Inbound",
      access: "Allow",
      protocol: "Tcp",
      sourcePortRanges: ["1024-65535", "443"],
      destinationPortRanges: ["22", "31337"],
      sourceApplicationSecurityGroups: [{ id: sourceAsgId }],
      destinationApplicationSecurityGroups: [{ id: destinationAsgId }],
      description: "External ASG policy",
    });

    const snapshot = await provider.listFirewallRules(resource);
    const listed = snapshot.rules.find((rule) => rule.name === ruleName);

    expect(listed).toEqual({
      id: ruleId,
      name: ruleName,
      priority: 300,
      direction: "ingress",
      access: "allow",
      protocol: "tcp",
      sourceAddressPrefixes: [],
      sourcePortRanges: ["1024-65535", "443"],
      destinationAddressPrefixes: [],
      destinationPortRanges: ["22", "31337"],
      description: "External ASG policy",
      managed: true,
      isDefault: false,
      sourceApplicationSecurityGroupIds: [sourceAsgId],
      destinationApplicationSecurityGroupIds: [destinationAsgId],
      editUnsupportedReason: "Rules that reference Azure application security groups can be viewed and deleted here, but cannot be edited.",
    });
    await expect(provider.updateFirewallRule(resource, ruleName, { ...customFirewallRule(), name: ruleName }))
      .rejects.toThrow("application security groups");
    await expect(provider.deleteFirewallRule(resource, ruleName)).resolves.toBeUndefined();
    expect(fake.securityRules.has(ruleId)).toBe(false);
  });

  it("refuses lifecycle, firewall, and destroy mutations when ownership tags do not match", async () => {
    const fake = new FakeAzureClients();
    const provider = providerFor(fake);
    const resource = await provider.create(managedCreateInput());
    const virtualMachine = fake.virtualMachines.get(vmId)!;
    fake.virtualMachines.set(vmId, { ...virtualMachine, tags: { ...virtualMachine.tags, SliverGUID: "other" } });

    await expect(provider.reboot(resource)).rejects.toThrow("ownership tags do not match");
    expect(fake.mutations).not.toContain("vm.restart");

    fake.virtualMachines.set(vmId, virtualMachine);
    const networkSecurityGroup = fake.networkSecurityGroups.get(nsgId)!;
    fake.networkSecurityGroups.set(nsgId, {
      ...networkSecurityGroup,
      tags: { ...networkSecurityGroup.tags, SliverGUIManaged: "false" },
    });
    await expect(provider.createFirewallRule(resource, customFirewallRule()))
      .rejects.toThrow("ownership tags do not match");
    expect(fake.securityRules.has(`${nsgId}/securityRules/custom-dns`)).toBe(false);

    fake.networkSecurityGroups.set(nsgId, networkSecurityGroup);
    fake.networkInterfaces.set(nicId, {
      ...fake.networkInterfaces.get(nicId)!,
      tags: { SliverGUIManaged: "false", SliverGUID: guid },
    });
    await expect(provider.destroy(resource)).rejects.toThrow("ownership tags do not match");
    expect(fake.mutations).not.toContain("nic.delete");
  });

  it("preserves an existing VNet and subnet while deleting only tagged managed resources in reverse order", async () => {
    const fake = new FakeAzureClients();
    const externalResourceGroup = "operator-network";
    const externalVnetId = networkId(externalResourceGroup, "virtualNetworks", "existing-vnet");
    const externalSubnetId = `${externalVnetId}/subnets/existing-subnet`;
    fake.virtualNetworks.set(externalVnetId, {
      id: externalVnetId,
      name: "existing-vnet",
      location,
      addressSpace: { addressPrefixes: ["10.99.0.0/16"] },
    });
    fake.subnets.set(externalSubnetId, {
      id: externalSubnetId,
      name: "existing-subnet",
      addressPrefix: "10.99.1.0/24",
    });
    const provider = providerFor(fake);
    const resource = await provider.create({
      ...managedCreateInput(),
      network: {
        mode: "existing",
        virtualNetworkId: externalVnetId,
        subnetId: externalSubnetId,
      },
    });
    const mutationStart = fake.mutations.length;

    await provider.destroy(resource);
    await provider.destroy(resource);

    expect(fake.virtualNetworks.get(externalVnetId)).toBeDefined();
    expect(fake.subnets.get(externalSubnetId)).toBeDefined();
    expect(fake.resourceGroups.has(resourceGroupName)).toBe(false);
    expect(fake.mutations.slice(mutationStart)).toEqual([
      "vm.delete",
      "disk.cascade-delete",
      "nic.delete",
      "pip.delete",
      "nsg.delete",
      "rg.delete",
    ]);
  });

  it("cleans an interrupted managed-network journal idempotently without touching untracked resources", async () => {
    const fake = new FakeAzureClients();
    const provider = providerFor(fake);
    const resource = await provider.create({ ...managedCreateInput(), allocatePublicIp: false });
    if (!resource.managedNetwork) throw new Error("Expected a managed network");
    const partial: AzureVmDestroyResource = {
      subscriptionId,
      tenantId,
      location,
      guid,
      name: "Azure test",
      resourceGroupId: resource.resourceGroupId,
      managedNetwork: resource.managedNetwork,
      networkSecurityGroupId: resource.networkSecurityGroupId,
      networkInterfaceId: resource.networkInterfaceId,
      virtualMachineId: resource.virtualMachineId,
      osDiskId: resource.osDiskId,
    } as const;
    const mutationStart = fake.mutations.length;

    await provider.destroy(partial);
    await provider.destroy(partial);

    expect(fake.mutations.slice(mutationStart)).toEqual([
      "vm.delete",
      "disk.cascade-delete",
      "nic.delete",
      "nsg.delete",
      "subnet.delete",
      "vnet.delete",
      "rg.delete",
    ]);
    expect(fake.resourceGroups.size).toBe(0);
  });

  it("probes only safe subscription reads and leaves mutation and resource-specific actions unverifiable", async () => {
    const fake = new FakeAzureClients();
    fake.listFailures.set("networkInterfaces", forbidden());
    const provider = providerFor(fake);
    const mutationStart = fake.mutations.length;

    const result = await provider.checkPermissions();

    expect(credential.getToken).toHaveBeenCalledWith("https://management.azure.com/.default");
    expect(result.verified).toEqual(expect.arrayContaining([
      "Microsoft.Resources/subscriptions/resourceGroups/read",
      "Microsoft.Compute/skus/read",
      "Microsoft.Compute/virtualMachines/read",
      "Microsoft.Compute/disks/read",
      "Microsoft.Network/virtualNetworks/read",
      "Microsoft.Network/networkSecurityGroups/read",
      "Microsoft.Network/publicIPAddresses/read",
    ]));
    expect(result.missing).toEqual(["Microsoft.Network/networkInterfaces/read"]);
    expect(result.unverifiable).toEqual(expect.arrayContaining([
      "Microsoft.Resources/subscriptions/resourceGroups/write",
      "Microsoft.Resources/subscriptions/resourcegroups/resources/read",
      "Microsoft.Compute/virtualMachines/delete",
      "Microsoft.Compute/images/read",
      "Microsoft.Compute/virtualMachines/instanceView/read",
      "Microsoft.Compute/virtualMachines/start/action",
      "Microsoft.Network/virtualNetworks/subnets/read",
      "Microsoft.Network/networkSecurityGroups/join/action",
      "Microsoft.Network/networkSecurityGroups/securityRules/read",
      "Microsoft.Network/networkInterfaces/join/action",
      "Microsoft.Network/networkInterfaces/write",
      "Microsoft.Network/publicIPAddresses/join/action",
    ]));
    expect(fake.mutations).toHaveLength(mutationStart);
  });

  it("surfaces credential and non-authorization probe failures without misreporting permissions", async () => {
    const fake = new FakeAzureClients();
    const failingCredential: TokenCredential = {
      getToken: vi.fn(async () => {
        throw Object.assign(new Error("private detail"), { statusCode: 401, code: "AuthenticationFailed" });
      }),
    };
    const provider = new AzureVmProvider(
      { subscriptionId, tenantId, location, credential: failingCredential },
      { clientFactory: () => fake.clients },
    );

    await expect(provider.checkPermissions()).rejects.toThrow(
      "Azure could not acquire an Azure Resource Manager token (AuthenticationFailed, HTTP 401).",
    );

    fake.listFailures.set("resourceGroups", Object.assign(
      new Error("private detail"),
      { statusCode: 500, code: "InternalServerError" },
    ));
    await expect(providerFor(fake).checkPermissions()).rejects.toThrow(
      "Azure could not probe Azure resource-group read access (InternalServerError, HTTP 500).",
    );
  });
});

function providerFor(fake: FakeAzureClients): AzureVmProvider {
  return new AzureVmProvider(
    { subscriptionId, tenantId, location, credential },
    { clientFactory: () => fake.clients },
  );
}

function managedCreateInput(): AzureVmCreateInput {
  return {
    guid,
    name: "Azure test",
    imageReference: AZURE_UBUNTU_IMAGE_OPTIONS[0]!.id,
    vmSize: "Standard_D2s_v5",
    network: {
      mode: "managed",
      virtualNetworkCidr: "10.0.0.0/16",
      subnetCidr: "10.0.1.0/24",
    },
    sshUsername: "azureuser",
    sshPublicKey,
    customData: "#!/bin/sh\necho ready\n",
    osDiskSizeGiB: 64,
    firewall: {
      sshPort: 22,
      sshSourceCidrs: ["198.51.100.4/32"],
      operatorPort: 31_337,
      operatorSourceCidrs: ["198.51.100.4/32"],
    },
    allocatePublicIp: true,
  };
}

function customFirewallRule(): AzureFirewallRuleSpec {
  return {
    name: "custom-dns",
    priority: 300,
    direction: "ingress",
    access: "allow",
    protocol: "tcp",
    sourceAddressPrefixes: ["198.51.100.0/24", "203.0.113.0/24"],
    sourcePortRanges: ["*"],
    destinationAddressPrefixes: ["*"],
    destinationPortRanges: ["443", "8443"],
    description: "Operator HTTPS",
  };
}

function managedTags(): Record<string, string> {
  return {
    [AZURE_MANAGED_TAG_KEY]: AZURE_MANAGED_TAG_VALUE,
    [AZURE_GUID_TAG_KEY]: guid,
    [AZURE_NAME_TAG_KEY]: "Azure test",
  };
}

function x64Sku(): ResourceSku {
  return {
    resourceType: "virtualMachines",
    name: "Standard_D2s_v5",
    locations: [location],
    capabilities: [
      { name: "CpuArchitectureType", value: "x64" },
      { name: "vCPUs", value: "2" },
      { name: "MemoryGB", value: "8" },
      { name: "MaxDataDiskCount", value: "4" },
      { name: "OSVhdSizeMB", value: "1048576" },
      { name: "PremiumIO", value: "True" },
    ],
    restrictions: [],
  };
}

function armSku(): ResourceSku {
  const base = x64Sku();
  return {
    ...base,
    name: "Standard_D2ps_v5",
    ...(base.capabilities ? {
      capabilities: base.capabilities.map((capability) => (
        capability.name === "CpuArchitectureType" ? { ...capability, value: "Arm64" } : capability
      )),
    } : {}),
  };
}

class FakeAzureClients {
  readonly resourceGroups = new Map<string, ResourceGroup>();
  readonly virtualNetworks = new Map<string, VirtualNetwork>();
  readonly subnets = new Map<string, Subnet>();
  readonly networkSecurityGroups = new Map<string, NetworkSecurityGroup>();
  readonly securityRules = new Map<string, SecurityRule>();
  readonly publicIpAddresses = new Map<string, PublicIPAddress>();
  readonly networkInterfaces = new Map<string, NetworkInterface>();
  readonly virtualMachines = new Map<string, VirtualMachine>();
  readonly disks = new Map<string, Disk>();
  readonly resourceSkus: ResourceSku[] = [x64Sku()];
  readonly reads: string[] = [];
  readonly mutations: string[] = [];
  readonly listFailures = new Map<string, unknown>();

  readonly clients: AzureVmClientSet = {
    resourceGroups: {
      list: () => this.listValues("resourceGroups", this.resourceGroups.values()),
      get: async (name) => {
        this.reads.push("rg.get");
        return getOrNotFound(this.resourceGroups, name);
      },
      createOrUpdate: async (name, parameters) => {
        const value = { ...parameters, id: resourceGroup(name), name };
        this.resourceGroups.set(name, value);
        this.mutations.push("rg.create");
        return value;
      },
      delete: async (name) => {
        ensureDeleted(this.resourceGroups, name);
        this.mutations.push("rg.delete");
      },
    },
    genericResources: {
      listByResourceGroup: (name) => this.genericResourcesFor(name),
    },
    resourceSkus: {
      list: () => this.listValues("resourceSkus", this.resourceSkus),
    },
    virtualNetworks: {
      listAll: () => this.listValues("virtualNetworks", this.virtualNetworks.values()),
      get: async (group, name) => {
        this.reads.push("vnet.get");
        return getOrNotFound(this.virtualNetworks, networkId(group, "virtualNetworks", name));
      },
      createOrUpdate: async (group, name, parameters) => {
        const id = networkId(group, "virtualNetworks", name);
        const value = { ...parameters, id, name };
        this.virtualNetworks.set(id, value);
        this.mutations.push("vnet.create");
        return value;
      },
      delete: async (group, name) => {
        ensureDeleted(this.virtualNetworks, networkId(group, "virtualNetworks", name));
        this.mutations.push("vnet.delete");
      },
    },
    subnets: {
      list: (group, virtualNetworkName) => asyncValues(
        [...this.subnets.values()].filter((subnet) => subnet.id?.toLowerCase().startsWith(
          `${networkId(group, "virtualNetworks", virtualNetworkName)}/subnets/`.toLowerCase(),
        )),
      ),
      get: async (group, virtualNetworkName, name) => {
        this.reads.push("subnet.get");
        return getOrNotFound(
          this.subnets,
          `${networkId(group, "virtualNetworks", virtualNetworkName)}/subnets/${name}`,
        );
      },
      createOrUpdate: async (group, virtualNetworkName, name, parameters) => {
        const id = `${networkId(group, "virtualNetworks", virtualNetworkName)}/subnets/${name}`;
        const value = { ...parameters, id, name };
        this.subnets.set(id, value);
        this.mutations.push("subnet.create");
        return value;
      },
      delete: async (group, virtualNetworkName, name) => {
        ensureDeleted(
          this.subnets,
          `${networkId(group, "virtualNetworks", virtualNetworkName)}/subnets/${name}`,
        );
        this.mutations.push("subnet.delete");
      },
    },
    networkSecurityGroups: {
      listAll: () => this.listValues("networkSecurityGroups", this.networkSecurityGroups.values()),
      get: async (group, name) => {
        this.reads.push("nsg.get");
        return getOrNotFound(this.networkSecurityGroups, networkId(group, "networkSecurityGroups", name));
      },
      createOrUpdate: async (group, name, parameters) => {
        const id = networkId(group, "networkSecurityGroups", name);
        const value = { ...parameters, id, name, defaultSecurityRules: [] };
        this.networkSecurityGroups.set(id, value);
        this.mutations.push("nsg.create");
        return value;
      },
      delete: async (group, name) => {
        const id = networkId(group, "networkSecurityGroups", name);
        ensureDeleted(this.networkSecurityGroups, id);
        for (const key of this.securityRules.keys()) {
          if (key.toLowerCase().startsWith(`${id}/securityrules/`.toLowerCase())) {
            this.securityRules.delete(key);
          }
        }
        this.mutations.push("nsg.delete");
      },
    },
    securityRules: {
      list: (group, networkSecurityGroupName) => {
        const prefix = `${networkId(group, "networkSecurityGroups", networkSecurityGroupName)}/securityRules/`;
        return asyncValues([...this.securityRules.values()].filter((rule) => (
          rule.id?.toLowerCase().startsWith(prefix.toLowerCase())
        )));
      },
      get: async (group, networkSecurityGroupName, name) => {
        this.reads.push("rule.get");
        return getOrNotFound(
          this.securityRules,
          `${networkId(group, "networkSecurityGroups", networkSecurityGroupName)}/securityRules/${name}`,
        );
      },
      createOrUpdate: async (group, networkSecurityGroupName, name, parameters) => {
        const id = `${networkId(group, "networkSecurityGroups", networkSecurityGroupName)}/securityRules/${name}`;
        const value = { ...parameters, id, name };
        this.securityRules.set(id, value);
        this.mutations.push("rule.write");
        return value;
      },
      delete: async (group, networkSecurityGroupName, name) => {
        ensureDeleted(
          this.securityRules,
          `${networkId(group, "networkSecurityGroups", networkSecurityGroupName)}/securityRules/${name}`,
        );
        this.mutations.push("rule.delete");
      },
    },
    publicIpAddresses: {
      listAll: () => this.listValues("publicIpAddresses", this.publicIpAddresses.values()),
      get: async (group, name) => {
        this.reads.push("pip.get");
        return getOrNotFound(this.publicIpAddresses, networkId(group, "publicIPAddresses", name));
      },
      createOrUpdate: async (group, name, parameters) => {
        const id = networkId(group, "publicIPAddresses", name);
        const value = { ...parameters, id, name, ipAddress: "203.0.113.42" };
        this.publicIpAddresses.set(id, value);
        this.mutations.push("pip.create");
        return value;
      },
      delete: async (group, name) => {
        ensureDeleted(this.publicIpAddresses, networkId(group, "publicIPAddresses", name));
        this.mutations.push("pip.delete");
      },
    },
    networkInterfaces: {
      listAll: () => this.listValues("networkInterfaces", this.networkInterfaces.values()),
      get: async (group, name) => {
        this.reads.push("nic.get");
        return getOrNotFound(this.networkInterfaces, networkId(group, "networkInterfaces", name));
      },
      createOrUpdate: async (group, name, parameters) => {
        const id = networkId(group, "networkInterfaces", name);
        const value: NetworkInterface = {
          ...parameters,
          id,
          name,
          ...(parameters.ipConfigurations ? {
            ipConfigurations: parameters.ipConfigurations.map((configuration) => ({
              ...configuration,
              privateIPAddress: "10.0.1.4",
            })),
          } : {}),
        };
        this.networkInterfaces.set(id, value);
        this.mutations.push("nic.create");
        return value;
      },
      delete: async (group, name) => {
        ensureDeleted(this.networkInterfaces, networkId(group, "networkInterfaces", name));
        this.mutations.push("nic.delete");
      },
    },
    virtualMachines: {
      listAll: () => this.listValues("virtualMachines", this.virtualMachines.values()),
      get: async (group, name) => {
        this.reads.push("vm.get");
        return getOrNotFound(this.virtualMachines, computeId(group, "virtualMachines", name));
      },
      createOrUpdate: async (group, name, parameters) => {
        const id = computeId(group, "virtualMachines", name);
        const actualDiskName = parameters.storageProfile?.osDisk?.name ?? diskName;
        const actualDiskId = computeId(group, "disks", actualDiskName);
        this.disks.set(actualDiskId, {
          id: actualDiskId,
          name: actualDiskName,
          location: parameters.location,
          creationData: { createOption: "FromImage" },
        });
        const value: VirtualMachine = {
          ...parameters,
          id,
          name,
          provisioningState: "Succeeded",
          storageProfile: {
            ...parameters.storageProfile,
            osDisk: {
              ...parameters.storageProfile?.osDisk,
              createOption: "FromImage",
              managedDisk: {
                ...parameters.storageProfile?.osDisk?.managedDisk,
                id: actualDiskId,
              },
            },
          },
          instanceView: { statuses: [{ code: "PowerState/running" }] },
        };
        this.virtualMachines.set(id, value);
        this.mutations.push("vm.create");
        return value;
      },
      start: async (group, name) => {
        this.setVmState(group, name, "PowerState/running");
        this.mutations.push("vm.start");
      },
      deallocate: async (group, name) => {
        this.setVmState(group, name, "PowerState/deallocated");
        this.mutations.push("vm.deallocate");
      },
      restart: async (group, name) => {
        this.setVmState(group, name, "PowerState/running");
        this.mutations.push("vm.restart");
      },
      delete: async (group, name) => {
        const id = computeId(group, "virtualMachines", name);
        const virtualMachine = getOrNotFound(this.virtualMachines, id);
        ensureDeleted(this.virtualMachines, id);
        this.mutations.push("vm.delete");
        if (virtualMachine.storageProfile?.osDisk?.deleteOption === "Delete") {
          const attachedDiskId = virtualMachine.storageProfile.osDisk.managedDisk?.id;
          if (attachedDiskId && this.disks.delete(attachedDiskId)) {
            this.mutations.push("disk.cascade-delete");
          }
        }
      },
    },
    disks: {
      list: () => this.listValues("disks", this.disks.values()),
      get: async (group, name) => {
        this.reads.push("disk.get");
        return getOrNotFound(this.disks, computeId(group, "disks", name));
      },
      update: async (group, name, parameters: DiskUpdate) => {
        const id = computeId(group, "disks", name);
        const value = { ...getOrNotFound(this.disks, id), ...parameters };
        this.disks.set(id, value);
        this.mutations.push("disk.update");
        return value;
      },
      delete: async (group, name) => {
        ensureDeleted(this.disks, computeId(group, "disks", name));
        this.mutations.push("disk.delete");
      },
    },
  };

  private async *genericResourcesFor(name: string): AsyncIterable<GenericResourceExpanded> {
    const prefix = `${resourceGroup(name)}/providers/`.toLowerCase();
    const values = [
      ...this.virtualNetworks.values(),
      ...this.networkSecurityGroups.values(),
      ...this.publicIpAddresses.values(),
      ...this.networkInterfaces.values(),
      ...this.virtualMachines.values(),
      ...this.disks.values(),
    ];
    for (const value of values) {
      if (value.id?.toLowerCase().startsWith(prefix)) yield { id: value.id };
    }
  }

  private async *listValues<T>(name: string, values: Iterable<T>): AsyncIterable<T> {
    const failure = this.listFailures.get(name);
    if (failure !== undefined) throw failure;
    yield* values;
  }

  private setVmState(group: string, name: string, state: string): void {
    const id = computeId(group, "virtualMachines", name);
    const current = getOrNotFound(this.virtualMachines, id);
    this.virtualMachines.set(id, { ...current, instanceView: { statuses: [{ code: state }] } });
  }
}

async function* asyncValues<T>(values: Iterable<T>): AsyncIterable<T> {
  yield* values;
}

function getOrNotFound<Key, Value>(map: ReadonlyMap<Key, Value>, key: Key): Value {
  const value = map.get(key);
  if (value === undefined) throw notFound();
  return value;
}

function ensureDeleted<Key, Value>(map: Map<Key, Value>, key: Key): void {
  if (!map.delete(key)) throw notFound();
}

function notFound(): Error & { statusCode: number; code: string } {
  return Object.assign(new Error("not found"), { statusCode: 404, code: "ResourceNotFound" });
}

function forbidden(): Error & { statusCode: number; code: string } {
  return Object.assign(new Error("forbidden"), { statusCode: 403, code: "AuthorizationFailed" });
}

function resourceGroup(name: string): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/${name}`;
}

function networkId(group: string, type: string, name: string): string {
  return `${resourceGroup(group)}/providers/Microsoft.Network/${type}/${name}`;
}

function computeId(group: string, type: string, name: string): string {
  return `${resourceGroup(group)}/providers/Microsoft.Compute/${type}/${name}`;
}
