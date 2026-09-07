import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AwsCloudDeploymentRecord,
  CreateCloudCredentialInput,
  CreateCloudDeploymentInput,
} from "../../shared/cloud-deployment-contracts";
import type {
  CloudDeploymentAPI,
  CloudDeploymentChangeScope,
  CloudDeploymentSnapshot,
  CurrentEgressIpv4,
} from "../../shared/cloud-deployment-ipc";
import type { AwsDeploymentOptions, DiscoverAwsOptionsInput } from "../../shared/cloud-provider-inventory";
import type { OperationResult } from "../../shared/contracts";
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

let currentSnapshot: CloudDeploymentSnapshot;
let themeListener: ((dark: boolean) => void) | undefined;
let changedListener: ((scope: CloudDeploymentChangeScope) => void) | undefined;
let capturedCredential: CreateCloudCredentialInput | undefined;
let capturedDeployment: CreateCloudDeploymentInput | undefined;
const unsubscribeTheme = vi.fn();
const unsubscribeChanged = vi.fn();

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
  onChanged: vi.fn((listener) => {
    changedListener = listener;
    return unsubscribeChanged;
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
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

beforeEach(() => {
  currentSnapshot = emptySnapshot;
  themeListener = undefined;
  changedListener = undefined;
  capturedCredential = undefined;
  capturedDeployment = undefined;
  unsubscribeTheme.mockClear();
  unsubscribeChanged.mockClear();
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
  vi.mocked(api.prepareDestroyDeployment).mockClear();
  vi.mocked(api.executeDestroyDeployment).mockClear();
  Object.defineProperty(window, "cloudDeployment", { configurable: true, value: Object.freeze(api) });
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "cloudDeployment");
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.colorScheme = "";
});

describe("CloudDeploymentWindowApp", () => {
  it("loads an accessible standalone dashboard and responds to bounded native events", async () => {
    const view = render(<CloudDeploymentWindowApp />);

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
  });

  it("coalesces rapid deployment changes into one trailing snapshot refresh", async () => {
    const firstSnapshot = deferred<OperationResult<CloudDeploymentSnapshot>>();
    const trailingSnapshot = deferred<OperationResult<CloudDeploymentSnapshot>>();
    vi.mocked(api.getSnapshot)
      .mockReturnValueOnce(firstSnapshot.promise)
      .mockReturnValueOnce(trailingSnapshot.promise);

    render(<CloudDeploymentWindowApp />);
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
    render(<CloudDeploymentWindowApp />);
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

    render(<CloudDeploymentWindowApp />);

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
    render(<CloudDeploymentWindowApp />);

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
    render(<CloudDeploymentWindowApp />);

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
    render(<CloudDeploymentWindowApp />);

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
    render(<CloudDeploymentWindowApp />);

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
    render(<CloudDeploymentWindowApp />);

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
    render(<CloudDeploymentWindowApp />);

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
    render(<CloudDeploymentWindowApp />);

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
    render(<CloudDeploymentWindowApp />);

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
    render(<CloudDeploymentWindowApp />);

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
    render(<CloudDeploymentWindowApp />);

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
    render(<CloudDeploymentWindowApp />);

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
    render(<CloudDeploymentWindowApp />);

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
    render(<CloudDeploymentWindowApp />);
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
    render(<CloudDeploymentWindowApp />);

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
    render(<CloudDeploymentWindowApp />);

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
    render(<CloudDeploymentWindowApp />);

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

  it("routes lifecycle, firewall, and reviewed destruction through their dedicated bridge methods", async () => {
    currentSnapshot = {
      state: { v: 1, revision: 9, deployments: [runningDeployment] },
      credentials: [awsCredential],
      secureCredentialStorage: true,
      awsProfiles: [{ name: "default", region: "us-west-2" }],
      awsProfileDiscoveryError: null,
      provisioningTranscripts: [],
    };
    const user = userEvent.setup();
    render(<CloudDeploymentWindowApp />);

    expect(await screen.findByText("range-control")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Stop/i }));
    await waitFor(() => expect(api.runLifecycleAction).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID, expectedRevision: 9, action: "stop" }));

    await user.click(screen.getByRole("button", { name: /Firewall/i }));
    const firewallHeading = screen.getByRole("heading", { name: "Firewall Sources" });
    const firewallPanel = firewallHeading.parentElement?.parentElement;
    if (!firewallPanel) throw new Error("Firewall editor was not rendered");
    const sshInput = within(firewallPanel).getByRole("textbox", { name: "SSH Source CIDRs" });
    await user.clear(sshInput);
    await user.type(sshInput, "192.0.2.4/32");
    await user.click(within(firewallPanel).getByRole("button", { name: "Save Firewall" }));
    await waitFor(() => expect(api.updateFirewall).toHaveBeenCalledWith({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 9,
      sshCidrs: ["192.0.2.4/32"],
      operatorCidrs: ["203.0.113.8/32"],
    }));

    await user.click(screen.getByRole("button", { name: "Terminate range-control" }));
    expect(await screen.findByRole("alertdialog", { name: "Terminate range-control?" })).toBeInTheDocument();
    expect(api.prepareDestroyDeployment).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID, expectedRevision: 9 });
    await user.click(screen.getByRole("button", { name: "Terminate Instance" }));
    await waitFor(() => expect(api.executeDestroyDeployment).toHaveBeenCalledWith({ token: "destroy-token" }));
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
    render(<CloudDeploymentWindowApp />);

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
