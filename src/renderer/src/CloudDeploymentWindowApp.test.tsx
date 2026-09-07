import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toast, toast } from "@heroui/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AwsCloudDeploymentRecord,
  AwsFirewallSnapshot,
  CreateCloudCredentialInput,
  CreateCloudDeploymentInput,
  ProxmoxCloudDeploymentRecord,
} from "../../shared/cloud-deployment-contracts";
import type {
  CloudDeploymentAPI,
  CloudDeploymentChangeScope,
  CloudDeploymentNavigationRequest,
  CloudDeploymentSnapshot,
  CurrentEgressIpv4,
} from "../../shared/cloud-deployment-ipc";
import type { AwsDeploymentOptions, DiscoverAwsOptionsInput } from "../../shared/cloud-provider-inventory";
import type { OperationResult } from "../../shared/contracts";
import type { SshHostKeyReview, SshOpenTabResult } from "../../shared/ssh-contracts";
import { CloudDeploymentWindowApp } from "./CloudDeploymentWindowApp";

vi.mock("./components/CloudProvisioningTerminal", () => ({
  CloudProvisioningTerminal: ({ transcript }: {
    readonly transcript?: CloudDeploymentSnapshot["provisioningTranscripts"][number];
  }) => (
    <div aria-label="Mock read-only SSH provisioning terminal" data-read-only="true">
      {transcript && transcript.chunks.length > 0
        ? transcript.chunks.map(({ bytes }) => new TextDecoder().decode(bytes)).join("")
        : "Waiting for SSH"}
    </div>
  ),
}));

const CREDENTIAL_ID = "0f24a4da-28c1-4d94-a66d-eb224892745d";
const DEPLOYMENT_ID = "a48987b1-7b88-46dc-b72b-7f34dd5e0e92";
const KEY_TOKEN = "2b1cbf1a-6861-4db8-a39d-ffbdad8087f8";
const SSH_REVIEW_TOKEN = "r".repeat(43);

let currentSnapshot: CloudDeploymentSnapshot;
let themeListener: ((dark: boolean) => void) | undefined;
let changedListener: ((scope: CloudDeploymentChangeScope) => void) | undefined;
let navigationListener: ((request: CloudDeploymentNavigationRequest) => void) | undefined;
let capturedCredential: CreateCloudCredentialInput | undefined;
let capturedDeployment: CreateCloudDeploymentInput | undefined;
let currentFirewallSnapshot: AwsFirewallSnapshot;
const unsubscribeTheme = vi.fn();
const unsubscribeChanged = vi.fn();
const unsubscribeNavigation = vi.fn();

const awsCredential = {
  id: CREDENTIAL_ID,
  provider: "aws" as const,
  label: "Production AWS",
  persistence: "secure" as const,
  createdAt: "2026-09-06T18:00:00.000Z",
  defaultRegion: "us-east-1",
  sshUsername: "ubuntu",
};

const runningDeployment: AwsCloudDeploymentRecord = {
  id: DEPLOYMENT_ID,
  provider: "aws",
  name: "range-control",
  credentialId: CREDENTIAL_ID,
  status: "running",
  phase: "ready",
  createdAt: "2026-09-06T18:00:00.000Z",
  updatedAt: "2026-09-06T18:05:00.000Z",
  operatorConfigFileName: "sliver-gui-cloud-range.cfg",
  operatorConfigDigest: "a".repeat(64),
  remoteHost: "198.51.100.24",
  lastError: null,
  managedAssets: [{ resourceType: "ec2-instance", resourceId: "i-abc123", displayName: "range-control", tagged: true }],
  spec: {
    region: "us-east-1",
    imageId: "ami-0123456789abcdef0",
    instanceType: "t3.small",
    subnetId: "subnet-0123456789abcdef0",
    vpcId: "vpc-0123456789abcdef0",
    networkMode: "existing",
    managedVpcCidr: null,
    managedSubnetCidr: null,
    sshKeyMode: "managed",
    existingKeyPairName: null,
    sshUsername: "ubuntu",
    keyPairName: "operator-key",
    operatorName: "operator",
    sshPort: 22,
    multiplayerPort: 31337,
    volumeSizeGiB: 20,
    useElasticIp: true,
    sshCidrs: ["203.0.113.8/32"],
    operatorCidrs: ["203.0.113.8/32"],
  },
  runtime: {
    instanceId: "i-abc123",
    instanceState: "running",
    instanceHealth: "ok",
    systemHealth: "ok",
    securityGroupIds: ["sg-abc123"],
    networkInterfaceIds: ["eni-abc123"],
    volumeIds: ["vol-abc123"],
    publicIpAddress: "198.51.100.24",
    privateIpAddress: "10.0.0.24",
    availabilityZone: "us-east-1a",
    elasticIpAllocationId: "eipalloc-abc123",
    vpcId: "vpc-0123456789abcdef0",
    subnetId: "subnet-0123456789abcdef0",
    internetGatewayId: null,
    routeTableId: null,
    routeTableAssociationId: null,
  },
};

const sshHostKeyReview: SshHostKeyReview = {
  token: SSH_REVIEW_TOKEN,
  deploymentId: DEPLOYMENT_ID,
  name: "range-control",
  host: "198.51.100.24",
  port: 22,
  fingerprint: `SHA256:${"A".repeat(43)}`,
  expiresAt: "2026-09-07T19:00:00.000Z",
};

const firewallSnapshot: AwsFirewallSnapshot = {
  securityGroupId: "sg-abc123",
  securityGroupName: "sliver-gui-range-control",
  vpcId: "vpc-0123456789abcdef0",
  rules: [
    {
      id: "sgr-11111111111111111",
      managed: true,
      direction: "ingress",
      protocol: "tcp",
      fromPort: 22,
      toPort: 22,
      peerType: "ipv4",
      peer: "203.0.113.8/32",
      description: "Operator SSH",
    },
    {
      id: "sgr-22222222222222222",
      managed: false,
      direction: "egress",
      protocol: "-1",
      fromPort: null,
      toPort: null,
      peerType: "ipv4",
      peer: "0.0.0.0/0",
      description: null,
    },
  ],
};

const awsDeploymentOptions: AwsDeploymentOptions = {
  region: "us-east-1",
  instanceTypes: [
    { name: "t3.micro", architecture: "x86_64", vCpuCount: 2, memoryMiB: 1_024, processor: "Intel Xeon", description: "Burstable x86 compute" },
    { name: "t3.small", architecture: "x86_64", vCpuCount: 2, memoryMiB: 2_048, processor: "Intel Xeon", description: "Burstable x86 compute" },
    { name: "t3.medium", architecture: "x86_64", vCpuCount: 2, memoryMiB: 4_096, processor: "Intel Xeon", description: "Burstable x86 compute" },
    { name: "t3.large", architecture: "x86_64", vCpuCount: 2, memoryMiB: 8_192, processor: "Intel Xeon", description: "Burstable x86 compute" },
    { name: "t3.xlarge", architecture: "x86_64", vCpuCount: 4, memoryMiB: 16_384, processor: "Intel Xeon", description: "Burstable x86 compute" },
    { name: "t4g.micro", architecture: "arm64", vCpuCount: 2, memoryMiB: 1_024, processor: "AWS Graviton2", description: "Burstable Arm compute" },
    { name: "t4g.small", architecture: "arm64", vCpuCount: 2, memoryMiB: 2_048, processor: "AWS Graviton2", description: "Burstable Arm compute" },
    { name: "t4g.medium", architecture: "arm64", vCpuCount: 2, memoryMiB: 4_096, processor: "AWS Graviton2", description: "Burstable Arm compute" },
    { name: "t4g.large", architecture: "arm64", vCpuCount: 2, memoryMiB: 8_192, processor: "AWS Graviton2", description: "Burstable Arm compute" },
    { name: "t4g.xlarge", architecture: "arm64", vCpuCount: 4, memoryMiB: 16_384, processor: "AWS Graviton2", description: "Burstable Arm compute" },
  ],
  images: [
    { id: "ami-11111111111111111", name: "ubuntu/images/hvm-ssd/ubuntu-noble-24.04-amd64-server", description: "Ubuntu Server 24.04 LTS", architecture: "x86_64", rootDeviceName: "/dev/sda1", distribution: "ubuntu", version: "24.04 LTS", creationDate: "2026-09-01T00:00:00.000Z", sshUsername: "ubuntu" },
    { id: "ami-22222222222222222", name: "al2023-ami-2023-x86_64", description: "Amazon Linux 2023", architecture: "x86_64", rootDeviceName: "/dev/xvda", distribution: "amazon-linux", version: "2023", creationDate: "2026-09-01T00:00:00.000Z", sshUsername: "ec2-user" },
    { id: "ami-aaaaaaaaaaaaaaaaa", name: "ubuntu/images/hvm-ssd/ubuntu-noble-24.04-arm64-server", description: "Ubuntu Server 24.04 LTS", architecture: "arm64", rootDeviceName: "/dev/sda1", distribution: "ubuntu", version: "24.04 LTS", creationDate: "2026-09-01T00:00:00.000Z", sshUsername: "ubuntu" },
    { id: "ami-bbbbbbbbbbbbbbbbb", name: "al2023-ami-2023-arm64", description: "Amazon Linux 2023", architecture: "arm64", rootDeviceName: "/dev/xvda", distribution: "amazon-linux", version: "2023", creationDate: "2026-09-01T00:00:00.000Z", sshUsername: "ec2-user" },
  ],
  vpcs: [
    { id: "vpc-0123456789abcdef0", name: "default", cidrBlock: "172.31.0.0/16", isDefault: true },
    { id: "vpc-11111111111111111", name: "operations", cidrBlock: "10.20.0.0/16", isDefault: false },
  ],
  subnets: [
    { id: "subnet-0123456789abcdef0", name: "default-public", vpcId: "vpc-0123456789abcdef0", cidrBlock: "172.31.16.0/20", availabilityZone: "us-east-1a", mapPublicIpOnLaunch: true },
    { id: "subnet-11111111111111111", name: "operations-private", vpcId: "vpc-11111111111111111", cidrBlock: "10.20.1.0/24", availabilityZone: "us-east-1b", mapPublicIpOnLaunch: false },
  ],
  keyPairs: [
    { name: "operator-existing", id: "key-0123456789abcdef0", fingerprint: "SHA256:abcdefghijklmnopqrstuv", keyType: "ed25519", isCredentialMatch: true },
    { name: "__sliver_managed_key__", id: "key-22222222222222222", fingerprint: "SHA256:abcdefghijklmnopqrstuv", keyType: "ed25519", isCredentialMatch: true },
    { name: "unusable-key", id: "key-11111111111111111", fingerprint: "SHA256:does-not-match", keyType: "rsa", isCredentialMatch: false },
  ],
  credentialKey: {
    type: "ed25519",
    fingerprint: "SHA256:abcdefghijklmnopqrstuv",
    matchingKeyPairNames: ["operator-existing", "__sliver_managed_key__"],
  },
};

const emptySnapshot: CloudDeploymentSnapshot = {
  state: { v: 1, revision: 0, deployments: [] },
  credentials: [],
  secureCredentialStorage: true,
  awsProfiles: [],
  awsProfileDiscoveryError: null,
  provisioningTranscripts: [],
};

const discoverAwsOptions = vi.fn(async (
  _input: DiscoverAwsOptionsInput,
): Promise<OperationResult<AwsDeploymentOptions>> => ({ ok: true, value: awsDeploymentOptions }));
const detectCurrentEgressIpv4 = vi.fn(async (): Promise<OperationResult<CurrentEgressIpv4>> => ({
  ok: false,
  error: "Current egress IPv4 could not be detected.",
}));

const api: CloudDeploymentAPI = {
  getSnapshot: vi.fn(async () => ({ ok: true as const, value: currentSnapshot })),
  getProvisioningTranscripts: vi.fn(async () => ({
    ok: true as const,
    value: { provisioningTranscripts: currentSnapshot.provisioningTranscripts },
  })),
  getTerminalRuntime: vi.fn(async () => ({
    ok: true as const,
    value: { version: "0.4.0" as const, sha256: "a".repeat(64), bytes: new Uint8Array([0, 97, 115, 109]) },
  })),
  detectCurrentEgressIpv4,
  chooseSshPrivateKey: vi.fn(async () => ({ ok: true as const, value: { token: KEY_TOKEN, fileName: "operator_ed25519" } })),
  createCredential: vi.fn(async (input) => {
    capturedCredential = structuredClone(input);
    if (input.provider === "proxmox") {
      return {
        ok: true as const,
        value: {
          id: CREDENTIAL_ID,
          provider: "proxmox" as const,
          label: input.label,
          persistence: "secure" as const,
          createdAt: "2026-09-06T18:00:00.000Z",
          endpoint: input.endpoint,
          sshUsername: input.sshUsername,
        },
      };
    }
    return {
      ok: true as const,
      value: {
        id: CREDENTIAL_ID,
        provider: "aws" as const,
        label: input.label,
        persistence: "secure" as const,
        createdAt: "2026-09-06T18:00:00.000Z",
        defaultRegion: input.defaultRegion,
        sshUsername: input.sshUsername,
        ...("profileName" in input ? { profileName: input.profileName } : {}),
      },
    };
  }),
  deleteCredential: vi.fn(async () => ({ ok: true as const })),
  testCredential: vi.fn(async () => ({
    ok: true as const,
    value: {
      provider: "aws" as const,
      summary: "AWS identity and EC2 permissions verified.",
      permissions: { required: [], verified: [], missing: [], unverifiable: [] },
    },
  })),
  discoverAwsOptions,
  createDeployment: vi.fn(async (input) => {
    capturedDeployment = structuredClone(input);
    return { ok: true as const, value: runningDeployment };
  }),
  runLifecycleAction: vi.fn(async () => ({ ok: true as const, value: runningDeployment })),
  updateFirewall: vi.fn(async () => ({ ok: true as const, value: runningDeployment })),
  listFirewallRules: vi.fn(async () => ({ ok: true as const, value: currentFirewallSnapshot })),
  createFirewallRule: vi.fn(async () => ({ ok: true as const, value: currentFirewallSnapshot })),
  updateFirewallRule: vi.fn(async () => ({ ok: true as const, value: currentFirewallSnapshot })),
  deleteFirewallRule: vi.fn(async () => ({ ok: true as const, value: currentFirewallSnapshot })),
  prepareDestroyDeployment: vi.fn(async () => ({
    ok: true as const,
    value: {
      token: "destroy-token",
      deploymentId: DEPLOYMENT_ID,
      deploymentName: "range-control",
      provider: "aws" as const,
      expiresAt: "2026-09-06T19:00:00.000Z",
    },
  })),
  executeDestroyDeployment: vi.fn(async () => ({ ok: true as const, value: emptySnapshot.state })),
  openSshWindow: vi.fn(async (): Promise<OperationResult<SshOpenTabResult>> => ({
    ok: true,
    value: { status: "opened", tabId: "t".repeat(43), created: true },
  })),
  approveSshHostKey: vi.fn(async (): Promise<OperationResult<SshOpenTabResult>> => ({
    ok: true,
    value: { status: "opened", tabId: "t".repeat(43), created: true },
  })),
  onChanged: vi.fn((listener) => {
    changedListener = listener;
    return unsubscribeChanged;
  }),
  onNavigationRequested: vi.fn((listener) => {
    navigationListener = listener;
    return unsubscribeNavigation;
  }),
  onThemeChanged: vi.fn((listener) => {
    themeListener = listener;
    return unsubscribeTheme;
  }),
};

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Element.prototype, "setPointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(Element.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(Element.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false,
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  Reflect.deleteProperty(Element.prototype, "setPointerCapture");
  Reflect.deleteProperty(Element.prototype, "releasePointerCapture");
  Reflect.deleteProperty(Element.prototype, "hasPointerCapture");
});

beforeEach(() => {
  toast.clear();
  currentSnapshot = emptySnapshot;
  themeListener = undefined;
  changedListener = undefined;
  navigationListener = undefined;
  capturedCredential = undefined;
  capturedDeployment = undefined;
  currentFirewallSnapshot = firewallSnapshot;
  unsubscribeTheme.mockClear();
  unsubscribeChanged.mockClear();
  unsubscribeNavigation.mockClear();
  vi.mocked(api.getSnapshot).mockClear();
  vi.mocked(api.getProvisioningTranscripts).mockClear();
  vi.mocked(api.chooseSshPrivateKey).mockClear();
  vi.mocked(api.createCredential).mockClear();
  detectCurrentEgressIpv4.mockClear();
  detectCurrentEgressIpv4.mockResolvedValue({
    ok: false,
    error: "Current egress IPv4 could not be detected.",
  });
  discoverAwsOptions.mockClear();
  discoverAwsOptions.mockResolvedValue({ ok: true, value: awsDeploymentOptions });
  vi.mocked(api.createDeployment).mockClear();
  vi.mocked(api.runLifecycleAction).mockClear();
  vi.mocked(api.updateFirewall).mockClear();
  vi.mocked(api.listFirewallRules).mockClear();
  vi.mocked(api.createFirewallRule).mockClear();
  vi.mocked(api.updateFirewallRule).mockClear();
  vi.mocked(api.deleteFirewallRule).mockClear();
  vi.mocked(api.prepareDestroyDeployment).mockClear();
  vi.mocked(api.executeDestroyDeployment).mockClear();
  vi.mocked(api.openSshWindow).mockClear();
  vi.mocked(api.approveSshHostKey).mockClear();
  Object.defineProperty(window, "cloudDeployment", { configurable: true, value: Object.freeze(api) });
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  toast.clear();
  cleanup();
  Reflect.deleteProperty(window, "cloudDeployment");
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.colorScheme = "";
});

function renderCloudDeploymentApp(): ReturnType<typeof render> {
  return render(
    <>
      <CloudDeploymentWindowApp />
      <Toast.Provider maxVisibleToasts={4} placement="bottom" />
    </>,
  );
}

describe("CloudDeploymentWindowApp", () => {
  it("loads an accessible standalone dashboard and responds to bounded native events", async () => {
    const view = renderCloudDeploymentApp();

    expect(await screen.findByRole("heading", { name: "Cloud Deployment" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Deployments/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Credentials/i })).toBeInTheDocument();
    expect(screen.getByText("No Managed Servers")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Deployment" })).toBeInTheDocument();
    expect(screen.getByText("Encrypted credentials")).toBeInTheDocument();
    expect(document.title).toBe("Cloud Deployment");

    act(() => themeListener?.(false));
    expect(document.documentElement).toHaveClass("light");
    act(() => themeListener?.(true));
    expect(document.documentElement).toHaveClass("dark");

    act(() => changedListener?.("snapshot"));
    await waitFor(() => expect(api.getSnapshot).toHaveBeenCalledTimes(2));

    view.unmount();
    expect(unsubscribeTheme).toHaveBeenCalledOnce();
    expect(unsubscribeChanged).toHaveBeenCalledOnce();
    expect(unsubscribeNavigation).toHaveBeenCalledOnce();
  });

  it("coalesces rapid deployment changes into one trailing snapshot refresh", async () => {
    const firstSnapshot = deferred<OperationResult<CloudDeploymentSnapshot>>();
    const trailingSnapshot = deferred<OperationResult<CloudDeploymentSnapshot>>();
    vi.mocked(api.getSnapshot)
      .mockReturnValueOnce(firstSnapshot.promise)
      .mockReturnValueOnce(trailingSnapshot.promise);

    renderCloudDeploymentApp();
    await waitFor(() => expect(api.getSnapshot).toHaveBeenCalledOnce());
    act(() => {
      changedListener?.("snapshot");
      changedListener?.("snapshot");
      changedListener?.("snapshot");
    });
    expect(api.getSnapshot).toHaveBeenCalledOnce();

    await act(async () => {
      firstSnapshot.resolve({ ok: true, value: emptySnapshot });
      await firstSnapshot.promise;
    });
    await waitFor(() => expect(api.getSnapshot).toHaveBeenCalledTimes(2));
    expect(api.getSnapshot).toHaveBeenCalledTimes(2);

    await act(async () => {
      trailingSnapshot.resolve({ ok: true, value: emptySnapshot });
      await trailingSnapshot.promise;
    });
    expect(await screen.findByText("No Managed Servers")).toBeInTheDocument();
    expect(api.getSnapshot).toHaveBeenCalledTimes(2);
  });

  it("refreshes only bounded transcript data for transcript change signals", async () => {
    renderCloudDeploymentApp();
    expect(await screen.findByText("No Managed Servers")).toBeInTheDocument();
    expect(api.getSnapshot).toHaveBeenCalledOnce();

    currentSnapshot = {
      ...emptySnapshot,
      provisioningTranscripts: [{
        deploymentId: DEPLOYMENT_ID,
        status: "streaming",
        truncated: false,
        chunks: [{ sequence: 0, bytes: new TextEncoder().encode("live output\n") }],
      }],
    };
    act(() => changedListener?.("transcripts"));

    await waitFor(() => expect(api.getProvisioningTranscripts).toHaveBeenCalledOnce());
    expect(api.getSnapshot).toHaveBeenCalledOnce();
  });

  it("resumes an in-progress deployment as the full instance view after reopening", async () => {
    const deployment = awsProvisioningDeployment();
    currentSnapshot = {
      ...emptySnapshot,
      state: { v: 1, revision: 8, deployments: [deployment] },
      credentials: [awsCredential],
      provisioningTranscripts: [{
        deploymentId: DEPLOYMENT_ID,
        status: "streaming",
        truncated: false,
        chunks: [],
      }],
    };

    renderCloudDeploymentApp();

    expect(await screen.findByRole("heading", { name: "range-control" })).toBeInTheDocument();
    expect(screen.getByText("AWS Status Checks")).toBeInTheDocument();
    expect(screen.getByText("0/2 checks passed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deployment in progress" })).toBeDisabled();
    expect(screen.queryByText("No Managed Servers")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New Deployment" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Mock read-only SSH provisioning terminal")).toBeInTheDocument();
  });

  it("creates an AWS credential using only an opaque native-picker key token", async () => {
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    expect(screen.getByRole("heading", { name: "Provider Credentials" })).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Label" }), "Production AWS");
    await user.type(screen.getByLabelText("Access Key ID"), "AKIAIOSFODNN7EXAMPLE");
    await user.type(screen.getByLabelText("Secret Access Key"), "super-secret-value");
    await user.click(screen.getByRole("button", { name: "Choose Key" }));
    expect(await screen.findByText("operator_ed25519")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save Credential" }));

    await waitFor(() => expect(api.createCredential).toHaveBeenCalledOnce());
    expect(capturedCredential).toMatchObject({
      provider: "aws",
      label: "Production AWS",
      defaultRegion: "us-east-1",
      sshUsername: "ubuntu",
      sshPrivateKeyToken: KEY_TOKEN,
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "super-secret-value",
    });
    expect(capturedCredential).not.toHaveProperty("sshPrivateKey");
    expect(screen.queryByDisplayValue("super-secret-value")).not.toBeInTheDocument();
    expect(await screen.findByText("Credential saved")).toBeInTheDocument();
  });

  it("requests an automatically generated Ed25519 key when no existing key is selected", async () => {
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    expect(screen.getByText(/a new Ed25519 key will be generated automatically/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("SSH Key Passphrase")).not.toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Label" }), "Generated Key AWS");
    await user.type(screen.getByLabelText("Access Key ID"), "AKIAIOSFODNN7EXAMPLE");
    await user.type(screen.getByLabelText("Secret Access Key"), "super-secret-value");
    await user.click(screen.getByRole("button", { name: "Save Credential" }));

    await waitFor(() => expect(api.createCredential).toHaveBeenCalledOnce());
    expect(api.chooseSshPrivateKey).not.toHaveBeenCalled();
    expect(capturedCredential).toMatchObject({
      provider: "aws",
      label: "Generated Key AWS",
      sshPrivateKeyToken: null,
      sshPassphrase: null,
    });
  });

  it("can return to automatic key generation after selecting an existing SSH key", async () => {
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.click(screen.getByRole("button", { name: "Choose Key" }));
    expect(await screen.findByText("operator_ed25519")).toBeInTheDocument();
    expect(screen.getByLabelText("SSH Key Passphrase")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Use an automatically generated SSH key" }));

    expect(screen.getByText(/a new Ed25519 key will be generated automatically/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("SSH Key Passphrase")).not.toBeInTheDocument();
  });

  it("reuses an explicit local AWS CLI profile without sending AWS secret values", async () => {
    currentSnapshot = {
      ...emptySnapshot,
      awsProfiles: [
        { name: "default", region: "us-west-2" },
        { name: "operators", region: "us-iso-east-1" },
      ],
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    expect(screen.getByRole("combobox", { name: "AWS Authentication" })).toHaveValue("profile");
    await user.selectOptions(screen.getByRole("combobox", { name: "AWS CLI Profile" }), "operators");
    expect(screen.getByRole("textbox", { name: "Default Region" })).toHaveValue("us-iso-east-1");
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Operator Profile");
    await user.click(screen.getByRole("button", { name: "Choose Key" }));
    await user.click(screen.getByRole("button", { name: "Save Credential" }));

    await waitFor(() => expect(api.createCredential).toHaveBeenCalledOnce());
    expect(capturedCredential).toEqual({
      provider: "aws",
      label: "Operator Profile",
      defaultRegion: "us-iso-east-1",
      sshUsername: "ubuntu",
      sshPrivateKeyToken: KEY_TOKEN,
      profileName: "operators",
      sshPassphrase: null,
    });
    expect(capturedCredential).not.toHaveProperty("accessKeyId");
    expect(capturedCredential).not.toHaveProperty("secretAccessKey");
    expect(capturedCredential).not.toHaveProperty("sessionToken");
  });

  it("clears static AWS credentials when switching to a CLI profile", async () => {
    currentSnapshot = {
      ...emptySnapshot,
      awsProfiles: [{ name: "default", region: "us-west-2" }],
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    const authentication = screen.getByRole("combobox", { name: "AWS Authentication" });
    await user.selectOptions(authentication, "access-keys");
    await user.type(screen.getByLabelText("Access Key ID"), "AKIAIOSFODNN7EXAMPLE");
    await user.type(screen.getByLabelText("Secret Access Key"), "super-secret-value");
    await user.type(screen.getByLabelText("Session Token"), "temporary-session-token");

    await user.selectOptions(authentication, "profile");
    await user.selectOptions(authentication, "access-keys");

    expect(screen.getByLabelText("Access Key ID")).toHaveValue("");
    expect(screen.getByLabelText("Secret Access Key")).toHaveValue("");
    expect(screen.getByLabelText("Session Token")).toHaveValue("");
  });

  it("reconciles profile authentication when the discovered profile inventory changes", async () => {
    currentSnapshot = {
      ...emptySnapshot,
      awsProfiles: [
        { name: "default", region: "us-west-2" },
        { name: "operators", region: "eu-west-1" },
      ],
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "AWS CLI Profile" }), "operators");

    currentSnapshot = {
      ...emptySnapshot,
      awsProfiles: [{ name: "default", region: "us-west-2" }],
    };
    act(() => changedListener?.("snapshot"));

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "AWS Authentication" })).toHaveValue("profile");
      expect(screen.getByRole("combobox", { name: "AWS CLI Profile" })).toHaveValue("default");
      expect(screen.getByRole("textbox", { name: "Default Region" })).toHaveValue("us-west-2");
    });

    currentSnapshot = emptySnapshot;
    act(() => changedListener?.("snapshot"));

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "AWS Authentication" })).toHaveValue("access-keys");
      expect(screen.queryByRole("combobox", { name: "AWS CLI Profile" })).not.toBeInTheDocument();
      expect(screen.getByLabelText("Access Key ID")).toBeInTheDocument();
    });
  });

  it("supports direct Proxmox API-token credentials without exposing SSH key contents", async () => {
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "proxmox");
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Lab Proxmox");
    await user.type(screen.getByRole("textbox", { name: "API Endpoint" }), "https://pve.example.test:8006");
    await user.type(screen.getByRole("textbox", { name: "API Token ID" }), "root@pam!sliver-gui");
    await user.type(screen.getByLabelText("API Token Secret"), "proxmox-token-secret");
    await user.click(screen.getByRole("button", { name: "Choose Key" }));
    await user.click(screen.getByRole("button", { name: "Save Credential" }));

    await waitFor(() => expect(api.createCredential).toHaveBeenCalledOnce());
    expect(capturedCredential).toMatchObject({
      provider: "proxmox",
      label: "Lab Proxmox",
      endpoint: "https://pve.example.test:8006",
      tokenId: "root@pam!sliver-gui",
      tokenSecret: "proxmox-token-secret",
      sshUsername: "root",
      sshPrivateKeyToken: KEY_TOKEN,
    });
    expect(capturedCredential).not.toHaveProperty("sshPrivateKey");
  });

  it("reports incomplete and missing provider permissions without treating them as success", async () => {
    currentSnapshot = { ...emptySnapshot, credentials: [awsCredential] };
    vi.mocked(api.testCredential).mockResolvedValueOnce({
      ok: true,
      value: {
        provider: "aws",
        summary: "AWS identity verified; destructive permissions were not exercised.",
        permissions: {
          required: [{ id: "ec2:TerminateInstances", label: "Terminate managed instances", capabilities: ["destroy"] }],
          verified: [],
          missing: [],
          unverifiable: ["ec2:TerminateInstances"],
        },
      },
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.click(screen.getByRole("button", { name: "Test connection for Production AWS" }));

    expect(await screen.findAllByText("Permission review incomplete")).toHaveLength(2);
    expect(screen.getByText(/1 could not be verified safely: ec2:TerminateInstances/u)).toBeInTheDocument();
    expect(screen.queryByText("Connection verified")).not.toBeInTheDocument();
    expect(screen.getByText("0 verified · 0 missing · 1 unverified")).toBeInTheDocument();
    await user.click(screen.getByText("Review permission IDs"));
    expect(screen.getByText("ec2:TerminateInstances").closest("li")).toHaveTextContent(
      "ec2:TerminateInstances — Terminate managed instances · could not verify safely",
    );

    vi.mocked(api.testCredential).mockResolvedValueOnce({
      ok: true,
      value: {
        provider: "aws",
        summary: "AWS identity verified with a denied deployment permission.",
        permissions: {
          required: [{ id: "ec2:RunInstances", label: "Launch an EC2 instance", capabilities: ["deploy"] }],
          verified: [],
          missing: ["ec2:RunInstances"],
          unverifiable: [],
        },
      },
    });
    await user.click(screen.getByRole("button", { name: "Test connection for Production AWS" }));

    expect(await screen.findByText("Required permissions missing")).toBeInTheDocument();
    expect(screen.getByText(/1 missing: ec2:RunInstances/u)).toBeInTheDocument();
    expect(screen.getByText("Permissions missing")).toBeInTheDocument();
  });

  it("automatically adds the detected egress IPv4 to both new-deployment source lists", async () => {
    detectCurrentEgressIpv4.mockResolvedValueOnce({
      ok: true,
      value: { address: "203.0.113.42", cidr: "203.0.113.42/32" },
    });
    currentSnapshot = { ...emptySnapshot, credentials: [awsCredential] };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "New Deployment" }));
    await waitFor(() => expect(detectCurrentEgressIpv4).toHaveBeenCalledOnce());
    await user.type(screen.getByRole("textbox", { name: "Deployment Name" }), "auto-egress");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("button", { name: /Instance Type/i });
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("textbox", { name: "SSH Source CIDRs" })).toHaveValue("203.0.113.42/32");
    expect(screen.getByRole("textbox", { name: "Operator Source CIDRs" })).toHaveValue("203.0.113.42/32");
    expect(screen.getByText("Current egress IPv4 detected")).toBeInTheDocument();
    expect(screen.getByText(/203\.0\.113\.42\/32 was added to any empty, untouched source lists/u)).toBeInTheDocument();
  });

  it("does not overwrite a source list the user edits and clears before egress detection finishes", async () => {
    const detection = deferred<OperationResult<CurrentEgressIpv4>>();
    detectCurrentEgressIpv4.mockReturnValueOnce(detection.promise);
    currentSnapshot = { ...emptySnapshot, credentials: [awsCredential] };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "New Deployment" }));
    await user.type(screen.getByRole("textbox", { name: "Deployment Name" }), "preserve-egress");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("button", { name: /Instance Type/i });
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Detecting current egress IPv4")).toBeInTheDocument();
    const sshCidrs = screen.getByRole("textbox", { name: "SSH Source CIDRs" });
    await user.type(sshCidrs, "198.51.100.8/32");
    await user.clear(sshCidrs);

    await act(async () => {
      detection.resolve({
        ok: true,
        value: { address: "203.0.113.42", cidr: "203.0.113.42/32" },
      });
      await detection.promise;
    });

    expect(sshCidrs).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Operator Source CIDRs" })).toHaveValue("203.0.113.42/32");
    expect(screen.getByText("Current egress IPv4 detected")).toBeInTheDocument();
  });

  it("keeps the access step usable when current egress IPv4 detection fails", async () => {
    detectCurrentEgressIpv4.mockRejectedValueOnce(new Error("network unavailable"));
    currentSnapshot = { ...emptySnapshot, credentials: [awsCredential] };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "New Deployment" }));
    await user.type(screen.getByRole("textbox", { name: "Deployment Name" }), "manual-egress");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("button", { name: /Instance Type/i });
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Current egress IPv4 unavailable")).toBeInTheDocument();
    expect(screen.getByText("Enter the source CIDRs manually before continuing.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("collects provider-specific infrastructure and separate firewall CIDRs before deployment", async () => {
    currentSnapshot = { ...emptySnapshot, state: { ...emptySnapshot.state, revision: 7 }, credentials: [awsCredential] };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "New Deployment" }));
    await user.type(screen.getByRole("textbox", { name: "Deployment Name" }), "range-control");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(discoverAwsOptions).toHaveBeenCalledWith({
      credentialId: CREDENTIAL_ID,
      region: "us-east-1",
    }));
    expect(await screen.findByRole("button", { name: /Instance Type/i })).toHaveTextContent("t3.micro");
    expect(screen.getByRole("button", { name: /Machine Image/i })).toHaveTextContent("Ubuntu 24.04 LTS");
    expect(screen.getByRole("button", { name: /VPC/i })).toHaveTextContent("default");
    expect(screen.getByRole("button", { name: /Subnet/i })).toHaveTextContent("default-public");
    expect(screen.getByRole("button", { name: /SSH Key/i })).toHaveTextContent("Credential key (managed)");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await user.type(screen.getByRole("textbox", { name: "SSH Source CIDRs" }), "203.0.113.8/32");
    await user.type(screen.getByRole("textbox", { name: "Operator Source CIDRs" }), "198.51.100.16/32");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("What happens next")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Deploy Sliver Server" }));

    await waitFor(() => expect(api.createDeployment).toHaveBeenCalledOnce());
    expect(capturedDeployment).toEqual({
      provider: "aws",
      expectedRevision: 7,
      credentialId: CREDENTIAL_ID,
      name: "range-control",
      spec: {
        region: "us-east-1",
        imageId: "ami-11111111111111111",
        instanceType: "t3.micro",
        subnetId: "subnet-0123456789abcdef0",
        vpcId: "vpc-0123456789abcdef0",
        networkMode: "existing",
        managedVpcCidr: null,
        managedSubnetCidr: null,
        sshKeyMode: "managed",
        existingKeyPairName: null,
        sshUsername: "ubuntu",
        keyPairName: "managed-by-sliver-gui",
        operatorName: "operator",
        sshPort: 22,
        multiplayerPort: 31337,
        volumeSizeGiB: 20,
        useElasticIp: true,
        sshCidrs: ["203.0.113.8/32"],
        operatorCidrs: ["198.51.100.16/32"],
      },
    });
    expect(await screen.findByText("Deployment ready")).toBeInTheDocument();
  });

  it("replaces setup with one full-width deployment instance until provisioning completes", async () => {
    currentSnapshot = {
      ...emptySnapshot,
      state: { ...emptySnapshot.state, revision: 7 },
      credentials: [awsCredential],
    };
    const deploymentResult = deferred<OperationResult<AwsCloudDeploymentRecord>>();
    const waitingDeployment: AwsCloudDeploymentRecord = {
      ...runningDeployment,
      status: "provisioning",
      phase: "waiting-instance-status",
      operatorConfigFileName: null,
      operatorConfigDigest: null,
      remoteHost: null,
      runtime: {
        ...runningDeployment.runtime,
        instanceState: "running",
        instanceHealth: "initializing",
        systemHealth: "initializing",
        publicIpAddress: null,
      },
    };
    vi.mocked(api.createDeployment).mockImplementationOnce(async () => {
      currentSnapshot = {
        ...currentSnapshot,
        state: { v: 1, revision: 8, deployments: [waitingDeployment] },
        provisioningTranscripts: [{
          deploymentId: DEPLOYMENT_ID,
          status: "streaming",
          truncated: false,
          chunks: [],
        }],
      };
      queueMicrotask(() => changedListener?.("snapshot"));
      return deploymentResult.promise;
    });

    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("button", { name: "New Deployment" }));
    await user.type(screen.getByRole("textbox", { name: "Deployment Name" }), "range-control");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("button", { name: /Instance Type/i });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByRole("textbox", { name: "SSH Source CIDRs" }), "203.0.113.8/32");
    await user.type(screen.getByRole("textbox", { name: "Operator Source CIDRs" }), "203.0.113.8/32");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Deployment")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Deploy Sliver Server" }));

    expect(await screen.findByRole("heading", { name: "range-control" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "New Deployment" })).not.toBeInTheDocument();
    expect(screen.getAllByText("range-control")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Deployment in progress" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start range-control" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Stop range-control" })).not.toBeInTheDocument();
    expect(screen.getByText("0/2 checks passed")).toBeInTheDocument();
    expect(screen.getByText("Waiting for SSH")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminate range-control" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit firewall for range-control" })).toBeDisabled();

    const readyForSsh: AwsCloudDeploymentRecord = {
      ...waitingDeployment,
      phase: "installing-sliver",
      remoteHost: "198.51.100.24",
      runtime: {
        ...waitingDeployment.runtime,
        instanceHealth: "ok",
        systemHealth: "ok",
        publicIpAddress: "198.51.100.24",
      },
    };
    await act(async () => {
      currentSnapshot = {
        ...currentSnapshot,
        state: { v: 1, revision: 9, deployments: [readyForSsh] },
        provisioningTranscripts: [{
          deploymentId: DEPLOYMENT_ID,
          status: "streaming",
          truncated: false,
          chunks: [{ sequence: 0, bytes: new TextEncoder().encode("sliver-server active\r\n") }],
        }],
      };
      changedListener?.("snapshot");
    });

    expect(await screen.findByText("2/2 checks passed")).toBeInTheDocument();
    expect(screen.getByLabelText("Mock read-only SSH provisioning terminal")).toHaveTextContent("sliver-server active");
    expect(screen.getByLabelText("Mock read-only SSH provisioning terminal")).toHaveAttribute("data-read-only", "true");

    await act(async () => {
      currentSnapshot = {
        ...currentSnapshot,
        state: { v: 1, revision: 10, deployments: [runningDeployment] },
        provisioningTranscripts: [],
      };
      changedListener?.("snapshot");
      deploymentResult.resolve({ ok: true, value: runningDeployment });
      await deploymentResult.promise;
    });

    expect(await screen.findByText("Deployment ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Deployment" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Mock read-only SSH provisioning terminal")).not.toBeInTheDocument();
  });

  it("offers the bounded t3/t4g catalog and keeps AMIs aligned with architecture", async () => {
    currentSnapshot = { ...emptySnapshot, credentials: [awsCredential] };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "New Deployment" }));
    await user.type(screen.getByRole("textbox", { name: "Deployment Name" }), "catalog-test");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const instanceType = await screen.findByRole("button", { name: /Instance Type/i });
    await user.click(instanceType);
    for (const name of [
      "t3.micro", "t3.small", "t3.medium", "t3.large", "t3.xlarge",
      "t4g.micro", "t4g.small", "t4g.medium", "t4g.large", "t4g.xlarge",
    ]) expect(screen.getByRole("option", { name: new RegExp(`^${name.replace(".", "\\.")}`, "u") })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^t3\.micro/u })).toHaveTextContent("2 vCPU · 1 GiB · x86-64");
    expect(screen.getByRole("option", { name: /^t4g\.xlarge/u })).toHaveTextContent("4 vCPU · 16 GiB · Arm64");

    await user.click(screen.getByRole("option", { name: /^t4g\.small/u }));
    const machineImage = screen.getByRole("button", { name: /Machine Image/i });
    expect(machineImage).toHaveTextContent("Ubuntu 24.04 LTS");
    expect(machineImage).toHaveTextContent("Arm64");
    await user.click(machineImage);
    expect(screen.getByRole("option", { name: /^Ubuntu 24\.04 LTS/u })).toHaveTextContent("ami-aaaaaaaaaaaaaaaaa · Arm64 · SSH user ubuntu");
    expect(screen.getByRole("option", { name: /^Amazon Linux 2023/u })).toHaveTextContent("ami-bbbbbbbbbbbbbbbbb · Arm64 · SSH user ec2-user");
    await user.click(screen.getByRole("option", { name: /^Amazon Linux 2023/u }));
    expect(screen.getByRole("textbox", { name: "Linux SSH Username" })).toHaveValue("ec2-user");

    await user.click(screen.getByRole("switch", { name: /^Enter AMI manually/u }));
    expect(screen.getByRole("textbox", { name: "AMI ID" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Machine Image/i })).not.toBeInTheDocument();
  });

  it("supports managed networking and disables AWS key pairs that do not match the credential", async () => {
    currentSnapshot = { ...emptySnapshot, state: { ...emptySnapshot.state, revision: 4 }, credentials: [awsCredential] };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "New Deployment" }));
    await user.type(screen.getByRole("textbox", { name: "Deployment Name" }), "managed-network");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const vpc = await screen.findByRole("button", { name: /VPC/i });
    await user.click(vpc);
    await user.click(screen.getByRole("option", { name: /^Create a new VPC/u }));
    expect(screen.getByRole("textbox", { name: "VPC CIDR" })).toHaveValue("10.0.0.0/16");
    expect(screen.getByRole("textbox", { name: "Subnet CIDR" })).toHaveValue("10.0.1.0/24");
    expect(screen.queryByRole("button", { name: /Subnet/i })).not.toBeInTheDocument();

    const sshKey = screen.getByRole("button", { name: /SSH Key/i });
    await user.click(sshKey);
    expect(screen.getByRole("option", { name: /^Credential key \(managed\)/u })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^operator-existing/u })).toHaveTextContent("Matches credential key");
    expect(screen.getByRole("option", { name: /^__sliver_managed_key__/u })).toHaveTextContent("Matches credential key");
    expect(screen.getByRole("option", { name: /^unusable-key/u })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("option", { name: /^unusable-key/u })).toHaveTextContent("Unavailable — public key does not match this credential.");
    await user.click(screen.getByRole("option", { name: /^__sliver_managed_key__/u }));
    expect(screen.getByRole("switch", { name: /^Elastic IP/u })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByRole("textbox", { name: "SSH Source CIDRs" }), "203.0.113.8/32");
    await user.type(screen.getByRole("textbox", { name: "Operator Source CIDRs" }), "198.51.100.16/32");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Deploy Sliver Server" }));

    await waitFor(() => expect(api.createDeployment).toHaveBeenCalledOnce());
    expect(capturedDeployment).toMatchObject({
      provider: "aws",
      expectedRevision: 4,
      spec: {
        networkMode: "managed",
        vpcId: null,
        subnetId: null,
        managedVpcCidr: "10.0.0.0/16",
        managedSubnetCidr: "10.0.1.0/24",
        sshKeyMode: "existing",
        existingKeyPairName: "__sliver_managed_key__",
        keyPairName: "__sliver_managed_key__",
        useElasticIp: true,
      },
    });
  });

  it("blocks infrastructure continuation when AWS discovery fails and can retry", async () => {
    discoverAwsOptions.mockResolvedValueOnce({ ok: false, error: "ec2:DescribeVpcs denied" });
    currentSnapshot = { ...emptySnapshot, credentials: [awsCredential] };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "New Deployment" }));
    await user.type(screen.getByRole("textbox", { name: "Deployment Name" }), "retry-discovery");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("AWS discovery failed")).toBeInTheDocument();
    expect(screen.getByText("ec2:DescribeVpcs denied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Try Again" }));
    expect(await screen.findByRole("button", { name: /Instance Type/i })).toHaveTextContent("t3.micro");
    expect(discoverAwsOptions).toHaveBeenCalledTimes(2);
  });

  it("routes lifecycle and reviewed destruction through their dedicated bridge methods", async () => {
    currentSnapshot = {
      state: { v: 1, revision: 9, deployments: [runningDeployment] },
      credentials: [awsCredential],
      secureCredentialStorage: true,
      awsProfiles: [{ name: "default", region: "us-west-2" }],
      awsProfileDiscoveryError: null,
      provisioningTranscripts: [],
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    expect(await screen.findByText("range-control")).toBeInTheDocument();
    const stopButton = screen.getByRole("button", { name: "Stop range-control" });
    expect(screen.queryByRole("button", { name: "Start range-control" })).not.toBeInTheDocument();
    expect(stopButton.querySelector('svg[data-icon="stop"]')).toBeInTheDocument();
    await user.click(stopButton);
    await waitFor(() => expect(api.runLifecycleAction).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID, expectedRevision: 9, action: "stop" }));

    await user.click(screen.getByRole("button", { name: "Edit firewall for range-control" }));
    expect(await screen.findByRole("heading", { name: "Firewall rules" })).toBeInTheDocument();
    await waitFor(() => expect(api.listFirewallRules).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID }));
    await user.click(screen.getByRole("button", { name: "Back to managed servers" }));

    const terminateButton = screen.getByRole("button", { name: "Terminate range-control" });
    expect(terminateButton).not.toHaveTextContent("Terminate");
    expect(terminateButton.querySelector('svg[data-icon="trash"]')).toBeInTheDocument();
    await user.hover(terminateButton);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Terminate");
    await user.unhover(terminateButton);
    await user.click(terminateButton);
    expect(await screen.findByRole("alertdialog", { name: "Terminate range-control?" })).toBeInTheDocument();
    expect(api.prepareDestroyDeployment).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID, expectedRevision: 9 });
    await user.click(screen.getByRole("button", { name: "Terminate Instance" }));
    await waitFor(() => expect(api.executeDestroyDeployment).toHaveBeenCalledWith({ token: "destroy-token" }));
  });

  it("groups connection actions on the left and lifecycle actions on the right", async () => {
    currentSnapshot = runningCloudSnapshot();
    renderCloudDeploymentApp();

    const connectionActions = await screen.findByRole("group", { name: "Connection actions for range-control" });
    const lifecycleActions = screen.getByRole("group", { name: "Lifecycle actions for range-control" });

    const connectionLabels = within(connectionActions)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"))
      .filter((label): label is string => label !== null);
    const lifecycleLabels = within(lifecycleActions)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"))
      .filter((label): label is string => label !== null);

    expect(connectionLabels).toEqual([
      "SSH to range-control",
      "Edit firewall for range-control",
    ]);
    expect(lifecycleLabels).toEqual([
      "Stop range-control",
      "Reboot range-control",
      "Terminate range-control",
    ]);
    expect(lifecycleActions).toHaveClass("ml-auto");
  });

  it("opens SSH through the dedicated bridge and requires explicit first-use host-key approval", async () => {
    currentSnapshot = runningCloudSnapshot();
    const openResult = deferred<OperationResult<SshOpenTabResult>>();
    vi.mocked(api.openSshWindow).mockImplementationOnce(() => openResult.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    const sshButton = await screen.findByRole("button", { name: "SSH to range-control" });
    expect(sshButton.querySelector('svg[data-icon="terminal"]')).toBeInTheDocument();
    await user.click(sshButton);
    expect(sshButton).toBeDisabled();
    expect(api.openSshWindow).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID });

    await act(async () => {
      openResult.resolve({
        ok: true,
        value: { status: "host-key-review", review: sshHostKeyReview },
      });
      await openResult.promise;
    });

    const review = await screen.findByRole("alertdialog", { name: "Verify SSH host" });
    expect(within(review).getByText("range-control")).toBeInTheDocument();
    expect(within(review).getByText("198.51.100.24:22")).toBeInTheDocument();
    expect(within(review).getByText(sshHostKeyReview.fingerprint)).toBeInTheDocument();
    expect(within(review).getByText(/Review expires/u)).toBeInTheDocument();

    await user.click(within(review).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog", { name: "Verify SSH host" })).not.toBeInTheDocument();
    expect(api.approveSshHostKey).not.toHaveBeenCalled();

    vi.mocked(api.openSshWindow).mockResolvedValueOnce({
      ok: true,
      value: { status: "host-key-review", review: sshHostKeyReview },
    });
    const approval = deferred<OperationResult<SshOpenTabResult>>();
    vi.mocked(api.approveSshHostKey).mockImplementationOnce(() => approval.promise);
    await user.click(sshButton);
    const secondReview = await screen.findByRole("alertdialog", { name: "Verify SSH host" });
    const connectButton = within(secondReview).getByRole("button", { name: "Trust & Connect" });
    await user.click(connectButton);
    expect(connectButton).toHaveAttribute("aria-disabled", "true");
    expect(connectButton).toHaveAttribute("data-pending", "true");
    expect(api.approveSshHostKey).toHaveBeenCalledWith({ token: SSH_REVIEW_TOKEN });

    await act(async () => {
      approval.resolve({
        ok: true,
        value: { status: "opened", tabId: "t".repeat(43), created: true },
      });
      await approval.promise;
    });
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog", { name: "Verify SSH host" })).not.toBeInTheDocument();
    });
  });

  it("keeps host-key approval failures in the review and re-probes before another approval", async () => {
    currentSnapshot = runningCloudSnapshot();
    const refreshedReview: SshHostKeyReview = {
      ...sshHostKeyReview,
      token: "s".repeat(43),
      fingerprint: `SHA256:${"B".repeat(43)}`,
      expiresAt: "2026-09-07T19:05:00.000Z",
    };
    vi.mocked(api.openSshWindow)
      .mockResolvedValueOnce({
        ok: true,
        value: { status: "host-key-review", review: sshHostKeyReview },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { status: "host-key-review", review: refreshedReview },
      });
    vi.mocked(api.approveSshHostKey).mockResolvedValueOnce({
      ok: false,
      error: "The SSH host-key review is invalid or expired.\nTry again.\u0000",
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "SSH to range-control" }));
    const review = await screen.findByRole("alertdialog", { name: "Verify SSH host" });
    await user.click(within(review).getByRole("button", { name: "Trust & Connect" }));

    const approvalError = await within(review).findByRole("alert");
    expect(within(approvalError).getByText("SSH connection failed")).toBeInTheDocument();
    expect(within(approvalError).getByText(
      "The SSH host-key review is invalid or expired. Try again.",
    )).toBeInTheDocument();
    expect(screen.getByRole("alertdialog", { name: "Verify SSH host" })).toBe(review);
    expect(api.approveSshHostKey).toHaveBeenCalledTimes(1);

    await user.click(within(review).getByRole("button", { name: "Re-check Host" }));

    await waitFor(() => {
      expect(within(review).getByText(refreshedReview.fingerprint)).toBeInTheDocument();
    });
    expect(within(review).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(review).getByRole("button", { name: "Trust & Connect" })).toBeInTheDocument();
    expect(api.openSshWindow).toHaveBeenCalledTimes(2);
    expect(api.openSshWindow).toHaveBeenLastCalledWith({ deploymentId: DEPLOYMENT_ID });
    expect(api.approveSshHostKey).toHaveBeenCalledTimes(1);
  });

  it("enables SSH only for a running deployment with its credential and a target address", async () => {
    const stoppedDeployment: AwsCloudDeploymentRecord = {
      ...runningDeployment,
      id: "c8a6e2b7-1d45-4f92-89cc-1f2c31bc57b8",
      name: "stopped-server",
      status: "stopped",
      phase: "stopped",
    };
    const missingCredentialDeployment: AwsCloudDeploymentRecord = {
      ...runningDeployment,
      id: "b0bd8e1d-09cf-468d-a122-bc18ae18a573",
      name: "missing-key-server",
      credentialId: "477410eb-f3be-4e79-840c-d87215db28ee",
    };
    const missingHostDeployment: AwsCloudDeploymentRecord = {
      ...runningDeployment,
      id: "a6405996-8a87-4e1d-b85c-3eb692b9fc67",
      name: "missing-host-server",
      remoteHost: null,
      runtime: {
        ...runningDeployment.runtime,
        publicIpAddress: null,
        privateIpAddress: null,
      },
    };
    currentSnapshot = {
      ...runningCloudSnapshot(),
      state: {
        v: 1,
        revision: 9,
        deployments: [runningDeployment, stoppedDeployment, missingCredentialDeployment, missingHostDeployment],
      },
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    expect(await screen.findByRole("button", { name: "SSH to range-control" })).toBeEnabled();
    const unavailableButtons = [
      screen.getByRole("button", { name: "SSH to stopped-server" }),
      screen.getByRole("button", { name: "SSH to missing-key-server" }),
      screen.getByRole("button", { name: "SSH to missing-host-server" }),
    ];
    for (const button of unavailableButtons) {
      expect(button).toBeDisabled();
      await user.click(button);
    }
    const stoppedReason = screen.getByLabelText(
      "SSH action unavailable for stopped-server: Start this server before opening SSH.",
    );
    const missingKeyReason = screen.getByLabelText(
      "SSH action unavailable for missing-key-server: No stored SSH private key is available for this server.",
    );
    const missingHostReason = screen.getByLabelText(
      "SSH action unavailable for missing-host-server: This server does not have an SSH address yet.",
    );
    for (const reason of [stoppedReason, missingKeyReason, missingHostReason]) {
      expect(reason).toHaveAttribute("tabindex", "0");
    }
    await user.hover(stoppedReason);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Start this server before opening SSH.");
    expect(api.openSshWindow).not.toHaveBeenCalled();
  });

  it("bounds and flattens SSH launch errors before showing them", async () => {
    currentSnapshot = runningCloudSnapshot();
    vi.mocked(api.openSshWindow).mockResolvedValueOnce({
      ok: false,
      error: `  Connection refused\nretry\u0000later ${"x".repeat(600)}`,
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "SSH to range-control" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("SSH connection failed")).toBeInTheDocument();
    const detail = within(alert).getByText(/^Connection refused retry later/u);
    expect(detail.textContent).not.toContain("\n");
    expect(detail.textContent).not.toContain("\u0000");
    expect(detail.textContent?.length).toBe(512);
  });

  it("reuses one lifecycle button across stopped, pending, and running states", async () => {
    const stoppedDeployment: AwsCloudDeploymentRecord = {
      ...runningDeployment,
      status: "stopped",
      phase: "stopped",
      runtime: {
        ...runningDeployment.runtime,
        instanceState: "stopped",
        instanceHealth: "unknown",
        systemHealth: "unknown",
      },
    };
    currentSnapshot = {
      ...runningCloudSnapshot(),
      state: { v: 1, revision: 10, deployments: [stoppedDeployment] },
    };
    const lifecycleResult = deferred<OperationResult<AwsCloudDeploymentRecord>>();
    vi.mocked(api.runLifecycleAction).mockImplementationOnce(() => lifecycleResult.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    const startButton = await screen.findByRole("button", { name: "Start range-control" });
    expect(screen.queryByRole("button", { name: "Stop range-control" })).not.toBeInTheDocument();
    expect(startButton.querySelector('svg[data-icon="play"]')).toBeInTheDocument();
    expect(startButton).not.toHaveClass("bg-warning-soft");

    await user.click(startButton);
    expect(startButton).toBeDisabled();
    expect(api.runLifecycleAction).toHaveBeenCalledWith({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 10,
      action: "start",
    });
    expect(await screen.findByRole("dialog", { name: "Starting range-control" })).toBeInTheDocument();

    currentSnapshot = runningCloudSnapshot();
    await act(async () => {
      lifecycleResult.resolve({ ok: true, value: runningDeployment });
      await lifecycleResult.promise;
    });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Starting range-control" })).not.toBeInTheDocument());
    const stopButton = screen.getByRole("button", { name: "Stop range-control" });
    expect(screen.queryByRole("button", { name: "Start range-control" })).not.toBeInTheDocument();
    expect(stopButton.querySelector('svg[data-icon="stop"]')).toBeInTheDocument();
    expect(stopButton).toHaveClass(
      "bg-warning-soft",
      "text-warning-soft-foreground",
      "hover:bg-warning-soft-hover",
    );
  });

  it("handles a native stop request on the deployments tab with a modal for the full pending duration", async () => {
    currentSnapshot = runningCloudSnapshot();
    const lifecycleResult = deferred<OperationResult<AwsCloudDeploymentRecord>>();
    vi.mocked(api.runLifecycleAction).mockImplementationOnce(() => lifecycleResult.promise);
    const successToast = vi.spyOn(toast, "success");
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/u }));
    expect(screen.getByRole("heading", { name: "Provider Credentials" })).toBeInTheDocument();

    act(() => navigationListener?.({
      view: "deployments",
      deploymentId: DEPLOYMENT_ID,
      action: "stop",
    }));

    const progress = await screen.findByRole("dialog", { name: "Stopping range-control" });
    expect(within(progress).getByText(/provider request is in progress/u)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Deployments/u, hidden: true })).toHaveAttribute("aria-selected", "true");
    expect(api.runLifecycleAction).toHaveBeenCalledWith({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 9,
      action: "stop",
    });
    act(() => navigationListener?.({
      view: "deployments",
      deploymentId: DEPLOYMENT_ID,
      action: "stop",
    }));
    await waitFor(() => expect(api.runLifecycleAction).toHaveBeenCalledOnce());
    act(() => navigationListener?.({ view: "firewall", deploymentId: DEPLOYMENT_ID }));
    expect(screen.getByRole("dialog", { name: "Stopping range-control" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Firewall rules" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop range-control", hidden: true })).toHaveClass(
      "bg-warning-soft",
      "text-warning-soft-foreground",
      "hover:bg-warning-soft-hover",
    );
    expect(screen.getByRole("button", { name: "Reboot range-control", hidden: true })).toHaveClass(
      "bg-warning-soft",
      "text-warning-soft-foreground",
      "hover:bg-warning-soft-hover",
    );

    await act(async () => {
      lifecycleResult.resolve({ ok: true, value: runningDeployment });
      await lifecycleResult.promise;
    });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Stopping range-control" })).not.toBeInTheDocument());
    expect(await screen.findByRole("heading", { name: "Firewall rules" })).toBeInTheDocument();
    expect(successToast).toHaveBeenCalledWith("Stop requested", {
      description: "range-control was updated by AWS EC2.",
      timeout: 30_000,
    });
    successToast.mockRestore();
  });

  it("serializes native lifecycle actions across deployment cards", async () => {
    const secondDeploymentId = "44444444-4444-4444-8444-444444444444";
    const secondDeployment: AwsCloudDeploymentRecord = {
      ...runningDeployment,
      id: secondDeploymentId,
      name: "range-secondary",
      remoteHost: "198.51.100.25",
      managedAssets: [{ resourceType: "ec2-instance", resourceId: "i-def456", displayName: "range-secondary", tagged: true }],
      runtime: {
        ...runningDeployment.runtime,
        instanceId: "i-def456",
        publicIpAddress: "198.51.100.25",
      },
    };
    currentSnapshot = {
      ...runningCloudSnapshot(),
      state: { v: 1, revision: 12, deployments: [runningDeployment, secondDeployment] },
    };
    const firstResult = deferred<OperationResult<AwsCloudDeploymentRecord>>();
    const secondResult = deferred<OperationResult<AwsCloudDeploymentRecord>>();
    vi.mocked(api.runLifecycleAction)
      .mockImplementationOnce(() => firstResult.promise)
      .mockImplementationOnce(() => secondResult.promise);
    renderCloudDeploymentApp();

    await screen.findByText("range-secondary");
    act(() => navigationListener?.({
      view: "deployments",
      deploymentId: DEPLOYMENT_ID,
      action: "stop",
    }));
    expect(await screen.findByRole("dialog", { name: "Stopping range-control" })).toBeInTheDocument();

    act(() => navigationListener?.({
      view: "deployments",
      deploymentId: secondDeploymentId,
      action: "stop",
    }));
    expect(api.runLifecycleAction).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Stopping range-secondary" })).not.toBeInTheDocument();

    await act(async () => {
      firstResult.resolve({ ok: true, value: runningDeployment });
      await firstResult.promise;
    });
    await waitFor(() => expect(api.runLifecycleAction).toHaveBeenCalledTimes(2));
    expect(api.runLifecycleAction).toHaveBeenLastCalledWith({
      deploymentId: secondDeploymentId,
      expectedRevision: 12,
      action: "stop",
    });
    expect(await screen.findByRole("dialog", { name: "Stopping range-secondary" })).toBeInTheDocument();

    await act(async () => {
      secondResult.resolve({ ok: true, value: secondDeployment });
      await secondResult.promise;
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Stopping range-secondary" })).not.toBeInTheDocument());
  });

  it("shows the pending modal for a native start request until the provider responds", async () => {
    const stoppedDeployment: AwsCloudDeploymentRecord = {
      ...runningDeployment,
      status: "stopped",
      phase: "stopped",
      runtime: {
        ...runningDeployment.runtime,
        instanceState: "stopped",
        instanceHealth: "unknown",
        systemHealth: "unknown",
      },
    };
    currentSnapshot = {
      ...runningCloudSnapshot(),
      state: { v: 1, revision: 10, deployments: [stoppedDeployment] },
    };
    const lifecycleResult = deferred<OperationResult<AwsCloudDeploymentRecord>>();
    vi.mocked(api.runLifecycleAction).mockImplementationOnce(() => lifecycleResult.promise);
    renderCloudDeploymentApp();

    await screen.findByText("range-control");
    act(() => navigationListener?.({
      view: "deployments",
      deploymentId: DEPLOYMENT_ID,
      action: "start",
    }));

    expect(await screen.findByRole("dialog", { name: "Starting range-control" })).toBeInTheDocument();
    expect(api.runLifecycleAction).toHaveBeenCalledWith({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 10,
      action: "start",
    });

    await act(async () => {
      lifecycleResult.resolve({ ok: true, value: runningDeployment });
      await lifecycleResult.promise;
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Starting range-control" })).not.toBeInTheDocument());
  });

  it("opens SSH from native navigation and preserves first-use host-key review", async () => {
    currentSnapshot = runningCloudSnapshot();
    vi.mocked(api.openSshWindow).mockResolvedValueOnce({
      ok: true,
      value: { status: "host-key-review", review: sshHostKeyReview },
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/u }));
    act(() => navigationListener?.({
      view: "deployments",
      deploymentId: DEPLOYMENT_ID,
      action: "ssh",
    }));

    expect(await screen.findByRole("alertdialog", { name: "Verify SSH host" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Deployments/u, hidden: true })).toHaveAttribute("aria-selected", "true");
    expect(api.openSshWindow).toHaveBeenCalledExactlyOnceWith({ deploymentId: DEPLOYMENT_ID });
  });

  it("keeps native termination confirmation before showing its pending modal", async () => {
    currentSnapshot = runningCloudSnapshot();
    const destroyResult = deferred<Awaited<ReturnType<CloudDeploymentAPI["executeDestroyDeployment"]>>>();
    vi.mocked(api.executeDestroyDeployment).mockImplementationOnce(() => destroyResult.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await screen.findByText("range-control");
    act(() => navigationListener?.({
      view: "deployments",
      deploymentId: DEPLOYMENT_ID,
      action: "terminate",
    }));

    const confirmation = await screen.findByRole("alertdialog", { name: "Terminate range-control?" });
    expect(screen.queryByRole("dialog", { name: "Terminating range-control" })).not.toBeInTheDocument();
    await user.click(within(confirmation).getByRole("button", { name: "Terminate Instance" }));

    expect(await screen.findByRole("dialog", { name: "Terminating range-control" })).toBeInTheDocument();
    expect(api.executeDestroyDeployment).toHaveBeenCalledWith({ token: "destroy-token" });

    await act(async () => {
      destroyResult.resolve({ ok: true, value: emptySnapshot.state });
      await destroyResult.promise;
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Terminating range-control" })).not.toBeInTheDocument());
  });

  it("opens the requested AWS firewall view from native navigation", async () => {
    currentSnapshot = runningCloudSnapshot();
    renderCloudDeploymentApp();

    await screen.findByText("range-control");
    act(() => navigationListener?.({ view: "firewall", deploymentId: DEPLOYMENT_ID }));

    expect(await screen.findByRole("heading", { level: 1, name: "range-control" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Firewall rules" })).toBeInTheDocument();
    expect(api.listFirewallRules).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID });
  });

  it("surfaces persistent errors for stale or unsupported native navigation targets", async () => {
    const proxmoxDeployment: ProxmoxCloudDeploymentRecord = {
      id: "c6418f75-e7bd-4e65-b378-b29fea6d63b2",
      provider: "proxmox",
      name: "lab-vm",
      credentialId: CREDENTIAL_ID,
      status: "running",
      phase: "ready",
      createdAt: "2026-09-06T18:00:00.000Z",
      updatedAt: "2026-09-06T18:05:00.000Z",
      operatorConfigFileName: "lab-vm.cfg",
      operatorConfigDigest: "b".repeat(64),
      remoteHost: "192.0.2.40",
      lastError: null,
      managedAssets: [{ resourceType: "proxmox-vm", resourceId: "pve/140", displayName: "lab-vm", tagged: true }],
      spec: {
        node: "pve",
        templateVmId: 9000,
        vmId: 140,
        storage: "local-lvm",
        bridge: "vmbr0",
        cores: 2,
        memoryMiB: 4096,
        diskGiB: 20,
        operatorName: "operator",
        sshPort: 22,
        multiplayerPort: 31337,
        ipConfig: "ip=dhcp",
        gateway: null,
        sshCidrs: ["192.0.2.0/24"],
        operatorCidrs: ["192.0.2.0/24"],
      },
      runtime: { vmId: 140, node: "pve", ipAddress: "192.0.2.40" },
    };
    currentSnapshot = {
      ...runningCloudSnapshot(),
      state: { v: 1, revision: 9, deployments: [proxmoxDeployment] },
    };
    const dangerToast = vi.spyOn(toast, "danger");
    renderCloudDeploymentApp();

    await screen.findByText("lab-vm");
    act(() => navigationListener?.({ view: "firewall", deploymentId: proxmoxDeployment.id }));
    const unsupportedAlert = await screen.findByRole("alert");
    expect(unsupportedAlert).toHaveTextContent("Firewall unavailable");
    expect(unsupportedAlert).toHaveTextContent("is not an AWS EC2 deployment");
    expect(dangerToast).not.toHaveBeenCalled();

    act(() => navigationListener?.({
      view: "deployments",
      deploymentId: DEPLOYMENT_ID,
      action: "start",
    }));
    const staleAlert = await screen.findByRole("alert");
    expect(staleAlert).toHaveTextContent("Cloud action unavailable");
    expect(staleAlert).toHaveTextContent("is no longer in the managed inventory");
    expect(dangerToast).not.toHaveBeenCalled();
    dangerToast.mockRestore();
  });

  it("opens a dedicated AWS instance details view with inbound and outbound rule tables", async () => {
    currentSnapshot = runningCloudSnapshot();
    const user = userEvent.setup();
    const { container } = renderCloudDeploymentApp();

    expect(await screen.findByText("range-control")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit firewall for range-control" }));

    const instanceHeading = await screen.findByRole("heading", { level: 1, name: "range-control" });
    await waitFor(() => expect(api.listFirewallRules).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID }));
    const backButton = screen.getByRole("button", { name: "Back to managed servers" });
    const stickyHeader = screen.getByTestId("aws-instance-sticky-header");
    const scrollRegion = screen.getByRole("region", { name: "Instance details content" });
    expect(container.querySelector("main")).toHaveClass("h-screen", "overflow-hidden");
    expect(stickyHeader).toHaveClass("sticky", "top-0", "z-20", "shrink-0", "bg-background");
    expect(stickyHeader).toContainElement(backButton);
    expect(stickyHeader).toContainElement(instanceHeading);
    expect(scrollRegion).toHaveAttribute("data-slot", "scroll-shadow");
    expect(scrollRegion).toHaveAttribute("data-orientation", "vertical");
    expect(scrollRegion).toHaveAttribute("data-scroll-shadow-size", "48");
    expect(scrollRegion).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
    expect(backButton.compareDocumentPosition(instanceHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Cloud Deployment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /^Deployments/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /^Credentials/u })).not.toBeInTheDocument();
    expect(within(scrollRegion).getByRole("heading", { name: "Instance summary" })).toBeInTheDocument();
    expect(within(scrollRegion).getByRole("heading", { name: "Firewall rules" })).toBeInTheDocument();
    expect(screen.getByText("sg-abc123")).toBeInTheDocument();
    expect(screen.queryByText(/Managed provenance identifies/u)).not.toBeInTheDocument();

    const inboundTab = screen.getByRole("tab", { name: /Inbound/u });
    const outboundTab = screen.getByRole("tab", { name: /Outbound/u });
    expect(within(inboundTab).getByText("Inbound")).toBeInTheDocument();
    expect(within(outboundTab).getByText("Outbound")).toBeInTheDocument();
    expect(inboundTab).toHaveClass("min-w-28", "whitespace-nowrap");
    expect(outboundTab).toHaveClass("min-w-28", "whitespace-nowrap");

    const inboundGrid = await screen.findByRole("grid", { name: "Inbound firewall rules" });
    expect(within(inboundGrid).getByText("sgr-11111111111111111")).toBeInTheDocument();
    expect(within(inboundGrid).getByText("203.0.113.8/32")).toBeInTheDocument();
    expect(within(inboundGrid).queryByRole("columnheader", { name: "Description" })).not.toBeInTheDocument();
    expect(within(inboundGrid).queryByText("Operator SSH")).not.toBeInTheDocument();
    expect(within(inboundGrid).getByRole("button", { name: "Edit firewall rule sgr-11111111111111111" })).toBeInTheDocument();
    const actionsHeader = within(inboundGrid).getByRole("columnheader", { name: "Actions" });
    const editButton = within(inboundGrid).getByRole("button", { name: "Edit firewall rule sgr-11111111111111111" });
    expect(actionsHeader).not.toHaveAttribute("data-pinned");
    expect(editButton.closest('[role="gridcell"]')).not.toHaveAttribute("data-pinned");

    await user.click(outboundTab);
    const outboundGrid = await screen.findByRole("grid", { name: "Outbound firewall rules" });
    expect(within(outboundGrid).getByText("sgr-22222222222222222")).toBeInTheDocument();
    expect(within(outboundGrid).getByText("0.0.0.0/0")).toBeInTheDocument();
    expect(within(outboundGrid).getByRole("button", { name: "Delete firewall rule sgr-22222222222222222" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to managed servers" }));
    expect(container.querySelector("main")).toHaveClass("overflow-y-auto");
    expect(container.querySelector("main")).not.toHaveClass("overflow-hidden");
    expect(screen.queryByRole("region", { name: "Instance details content" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Managed Servers" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit firewall for range-control" })).toBeInTheDocument();
  });

  it("opens rule editing from accessible row actions without bubbling nested delete actions", async () => {
    currentSnapshot = runningCloudSnapshot();
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "Edit firewall for range-control" }));
    const inboundGrid = await screen.findByRole("grid", { name: "Inbound firewall rules" });
    const ruleRow = within(inboundGrid).getByText("sgr-11111111111111111").closest('[role="row"]');
    if (!(ruleRow instanceof HTMLElement)) throw new Error("Firewall rule row was not rendered");

    await user.click(ruleRow);
    expect(await screen.findByRole("dialog", { name: "Edit firewall rule" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit firewall rule" })).not.toBeInTheDocument());

    ruleRow.focus();
    expect(ruleRow).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Edit firewall rule" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit firewall rule" })).not.toBeInTheDocument());

    await user.click(within(inboundGrid).getByRole("button", { name: "Delete firewall rule sgr-11111111111111111" }));
    expect(await screen.findByRole("alertdialog", { name: "Delete firewall rule?" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Edit firewall rule" })).not.toBeInTheDocument();
  });

  it("creates an AWS firewall rule from the add-rule sheet and warns about public inbound access", async () => {
    currentSnapshot = runningCloudSnapshot();
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "Edit firewall for range-control" }));
    await screen.findByRole("grid", { name: "Inbound firewall rules" });
    await user.click(screen.getByRole("button", { name: "Add rule" }));

    const sheet = await screen.findByRole("dialog", { name: "Add firewall rule" });
    expect(within(sheet).getByRole("combobox", { name: "Direction" })).toHaveValue("ingress");
    expect(within(sheet).getByRole("combobox", { name: "Source type" })).toHaveValue("ipv4");
    await user.type(within(sheet).getByRole("textbox", { name: "From port" }), "8443");
    await user.type(within(sheet).getByRole("textbox", { name: "To port" }), "8443");
    await user.type(within(sheet).getByRole("textbox", { name: "Source" }), "0.0.0.0/0");
    await user.type(within(sheet).getByRole("textbox", { name: "Description" }), "Public test endpoint");

    expect(within(sheet).getByText("Public inbound access")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Add rule" }));

    await waitFor(() => expect(api.createFirewallRule).toHaveBeenCalledWith({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 9,
      rule: {
        direction: "ingress",
        protocol: "tcp",
        fromPort: 8_443,
        toPort: 8_443,
        peerType: "ipv4",
        peer: "0.0.0.0/0",
        description: "Public test endpoint",
      },
    }));
    expect(await screen.findByText("Firewall rule added")).toBeInTheDocument();
  });

  it("updates an AWS firewall rule while keeping its direction and peer type fixed", async () => {
    currentSnapshot = runningCloudSnapshot();
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "Edit firewall for range-control" }));
    const inboundGrid = await screen.findByRole("grid", { name: "Inbound firewall rules" });
    await user.click(within(inboundGrid).getByRole("button", { name: "Edit firewall rule sgr-11111111111111111" }));

    const sheet = await screen.findByRole("dialog", { name: "Edit firewall rule" });
    expect(within(sheet).getByRole("combobox", { name: "Direction" })).toBeDisabled();
    expect(within(sheet).getByRole("combobox", { name: "Source type" })).toBeDisabled();
    const source = within(sheet).getByRole("textbox", { name: "Source" });
    const description = within(sheet).getByRole("textbox", { name: "Description" });
    await user.clear(source);
    await user.type(source, "198.51.100.18/32");
    await user.clear(description);
    await user.type(description, "Updated operator SSH");
    await user.click(within(sheet).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(api.updateFirewallRule).toHaveBeenCalledWith({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 9,
      ruleId: "sgr-11111111111111111",
      rule: {
        direction: "ingress",
        protocol: "tcp",
        fromPort: 22,
        toPort: 22,
        peerType: "ipv4",
        peer: "198.51.100.18/32",
        description: "Updated operator SSH",
      },
    }));
    expect(await screen.findByText("Firewall rule updated")).toBeInTheDocument();
  });

  it("deletes any rule in the deployment security group after confirmation", async () => {
    currentSnapshot = runningCloudSnapshot();
    vi.mocked(api.deleteFirewallRule).mockResolvedValueOnce({
      ok: true,
      value: { ...firewallSnapshot, rules: firewallSnapshot.rules.filter(({ direction }) => direction === "ingress") },
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "Edit firewall for range-control" }));
    await screen.findByRole("grid", { name: "Inbound firewall rules" });
    await user.click(screen.getByRole("tab", { name: /Outbound/u }));
    const outboundGrid = await screen.findByRole("grid", { name: "Outbound firewall rules" });
    await user.click(within(outboundGrid).getByRole("button", { name: "Delete firewall rule sgr-22222222222222222" }));

    const confirmation = await screen.findByRole("alertdialog", { name: "Delete firewall rule?" });
    expect(within(confirmation).getByText(/All traffic access for 0\.0\.0\.0\/0/u)).toBeInTheDocument();
    await user.click(within(confirmation).getByRole("button", { name: "Delete rule" }));

    await waitFor(() => expect(api.deleteFirewallRule).toHaveBeenCalledWith({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 9,
      ruleId: "sgr-22222222222222222",
    }));
    expect(await screen.findByText("No outbound rules")).toBeInTheDocument();
    expect(screen.getByText("Firewall rule deleted")).toBeInTheDocument();
  });

  it("keeps the last good snapshot visible and reports a later refresh failure", async () => {
    currentSnapshot = {
      state: { v: 1, revision: 9, deployments: [runningDeployment] },
      credentials: [awsCredential],
      secureCredentialStorage: true,
      awsProfiles: [{ name: "default", region: "us-west-2" }],
      awsProfileDiscoveryError: null,
      provisioningTranscripts: [],
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    expect(await screen.findByText("range-control")).toBeInTheDocument();
    vi.mocked(api.getSnapshot).mockResolvedValueOnce({ ok: false, error: "provider snapshot unavailable" });
    await user.click(screen.getByRole("button", { name: "Refresh cloud deployments" }));

    expect(await screen.findByText("Refresh failed")).toBeInTheDocument();
    expect(screen.getByText(/provider snapshot unavailable/u)).toBeInTheDocument();
    expect(screen.getByText("range-control")).toBeInTheDocument();

    act(() => changedListener?.("transcripts"));
    await waitFor(() => expect(api.getProvisioningTranscripts).toHaveBeenCalledOnce());
    expect(screen.getByText(/provider snapshot unavailable/u)).toBeInTheDocument();
  });
});

function runningCloudSnapshot(): CloudDeploymentSnapshot {
  return {
    state: { v: 1, revision: 9, deployments: [runningDeployment] },
    credentials: [awsCredential],
    secureCredentialStorage: true,
    awsProfiles: [{ name: "default", region: "us-west-2" }],
    awsProfileDiscoveryError: null,
    provisioningTranscripts: [],
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function awsProvisioningDeployment(): AwsCloudDeploymentRecord {
  return {
    ...runningDeployment,
    status: "provisioning",
    phase: "waiting-instance-status",
    operatorConfigFileName: null,
    operatorConfigDigest: null,
    remoteHost: null,
    runtime: {
      ...runningDeployment.runtime,
      instanceState: "running",
      instanceHealth: "initializing",
      systemHealth: "initializing",
      publicIpAddress: null,
    },
  };
}
