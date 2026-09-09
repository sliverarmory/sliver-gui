import { isIP } from "node:net";

import {
  ComputeManagementClient,
  type Disk,
  type DiskUpdate,
  type ResourceSku,
  type VirtualMachine,
} from "@azure/arm-compute";
import {
  NetworkManagementClient,
  type NetworkInterface,
  type NetworkSecurityGroup,
  type PublicIPAddress,
  type SecurityRule,
  type Subnet,
  type VirtualNetwork,
} from "@azure/arm-network";
import {
  ResourceManagementClient,
  type GenericResourceExpanded,
  type ResourceGroup,
} from "@azure/arm-resources";
import type { TokenCredential } from "@azure/identity";

import {
  AZURE_FIREWALL_RULE_MAX_VALUES,
  AZURE_SSH_PORT,
  isAzureSshUsername,
} from "../../shared/cloud-deployment-contracts.js";
import {
  createCloudPermissionEvaluation,
  type CloudPermissionEvaluation,
} from "../../shared/cloud-provider-permissions.js";

export const AZURE_MANAGED_TAG_KEY = "SliverGUIManaged";
export const AZURE_GUID_TAG_KEY = "SliverGUID";
export const AZURE_NAME_TAG_KEY = "Name";
export const AZURE_MANAGED_TAG_VALUE = "true";

const MAX_DISCOVERY_ITEMS = 10_000;
const MAX_FIREWALL_PREFIXES = 60;
const MAX_CUSTOM_DATA_BYTES = 64 * 1024;
const MAX_SSH_PUBLIC_KEY_BYTES = 16 * 1024;
const MAX_ARM_ID_LENGTH = 2_048;
const AZURE_MANAGEMENT_ORIGIN = "https://management.azure.com";
const BASELINE_PRIORITY_START = 1_000;
const BASELINE_PRIORITY_END = 1_199;
const AZURE_IDENTIFIER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DEPLOYMENT_GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LOCATION_PATTERN = /^[a-z0-9]{1,64}$/u;
const RESOURCE_GROUP_PATTERN = /^(?!.*\.$)[\p{L}\p{N}_.()\-]{1,90}$/u;
const RESOURCE_NAME_PATTERN = /^[\p{L}\p{N}_.\-]{1,80}$/u;
const VM_SIZE_PATTERN = /^[A-Za-z0-9_.\-]{1,128}$/u;
const IMAGE_URN_PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,127}$/u;
const SECURITY_RULE_NAME_PATTERN = /^[A-Za-z0-9_.\-]{1,80}$/u;
const SERVICE_TAG_PATTERN = /^[A-Za-z][A-Za-z0-9_.\-]{0,79}$/u;

export type AzureVmArchitecture = "x64" | "arm64";

export interface AzureVmImageOption {
  readonly id: string;
  readonly label: string;
  readonly architecture: AzureVmArchitecture;
  readonly publisher: string;
  readonly offer: string;
  readonly sku: string;
  readonly version: "latest";
  readonly sshUsername: "azureuser";
}

export const AZURE_UBUNTU_IMAGE_OPTIONS: readonly AzureVmImageOption[] = Object.freeze([
  {
    id: "Canonical:ubuntu-24_04-lts:server:latest",
    label: "Ubuntu Server 24.04 LTS (x64)",
    architecture: "x64",
    publisher: "Canonical",
    offer: "ubuntu-24_04-lts",
    sku: "server",
    version: "latest",
    sshUsername: "azureuser",
  },
  {
    id: "Canonical:ubuntu-24_04-lts:server-arm64:latest",
    label: "Ubuntu Server 24.04 LTS (Arm64)",
    architecture: "arm64",
    publisher: "Canonical",
    offer: "ubuntu-24_04-lts",
    sku: "server-arm64",
    version: "latest",
    sshUsername: "azureuser",
  },
]);

export interface AzureVmSizeOption {
  readonly name: string;
  readonly architecture: AzureVmArchitecture;
  readonly vCpuCount: number;
  readonly memoryMiB: number;
  readonly maxDataDiskCount: number;
  readonly osDiskSizeMiB: number;
  readonly premiumIo: boolean;
}

export interface AzureVirtualNetworkOption {
  readonly id: string;
  readonly name: string;
  readonly resourceGroupName: string;
  readonly location: string;
  readonly addressPrefixes: readonly string[];
}

export interface AzureSubnetOption {
  readonly id: string;
  readonly name: string;
  readonly resourceGroupName: string;
  readonly virtualNetworkName: string;
  readonly addressPrefixes: readonly string[];
}

export interface AzureVmDiscoveryResult {
  readonly subscriptionId: string;
  readonly tenantId: string;
  readonly location: string;
  readonly vmSizes: readonly AzureVmSizeOption[];
  readonly virtualNetworks: readonly AzureVirtualNetworkOption[];
  readonly subnets: readonly AzureSubnetOption[];
  readonly images: readonly AzureVmImageOption[];
}

export interface AzureVmProviderConnection {
  readonly subscriptionId: string;
  readonly tenantId: string;
  readonly location: string;
  readonly credential: TokenCredential;
}

export interface AzureVmClientConfiguration extends AzureVmProviderConnection {}

export interface AzureResourceGroupClient {
  list(): AsyncIterable<ResourceGroup>;
  get(resourceGroupName: string): Promise<ResourceGroup>;
  createOrUpdate(resourceGroupName: string, parameters: ResourceGroup): Promise<ResourceGroup>;
  delete(resourceGroupName: string): Promise<void>;
}

export interface AzureGenericResourceClient {
  listByResourceGroup(resourceGroupName: string): AsyncIterable<GenericResourceExpanded>;
}

export interface AzureResourceSkuClient {
  list(): AsyncIterable<ResourceSku>;
}

export interface AzureVmReadOptions {
  readonly abortSignal?: AbortSignal;
}

export interface AzureVirtualNetworkClient {
  listAll(): AsyncIterable<VirtualNetwork>;
  get(resourceGroupName: string, virtualNetworkName: string): Promise<VirtualNetwork>;
  createOrUpdate(
    resourceGroupName: string,
    virtualNetworkName: string,
    parameters: VirtualNetwork,
  ): Promise<VirtualNetwork>;
  delete(resourceGroupName: string, virtualNetworkName: string): Promise<void>;
}

export interface AzureSubnetClient {
  list(resourceGroupName: string, virtualNetworkName: string): AsyncIterable<Subnet>;
  get(resourceGroupName: string, virtualNetworkName: string, subnetName: string): Promise<Subnet>;
  createOrUpdate(
    resourceGroupName: string,
    virtualNetworkName: string,
    subnetName: string,
    parameters: Subnet,
  ): Promise<Subnet>;
  delete(resourceGroupName: string, virtualNetworkName: string, subnetName: string): Promise<void>;
}

export interface AzureNetworkSecurityGroupClient {
  listAll(): AsyncIterable<NetworkSecurityGroup>;
  get(resourceGroupName: string, networkSecurityGroupName: string, options?: AzureVmReadOptions): Promise<NetworkSecurityGroup>;
  createOrUpdate(
    resourceGroupName: string,
    networkSecurityGroupName: string,
    parameters: NetworkSecurityGroup,
  ): Promise<NetworkSecurityGroup>;
  delete(resourceGroupName: string, networkSecurityGroupName: string): Promise<void>;
}

export interface AzureSecurityRuleClient {
  list(resourceGroupName: string, networkSecurityGroupName: string): AsyncIterable<SecurityRule>;
  get(
    resourceGroupName: string,
    networkSecurityGroupName: string,
    securityRuleName: string,
  ): Promise<SecurityRule>;
  createOrUpdate(
    resourceGroupName: string,
    networkSecurityGroupName: string,
    securityRuleName: string,
    parameters: SecurityRule,
  ): Promise<SecurityRule>;
  delete(
    resourceGroupName: string,
    networkSecurityGroupName: string,
    securityRuleName: string,
  ): Promise<void>;
}

export interface AzurePublicIpAddressClient {
  listAll(): AsyncIterable<PublicIPAddress>;
  get(resourceGroupName: string, publicIpAddressName: string, options?: AzureVmReadOptions): Promise<PublicIPAddress>;
  createOrUpdate(
    resourceGroupName: string,
    publicIpAddressName: string,
    parameters: PublicIPAddress,
  ): Promise<PublicIPAddress>;
  delete(resourceGroupName: string, publicIpAddressName: string): Promise<void>;
}

export interface AzureNetworkInterfaceClient {
  listAll(): AsyncIterable<NetworkInterface>;
  get(resourceGroupName: string, networkInterfaceName: string, options?: AzureVmReadOptions): Promise<NetworkInterface>;
  createOrUpdate(
    resourceGroupName: string,
    networkInterfaceName: string,
    parameters: NetworkInterface,
  ): Promise<NetworkInterface>;
  delete(resourceGroupName: string, networkInterfaceName: string): Promise<void>;
}

export interface AzureVirtualMachineClient {
  listAll(): AsyncIterable<VirtualMachine>;
  get(resourceGroupName: string, virtualMachineName: string, options?: AzureVmReadOptions): Promise<VirtualMachine>;
  createOrUpdate(
    resourceGroupName: string,
    virtualMachineName: string,
    parameters: VirtualMachine,
  ): Promise<VirtualMachine>;
  start(resourceGroupName: string, virtualMachineName: string): Promise<void>;
  deallocate(resourceGroupName: string, virtualMachineName: string): Promise<void>;
  restart(resourceGroupName: string, virtualMachineName: string): Promise<void>;
  delete(resourceGroupName: string, virtualMachineName: string): Promise<void>;
}

export interface AzureDiskClient {
  list(): AsyncIterable<Disk>;
  get(resourceGroupName: string, diskName: string, options?: AzureVmReadOptions): Promise<Disk>;
  update(resourceGroupName: string, diskName: string, parameters: DiskUpdate): Promise<Disk>;
  delete(resourceGroupName: string, diskName: string): Promise<void>;
}

export interface AzureVmClientSet {
  readonly resourceGroups: AzureResourceGroupClient;
  readonly genericResources: AzureGenericResourceClient;
  readonly resourceSkus: AzureResourceSkuClient;
  readonly virtualNetworks: AzureVirtualNetworkClient;
  readonly subnets: AzureSubnetClient;
  readonly networkSecurityGroups: AzureNetworkSecurityGroupClient;
  readonly securityRules: AzureSecurityRuleClient;
  readonly publicIpAddresses: AzurePublicIpAddressClient;
  readonly networkInterfaces: AzureNetworkInterfaceClient;
  readonly virtualMachines: AzureVirtualMachineClient;
  readonly disks: AzureDiskClient;
}

export type AzureVmClientFactory = (configuration: AzureVmClientConfiguration) => AzureVmClientSet;

export interface AzureVmProviderDependencies {
  readonly clientFactory?: AzureVmClientFactory;
}

export type AzureVmNetworkInput =
  | {
    readonly mode: "existing";
    readonly virtualNetworkId: string;
    readonly subnetId: string;
  }
  | {
    readonly mode: "managed";
    readonly virtualNetworkCidr: string;
    readonly subnetCidr: string;
  };

export interface AzureVmFirewallInput {
  readonly sshPort: typeof AZURE_SSH_PORT;
  readonly sshSourceCidrs: readonly string[];
  readonly operatorPort: number;
  readonly operatorSourceCidrs: readonly string[];
}

export interface AzureVmCreateInput {
  readonly guid: string;
  readonly name: string;
  readonly resourceGroupName?: string;
  readonly imageReference: string;
  readonly vmSize: string;
  readonly network: AzureVmNetworkInput;
  readonly sshUsername: string;
  readonly sshPublicKey: string;
  readonly customData?: string;
  readonly osDiskSizeGiB?: number;
  readonly firewall: AzureVmFirewallInput;
  readonly allocatePublicIp: boolean;
}

export interface AzureVmManagedNetworkResource {
  readonly virtualNetworkId: string;
  readonly subnetId: string;
}

export interface AzureVmCreateMutationResources {
  readonly resourceGroupId?: string;
  readonly managedNetwork?: AzureVmManagedNetworkResource;
  readonly networkSecurityGroupId?: string;
  readonly publicIpAddressId?: string;
  readonly networkInterfaceId?: string;
  readonly virtualMachineId?: string;
  readonly osDiskId?: string;
}

export type AzureVmCreatePhase =
  | "resource-group"
  | "virtual-network"
  | "subnet"
  | "network-security-group"
  | "firewall"
  | "public-ip-address"
  | "network-interface"
  | "virtual-machine"
  | "os-disk";

export interface AzureVmCreateMutationEvent {
  readonly phase: AzureVmCreatePhase;
  readonly resources: AzureVmCreateMutationResources;
}

export type AzureVmCreateMutationListener = (
  event: AzureVmCreateMutationEvent,
) => void | Promise<void>;

export type AzureVmInstanceState =
  | "creating"
  | "running"
  | "deallocated"
  | "deallocating"
  | "starting"
  | "stopping"
  | "stopped"
  | "failed"
  | "unknown";

export interface AzureVmDeploymentResource {
  readonly subscriptionId: string;
  readonly tenantId: string;
  readonly location: string;
  readonly guid: string;
  readonly name: string;
  readonly resourceGroupId: string;
  readonly virtualNetworkId: string;
  readonly subnetId: string;
  readonly managedNetwork?: AzureVmManagedNetworkResource;
  readonly networkSecurityGroupId: string;
  readonly publicIpAddressId?: string;
  readonly networkInterfaceId: string;
  readonly virtualMachineId: string;
  readonly osDiskId: string;
  readonly instanceState: AzureVmInstanceState;
  readonly provisioningState?: string;
  readonly privateIpAddress?: string;
  readonly publicIpAddress?: string;
}

export interface AzureVmDestroyResource {
  readonly subscriptionId: string;
  readonly tenantId: string;
  readonly location: string;
  readonly guid: string;
  readonly name: string;
  readonly resourceGroupId?: string;
  readonly managedNetwork?: Partial<AzureVmManagedNetworkResource>;
  readonly networkSecurityGroupId?: string;
  readonly publicIpAddressId?: string;
  readonly networkInterfaceId?: string;
  readonly virtualMachineId?: string;
  readonly osDiskId?: string;
}

export type AzureFirewallDirection = "ingress" | "egress";
export type AzureFirewallAccess = "allow" | "deny";
export type AzureFirewallProtocol = "tcp" | "udp" | "icmp" | "ah" | "esp" | "*";

export interface AzureFirewallRuleSpec {
  readonly name: string;
  readonly priority: number;
  readonly direction: AzureFirewallDirection;
  readonly access: AzureFirewallAccess;
  readonly protocol: AzureFirewallProtocol;
  readonly sourceAddressPrefixes: readonly string[];
  readonly sourcePortRanges: readonly string[];
  readonly destinationAddressPrefixes: readonly string[];
  readonly destinationPortRanges: readonly string[];
  readonly description: string | null;
}

export interface AzureFirewallRule extends AzureFirewallRuleSpec {
  readonly id: string;
  readonly managed: boolean;
  readonly isDefault: boolean;
  readonly sourceApplicationSecurityGroupIds: readonly string[];
  readonly destinationApplicationSecurityGroupIds: readonly string[];
  readonly editUnsupportedReason: string | null;
}

export interface AzureFirewallSnapshot {
  readonly provider: "azure";
  readonly networkSecurityGroupId: string;
  readonly networkSecurityGroupName: string;
  readonly resourceGroupName: string;
  readonly rules: readonly AzureFirewallRule[];
}

interface ValidatedCreateInput extends Omit<
  AzureVmCreateInput,
  "resourceGroupName" | "imageReference" | "osDiskSizeGiB"
> {
  readonly resourceGroupName: string;
  readonly imageReference: ParsedImageReference;
  readonly osDiskSizeGiB: number;
}

type ParsedImageReference =
  | {
    readonly kind: "platform";
    readonly id: string;
    readonly publisher: string;
    readonly offer: string;
    readonly sku: string;
    readonly version: string;
    readonly architecture?: AzureVmArchitecture;
  }
  | {
    readonly kind: "managed";
    readonly id: string;
  };

interface ParsedResourceId {
  readonly id: string;
  readonly subscriptionId: string;
  readonly resourceGroupName: string;
  readonly provider: string;
  readonly typeSegments: readonly string[];
  readonly nameSegments: readonly string[];
}

export class AzureVmProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AzureVmProviderError";
  }
}

/** ARM operations for one explicit subscription, tenant, and location. */
export class AzureVmProvider {
  private readonly subscriptionId: string;
  private readonly tenantId: string;
  private readonly location: string;
  private readonly credential: TokenCredential;
  private readonly clients: AzureVmClientSet;

  constructor(connection: AzureVmProviderConnection, dependencies: AzureVmProviderDependencies = {}) {
    this.subscriptionId = requireAzureIdentifier(connection.subscriptionId, "Azure subscription ID");
    this.tenantId = requireAzureIdentifier(connection.tenantId, "Azure tenant ID");
    this.location = validateLocation(connection.location);
    if (!connection.credential || typeof connection.credential.getToken !== "function") {
      throw new AzureVmProviderError("An explicit Azure TokenCredential is required.");
    }
    this.credential = connection.credential;
    const clientFactory = dependencies.clientFactory ?? defaultAzureVmClientFactory;
    this.clients = clientFactory({
      subscriptionId: this.subscriptionId,
      tenantId: this.tenantId,
      location: this.location,
      credential: connection.credential,
    });
  }

  async preflight(): Promise<AzureVmDiscoveryResult> {
    return await this.discover();
  }

  async checkPermissions(): Promise<CloudPermissionEvaluation> {
    const token = await this.call("acquire an Azure Resource Manager token", async () => (
      await this.credential.getToken(`${AZURE_MANAGEMENT_ORIGIN}/.default`)
    ));
    if (!token || typeof token.token !== "string" || token.token.length < 1) {
      throw new AzureVmProviderError("The Azure credential did not return an ARM access token.");
    }
    const probes = [
      [
        "Microsoft.Resources/subscriptions/resourceGroups/read",
        "probe Azure resource-group read access",
        () => this.clients.resourceGroups.list(),
      ],
      [
        "Microsoft.Compute/skus/read",
        "probe Azure VM-size read access",
        () => this.clients.resourceSkus.list(),
      ],
      [
        "Microsoft.Compute/virtualMachines/read",
        "probe Azure virtual-machine read access",
        () => this.clients.virtualMachines.listAll(),
      ],
      [
        "Microsoft.Compute/disks/read",
        "probe Azure managed-disk read access",
        () => this.clients.disks.list(),
      ],
      [
        "Microsoft.Network/virtualNetworks/read",
        "probe Azure virtual-network read access",
        () => this.clients.virtualNetworks.listAll(),
      ],
      [
        "Microsoft.Network/networkSecurityGroups/read",
        "probe Azure network-security-group read access",
        () => this.clients.networkSecurityGroups.listAll(),
      ],
      [
        "Microsoft.Network/publicIPAddresses/read",
        "probe Azure public-IP read access",
        () => this.clients.publicIpAddresses.listAll(),
      ],
      [
        "Microsoft.Network/networkInterfaces/read",
        "probe Azure network-interface read access",
        () => this.clients.networkInterfaces.listAll(),
      ],
    ] as const satisfies readonly (
      readonly [string, string, () => AsyncIterable<unknown>]
    )[];
    const statuses = new Map<string, "verified" | "missing" | "unverifiable">();
    await Promise.all(probes.map(async ([id, operation, values]) => {
      statuses.set(id, await this.probeReadPermission(operation, values));
    }));
    return createCloudPermissionEvaluation("azure", statuses);
  }

  async discover(): Promise<AzureVmDiscoveryResult> {
    const [skuValues, virtualNetworkValues] = await Promise.all([
      this.collect("discover Azure VM sizes", this.clients.resourceSkus.list()),
      this.collect("discover Azure virtual networks", this.clients.virtualNetworks.listAll()),
    ]);
    const virtualNetworks = virtualNetworkValues
      .flatMap((virtualNetwork) => normalizeVirtualNetworkOption(
        virtualNetwork,
        this.subscriptionId,
        this.location,
      ))
      .sort(compareAzureOptions);
    const subnets = (await Promise.all(virtualNetworks.map(async (virtualNetwork) => {
      const values = await this.collect(
        "discover Azure subnets",
        this.clients.subnets.list(virtualNetwork.resourceGroupName, virtualNetwork.name),
      );
      return values.flatMap((subnet) => normalizeSubnetOption(
        subnet,
        virtualNetwork,
        this.subscriptionId,
      ));
    }))).flat().sort(compareAzureOptions);

    return {
      subscriptionId: this.subscriptionId,
      tenantId: this.tenantId,
      location: this.location,
      vmSizes: normalizeVmSizeOptions(skuValues, this.location),
      virtualNetworks,
      subnets,
      images: AZURE_UBUNTU_IMAGE_OPTIONS,
    };
  }

  async create(
    input: AzureVmCreateInput,
    onMutation?: AzureVmCreateMutationListener,
  ): Promise<AzureVmDeploymentResource> {
    const validated = validateCreateInput(input, this.subscriptionId);
    await this.assertVmSizeAvailable(validated.vmSize, validated.imageReference);
    const tags = managedTags(validated.guid, validated.name);
    let resourceGroupId: string | undefined;
    let managedNetwork: AzureVmManagedNetworkResource | undefined;
    let virtualNetworkId: string | undefined;
    let subnetId: string | undefined;
    let networkSecurityGroupId: string | undefined;
    let publicIpAddressId: string | undefined;
    let networkInterfaceId: string | undefined;
    let virtualMachineId: string | undefined;
    let osDiskId: string | undefined;
    const mutationResources = (): AzureVmCreateMutationResources => ({
      ...optionalString("resourceGroupId", resourceGroupId),
      ...(managedNetwork ? { managedNetwork } : {}),
      ...optionalString("networkSecurityGroupId", networkSecurityGroupId),
      ...optionalString("publicIpAddressId", publicIpAddressId),
      ...optionalString("networkInterfaceId", networkInterfaceId),
      ...optionalString("virtualMachineId", virtualMachineId),
      ...optionalString("osDiskId", osDiskId),
    });

    try {
      const expectedResourceGroupId = buildResourceGroupId(
        this.subscriptionId,
        validated.resourceGroupName,
      );
      const existingResourceGroup = await this.getOptional(
        "read the deployment resource group",
        () => this.clients.resourceGroups.get(validated.resourceGroupName),
      );
      if (existingResourceGroup) {
        assertOwnedResource(
          existingResourceGroup,
          expectedResourceGroupId,
          validated.guid,
          "resource group",
        );
        resourceGroupId = expectedResourceGroupId;
        await notifyCreateMutation(onMutation, "resource-group", mutationResources());
      } else {
        resourceGroupId = expectedResourceGroupId;
        await notifyCreateMutation(onMutation, "resource-group", mutationResources());
        const createdResourceGroup = await this.call(
          "create the deployment resource group",
          () => this.clients.resourceGroups.createOrUpdate(validated.resourceGroupName, {
            location: this.location,
            tags,
          }),
        );
        assertOwnedResource(
          createdResourceGroup,
          expectedResourceGroupId,
          validated.guid,
          "resource group",
        );
      }

      if (validated.network.mode === "managed") {
        const managedNetworkInput = validated.network;
        const virtualNetworkName = resourceName("sliver-vnet", validated.guid);
        const subnetName = resourceName("sliver-subnet", validated.guid);
        const expectedVirtualNetworkId = buildProviderResourceId(
          this.subscriptionId,
          validated.resourceGroupName,
          "Microsoft.Network",
          ["virtualNetworks"],
          [virtualNetworkName],
        );
        const expectedSubnetId = buildProviderResourceId(
          this.subscriptionId,
          validated.resourceGroupName,
          "Microsoft.Network",
          ["virtualNetworks", "subnets"],
          [virtualNetworkName, subnetName],
        );
        const existingVirtualNetwork = await this.getOptional(
          "read the managed virtual network",
          () => this.clients.virtualNetworks.get(validated.resourceGroupName, virtualNetworkName),
        );
        if (existingVirtualNetwork) {
          assertOwnedResource(
            existingVirtualNetwork,
            expectedVirtualNetworkId,
            validated.guid,
            "virtual network",
          );
          assertAddressPrefix(
            existingVirtualNetwork.addressSpace?.addressPrefixes,
            managedNetworkInput.virtualNetworkCidr,
            "virtual network",
          );
          virtualNetworkId = expectedVirtualNetworkId;
          managedNetwork = {
            virtualNetworkId: expectedVirtualNetworkId,
            subnetId: expectedSubnetId,
          };
          await notifyCreateMutation(onMutation, "virtual-network", mutationResources());
        } else {
          virtualNetworkId = expectedVirtualNetworkId;
          managedNetwork = {
            virtualNetworkId: expectedVirtualNetworkId,
            subnetId: expectedSubnetId,
          };
          await notifyCreateMutation(onMutation, "virtual-network", mutationResources());
          const createdVirtualNetwork = await this.call(
            "create the managed virtual network",
            () => this.clients.virtualNetworks.createOrUpdate(
              validated.resourceGroupName,
              virtualNetworkName,
              {
                location: this.location,
                tags,
                addressSpace: { addressPrefixes: [managedNetworkInput.virtualNetworkCidr] },
              },
            ),
          );
          assertOwnedResource(
            createdVirtualNetwork,
            expectedVirtualNetworkId,
            validated.guid,
            "virtual network",
          );
        }
        const existingSubnet = await this.getOptional(
          "read the managed subnet",
          () => this.clients.subnets.get(
            validated.resourceGroupName,
            virtualNetworkName,
            subnetName,
          ),
        );
        if (existingSubnet) {
          assertResourceId(existingSubnet.id, expectedSubnetId, "subnet");
          assertAddressPrefix(
            subnetAddressPrefixes(existingSubnet),
            managedNetworkInput.subnetCidr,
            "subnet",
          );
          subnetId = expectedSubnetId;
          await notifyCreateMutation(onMutation, "subnet", mutationResources());
        } else {
          subnetId = expectedSubnetId;
          await notifyCreateMutation(onMutation, "subnet", mutationResources());
          const createdSubnet = await this.call(
            "create the managed subnet",
            () => this.clients.subnets.createOrUpdate(
              validated.resourceGroupName,
              virtualNetworkName,
              subnetName,
              { addressPrefix: managedNetworkInput.subnetCidr },
            ),
          );
          assertResourceId(createdSubnet.id, expectedSubnetId, "subnet");
        }
      } else {
        const network = await this.readExistingNetwork(validated.network);
        virtualNetworkId = network.virtualNetworkId;
        subnetId = network.subnetId;
      }

      const networkSecurityGroupName = resourceName("sliver-nsg", validated.guid);
      const expectedNetworkSecurityGroupId = buildProviderResourceId(
        this.subscriptionId,
        validated.resourceGroupName,
        "Microsoft.Network",
        ["networkSecurityGroups"],
        [networkSecurityGroupName],
      );
      const existingNetworkSecurityGroup = await this.getOptional(
        "read the deployment network security group",
        () => this.clients.networkSecurityGroups.get(
          validated.resourceGroupName,
          networkSecurityGroupName,
        ),
      );
      if (existingNetworkSecurityGroup) {
        assertOwnedResource(
          existingNetworkSecurityGroup,
          expectedNetworkSecurityGroupId,
          validated.guid,
          "network security group",
        );
        networkSecurityGroupId = expectedNetworkSecurityGroupId;
        await notifyCreateMutation(onMutation, "network-security-group", mutationResources());
      } else {
        networkSecurityGroupId = expectedNetworkSecurityGroupId;
        await notifyCreateMutation(onMutation, "network-security-group", mutationResources());
        const createdNetworkSecurityGroup = await this.call(
          "create the deployment network security group",
          () => this.clients.networkSecurityGroups.createOrUpdate(
            validated.resourceGroupName,
            networkSecurityGroupName,
            { location: this.location, tags },
          ),
        );
        assertOwnedResource(
          createdNetworkSecurityGroup,
          expectedNetworkSecurityGroupId,
          validated.guid,
          "network security group",
        );
      }

      const firewallResource = provisionalDeploymentResource({
        subscriptionId: this.subscriptionId,
        tenantId: this.tenantId,
        location: this.location,
        guid: validated.guid,
        name: validated.name,
        resourceGroupId,
        virtualNetworkId: requirePresent(virtualNetworkId, "virtual network ID"),
        subnetId: requirePresent(subnetId, "subnet ID"),
        ...(managedNetwork ? { managedNetwork } : {}),
        networkSecurityGroupId,
      });
      await notifyCreateMutation(onMutation, "firewall", mutationResources());
      await this.replaceFirewall(firewallResource, validated.firewall);

      if (validated.allocatePublicIp) {
        const publicIpAddressName = resourceName("sliver-ip", validated.guid);
        const expectedPublicIpAddressId = buildProviderResourceId(
          this.subscriptionId,
          validated.resourceGroupName,
          "Microsoft.Network",
          ["publicIPAddresses"],
          [publicIpAddressName],
        );
        const existingPublicIpAddress = await this.getOptional(
          "read the deployment public IP address",
          () => this.clients.publicIpAddresses.get(
            validated.resourceGroupName,
            publicIpAddressName,
          ),
        );
        let publicIpAddress: PublicIPAddress;
        if (existingPublicIpAddress) {
          publicIpAddress = existingPublicIpAddress;
          assertOwnedResource(
            publicIpAddress,
            expectedPublicIpAddressId,
            validated.guid,
            "public IP address",
          );
          publicIpAddressId = expectedPublicIpAddressId;
          await notifyCreateMutation(onMutation, "public-ip-address", mutationResources());
        } else {
          publicIpAddressId = expectedPublicIpAddressId;
          await notifyCreateMutation(onMutation, "public-ip-address", mutationResources());
          publicIpAddress = await this.call(
            "create the deployment public IP address",
            () => this.clients.publicIpAddresses.createOrUpdate(
              validated.resourceGroupName,
              publicIpAddressName,
              {
                location: this.location,
                tags,
                sku: { name: "Standard", tier: "Regional" },
                publicIPAllocationMethod: "Static",
                publicIPAddressVersion: "IPv4",
                idleTimeoutInMinutes: 15,
              },
            ),
          );
        }
        assertOwnedResource(
          publicIpAddress,
          expectedPublicIpAddressId,
          validated.guid,
          "public IP address",
        );
        if (publicIpAddress.sku?.name !== "Standard" || publicIpAddress.publicIPAllocationMethod !== "Static") {
          throw new AzureVmProviderError("Azure returned a public IP address without the required Standard static configuration.");
        }
      }

      const networkInterfaceName = resourceName("sliver-nic", validated.guid);
      const expectedNetworkInterfaceId = buildProviderResourceId(
        this.subscriptionId,
        validated.resourceGroupName,
        "Microsoft.Network",
        ["networkInterfaces"],
        [networkInterfaceName],
      );
      const existingNetworkInterface = await this.getOptional(
        "read the deployment network interface",
        () => this.clients.networkInterfaces.get(validated.resourceGroupName, networkInterfaceName),
      );
      let networkInterface: NetworkInterface;
      if (existingNetworkInterface) {
        networkInterface = existingNetworkInterface;
        assertOwnedResource(
          networkInterface,
          expectedNetworkInterfaceId,
          validated.guid,
          "network interface",
        );
        networkInterfaceId = expectedNetworkInterfaceId;
        await notifyCreateMutation(onMutation, "network-interface", mutationResources());
      } else {
        networkInterfaceId = expectedNetworkInterfaceId;
        await notifyCreateMutation(onMutation, "network-interface", mutationResources());
        networkInterface = await this.call(
          "create the deployment network interface",
          () => this.clients.networkInterfaces.createOrUpdate(
            validated.resourceGroupName,
            networkInterfaceName,
            {
              location: this.location,
              tags,
              networkSecurityGroup: {
                id: requirePresent(networkSecurityGroupId, "network security group ID"),
              },
              ipConfigurations: [{
                name: "primary",
                primary: true,
                privateIPAllocationMethod: "Dynamic",
                subnet: { id: requirePresent(subnetId, "subnet ID") },
                ...(publicIpAddressId ? { publicIPAddress: { id: publicIpAddressId } } : {}),
              }],
            },
          ),
        );
      }
      assertOwnedResource(
        networkInterface,
        expectedNetworkInterfaceId,
        validated.guid,
        "network interface",
      );

      const virtualMachineName = resourceName("sliver-vm", validated.guid);
      const expectedVirtualMachineId = buildProviderResourceId(
        this.subscriptionId,
        validated.resourceGroupName,
        "Microsoft.Compute",
        ["virtualMachines"],
        [virtualMachineName],
      );
      const osDiskName = resourceName("sliver-os", validated.guid);
      const expectedOsDiskId = buildProviderResourceId(
        this.subscriptionId,
        validated.resourceGroupName,
        "Microsoft.Compute",
        ["disks"],
        [osDiskName],
      );
      const existingVirtualMachine = await this.getOptional(
        "read the deployment virtual machine",
        () => this.clients.virtualMachines.get(validated.resourceGroupName, virtualMachineName),
      );
      let virtualMachine: VirtualMachine;
      if (existingVirtualMachine) {
        virtualMachine = existingVirtualMachine;
        assertOwnedResource(
          virtualMachine,
          expectedVirtualMachineId,
          validated.guid,
          "virtual machine",
        );
        assertResourceId(
          virtualMachine.storageProfile?.osDisk?.managedDisk?.id,
          expectedOsDiskId,
          "OS disk",
        );
        virtualMachineId = expectedVirtualMachineId;
        osDiskId = expectedOsDiskId;
        await notifyCreateMutation(onMutation, "virtual-machine", mutationResources());
      } else {
        virtualMachineId = expectedVirtualMachineId;
        osDiskId = expectedOsDiskId;
        await notifyCreateMutation(onMutation, "virtual-machine", mutationResources());
        virtualMachine = await this.call(
          "create the deployment virtual machine",
          () => this.clients.virtualMachines.createOrUpdate(
            validated.resourceGroupName,
            virtualMachineName,
            virtualMachineParameters(
              validated,
              tags,
              networkInterfaceId!,
              osDiskName,
              this.location,
            ),
          ),
        );
      }
      assertOwnedResource(
        virtualMachine,
        expectedVirtualMachineId,
        validated.guid,
        "virtual machine",
      );
      assertResourceId(
        virtualMachine.storageProfile?.osDisk?.managedDisk?.id,
        expectedOsDiskId,
        "OS disk",
      );

      const taggedDisk = await this.call(
        "tag the managed OS disk",
        () => this.clients.disks.update(
          validated.resourceGroupName,
          osDiskName,
          { tags },
        ),
      );
      assertOwnedResource(taggedDisk, expectedOsDiskId, validated.guid, "OS disk");
      await notifyCreateMutation(onMutation, "os-disk", mutationResources());

      return await this.refresh({
        subscriptionId: this.subscriptionId,
        tenantId: this.tenantId,
        location: this.location,
        guid: validated.guid,
        name: validated.name,
        resourceGroupId,
        virtualNetworkId,
        subnetId,
        ...(managedNetwork ? { managedNetwork } : {}),
        networkSecurityGroupId,
        ...(publicIpAddressId ? { publicIpAddressId } : {}),
        networkInterfaceId,
        virtualMachineId,
        osDiskId,
        instanceState: "creating",
      });
    } catch (error) {
      const sanitized = sanitizeAzureError("create the deployment", error);
      await this.rollbackCreate({
        subscriptionId: this.subscriptionId,
        tenantId: this.tenantId,
        location: this.location,
        guid: validated.guid,
        name: validated.name,
        ...optionalString("resourceGroupId", resourceGroupId),
        ...(managedNetwork ? { managedNetwork } : {}),
        ...optionalString("networkSecurityGroupId", networkSecurityGroupId),
        ...optionalString("publicIpAddressId", publicIpAddressId),
        ...optionalString("networkInterfaceId", networkInterfaceId),
        ...optionalString("virtualMachineId", virtualMachineId),
        ...optionalString("osDiskId", osDiskId),
      });
      throw sanitized;
    }
  }

  async refresh(resource: AzureVmDeploymentResource, signal?: AbortSignal): Promise<AzureVmDeploymentResource> {
    this.validateDeploymentResource(resource);
    if (signal?.aborted) throw new AzureVmProviderError("Azure status refresh was cancelled.");
    const [virtualMachine, networkSecurityGroup, networkInterface, osDisk, publicIpAddress] = await Promise.all([
      this.getOwnedVirtualMachine(resource, signal),
      this.getOwnedNetworkSecurityGroup(resource, signal),
      this.getOwnedNetworkInterface(resource, signal),
      this.getOwnedDisk(resource, signal),
      resource.publicIpAddressId ? this.getOwnedPublicIpAddress(resource, signal) : Promise.resolve(undefined),
    ]);
    if (signal?.aborted) throw new AzureVmProviderError("Azure status refresh was cancelled.");
    void networkSecurityGroup;
    void osDisk;
    const privateIpAddress = networkInterface.ipConfigurations
      ?.map((configuration) => configuration.privateIPAddress)
      .find((address): address is string => address !== undefined);
    const publicIpValue = publicIpAddress?.ipAddress;
    const refreshedResource = { ...resource };
    // Absent fields in a current response must replace the previous observation.
    delete refreshedResource.provisioningState;
    delete refreshedResource.privateIpAddress;
    delete refreshedResource.publicIpAddress;
    return {
      ...refreshedResource,
      instanceState: normalizeInstanceState(virtualMachine),
      ...optionalString("provisioningState", normalizeOptionalAzureString(
        virtualMachine.provisioningState,
        "virtual machine provisioning state",
        128,
      )),
      ...optionalString("privateIpAddress", validateOptionalIp(privateIpAddress, "private IP address")),
      ...optionalString("publicIpAddress", validateOptionalIp(publicIpValue, "public IP address")),
    };
  }

  async start(resource: AzureVmDeploymentResource): Promise<AzureVmDeploymentResource> {
    const virtualMachine = await this.getOwnedVirtualMachine(resource);
    if (normalizeInstanceState(virtualMachine) !== "running") {
      const parsed = parseExpectedResourceId(
        resource.virtualMachineId,
        this.subscriptionId,
        "Microsoft.Compute",
        ["virtualMachines"],
        "virtual machine",
      );
      await this.call(
        "start the managed virtual machine",
        () => this.clients.virtualMachines.start(parsed.resourceGroupName, parsed.nameSegments[0]!),
      );
    }
    return await this.refresh(resource);
  }

  async stop(resource: AzureVmDeploymentResource): Promise<AzureVmDeploymentResource> {
    const virtualMachine = await this.getOwnedVirtualMachine(resource);
    if (normalizeInstanceState(virtualMachine) !== "deallocated") {
      const parsed = parseExpectedResourceId(
        resource.virtualMachineId,
        this.subscriptionId,
        "Microsoft.Compute",
        ["virtualMachines"],
        "virtual machine",
      );
      await this.call(
        "deallocate the managed virtual machine",
        () => this.clients.virtualMachines.deallocate(parsed.resourceGroupName, parsed.nameSegments[0]!),
      );
    }
    return await this.refresh(resource);
  }

  async reboot(resource: AzureVmDeploymentResource): Promise<AzureVmDeploymentResource> {
    await this.getOwnedVirtualMachine(resource);
    const parsed = parseExpectedResourceId(
      resource.virtualMachineId,
      this.subscriptionId,
      "Microsoft.Compute",
      ["virtualMachines"],
      "virtual machine",
    );
    await this.call(
      "restart the managed virtual machine",
      () => this.clients.virtualMachines.restart(parsed.resourceGroupName, parsed.nameSegments[0]!),
    );
    return await this.refresh(resource);
  }

  async replaceFirewall(
    resource: AzureVmDeploymentResource,
    firewall: AzureVmFirewallInput,
  ): Promise<AzureVmDeploymentResource> {
    this.validateDeploymentResource(resource, true);
    const validated = validateFirewallInput(firewall);
    const current = await this.listFirewallRules(resource);
    const baselineRules = current.rules.filter((rule) => rule.managed && isBaselineRule(rule, resource.guid));
    const desired = baselineFirewallRules(validated, resource.guid);
    const desiredPriorities = new Set(desired.map((rule) => rule.priority));
    const desiredNames = new Set(desired.map((rule) => rule.name));
    if (current.rules.some((rule) => !isBaselineRule(rule, resource.guid) && desiredPriorities.has(rule.priority))) {
      throw new AzureVmProviderError("A custom Azure firewall rule uses a priority reserved for baseline access.");
    }
    if (current.rules.some((rule) => !isBaselineRule(rule, resource.guid) && desiredNames.has(rule.name))) {
      throw new AzureVmProviderError("A custom Azure firewall rule uses a name reserved for baseline access.");
    }
    // Azure security-rule writes are upserts. Establish the complete desired
    // baseline before removing obsolete entries so a transient write failure
    // cannot erase working SSH/operator access.
    for (const rule of desired) {
      await this.createBaselineRule(resource, rule);
    }
    for (const rule of baselineRules) {
      if (!desiredNames.has(rule.name)) await this.deleteBaselineRule(resource, rule.name);
    }
    return resource;
  }

  async listFirewallRules(resource: AzureVmDeploymentResource): Promise<AzureFirewallSnapshot> {
    this.validateDeploymentResource(resource, true);
    const networkSecurityGroup = await this.getOwnedNetworkSecurityGroup(resource);
    const parsed = parseExpectedResourceId(
      resource.networkSecurityGroupId,
      this.subscriptionId,
      "Microsoft.Network",
      ["networkSecurityGroups"],
      "network security group",
    );
    const customRules = await this.collect(
      "list Azure firewall rules",
      this.clients.securityRules.list(parsed.resourceGroupName, parsed.nameSegments[0]!),
    );
    const rules = [
      ...customRules.map((rule) => normalizeFirewallRule(
        rule,
        resource.networkSecurityGroupId,
        false,
      )),
      ...(networkSecurityGroup.defaultSecurityRules ?? []).map((rule) => normalizeFirewallRule(
        rule,
        resource.networkSecurityGroupId,
        true,
      )),
    ].sort(compareFirewallRules);
    return {
      provider: "azure",
      networkSecurityGroupId: resource.networkSecurityGroupId,
      networkSecurityGroupName: parsed.nameSegments[0]!,
      resourceGroupName: parsed.resourceGroupName,
      rules,
    };
  }

  async createFirewallRule(
    resource: AzureVmDeploymentResource,
    spec: AzureFirewallRuleSpec,
  ): Promise<AzureFirewallRule> {
    const validated = validateFirewallRuleSpec(spec, false);
    const parsed = await this.assertFirewallMutationTarget(resource);
    const existing = await this.getOptional(
      "read the Azure firewall rule",
      () => this.clients.securityRules.get(
        parsed.resourceGroupName,
        parsed.nameSegments[0]!,
        validated.name,
      ),
    );
    if (existing) throw new AzureVmProviderError("An Azure firewall rule with that name already exists.");
    await this.assertUniqueFirewallPriority(resource, validated.priority);
    const created = await this.call(
      "create the Azure firewall rule",
      () => this.clients.securityRules.createOrUpdate(
        parsed.resourceGroupName,
        parsed.nameSegments[0]!,
        validated.name,
        firewallRuleParameters(validated),
      ),
    );
    return normalizeFirewallRule(created, resource.networkSecurityGroupId, false);
  }

  async updateFirewallRule(
    resource: AzureVmDeploymentResource,
    ruleName: string,
    spec: AzureFirewallRuleSpec,
  ): Promise<AzureFirewallRule> {
    const name = validateSecurityRuleName(ruleName, false);
    const validated = validateFirewallRuleSpec(spec, false);
    if (validated.name !== name) {
      throw new AzureVmProviderError("An Azure firewall rule cannot be renamed during an update.");
    }
    const parsed = await this.assertFirewallMutationTarget(resource);
    const current = await this.requireFirewallRule(resource, parsed, name);
    if (isBaselineRule(current, resource.guid) || current.isDefault) {
      throw new AzureVmProviderError("Baseline and Azure default firewall rules cannot be edited directly.");
    }
    if (current.editUnsupportedReason) {
      throw new AzureVmProviderError(current.editUnsupportedReason);
    }
    await this.assertUniqueFirewallPriority(resource, validated.priority, name);
    const updated = await this.call(
      "update the Azure firewall rule",
      () => this.clients.securityRules.createOrUpdate(
        parsed.resourceGroupName,
        parsed.nameSegments[0]!,
        name,
        firewallRuleParameters(validated),
      ),
    );
    return normalizeFirewallRule(updated, resource.networkSecurityGroupId, false);
  }

  async deleteFirewallRule(resource: AzureVmDeploymentResource, ruleName: string): Promise<void> {
    const name = validateSecurityRuleName(ruleName, false);
    const parsed = await this.assertFirewallMutationTarget(resource);
    const current = await this.requireFirewallRule(resource, parsed, name);
    if (isBaselineRule(current, resource.guid) || current.isDefault) {
      throw new AzureVmProviderError("Baseline and Azure default firewall rules cannot be deleted directly.");
    }
    await this.call(
      "delete the Azure firewall rule",
      () => this.clients.securityRules.delete(
        parsed.resourceGroupName,
        parsed.nameSegments[0]!,
        name,
      ),
    );
  }

  async destroy(resource: AzureVmDestroyResource): Promise<void> {
    this.validateDestroyResource(resource);
    if (resource.virtualMachineId) await this.deleteOwnedVirtualMachine(resource);
    if (resource.osDiskId) await this.deleteOwnedDisk(resource);
    if (resource.networkInterfaceId) await this.deleteOwnedNetworkInterface(resource);
    if (resource.publicIpAddressId) await this.deleteOwnedPublicIpAddress(resource);
    if (resource.networkSecurityGroupId) await this.deleteOwnedNetworkSecurityGroup(resource);
    if (resource.managedNetwork?.subnetId) await this.deleteOwnedSubnet(resource);
    if (resource.managedNetwork?.virtualNetworkId) await this.deleteOwnedVirtualNetwork(resource);
    if (resource.resourceGroupId) await this.deleteOwnedResourceGroup(resource);
  }

  private async assertVmSizeAvailable(
    vmSize: string,
    imageReference: ParsedImageReference,
  ): Promise<void> {
    const values = await this.collect("validate the Azure VM size", this.clients.resourceSkus.list());
    const options = normalizeVmSizeOptions(values, this.location);
    const selected = options.find((option) => option.name.toLowerCase() === vmSize.toLowerCase());
    if (!selected) throw new AzureVmProviderError("The selected Azure VM size is not available in this location.");
    if (imageReference.kind === "platform" && imageReference.architecture && (
      selected.architecture !== imageReference.architecture
    )) {
      throw new AzureVmProviderError(
        `The selected Azure image requires a ${imageReference.architecture} VM size.`,
      );
    }
  }

  private async readExistingNetwork(
    input: Extract<AzureVmNetworkInput, { readonly mode: "existing" }>,
  ): Promise<{ readonly virtualNetworkId: string; readonly subnetId: string }> {
    const virtualNetwork = parseExpectedResourceId(
      input.virtualNetworkId,
      this.subscriptionId,
      "Microsoft.Network",
      ["virtualNetworks"],
      "virtual network",
    );
    const subnet = parseExpectedResourceId(
      input.subnetId,
      this.subscriptionId,
      "Microsoft.Network",
      ["virtualNetworks", "subnets"],
      "subnet",
    );
    if (virtualNetwork.resourceGroupName.toLowerCase() !== subnet.resourceGroupName.toLowerCase() ||
      virtualNetwork.nameSegments[0]!.toLowerCase() !== subnet.nameSegments[0]!.toLowerCase()) {
      throw new AzureVmProviderError("The selected Azure subnet does not belong to the selected virtual network.");
    }
    const [actualVirtualNetwork, actualSubnet] = await Promise.all([
      this.call(
        "read the selected virtual network",
        () => this.clients.virtualNetworks.get(
          virtualNetwork.resourceGroupName,
          virtualNetwork.nameSegments[0]!,
        ),
      ),
      this.call(
        "read the selected subnet",
        () => this.clients.subnets.get(
          subnet.resourceGroupName,
          subnet.nameSegments[0]!,
          subnet.nameSegments[1]!,
        ),
      ),
    ]);
    assertResourceId(actualVirtualNetwork.id, virtualNetwork.id, "virtual network");
    assertResourceId(actualSubnet.id, subnet.id, "subnet");
    if (actualVirtualNetwork.location?.toLowerCase() !== this.location) {
      throw new AzureVmProviderError("The selected Azure virtual network is not in the deployment location.");
    }
    return { virtualNetworkId: virtualNetwork.id, subnetId: subnet.id };
  }

  private async assertFirewallMutationTarget(
    resource: AzureVmDeploymentResource,
  ): Promise<ParsedResourceId> {
    this.validateDeploymentResource(resource, true);
    await this.getOwnedNetworkSecurityGroup(resource);
    return parseExpectedResourceId(
      resource.networkSecurityGroupId,
      this.subscriptionId,
      "Microsoft.Network",
      ["networkSecurityGroups"],
      "network security group",
    );
  }

  private async assertUniqueFirewallPriority(
    resource: AzureVmDeploymentResource,
    priority: number,
    exceptName?: string,
  ): Promise<void> {
    const snapshot = await this.listFirewallRules(resource);
    if (snapshot.rules.some((rule) => rule.priority === priority && rule.name !== exceptName)) {
      throw new AzureVmProviderError("An Azure firewall rule already uses that priority.");
    }
  }

  private async requireFirewallRule(
    resource: AzureVmDeploymentResource,
    networkSecurityGroup: ParsedResourceId,
    name: string,
  ): Promise<AzureFirewallRule> {
    const rule = await this.getOptional(
      "read the Azure firewall rule",
      () => this.clients.securityRules.get(
        networkSecurityGroup.resourceGroupName,
        networkSecurityGroup.nameSegments[0]!,
        name,
      ),
    );
    if (!rule) throw new AzureVmProviderError("The Azure firewall rule no longer exists.");
    return normalizeFirewallRule(rule, resource.networkSecurityGroupId, false);
  }

  private async createBaselineRule(
    resource: AzureVmDeploymentResource,
    spec: AzureFirewallRuleSpec,
  ): Promise<void> {
    const parsed = await this.assertFirewallMutationTarget(resource);
    await this.call(
      "create a baseline Azure firewall rule",
      () => this.clients.securityRules.createOrUpdate(
        parsed.resourceGroupName,
        parsed.nameSegments[0]!,
        spec.name,
        firewallRuleParameters(spec),
      ),
    );
  }

  private async deleteBaselineRule(resource: AzureVmDeploymentResource, name: string): Promise<void> {
    const parsed = await this.assertFirewallMutationTarget(resource);
    const current = await this.requireFirewallRule(resource, parsed, name);
    if (!isBaselineRule(current, resource.guid)) {
      throw new AzureVmProviderError("Refusing to delete a non-baseline Azure firewall rule.");
    }
    await this.call(
      "delete a baseline Azure firewall rule",
      () => this.clients.securityRules.delete(
        parsed.resourceGroupName,
        parsed.nameSegments[0]!,
        name,
      ),
    );
  }

  private async getOwnedVirtualMachine(resource: AzureVmDeploymentResource, signal?: AbortSignal): Promise<VirtualMachine> {
    const parsed = parseExpectedResourceId(
      resource.virtualMachineId,
      this.subscriptionId,
      "Microsoft.Compute",
      ["virtualMachines"],
      "virtual machine",
    );
    const value = await this.call(
      "read the managed virtual machine",
      () => this.clients.virtualMachines.get(parsed.resourceGroupName, parsed.nameSegments[0]!, signal ? { abortSignal: signal } : undefined),
    );
    assertOwnedResource(value, parsed.id, resource.guid, "virtual machine");
    return value;
  }

  private async getOwnedNetworkSecurityGroup(
    resource: Pick<AzureVmDeploymentResource, "networkSecurityGroupId" | "guid">,
    signal?: AbortSignal,
  ): Promise<NetworkSecurityGroup> {
    const parsed = parseExpectedResourceId(
      resource.networkSecurityGroupId,
      this.subscriptionId,
      "Microsoft.Network",
      ["networkSecurityGroups"],
      "network security group",
    );
    const value = await this.call(
      "read the managed network security group",
      () => this.clients.networkSecurityGroups.get(parsed.resourceGroupName, parsed.nameSegments[0]!, signal ? { abortSignal: signal } : undefined),
    );
    assertOwnedResource(value, parsed.id, resource.guid, "network security group");
    return value;
  }

  private async getOwnedNetworkInterface(resource: AzureVmDeploymentResource, signal?: AbortSignal): Promise<NetworkInterface> {
    const parsed = parseExpectedResourceId(
      resource.networkInterfaceId,
      this.subscriptionId,
      "Microsoft.Network",
      ["networkInterfaces"],
      "network interface",
    );
    const value = await this.call(
      "read the managed network interface",
      () => this.clients.networkInterfaces.get(parsed.resourceGroupName, parsed.nameSegments[0]!, signal ? { abortSignal: signal } : undefined),
    );
    assertOwnedResource(value, parsed.id, resource.guid, "network interface");
    return value;
  }

  private async getOwnedPublicIpAddress(resource: AzureVmDeploymentResource, signal?: AbortSignal): Promise<PublicIPAddress> {
    const parsed = parseExpectedResourceId(
      requirePresent(resource.publicIpAddressId, "public IP address ID"),
      this.subscriptionId,
      "Microsoft.Network",
      ["publicIPAddresses"],
      "public IP address",
    );
    const value = await this.call(
      "read the managed public IP address",
      () => this.clients.publicIpAddresses.get(parsed.resourceGroupName, parsed.nameSegments[0]!, signal ? { abortSignal: signal } : undefined),
    );
    assertOwnedResource(value, parsed.id, resource.guid, "public IP address");
    return value;
  }

  private async getOwnedDisk(resource: AzureVmDeploymentResource, signal?: AbortSignal): Promise<Disk> {
    const parsed = parseExpectedResourceId(
      resource.osDiskId,
      this.subscriptionId,
      "Microsoft.Compute",
      ["disks"],
      "OS disk",
    );
    const value = await this.call(
      "read the managed OS disk",
      () => this.clients.disks.get(parsed.resourceGroupName, parsed.nameSegments[0]!, signal ? { abortSignal: signal } : undefined),
    );
    assertOwnedResource(value, parsed.id, resource.guid, "OS disk");
    return value;
  }

  private async deleteOwnedVirtualMachine(resource: AzureVmDestroyResource): Promise<void> {
    const parsed = parseExpectedResourceId(
      resource.virtualMachineId!,
      this.subscriptionId,
      "Microsoft.Compute",
      ["virtualMachines"],
      "virtual machine",
    );
    const current = await this.getOptional(
      "read the managed virtual machine",
      () => this.clients.virtualMachines.get(parsed.resourceGroupName, parsed.nameSegments[0]!),
    );
    if (!current) return;
    assertOwnedResource(current, parsed.id, resource.guid, "virtual machine");
    if (resource.osDiskId) {
      const expectedOsDisk = parseExpectedResourceId(
        resource.osDiskId,
        this.subscriptionId,
        "Microsoft.Compute",
        ["disks"],
        "OS disk",
      );
      assertResourceId(
        current.storageProfile?.osDisk?.managedDisk?.id,
        expectedOsDisk.id,
        "OS disk",
      );
    }
    await this.callAllowingNotFound(
      "delete the managed virtual machine",
      () => this.clients.virtualMachines.delete(parsed.resourceGroupName, parsed.nameSegments[0]!),
    );
  }

  private async deleteOwnedDisk(resource: AzureVmDestroyResource): Promise<void> {
    const parsed = parseExpectedResourceId(
      resource.osDiskId!,
      this.subscriptionId,
      "Microsoft.Compute",
      ["disks"],
      "OS disk",
    );
    const current = await this.getOptional(
      "read the managed OS disk",
      () => this.clients.disks.get(parsed.resourceGroupName, parsed.nameSegments[0]!),
    );
    if (!current) return;
    assertOwnedResource(current, parsed.id, resource.guid, "OS disk");
    await this.callAllowingNotFound(
      "delete the managed OS disk",
      () => this.clients.disks.delete(parsed.resourceGroupName, parsed.nameSegments[0]!),
    );
  }

  private async deleteOwnedNetworkInterface(resource: AzureVmDestroyResource): Promise<void> {
    const parsed = parseExpectedResourceId(
      resource.networkInterfaceId!,
      this.subscriptionId,
      "Microsoft.Network",
      ["networkInterfaces"],
      "network interface",
    );
    const current = await this.getOptional(
      "read the managed network interface",
      () => this.clients.networkInterfaces.get(parsed.resourceGroupName, parsed.nameSegments[0]!),
    );
    if (!current) return;
    assertOwnedResource(current, parsed.id, resource.guid, "network interface");
    await this.callAllowingNotFound(
      "delete the managed network interface",
      () => this.clients.networkInterfaces.delete(parsed.resourceGroupName, parsed.nameSegments[0]!),
    );
  }

  private async deleteOwnedPublicIpAddress(resource: AzureVmDestroyResource): Promise<void> {
    const parsed = parseExpectedResourceId(
      resource.publicIpAddressId!,
      this.subscriptionId,
      "Microsoft.Network",
      ["publicIPAddresses"],
      "public IP address",
    );
    const current = await this.getOptional(
      "read the managed public IP address",
      () => this.clients.publicIpAddresses.get(parsed.resourceGroupName, parsed.nameSegments[0]!),
    );
    if (!current) return;
    assertOwnedResource(current, parsed.id, resource.guid, "public IP address");
    await this.callAllowingNotFound(
      "delete the managed public IP address",
      () => this.clients.publicIpAddresses.delete(parsed.resourceGroupName, parsed.nameSegments[0]!),
    );
  }

  private async deleteOwnedNetworkSecurityGroup(resource: AzureVmDestroyResource): Promise<void> {
    const parsed = parseExpectedResourceId(
      resource.networkSecurityGroupId!,
      this.subscriptionId,
      "Microsoft.Network",
      ["networkSecurityGroups"],
      "network security group",
    );
    const current = await this.getOptional(
      "read the managed network security group",
      () => this.clients.networkSecurityGroups.get(parsed.resourceGroupName, parsed.nameSegments[0]!),
    );
    if (!current) return;
    assertOwnedResource(current, parsed.id, resource.guid, "network security group");
    await this.callAllowingNotFound(
      "delete the managed network security group",
      () => this.clients.networkSecurityGroups.delete(parsed.resourceGroupName, parsed.nameSegments[0]!),
    );
  }

  private async deleteOwnedSubnet(resource: AzureVmDestroyResource): Promise<void> {
    const subnet = parseExpectedResourceId(
      resource.managedNetwork!.subnetId!,
      this.subscriptionId,
      "Microsoft.Network",
      ["virtualNetworks", "subnets"],
      "subnet",
    );
    const virtualNetworkId = requirePresent(
      resource.managedNetwork?.virtualNetworkId,
      "managed virtual network ID",
    );
    const current = await this.getOptional(
      "read the managed subnet",
      () => this.clients.subnets.get(
        subnet.resourceGroupName,
        subnet.nameSegments[0]!,
        subnet.nameSegments[1]!,
      ),
    );
    if (!current) return;
    assertResourceId(current.id, subnet.id, "subnet");
    await this.getOwnedVirtualNetwork(resource, virtualNetworkId);
    await this.callAllowingNotFound(
      "delete the managed subnet",
      () => this.clients.subnets.delete(
        subnet.resourceGroupName,
        subnet.nameSegments[0]!,
        subnet.nameSegments[1]!,
      ),
    );
  }

  private async deleteOwnedVirtualNetwork(resource: AzureVmDestroyResource): Promise<void> {
    const id = resource.managedNetwork!.virtualNetworkId!;
    const parsed = parseExpectedResourceId(
      id,
      this.subscriptionId,
      "Microsoft.Network",
      ["virtualNetworks"],
      "virtual network",
    );
    const current = await this.getOptional(
      "read the managed virtual network",
      () => this.clients.virtualNetworks.get(parsed.resourceGroupName, parsed.nameSegments[0]!),
    );
    if (!current) return;
    assertOwnedResource(current, parsed.id, resource.guid, "virtual network");
    await this.callAllowingNotFound(
      "delete the managed virtual network",
      () => this.clients.virtualNetworks.delete(parsed.resourceGroupName, parsed.nameSegments[0]!),
    );
  }

  private async getOwnedVirtualNetwork(
    resource: AzureVmDestroyResource,
    id: string,
  ): Promise<VirtualNetwork> {
    const parsed = parseExpectedResourceId(
      id,
      this.subscriptionId,
      "Microsoft.Network",
      ["virtualNetworks"],
      "virtual network",
    );
    const value = await this.call(
      "read the managed virtual network",
      () => this.clients.virtualNetworks.get(parsed.resourceGroupName, parsed.nameSegments[0]!),
    );
    assertOwnedResource(value, parsed.id, resource.guid, "virtual network");
    return value;
  }

  private async deleteOwnedResourceGroup(resource: AzureVmDestroyResource): Promise<void> {
    const parsed = parseResourceGroupId(
      resource.resourceGroupId!,
      this.subscriptionId,
      "resource group",
    );
    const current = await this.getOptional(
      "read the deployment resource group",
      () => this.clients.resourceGroups.get(parsed.resourceGroupName),
    );
    if (!current) return;
    assertOwnedResource(current, parsed.id, resource.guid, "resource group");
    const remaining = await this.collect(
      "verify the deployment resource group is empty",
      this.clients.genericResources.listByResourceGroup(parsed.resourceGroupName),
    );
    if (remaining.length > 0) {
      throw new AzureVmProviderError(
        "Refusing to delete the managed resource group because it contains untracked resources.",
      );
    }
    const verified = await this.call(
      "re-read the deployment resource group",
      () => this.clients.resourceGroups.get(parsed.resourceGroupName),
    );
    assertOwnedResource(verified, parsed.id, resource.guid, "resource group");
    await this.callAllowingNotFound(
      "delete the deployment resource group",
      () => this.clients.resourceGroups.delete(parsed.resourceGroupName),
    );
  }

  private validateDeploymentResource(resource: AzureVmDeploymentResource, partial = false): void {
    validateResourceScope(resource, this.subscriptionId, this.tenantId, this.location);
    requireDeploymentGuid(resource.guid);
    validateDisplayName(resource.name);
    parseResourceGroupId(resource.resourceGroupId, this.subscriptionId, "resource group");
    parseExpectedResourceId(
      resource.networkSecurityGroupId,
      this.subscriptionId,
      "Microsoft.Network",
      ["networkSecurityGroups"],
      "network security group",
    );
    if (partial) return;
    parseExpectedResourceId(resource.virtualMachineId, this.subscriptionId, "Microsoft.Compute", ["virtualMachines"], "virtual machine");
    parseExpectedResourceId(resource.osDiskId, this.subscriptionId, "Microsoft.Compute", ["disks"], "OS disk");
    parseExpectedResourceId(resource.networkInterfaceId, this.subscriptionId, "Microsoft.Network", ["networkInterfaces"], "network interface");
    parseExpectedResourceId(resource.virtualNetworkId, this.subscriptionId, "Microsoft.Network", ["virtualNetworks"], "virtual network");
    parseExpectedResourceId(resource.subnetId, this.subscriptionId, "Microsoft.Network", ["virtualNetworks", "subnets"], "subnet");
    if (resource.publicIpAddressId) {
      parseExpectedResourceId(resource.publicIpAddressId, this.subscriptionId, "Microsoft.Network", ["publicIPAddresses"], "public IP address");
    }
  }

  private validateDestroyResource(resource: AzureVmDestroyResource): void {
    validateResourceScope(resource, this.subscriptionId, this.tenantId, this.location);
    requireDeploymentGuid(resource.guid);
    validateDisplayName(resource.name);
    if (resource.resourceGroupId) parseResourceGroupId(resource.resourceGroupId, this.subscriptionId, "resource group");
    if (resource.virtualMachineId) parseExpectedResourceId(resource.virtualMachineId, this.subscriptionId, "Microsoft.Compute", ["virtualMachines"], "virtual machine");
    if (resource.osDiskId) parseExpectedResourceId(resource.osDiskId, this.subscriptionId, "Microsoft.Compute", ["disks"], "OS disk");
    if (resource.networkInterfaceId) parseExpectedResourceId(resource.networkInterfaceId, this.subscriptionId, "Microsoft.Network", ["networkInterfaces"], "network interface");
    if (resource.publicIpAddressId) parseExpectedResourceId(resource.publicIpAddressId, this.subscriptionId, "Microsoft.Network", ["publicIPAddresses"], "public IP address");
    if (resource.networkSecurityGroupId) parseExpectedResourceId(resource.networkSecurityGroupId, this.subscriptionId, "Microsoft.Network", ["networkSecurityGroups"], "network security group");
    if (resource.managedNetwork?.virtualNetworkId) parseExpectedResourceId(resource.managedNetwork.virtualNetworkId, this.subscriptionId, "Microsoft.Network", ["virtualNetworks"], "virtual network");
    if (resource.managedNetwork?.subnetId) parseExpectedResourceId(resource.managedNetwork.subnetId, this.subscriptionId, "Microsoft.Network", ["virtualNetworks", "subnets"], "subnet");
    if (resource.managedNetwork?.subnetId && !resource.managedNetwork.virtualNetworkId) {
      throw new AzureVmProviderError("A tracked managed subnet requires its managed virtual network ID.");
    }
  }

  private async rollbackCreate(resource: AzureVmDestroyResource): Promise<void> {
    try {
      await this.destroy(resource);
    } catch {
      // The durable mutation journal is the source of truth for a later retry.
      // Rollback is deliberately best-effort and must not hide the create error.
    }
  }

  private async probeReadPermission(
    operation: string,
    values: () => AsyncIterable<unknown>,
  ): Promise<"verified" | "missing"> {
    try {
      const iterator = values()[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.return?.();
      return "verified";
    } catch (error) {
      if (isAzureForbidden(error)) return "missing";
      throw sanitizeAzureError(operation, error);
    }
  }

  private async collect<T>(operation: string, values: AsyncIterable<T>): Promise<T[]> {
    try {
      const result: T[] = [];
      for await (const value of values) {
        if (result.length >= MAX_DISCOVERY_ITEMS) {
          throw new AzureVmProviderError("Azure returned more resources than the bounded discovery limit.");
        }
        result.push(value);
      }
      return result;
    } catch (error) {
      throw sanitizeAzureError(operation, error);
    }
  }

  private async call<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw sanitizeAzureError(operation, error);
    }
  }

  private async callAllowingNotFound(operation: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (!isAzureNotFound(error)) throw sanitizeAzureError(operation, error);
    }
  }

  private async getOptional<T>(operation: string, action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await action();
    } catch (error) {
      if (isAzureNotFound(error)) return undefined;
      throw sanitizeAzureError(operation, error);
    }
  }
}

export const defaultAzureVmClientFactory: AzureVmClientFactory = (configuration) => {
  const resourceClient = new ResourceManagementClient(
    configuration.credential,
    configuration.subscriptionId,
  );
  const computeClient = new ComputeManagementClient(
    configuration.credential,
    configuration.subscriptionId,
  );
  const networkClient = new NetworkManagementClient(
    configuration.credential,
    configuration.subscriptionId,
  );
  return {
    resourceGroups: {
      list: () => resourceClient.resourceGroups.list(),
      get: async (resourceGroupName) => await resourceClient.resourceGroups.get(resourceGroupName),
      createOrUpdate: async (resourceGroupName, parameters) => (
        await resourceClient.resourceGroups.createOrUpdate(resourceGroupName, parameters)
      ),
      delete: async (resourceGroupName) => {
        await resourceClient.resourceGroups.delete(resourceGroupName).pollUntilDone();
      },
    },
    genericResources: {
      listByResourceGroup: (resourceGroupName) => (
        resourceClient.resources.listByResourceGroup(resourceGroupName)
      ),
    },
    resourceSkus: {
      list: () => computeClient.resourceSkus.list(),
    },
    virtualNetworks: {
      listAll: () => networkClient.virtualNetworks.listAll(),
      get: async (resourceGroupName, virtualNetworkName) => (
        await networkClient.virtualNetworks.get(resourceGroupName, virtualNetworkName)
      ),
      createOrUpdate: async (resourceGroupName, virtualNetworkName, parameters) => (
        await networkClient.virtualNetworks
          .createOrUpdate(resourceGroupName, virtualNetworkName, parameters)
          .pollUntilDone()
      ),
      delete: async (resourceGroupName, virtualNetworkName) => {
        await networkClient.virtualNetworks
          .delete(resourceGroupName, virtualNetworkName)
          .pollUntilDone();
      },
    },
    subnets: {
      list: (resourceGroupName, virtualNetworkName) => (
        networkClient.subnets.list(resourceGroupName, virtualNetworkName)
      ),
      get: async (resourceGroupName, virtualNetworkName, subnetName) => (
        await networkClient.subnets.get(resourceGroupName, virtualNetworkName, subnetName)
      ),
      createOrUpdate: async (resourceGroupName, virtualNetworkName, subnetName, parameters) => (
        await networkClient.subnets
          .createOrUpdate(resourceGroupName, virtualNetworkName, subnetName, parameters)
          .pollUntilDone()
      ),
      delete: async (resourceGroupName, virtualNetworkName, subnetName) => {
        await networkClient.subnets
          .delete(resourceGroupName, virtualNetworkName, subnetName)
          .pollUntilDone();
      },
    },
    networkSecurityGroups: {
      listAll: () => networkClient.networkSecurityGroups.listAll(),
      get: async (resourceGroupName, networkSecurityGroupName, options) => (
        await networkClient.networkSecurityGroups.get(resourceGroupName, networkSecurityGroupName, options)
      ),
      createOrUpdate: async (resourceGroupName, networkSecurityGroupName, parameters) => (
        await networkClient.networkSecurityGroups
          .createOrUpdate(resourceGroupName, networkSecurityGroupName, parameters)
          .pollUntilDone()
      ),
      delete: async (resourceGroupName, networkSecurityGroupName) => {
        await networkClient.networkSecurityGroups
          .delete(resourceGroupName, networkSecurityGroupName)
          .pollUntilDone();
      },
    },
    securityRules: {
      list: (resourceGroupName, networkSecurityGroupName) => (
        networkClient.securityRules.list(resourceGroupName, networkSecurityGroupName)
      ),
      get: async (resourceGroupName, networkSecurityGroupName, securityRuleName) => (
        await networkClient.securityRules.get(
          resourceGroupName,
          networkSecurityGroupName,
          securityRuleName,
        )
      ),
      createOrUpdate: async (
        resourceGroupName,
        networkSecurityGroupName,
        securityRuleName,
        parameters,
      ) => (
        await networkClient.securityRules
          .createOrUpdate(
            resourceGroupName,
            networkSecurityGroupName,
            securityRuleName,
            parameters,
          )
          .pollUntilDone()
      ),
      delete: async (resourceGroupName, networkSecurityGroupName, securityRuleName) => {
        await networkClient.securityRules
          .delete(resourceGroupName, networkSecurityGroupName, securityRuleName)
          .pollUntilDone();
      },
    },
    publicIpAddresses: {
      listAll: () => networkClient.publicIPAddresses.listAll(),
      get: async (resourceGroupName, publicIpAddressName, options) => (
        await networkClient.publicIPAddresses.get(resourceGroupName, publicIpAddressName, options)
      ),
      createOrUpdate: async (resourceGroupName, publicIpAddressName, parameters) => (
        await networkClient.publicIPAddresses
          .createOrUpdate(resourceGroupName, publicIpAddressName, parameters)
          .pollUntilDone()
      ),
      delete: async (resourceGroupName, publicIpAddressName) => {
        await networkClient.publicIPAddresses
          .delete(resourceGroupName, publicIpAddressName)
          .pollUntilDone();
      },
    },
    networkInterfaces: {
      listAll: () => networkClient.networkInterfaces.listAll(),
      get: async (resourceGroupName, networkInterfaceName, options) => (
        await networkClient.networkInterfaces.get(resourceGroupName, networkInterfaceName, options)
      ),
      createOrUpdate: async (resourceGroupName, networkInterfaceName, parameters) => (
        await networkClient.networkInterfaces
          .createOrUpdate(resourceGroupName, networkInterfaceName, parameters)
          .pollUntilDone()
      ),
      delete: async (resourceGroupName, networkInterfaceName) => {
        await networkClient.networkInterfaces
          .delete(resourceGroupName, networkInterfaceName)
          .pollUntilDone();
      },
    },
    virtualMachines: {
      listAll: () => computeClient.virtualMachines.listAll(),
      get: async (resourceGroupName, virtualMachineName, options) => (
        await computeClient.virtualMachines.get(
          resourceGroupName,
          virtualMachineName,
          { ...options, expand: "instanceView" },
        )
      ),
      createOrUpdate: async (resourceGroupName, virtualMachineName, parameters) => (
        await computeClient.virtualMachines
          .createOrUpdate(resourceGroupName, virtualMachineName, parameters)
          .pollUntilDone()
      ),
      start: async (resourceGroupName, virtualMachineName) => {
        await computeClient.virtualMachines
          .start(resourceGroupName, virtualMachineName)
          .pollUntilDone();
      },
      deallocate: async (resourceGroupName, virtualMachineName) => {
        await computeClient.virtualMachines
          .deallocate(resourceGroupName, virtualMachineName)
          .pollUntilDone();
      },
      restart: async (resourceGroupName, virtualMachineName) => {
        await computeClient.virtualMachines
          .restart(resourceGroupName, virtualMachineName)
          .pollUntilDone();
      },
      delete: async (resourceGroupName, virtualMachineName) => {
        await computeClient.virtualMachines
          .delete(resourceGroupName, virtualMachineName)
          .pollUntilDone();
      },
    },
    disks: {
      list: () => computeClient.disks.list(),
      get: async (resourceGroupName, diskName, options) => await computeClient.disks.get(resourceGroupName, diskName, options),
      update: async (resourceGroupName, diskName, parameters) => (
        await computeClient.disks.update(resourceGroupName, diskName, parameters).pollUntilDone()
      ),
      delete: async (resourceGroupName, diskName) => {
        await computeClient.disks.delete(resourceGroupName, diskName).pollUntilDone();
      },
    },
  };
};

function validateCreateInput(input: AzureVmCreateInput, subscriptionId: string): ValidatedCreateInput {
  const guid = requireDeploymentGuid(input.guid);
  const name = validateDisplayName(input.name);
  const resourceGroupName = validateResourceGroupName(
    input.resourceGroupName ?? `sliver-gui-${guid}`,
  );
  const imageReference = parseImageReference(input.imageReference, subscriptionId);
  const vmSize = validateVmSize(input.vmSize);
  const network = validateNetworkInput(input.network, subscriptionId);
  const sshUsername = validateSshUsername(input.sshUsername);
  const sshPublicKey = validateSshPublicKey(input.sshPublicKey);
  const customData = input.customData === undefined
    ? undefined
    : validateCustomData(input.customData);
  const osDiskSizeGiB = input.osDiskSizeGiB === undefined
    ? 64
    : validateInteger(input.osDiskSizeGiB, "Azure OS disk size", 30, 4_095);
  const firewall = validateFirewallInput(input.firewall);
  if (typeof input.allocatePublicIp !== "boolean") {
    throw new AzureVmProviderError("The Azure public IP selection is invalid.");
  }
  return {
    guid,
    name,
    resourceGroupName,
    imageReference,
    vmSize,
    network,
    sshUsername,
    sshPublicKey,
    ...(customData === undefined ? {} : { customData }),
    osDiskSizeGiB,
    firewall,
    allocatePublicIp: input.allocatePublicIp,
  };
}

function validateNetworkInput(input: AzureVmNetworkInput, subscriptionId: string): AzureVmNetworkInput {
  if (input.mode === "existing") {
    const virtualNetwork = parseExpectedResourceId(
      input.virtualNetworkId,
      subscriptionId,
      "Microsoft.Network",
      ["virtualNetworks"],
      "virtual network",
    );
    const subnet = parseExpectedResourceId(
      input.subnetId,
      subscriptionId,
      "Microsoft.Network",
      ["virtualNetworks", "subnets"],
      "subnet",
    );
    if (virtualNetwork.resourceGroupName.toLowerCase() !== subnet.resourceGroupName.toLowerCase() ||
      virtualNetwork.nameSegments[0]!.toLowerCase() !== subnet.nameSegments[0]!.toLowerCase()) {
      throw new AzureVmProviderError("The selected Azure subnet does not belong to the selected virtual network.");
    }
    return { mode: "existing", virtualNetworkId: virtualNetwork.id, subnetId: subnet.id };
  }
  if (input.mode !== "managed") throw new AzureVmProviderError("The Azure network mode is invalid.");
  const virtualNetwork = parseIpv4Cidr(input.virtualNetworkCidr, "managed virtual network CIDR");
  const subnet = parseIpv4Cidr(input.subnetCidr, "managed subnet CIDR");
  if (subnet.prefix <= virtualNetwork.prefix || !ipv4CidrContains(virtualNetwork, subnet)) {
    throw new AzureVmProviderError("The managed Azure subnet CIDR must be contained by the virtual network CIDR.");
  }
  return {
    mode: "managed",
    virtualNetworkCidr: input.virtualNetworkCidr,
    subnetCidr: input.subnetCidr,
  };
}

function validateFirewallInput(input: AzureVmFirewallInput): AzureVmFirewallInput {
  if (input.sshPort !== AZURE_SSH_PORT) {
    throw new AzureVmProviderError(`Azure deployments require SSH port ${AZURE_SSH_PORT}.`);
  }
  const sshPort = AZURE_SSH_PORT;
  const operatorPort = validateInteger(input.operatorPort, "Azure operator port", 1, 65_535);
  const sshSourceCidrs = validatePrefixList(input.sshSourceCidrs, "SSH source CIDRs");
  const operatorSourceCidrs = validatePrefixList(input.operatorSourceCidrs, "operator source CIDRs");
  if (sshSourceCidrs.length + operatorSourceCidrs.length > BASELINE_PRIORITY_END - BASELINE_PRIORITY_START + 1) {
    throw new AzureVmProviderError("Too many Azure baseline firewall rules were requested.");
  }
  return { sshPort, sshSourceCidrs, operatorPort, operatorSourceCidrs };
}

function validateFirewallRuleSpec(
  input: AzureFirewallRuleSpec,
  allowReserved: boolean,
): AzureFirewallRuleSpec {
  const name = validateSecurityRuleName(input.name, allowReserved);
  const priority = validateInteger(
    input.priority,
    "Azure firewall priority",
    100,
    allowReserved ? 65_500 : 4_096,
  );
  if (!allowReserved && priority >= BASELINE_PRIORITY_START && priority <= BASELINE_PRIORITY_END) {
    throw new AzureVmProviderError("Azure firewall priorities 1000 through 1199 are reserved for baseline access.");
  }
  if (input.direction !== "ingress" && input.direction !== "egress") {
    throw new AzureVmProviderError("The Azure firewall rule direction is invalid.");
  }
  if (input.access !== "allow" && input.access !== "deny") {
    throw new AzureVmProviderError("The Azure firewall rule access is invalid.");
  }
  if (!["tcp", "udp", "icmp", "ah", "esp", "*"].includes(input.protocol)) {
    throw new AzureVmProviderError("The Azure firewall rule protocol is invalid.");
  }
  const sourceAddressPrefixes = validateRuleValueList(
    input.sourceAddressPrefixes,
    "source address prefixes",
    validateAddressPrefix,
  );
  const sourcePortRanges = validateRuleValueList(
    input.sourcePortRanges,
    "source port ranges",
    validatePortRange,
  );
  const destinationAddressPrefixes = validateRuleValueList(
    input.destinationAddressPrefixes,
    "destination address prefixes",
    validateAddressPrefix,
  );
  const destinationPortRanges = validateRuleValueList(
    input.destinationPortRanges,
    "destination port ranges",
    validatePortRange,
  );
  const description = input.description === null
    ? null
    : validateBoundedString(input.description, "Azure firewall description", 0, 140);
  return {
    name,
    priority,
    direction: input.direction,
    access: input.access,
    protocol: input.protocol,
    sourceAddressPrefixes,
    sourcePortRanges,
    destinationAddressPrefixes,
    destinationPortRanges,
    description,
  };
}

function virtualMachineParameters(
  input: ValidatedCreateInput,
  tags: Record<string, string>,
  networkInterfaceId: string,
  osDiskName: string,
  location: string,
): VirtualMachine {
  const imageReference = input.imageReference.kind === "managed"
    ? { id: input.imageReference.id }
    : {
      publisher: input.imageReference.publisher,
      offer: input.imageReference.offer,
      sku: input.imageReference.sku,
      version: input.imageReference.version,
    };
  return {
    location,
    tags,
    hardwareProfile: { vmSize: input.vmSize },
    storageProfile: {
      imageReference,
      osDisk: {
        name: osDiskName,
        createOption: "FromImage",
        deleteOption: "Delete",
        diskSizeGB: input.osDiskSizeGiB,
        caching: "ReadWrite",
        managedDisk: { storageAccountType: "StandardSSD_LRS" },
      },
    },
    osProfile: {
      computerName: resourceName("sliver", input.guid),
      adminUsername: input.sshUsername,
      ...(input.customData === undefined
        ? {}
        : { customData: Buffer.from(input.customData, "utf8").toString("base64") }),
      linuxConfiguration: {
        disablePasswordAuthentication: true,
        provisionVMAgent: true,
        patchSettings: { patchMode: "ImageDefault", assessmentMode: "ImageDefault" },
        ssh: {
          publicKeys: [{
            path: `/home/${input.sshUsername}/.ssh/authorized_keys`,
            keyData: input.sshPublicKey,
          }],
        },
      },
    },
    networkProfile: {
      networkInterfaces: [{ id: networkInterfaceId, primary: true, deleteOption: "Detach" }],
    },
  };
}

function provisionalDeploymentResource(
  resource: Pick<
    AzureVmDeploymentResource,
    | "subscriptionId"
    | "tenantId"
    | "location"
    | "guid"
    | "name"
    | "resourceGroupId"
    | "virtualNetworkId"
    | "subnetId"
    | "managedNetwork"
    | "networkSecurityGroupId"
  >,
): AzureVmDeploymentResource {
  const placeholder = buildProviderResourceId(
    resource.subscriptionId,
    parseResourceGroupId(resource.resourceGroupId, resource.subscriptionId, "resource group").resourceGroupName,
    "Microsoft.Compute",
    ["virtualMachines"],
    [resourceName("sliver-vm", resource.guid)],
  );
  return {
    ...resource,
    networkInterfaceId: buildProviderResourceId(
      resource.subscriptionId,
      parseResourceGroupId(resource.resourceGroupId, resource.subscriptionId, "resource group").resourceGroupName,
      "Microsoft.Network",
      ["networkInterfaces"],
      [resourceName("sliver-nic", resource.guid)],
    ),
    virtualMachineId: placeholder,
    osDiskId: buildProviderResourceId(
      resource.subscriptionId,
      parseResourceGroupId(resource.resourceGroupId, resource.subscriptionId, "resource group").resourceGroupName,
      "Microsoft.Compute",
      ["disks"],
      [resourceName("sliver-os", resource.guid)],
    ),
    instanceState: "creating",
  };
}

function baselineFirewallRules(
  input: AzureVmFirewallInput,
  guid: string,
): AzureFirewallRuleSpec[] {
  let priority = BASELINE_PRIORITY_START;
  const rules: AzureFirewallRuleSpec[] = [];
  for (const [index, sourceAddressPrefix] of input.sshSourceCidrs.entries()) {
    rules.push({
      name: `sliver-gui-ssh-${String(index + 1).padStart(3, "0")}`,
      priority: priority++,
      direction: "ingress",
      access: "allow",
      protocol: "tcp",
      sourceAddressPrefixes: [sourceAddressPrefix],
      sourcePortRanges: ["*"],
      destinationAddressPrefixes: ["*"],
      destinationPortRanges: [String(input.sshPort)],
      description: `sliver-gui:${guid}:baseline:ssh`,
    });
  }
  for (const [index, sourceAddressPrefix] of input.operatorSourceCidrs.entries()) {
    rules.push({
      name: `sliver-gui-operator-${String(index + 1).padStart(3, "0")}`,
      priority: priority++,
      direction: "ingress",
      access: "allow",
      protocol: "tcp",
      sourceAddressPrefixes: [sourceAddressPrefix],
      sourcePortRanges: ["*"],
      destinationAddressPrefixes: ["*"],
      destinationPortRanges: [String(input.operatorPort)],
      description: `sliver-gui:${guid}:baseline:operator`,
    });
  }
  return rules;
}

function firewallRuleParameters(spec: AzureFirewallRuleSpec): SecurityRule {
  return {
    ...(spec.description === null ? {} : { description: spec.description }),
    protocol: azureProtocol(spec.protocol),
    ...azureRuleValues(spec.sourcePortRanges, "sourcePortRange", "sourcePortRanges"),
    ...azureRuleValues(spec.destinationPortRanges, "destinationPortRange", "destinationPortRanges"),
    ...azureRuleValues(spec.sourceAddressPrefixes, "sourceAddressPrefix", "sourceAddressPrefixes"),
    ...azureRuleValues(spec.destinationAddressPrefixes, "destinationAddressPrefix", "destinationAddressPrefixes"),
    access: spec.access === "allow" ? "Allow" : "Deny",
    priority: spec.priority,
    direction: spec.direction === "ingress" ? "Inbound" : "Outbound",
  };
}

function azureRuleValues(
  values: readonly string[],
  singularKey: "sourcePortRange" | "destinationPortRange" | "sourceAddressPrefix" | "destinationAddressPrefix",
  pluralKey: "sourcePortRanges" | "destinationPortRanges" | "sourceAddressPrefixes" | "destinationAddressPrefixes",
): Partial<SecurityRule> {
  return values.length === 1
    ? { [singularKey]: values[0] }
    : { [pluralKey]: [...values] };
}

function normalizeFirewallRule(
  rule: SecurityRule,
  networkSecurityGroupId: string,
  isDefault: boolean,
): AzureFirewallRule {
  const name = validateSecurityRuleName(requirePresent(rule.name, "Azure firewall rule name"), true);
  const collection = isDefault ? "defaultSecurityRules" : "securityRules";
  const expectedId = `${networkSecurityGroupId}/${collection}/${name}`;
  if (rule.id !== undefined) assertResourceId(rule.id, expectedId, "firewall rule");
  const description = normalizeOptionalAzureString(rule.description, "firewall rule description", 140) ?? null;
  const priority = validateInteger(
    requirePresent(rule.priority, "Azure firewall rule priority"),
    "Azure firewall priority",
    100,
    65_500,
  );
  const direction = normalizeFirewallDirection(rule.direction);
  const access = normalizeFirewallAccess(rule.access);
  const protocol = normalizeFirewallProtocol(rule.protocol);
  const sourceAddresses = normalizeRuleValues(
    rule.sourceAddressPrefix,
    rule.sourceAddressPrefixes,
    "source address prefixes",
    validateAddressPrefix,
  );
  const sourcePorts = normalizeRuleValues(
    rule.sourcePortRange,
    rule.sourcePortRanges,
    "source port ranges",
    validatePortRange,
  );
  const destinationAddresses = normalizeRuleValues(
    rule.destinationAddressPrefix,
    rule.destinationAddressPrefixes,
    "destination address prefixes",
    validateAddressPrefix,
  );
  const destinationPorts = normalizeRuleValues(
    rule.destinationPortRange,
    rule.destinationPortRanges,
    "destination port ranges",
    validatePortRange,
  );
  const sourceApplicationSecurityGroupIds = normalizeApplicationSecurityGroupIds(
    rule.sourceApplicationSecurityGroups,
    "source application security groups",
  );
  const destinationApplicationSecurityGroupIds = normalizeApplicationSecurityGroupIds(
    rule.destinationApplicationSecurityGroups,
    "destination application security groups",
  );
  if (sourcePorts.values.length === 0 || destinationPorts.values.length === 0) {
    throw new AzureVmProviderError("Azure returned a firewall rule without required port ranges.");
  }
  if (sourceAddresses.values.length === 0 && sourceApplicationSecurityGroupIds.length === 0) {
    throw new AzureVmProviderError("Azure returned a firewall rule without a source address or application security group.");
  }
  if (destinationAddresses.values.length === 0 && destinationApplicationSecurityGroupIds.length === 0) {
    throw new AzureVmProviderError("Azure returned a firewall rule without a destination address or application security group.");
  }
  const editUnsupportedReasons = [
    sourceApplicationSecurityGroupIds.length > 0 || destinationApplicationSecurityGroupIds.length > 0
      ? "Rules that reference Azure application security groups can be viewed and deleted here, but cannot be edited."
      : null,
    sourceAddresses.usedSingularAndPlural || sourcePorts.usedSingularAndPlural ||
      destinationAddresses.usedSingularAndPlural || destinationPorts.usedSingularAndPlural
      ? "Azure returned both singular and plural values for this rule, so it cannot be edited safely."
      : null,
  ].filter((reason): reason is string => reason !== null);
  return {
    name,
    priority,
    direction,
    access,
    protocol,
    sourceAddressPrefixes: sourceAddresses.values,
    sourcePortRanges: sourcePorts.values,
    destinationAddressPrefixes: destinationAddresses.values,
    destinationPortRanges: destinationPorts.values,
    description,
    id: expectedId,
    managed: !isDefault,
    isDefault,
    sourceApplicationSecurityGroupIds,
    destinationApplicationSecurityGroupIds,
    editUnsupportedReason: editUnsupportedReasons.length > 0 ? editUnsupportedReasons.join(" ") : null,
  };
}

function normalizeRuleValues(
  singular: string | undefined,
  plural: string[] | undefined,
  label: string,
  validate: (value: string, label: string) => string,
): { readonly values: readonly string[]; readonly usedSingularAndPlural: boolean } {
  if (plural && plural.length > AZURE_FIREWALL_RULE_MAX_VALUES) {
    throw new AzureVmProviderError(`Azure returned too many ${label}.`);
  }
  const values = [
    ...(singular === undefined ? [] : [validate(singular, label)]),
    ...(plural ?? []).map((value) => validate(value, label)),
  ];
  return {
    values: Object.freeze(values),
    usedSingularAndPlural: singular !== undefined && Boolean(plural?.length),
  };
}

function normalizeApplicationSecurityGroupIds(
  groups: readonly { readonly id?: string }[] | undefined,
  label: string,
): readonly string[] {
  if (!groups) return Object.freeze([]);
  if (groups.length > AZURE_FIREWALL_RULE_MAX_VALUES) {
    throw new AzureVmProviderError(`Azure returned too many ${label}.`);
  }
  return Object.freeze(groups.map((group) => {
    const id = requirePresent(group.id, `Azure ${label} ID`);
    const parsed = parseAzureResourceId(id, "application security group");
    if (parsed.provider.toLowerCase() !== "microsoft.network" ||
      parsed.typeSegments.length !== 1 ||
      parsed.typeSegments[0]?.toLowerCase() !== "applicationsecuritygroups") {
      throw new AzureVmProviderError(`The Azure ${label} ID is not an application security group.`);
    }
    return parsed.id;
  }));
}

function isBaselineRule(rule: AzureFirewallRule, guid: string): boolean {
  return isBaselineDescription(rule.description, guid) && (
    rule.name.startsWith("sliver-gui-ssh-") || rule.name.startsWith("sliver-gui-operator-")
  );
}

function isBaselineDescription(description: string | null, guid: string): boolean {
  return description === `sliver-gui:${guid}:baseline:ssh` ||
    description === `sliver-gui:${guid}:baseline:operator`;
}

function normalizeVmSizeOptions(values: readonly ResourceSku[], location: string): AzureVmSizeOption[] {
  const normalized = values.flatMap((sku): AzureVmSizeOption[] => {
    if (sku.resourceType?.toLowerCase() !== "virtualmachines" || !sku.name) return [];
    if (!(sku.locations ?? []).some((candidate) => candidate.toLowerCase() === location)) return [];
    if (sku.restrictions?.some((restriction) => restriction.type === "Location" && (
      restriction.values?.some((candidate) => candidate.toLowerCase() === location) ||
      restriction.restrictionInfo?.locations?.some((candidate) => candidate.toLowerCase() === location)
    ))) return [];
    const capabilities = new Map(
      (sku.capabilities ?? []).flatMap((capability) => (
        capability.name && capability.value ? [[capability.name.toLowerCase(), capability.value] as const] : []
      )),
    );
    const architecture = normalizeArchitecture(capabilities.get("cpuarchitecturetype"));
    const vCpuCount = parsePositiveCapability(capabilities.get("vcpus"));
    const memoryGiB = parsePositiveCapability(capabilities.get("memorygb"));
    if (!architecture || vCpuCount === undefined || memoryGiB === undefined) return [];
    return [{
      name: validateVmSize(sku.name),
      architecture,
      vCpuCount,
      memoryMiB: Math.round(memoryGiB * 1_024),
      maxDataDiskCount: parseNonNegativeCapability(capabilities.get("maxdatadiskcount")) ?? 0,
      osDiskSizeMiB: parseNonNegativeCapability(capabilities.get("osvhdsizeMB".toLowerCase())) ?? 0,
      premiumIo: capabilities.get("premiumio")?.toLowerCase() === "true",
    }];
  });
  return uniqueBy(normalized, (value) => value.name.toLowerCase())
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeVirtualNetworkOption(
  value: VirtualNetwork,
  subscriptionId: string,
  location: string,
): AzureVirtualNetworkOption[] {
  if (!value.id || !value.name || value.location?.toLowerCase() !== location) return [];
  const parsed = parseExpectedResourceId(
    value.id,
    subscriptionId,
    "Microsoft.Network",
    ["virtualNetworks"],
    "virtual network",
  );
  if (parsed.nameSegments[0]!.toLowerCase() !== value.name.toLowerCase()) {
    throw new AzureVmProviderError("Azure returned an inconsistent virtual network name.");
  }
  return [{
    id: parsed.id,
    name: value.name,
    resourceGroupName: parsed.resourceGroupName,
    location,
    addressPrefixes: validateReturnedPrefixes(value.addressSpace?.addressPrefixes, "virtual network"),
  }];
}

function normalizeSubnetOption(
  value: Subnet,
  virtualNetwork: AzureVirtualNetworkOption,
  subscriptionId: string,
): AzureSubnetOption[] {
  if (!value.id || !value.name) return [];
  const parsed = parseExpectedResourceId(
    value.id,
    subscriptionId,
    "Microsoft.Network",
    ["virtualNetworks", "subnets"],
    "subnet",
  );
  if (parsed.resourceGroupName.toLowerCase() !== virtualNetwork.resourceGroupName.toLowerCase() ||
    parsed.nameSegments[0]!.toLowerCase() !== virtualNetwork.name.toLowerCase() ||
    parsed.nameSegments[1]!.toLowerCase() !== value.name.toLowerCase()) {
    throw new AzureVmProviderError("Azure returned a subnet outside its requested virtual network.");
  }
  return [{
    id: parsed.id,
    name: value.name,
    resourceGroupName: parsed.resourceGroupName,
    virtualNetworkName: parsed.nameSegments[0]!,
    addressPrefixes: validateReturnedPrefixes(subnetAddressPrefixes(value), "subnet"),
  }];
}

function normalizeInstanceState(virtualMachine: VirtualMachine): AzureVmInstanceState {
  const powerState = virtualMachine.instanceView?.statuses
    ?.map((status) => status.code?.toLowerCase())
    .find((code) => code?.startsWith("powerstate/"));
  switch (powerState) {
    case "powerstate/creating": return "creating";
    case "powerstate/running": return "running";
    case "powerstate/deallocated": return "deallocated";
    case "powerstate/deallocating": return "deallocating";
    case "powerstate/starting": return "starting";
    case "powerstate/stopping": return "stopping";
    case "powerstate/stopped": return "stopped";
    default:
      return virtualMachine.provisioningState?.toLowerCase() === "failed" ? "failed" : "unknown";
  }
}

function parseImageReference(value: string, subscriptionId: string): ParsedImageReference {
  const normalized = validateBoundedString(value, "Azure image reference", 1, MAX_ARM_ID_LENGTH);
  if (normalized.startsWith("/")) {
    const parsed = parseExpectedResourceId(
      normalized,
      subscriptionId,
      "Microsoft.Compute",
      ["images"],
      "managed image",
    );
    return { kind: "managed", id: parsed.id };
  }
  const parts = normalized.split(":");
  if (parts.length !== 4 || parts.some((part) => !IMAGE_URN_PART_PATTERN.test(part))) {
    throw new AzureVmProviderError("The Azure platform image reference is invalid.");
  }
  const option = AZURE_UBUNTU_IMAGE_OPTIONS.find((candidate) => candidate.id === normalized);
  return {
    kind: "platform",
    id: normalized,
    publisher: parts[0]!,
    offer: parts[1]!,
    sku: parts[2]!,
    version: parts[3]!,
    ...(option ? { architecture: option.architecture } : {}),
  };
}

function parseExpectedResourceId(
  value: string,
  subscriptionId: string,
  provider: string,
  typeSegments: readonly string[],
  label: string,
): ParsedResourceId {
  const parsed = parseAzureResourceId(value, label);
  if (parsed.subscriptionId.toLowerCase() !== subscriptionId.toLowerCase() ||
    parsed.provider.toLowerCase() !== provider.toLowerCase() ||
    parsed.typeSegments.length !== typeSegments.length ||
    !parsed.typeSegments.every((segment, index) => segment.toLowerCase() === typeSegments[index]!.toLowerCase())) {
    throw new AzureVmProviderError(`The Azure ${label} ID is outside the expected subscription or resource type.`);
  }
  return parsed;
}

function parseAzureResourceId(value: string, label: string): ParsedResourceId {
  const id = validateBoundedString(value, `Azure ${label} ID`, 1, MAX_ARM_ID_LENGTH);
  if (!id.startsWith("/") || id.endsWith("/") || id.includes("//")) {
    throw new AzureVmProviderError(`The Azure ${label} ID is invalid.`);
  }
  const segments = id.split("/").slice(1);
  if (segments.length < 8 || segments.length % 2 !== 0 ||
    segments[0]?.toLowerCase() !== "subscriptions" ||
    segments[2]?.toLowerCase() !== "resourcegroups" ||
    segments[4]?.toLowerCase() !== "providers") {
    throw new AzureVmProviderError(`The Azure ${label} ID is invalid.`);
  }
  const actualSubscriptionId = requireAzureIdentifier(segments[1]!, `Azure ${label} subscription ID`);
  const resourceGroupName = validateResourceGroupName(segments[3]!);
  const provider = validateBoundedString(segments[5]!, `Azure ${label} provider`, 1, 128);
  const typeSegments: string[] = [];
  const nameSegments: string[] = [];
  for (let index = 6; index < segments.length; index += 2) {
    typeSegments.push(validateBoundedString(segments[index]!, `Azure ${label} resource type`, 1, 128));
    nameSegments.push(validateResourceName(segments[index + 1]!, label));
  }
  return {
    id,
    subscriptionId: actualSubscriptionId,
    resourceGroupName,
    provider,
    typeSegments,
    nameSegments,
  };
}

function parseResourceGroupId(value: string, subscriptionId: string, label: string): ParsedResourceId {
  const id = validateBoundedString(value, `Azure ${label} ID`, 1, MAX_ARM_ID_LENGTH);
  const segments = id.split("/");
  if (segments.length !== 5 || segments[0] !== "" ||
    segments[1]?.toLowerCase() !== "subscriptions" ||
    segments[3]?.toLowerCase() !== "resourcegroups") {
    throw new AzureVmProviderError(`The Azure ${label} ID is invalid.`);
  }
  const actualSubscriptionId = requireAzureIdentifier(segments[2]!, `Azure ${label} subscription ID`);
  if (actualSubscriptionId.toLowerCase() !== subscriptionId.toLowerCase()) {
    throw new AzureVmProviderError(`The Azure ${label} ID is outside the expected subscription.`);
  }
  return {
    id,
    subscriptionId: actualSubscriptionId,
    resourceGroupName: validateResourceGroupName(segments[4]!),
    provider: "",
    typeSegments: [],
    nameSegments: [],
  };
}

function buildResourceGroupId(subscriptionId: string, resourceGroupName: string): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}`;
}

function buildProviderResourceId(
  subscriptionId: string,
  resourceGroupName: string,
  provider: string,
  typeSegments: readonly string[],
  nameSegments: readonly string[],
): string {
  if (typeSegments.length !== nameSegments.length || typeSegments.length === 0) {
    throw new AzureVmProviderError("The Azure resource ID components are invalid.");
  }
  return `${buildResourceGroupId(subscriptionId, resourceGroupName)}/providers/${provider}/${
    typeSegments.flatMap((type, index) => [type, nameSegments[index]!]).join("/")
  }`;
}

function managedTags(guid: string, name: string): Record<string, string> {
  return {
    [AZURE_MANAGED_TAG_KEY]: AZURE_MANAGED_TAG_VALUE,
    [AZURE_GUID_TAG_KEY]: guid,
    [AZURE_NAME_TAG_KEY]: name,
  };
}

function assertOwnedResource(
  resource: { readonly id?: string; readonly tags?: Record<string, string> },
  expectedId: string,
  guid: string,
  label: string,
): void {
  assertResourceId(resource.id, expectedId, label);
  if (resource.tags?.[AZURE_MANAGED_TAG_KEY] !== AZURE_MANAGED_TAG_VALUE ||
    resource.tags[AZURE_GUID_TAG_KEY] !== guid) {
    throw new AzureVmProviderError(
      `Refusing to modify the Azure ${label}: its Sliver GUI ownership tags do not match.`,
    );
  }
}

function assertResourceId(value: string | undefined, expectedId: string, label: string): void {
  if (!value || value.toLowerCase() !== expectedId.toLowerCase()) {
    throw new AzureVmProviderError(`Azure returned an unexpected ${label} ID.`);
  }
}

function assertAddressPrefix(
  actual: readonly string[] | undefined,
  expected: string,
  label: string,
): void {
  if (!actual || actual.length !== 1 || actual[0] !== expected) {
    throw new AzureVmProviderError(`The managed Azure ${label} address prefix does not match.`);
  }
}

function validateResourceScope(
  resource: Pick<AzureVmDeploymentResource, "subscriptionId" | "tenantId" | "location">,
  subscriptionId: string,
  tenantId: string,
  location: string,
): void {
  if (requireAzureIdentifier(resource.subscriptionId, "tracked Azure subscription ID") !== subscriptionId ||
    requireAzureIdentifier(resource.tenantId, "tracked Azure tenant ID") !== tenantId ||
    validateLocation(resource.location) !== location) {
    throw new AzureVmProviderError("The Azure deployment belongs to a different credential scope.");
  }
}

function resourceName(prefix: string, guid: string): string {
  return validateResourceName(`${prefix}-${guid}`, prefix);
}

function validateResourceGroupName(value: string): string {
  if (!RESOURCE_GROUP_PATTERN.test(value)) {
    throw new AzureVmProviderError("The Azure resource group name is invalid.");
  }
  return value;
}

function validateResourceName(value: string, label: string): string {
  if (!RESOURCE_NAME_PATTERN.test(value)) {
    throw new AzureVmProviderError(`The Azure ${label} name is invalid.`);
  }
  return value;
}

function validateSecurityRuleName(value: string, allowReserved: boolean): string {
  if (!SECURITY_RULE_NAME_PATTERN.test(value)) {
    throw new AzureVmProviderError("The Azure firewall rule name is invalid.");
  }
  if (!allowReserved && (value.startsWith("sliver-gui-ssh-") || value.startsWith("sliver-gui-operator-"))) {
    throw new AzureVmProviderError("That Azure firewall rule name is reserved for baseline access.");
  }
  return value;
}

function validateLocation(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized !== value || !LOCATION_PATTERN.test(value)) {
    throw new AzureVmProviderError("The Azure location is invalid.");
  }
  return normalized;
}

function validateVmSize(value: string): string {
  if (!VM_SIZE_PATTERN.test(value)) throw new AzureVmProviderError("The Azure VM size is invalid.");
  return value;
}

function validateDisplayName(value: string): string {
  return validateBoundedString(value, "deployment name", 1, 128);
}

function validateSshUsername(value: string): string {
  if (!isAzureSshUsername(value)) {
    throw new AzureVmProviderError("The Azure Linux SSH username is invalid or reserved.");
  }
  return value;
}

function validateSshPublicKey(value: string): string {
  const validated = validateBoundedUtf8(value, "SSH public key", MAX_SSH_PUBLIC_KEY_BYTES);
  const match = /^(ssh-ed25519|ssh-rsa) ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/u.exec(validated);
  if (!match) throw new AzureVmProviderError("The Azure SSH public key must be OpenSSH RSA or ED25519 format.");
  try {
    if (Buffer.from(match[2]!, "base64").length < 16) throw new Error("short key");
  } catch {
    throw new AzureVmProviderError("The Azure SSH public key is invalid.");
  }
  return validated;
}

function validateCustomData(value: string): string {
  if (typeof value !== "string" || value.length < 1 ||
    Buffer.byteLength(value, "utf8") > MAX_CUSTOM_DATA_BYTES ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cf}]/u.test(value)) {
    throw new AzureVmProviderError("The Azure custom data is invalid.");
  }
  return value;
}

function validatePrefixList(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values) || values.length > MAX_FIREWALL_PREFIXES) {
    throw new AzureVmProviderError(`The Azure ${label} list is invalid.`);
  }
  const normalized = values.map((value) => validateIpCidr(value, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new AzureVmProviderError(`The Azure ${label} list contains duplicates.`);
  }
  return normalized;
}

function validateRuleValueList(
  values: readonly string[],
  label: string,
  validate: (value: string, label: string) => string,
): readonly string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > AZURE_FIREWALL_RULE_MAX_VALUES) {
    throw new AzureVmProviderError(`The Azure ${label} list is invalid.`);
  }
  return Object.freeze(values.map((value) => validate(value, label)));
}

function validateIpCidr(value: string, label: string): string {
  const parts = value.split("/");
  if (parts.length !== 2 || isIP(parts[0]!) === 0 || !/^\d{1,3}$/u.test(parts[1]!)) {
    throw new AzureVmProviderError(`The Azure ${label} must contain valid IP CIDRs.`);
  }
  const family = isIP(parts[0]!);
  const prefix = Number(parts[1]);
  if (prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
    throw new AzureVmProviderError(`The Azure ${label} must contain valid IP CIDRs.`);
  }
  return value;
}

function validateAddressPrefix(value: string, label: string): string {
  const validated = validateBoundedString(value, `Azure ${label}`, 1, 128);
  if (validated === "*" || isIP(validated) !== 0 || validated.includes("/") && isValidCidr(validated) ||
    SERVICE_TAG_PATTERN.test(validated)) return validated;
  throw new AzureVmProviderError(`The Azure ${label} is invalid.`);
}

function validatePortRange(value: string, label: string): string {
  const validated = validateBoundedString(value, `Azure ${label}`, 1, 11);
  if (validated === "*") return validated;
  const match = /^(\d{1,5})(?:-(\d{1,5}))?$/u.exec(validated);
  if (!match) throw new AzureVmProviderError(`The Azure ${label} is invalid.`);
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (start < 0 || end > 65_535 || start > end) {
    throw new AzureVmProviderError(`The Azure ${label} is invalid.`);
  }
  return validated;
}

function parseIpv4Cidr(value: string, label: string): { readonly address: number; readonly prefix: number } {
  validateIpCidr(value, label);
  const [addressValue, prefixValue] = value.split("/");
  if (isIP(addressValue!) !== 4) throw new AzureVmProviderError(`The Azure ${label} must use IPv4.`);
  const prefix = Number(prefixValue);
  const address = ipv4Number(addressValue!);
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  if ((address & mask) !== address) {
    throw new AzureVmProviderError(`The Azure ${label} must use a canonical network address.`);
  }
  return { address, prefix };
}

function ipv4CidrContains(
  parent: { readonly address: number; readonly prefix: number },
  child: { readonly address: number; readonly prefix: number },
): boolean {
  const mask = parent.prefix === 0 ? 0 : (0xffff_ffff << (32 - parent.prefix)) >>> 0;
  return (parent.address & mask) === (child.address & mask);
}

function ipv4Number(value: string): number {
  return value.split(".").reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

function isValidCidr(value: string): boolean {
  try {
    validateIpCidr(value, "address prefix");
    return true;
  } catch {
    return false;
  }
}

function validateReturnedPrefixes(values: readonly string[] | undefined, label: string): readonly string[] {
  if (!values) return [];
  if (values.length > 256) throw new AzureVmProviderError(`Azure returned too many ${label} address prefixes.`);
  return values.map((value) => validateIpCidr(value, `${label} address prefixes`));
}

function subnetAddressPrefixes(subnet: Subnet): readonly string[] | undefined {
  if (subnet.addressPrefixes && subnet.addressPrefixes.length > 0) return subnet.addressPrefixes;
  return subnet.addressPrefix ? [subnet.addressPrefix] : undefined;
}

function requireAzureIdentifier(value: string, label: string): string {
  if (!AZURE_IDENTIFIER_PATTERN.test(value)) {
    throw new AzureVmProviderError(`The ${label} is invalid.`);
  }
  return value.toLowerCase();
}

function requireDeploymentGuid(value: string): string {
  if (!DEPLOYMENT_GUID_PATTERN.test(value)) {
    throw new AzureVmProviderError("The deployment GUID is invalid.");
  }
  return value.toLowerCase();
}

function validateInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AzureVmProviderError(`The ${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function validateBoundedUtf8(value: string, label: string, maximumBytes: number): string {
  const validated = validateBoundedString(value, label, 1, maximumBytes);
  if (Buffer.byteLength(validated, "utf8") > maximumBytes) {
    throw new AzureVmProviderError(`The ${label} is too large.`);
  }
  return validated;
}

function validateBoundedString(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < minimum ||
    value.length > maximum || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new AzureVmProviderError(`The ${label} is invalid.`);
  }
  return value;
}

function normalizeOptionalAzureString(
  value: string | undefined,
  label: string,
  maximum: number,
): string | undefined {
  return value === undefined ? undefined : validateBoundedString(value, `Azure ${label}`, 1, maximum);
}

function validateOptionalIp(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (isIP(value) === 0) throw new AzureVmProviderError(`Azure returned an invalid ${label}.`);
  return value;
}

function normalizeArchitecture(value: string | undefined): AzureVmArchitecture | undefined {
  switch (value?.toLowerCase()) {
    case "x64":
    case "x86_64":
    case "amd64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      return undefined;
  }
}

function parsePositiveCapability(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+(?:\.\d+)?$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeCapability(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+(?:\.\d+)?$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeFirewallDirection(value: string | undefined): AzureFirewallDirection {
  if (value === "Inbound") return "ingress";
  if (value === "Outbound") return "egress";
  throw new AzureVmProviderError("Azure returned an invalid firewall rule direction.");
}

function normalizeFirewallAccess(value: string | undefined): AzureFirewallAccess {
  if (value === "Allow") return "allow";
  if (value === "Deny") return "deny";
  throw new AzureVmProviderError("Azure returned an invalid firewall rule access.");
}

function normalizeFirewallProtocol(value: string | undefined): AzureFirewallProtocol {
  switch (value) {
    case "Tcp": return "tcp";
    case "Udp": return "udp";
    case "Icmp": return "icmp";
    case "Ah": return "ah";
    case "Esp": return "esp";
    case "*": return "*";
    default: throw new AzureVmProviderError("Azure returned an invalid firewall rule protocol.");
  }
}

function azureProtocol(value: AzureFirewallProtocol): string {
  switch (value) {
    case "tcp": return "Tcp";
    case "udp": return "Udp";
    case "icmp": return "Icmp";
    case "ah": return "Ah";
    case "esp": return "Esp";
    case "*": return "*";
  }
}

function compareAzureOptions(
  left: { readonly name: string; readonly id: string },
  right: { readonly name: string; readonly id: string },
): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function compareFirewallRules(left: AzureFirewallRule, right: AzureFirewallRule): number {
  return left.priority - right.priority || left.name.localeCompare(right.name);
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const actual = key(value);
    if (seen.has(actual)) return false;
    seen.add(actual);
    return true;
  });
}

function optionalString<Key extends string>(key: Key, value: string | undefined): { [K in Key]?: string } {
  return value === undefined ? {} : { [key]: value } as { [K in Key]?: string };
}

function requirePresent<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null) throw new AzureVmProviderError(`Azure did not return the ${label}.`);
  return value;
}

async function notifyCreateMutation(
  listener: AzureVmCreateMutationListener | undefined,
  phase: AzureVmCreatePhase,
  resources: AzureVmCreateMutationResources,
): Promise<void> {
  await listener?.({ phase, resources });
}

function isAzureNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { readonly statusCode?: unknown; readonly code?: unknown; readonly name?: unknown };
  return candidate.statusCode === 404 || candidate.code === "ResourceNotFound" ||
    candidate.code === "ResourceGroupNotFound" || candidate.name === "ResourceNotFoundError";
}

function isAzureForbidden(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { readonly statusCode?: unknown; readonly code?: unknown };
  if (typeof candidate.statusCode === "number") return candidate.statusCode === 403;
  return candidate.code === "AuthorizationFailed" || candidate.code === "Forbidden";
}

function sanitizeAzureError(operation: string, error: unknown): AzureVmProviderError {
  if (error instanceof AzureVmProviderError) return error;
  if (!error || typeof error !== "object") {
    return new AzureVmProviderError(`Azure could not ${operation}.`);
  }
  const candidate = error as {
    readonly code?: unknown;
    readonly name?: unknown;
    readonly statusCode?: unknown;
  };
  if (candidate.name === "AzureBrowserLoginError" || candidate.name === "CredentialUnavailableError" || candidate.name === "AuthenticationRequiredError") {
    return new AzureVmProviderError(`Azure could not ${operation}. Use Azure Login to renew this credential, or refresh its Azure CLI sign-in, and try again.`);
  }
  const code = typeof candidate.code === "string" && /^[A-Za-z0-9_.\-]{1,128}$/u.test(candidate.code)
    ? candidate.code
    : typeof candidate.name === "string" && /^[A-Za-z0-9_.\-]{1,128}$/u.test(candidate.name)
      ? candidate.name
      : undefined;
  const statusCode = typeof candidate.statusCode === "number" &&
    Number.isInteger(candidate.statusCode) && candidate.statusCode >= 100 && candidate.statusCode <= 599
    ? candidate.statusCode
    : undefined;
  const details = [code, statusCode === undefined ? undefined : `HTTP ${statusCode}`]
    .filter((value): value is string => value !== undefined)
    .join(", ");
  return new AzureVmProviderError(`Azure could not ${operation}${details ? ` (${details})` : ""}.`);
}
