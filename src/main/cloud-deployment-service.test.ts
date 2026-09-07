// @vitest-environment node

import { createHash, generateKeyPairSync } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ssh2 from "ssh2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CreateAwsCloudDeploymentInput,
  CreateProxmoxCloudDeploymentInput,
  ResolvedAwsCloudCredentialInput,
  ResolvedProxmoxCloudCredentialInput,
} from "../shared/cloud-deployment-contracts.js";
import type { CloudDeploymentChangeScope } from "../shared/cloud-deployment-ipc.js";
import {
  cloudRequiredPermissions,
  createCloudPermissionEvaluation,
} from "../shared/cloud-provider-permissions.js";
import { CloudCredentialVault, type CloudSafeStorageAdapter } from "./cloud-credential-vault.js";
import { CloudDeploymentStore } from "./cloud-deployment-store.js";
import {
  CloudDeploymentService,
  type CloudAwsProvider,
  type CloudAwsProfileSource,
  type CloudPrivateKeyCapabilities,
  type CloudProxmoxProvider,
  type CloudSliverProvisioner,
} from "./cloud-deployment-service.js";
import type { AwsEc2DeploymentResource } from "./cloud/aws-ec2-provider.js";
import type { ProxmoxDeploymentResult, ProxmoxResources } from "./cloud/proxmox-provider.js";
import { generateEd25519SshKeyPair } from "./cloud/ssh-key-generator.js";

const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_DEPLOYMENT_ID = "55555555-5555-4555-8555-555555555555";
const CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
const DESTROY_TOKEN = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-09-06T18:00:00.000Z");

let temporaryDirectory = "";
let rootDirectory = "";
let operatorConfigDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "sliver-gui-cloud-service-"));
  rootDirectory = join(temporaryDirectory, ".sliver-client", "gui", "cloud-deployment", "v1");
  operatorConfigDirectory = join(temporaryDirectory, ".sliver-client", "configs");
});

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("CloudDeploymentService", () => {
  it.each(["provisioning", "deleting"] as const)(
    "marks an interrupted %s transition failed when a new service session starts",
    async (status) => {
      const { store, safeStorage } = await dependencies();
      const created = await store.create(awsDeployment());
      if (!created.ok) throw new Error(created.error);
      if (status === "deleting") {
        const deleting = await store.update({
          expectedRevision: store.getState().revision,
          deployment: { ...created.value.deployment, status: "deleting", phase: "deleting" },
        });
        if (!deleting.ok) throw new Error(deleting.error);
      }

      const service = await CloudDeploymentService.create({
        rootDirectory,
        operatorConfigDirectory,
        safeStorage,
        store,
        provisioner: fakeProvisioner(),
      });

      expect(store.getState().deployments[0]).toMatchObject({
        status: "failed",
        phase: "failed",
        lastError: expect.stringMatching(new RegExp(`${status === "deleting" ? "termination" : "provisioning"} operation was interrupted`, "u")),
      });
      await expect(service.getSnapshot()).resolves.toMatchObject({
        ok: true,
        value: { provisioningTranscripts: [] },
      });
      expect(JSON.parse(await readFile(store.filePath, "utf8"))).toEqual(store.getState());
      service.dispose();
    },
  );

  it("returns the detected current egress IPv4 CIDR through the main-owned service", async () => {
    const detector = vi.fn(async () => ({
      address: "203.0.113.42",
      cidr: "203.0.113.42/32",
    }));
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      provisioner: fakeProvisioner(),
      egressIpv4Detector: detector,
    });

    const result = await service.detectCurrentEgressIpv4();

    expect(result).toEqual({
      ok: true,
      value: { address: "203.0.113.42", cidr: "203.0.113.42/32" },
    });
    if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
    expect(detector).toHaveBeenCalledOnce();
  });

  it("returns bounded transcripts without listing credentials or AWS profiles", async () => {
    const { vault } = await dependencies();
    const listCredentials = vi.spyOn(vault, "list");
    const listProfiles = vi.fn(async () => [{ name: "default", region: "us-west-2" }]);
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      vault,
      provisioner: fakeProvisioner(),
      awsProfileSource: {
        list: listProfiles,
        credentialProvider: vi.fn(async () => async () => ({
          accessKeyId: "not-used",
          secretAccessKey: "not-used",
        })),
      },
    });

    const result = service.getProvisioningTranscripts();

    expect(result).toEqual({ ok: true, value: { provisioningTranscripts: [] } });
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.provisioningTranscripts)).toBe(true);
    }
    expect(listCredentials).not.toHaveBeenCalled();
    expect(listProfiles).not.toHaveBeenCalled();
    service.dispose();
  });

  it("performs an AWS one-click deployment, lifecycle/firewall management, and confirmed deletion", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    const provisioner = fakeProvisioner();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner,
      awsProviderFactory: () => provider,
      idFactory: () => DESTROY_TOKEN,
      now: () => NOW.getTime(),
    });
    const awsProgress: Array<{
      phase: string;
      status: string;
      instanceState: string;
      instanceHealth: string;
      systemHealth: string;
    }> = [];
    const changeScopes: CloudDeploymentChangeScope[] = [];
    const changed = vi.fn((scope: CloudDeploymentChangeScope) => {
      changeScopes.push(scope);
      const latest = store.getState().deployments[0];
      if (latest?.provider !== "aws") return;
      awsProgress.push({
        phase: latest.phase,
        status: latest.status,
        instanceState: latest.runtime.instanceState,
        instanceHealth: latest.runtime.instanceHealth,
        systemHealth: latest.runtime.systemHealth,
      });
    });
    service.subscribe(changed);

    const created = await service.createDeployment(awsDeployment());
    if (!created.ok) throw new Error(created.error);

    expect(created).toMatchObject({
      ok: true,
      value: {
        id: DEPLOYMENT_ID,
        status: "running",
        phase: "ready",
        remoteHost: "203.0.113.20",
        operatorConfigFileName: `sliver-gui-cloud-${DEPLOYMENT_ID}.cfg`,
        managedAssets: [
          { resourceType: "ec2-instance", resourceId: "i-0123456789abcdef0", tagged: true },
          { resourceType: "ec2-volume", resourceId: "vol-0123456789abcdef0", tagged: true },
          { resourceType: "ec2-network-interface", resourceId: "eni-0123456789abcdef0", tagged: true },
          { resourceType: "ec2-security-group", resourceId: "sg-0123456789abcdef0", tagged: true },
          { resourceType: "ec2-key-pair", resourceId: "key-0123456789abcdef0", tagged: true },
          { resourceType: "ec2-elastic-ip", resourceId: "eipalloc-0123456789abcdef0", tagged: true },
        ],
      },
    });
    expect(provider.create).toHaveBeenCalledWith(
      expect.objectContaining({
        guid: DEPLOYMENT_ID,
        network: {
          mode: "existing",
          vpcId: "vpc-0123456789abcdef0",
          subnetId: "subnet-a0000000000000000",
        },
        sshPublicKey: expect.stringMatching(/^ssh-rsa /u),
      }),
      expect.any(Function),
    );
    expect(provider.create.mock.calls[0]?.[0]).not.toHaveProperty("keyName");
    expect(created.value.provider).toBe("aws");
    if (created.value.provider !== "aws") throw new Error("Expected an AWS deployment");
    expect(created.value.spec.keyPairName).toBe("managed-by-sliver-gui");
    expect(provisioner.provision).toHaveBeenCalledWith(expect.objectContaining({
      deploymentId: DEPLOYMENT_ID,
      operatorEndpointHost: "203.0.113.20",
      ssh: expect.objectContaining({ host: "203.0.113.20", username: "ubuntu" }),
    }));
    expect(awsProgress).toEqual(expect.arrayContaining([
      {
        phase: "starting-instance",
        status: "provisioning",
        instanceState: "pending",
        instanceHealth: "initializing",
        systemHealth: "initializing",
      },
      {
        phase: "waiting-instance-status",
        status: "provisioning",
        instanceState: "running",
        instanceHealth: "initializing",
        systemHealth: "initializing",
      },
      {
        phase: "waiting-system-status",
        status: "provisioning",
        instanceState: "running",
        instanceHealth: "ok",
        systemHealth: "initializing",
      },
      {
        phase: "finalizing-network",
        status: "provisioning",
        instanceState: "running",
        instanceHealth: "ok",
        systemHealth: "ok",
      },
      {
        phase: "installing-sliver",
        status: "provisioning",
        instanceState: "running",
        instanceHealth: "ok",
        systemHealth: "ok",
      },
    ]));
    expect(changeScopes).toContain("snapshot");
    expect(changeScopes).toContain("transcripts");

    const provisioningSnapshot = await service.getSnapshot();
    expect(provisioningSnapshot).toMatchObject({
      ok: true,
      value: {
        provisioningTranscripts: [{
          deploymentId: DEPLOYMENT_ID,
          status: "complete",
          truncated: false,
        }],
      },
    });
    if (!provisioningSnapshot.ok) throw new Error(provisioningSnapshot.error);
    const transcriptText = provisioningSnapshot.value.provisioningTranscripts[0]?.chunks
      .map(({ bytes }) => Buffer.from(bytes).toString("utf8"))
      .join("");
    expect(transcriptText).toContain("==> Installing the Sliver server");
    expect(transcriptText).toContain("sliver-server active");
    expect(await readFile(join(rootDirectory, "state.json"), "utf8")).not.toContain("sliver-server active");

    const filePath = join(operatorConfigDirectory, `sliver-gui-cloud-${DEPLOYMENT_ID}.cfg`);
    const config = await readFile(filePath);
    expect(createHash("sha256").update(config).digest("hex")).toBe(
      created.ok ? created.value.operatorConfigDigest : undefined,
    );
    if (process.platform !== "win32") expect((await lstat(filePath)).mode & 0o777).toBe(0o600);
    expect(changed).toHaveBeenCalled();

    const stopped = await service.runLifecycleAction({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
      action: "stop",
    });
    expect(stopped).toMatchObject({ ok: true, value: { status: "stopped", phase: "stopped" } });

    const firewall = await service.updateFirewall({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
      sshCidrs: ["192.0.2.44/32"],
      operatorCidrs: ["198.51.100.44/32"],
    });
    expect(firewall).toMatchObject({
      ok: true,
      value: { spec: { sshCidrs: ["192.0.2.44/32"], operatorCidrs: ["198.51.100.44/32"] } },
    });
    if (!firewall.ok) throw new Error(firewall.error);

    const busyDeployment = await store.update({
      expectedRevision: store.getState().revision,
      deployment: { ...firewall.value, status: "provisioning", phase: "installing-sliver" },
    });
    if (!busyDeployment.ok) throw new Error(busyDeployment.error);
    await expect(service.updateFirewall({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
      sshCidrs: ["192.0.2.45/32"],
      operatorCidrs: ["198.51.100.45/32"],
    })).resolves.toEqual({ ok: false, error: "The deployment is busy" });
    expect(provider.replaceFirewall).toHaveBeenCalledTimes(1);
    const restoredDeployment = await store.update({
      expectedRevision: store.getState().revision,
      deployment: { ...busyDeployment.value.deployment, status: "running", phase: "ready" },
    });
    if (!restoredDeployment.ok) throw new Error(restoredDeployment.error);

    const prepared = service.prepareDestroyDeployment({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
    });
    expect(prepared).toMatchObject({ ok: true, value: { token: DESTROY_TOKEN, deploymentId: DEPLOYMENT_ID } });
    const destroyed = await service.executeDestroyDeployment({ token: DESTROY_TOKEN });
    expect(destroyed).toEqual({ ok: true, value: { v: 1, revision: store.getState().revision, deployments: [] } });
    expect(provider.destroy).toHaveBeenCalledOnce();
    expect(provider.destroy).toHaveBeenCalledWith(expect.objectContaining({
      volumeIds: ["vol-0123456789abcdef0"],
      networkInterfaceIds: ["eni-0123456789abcdef0"],
    }));
    await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(service.getSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { provisioningTranscripts: [] },
    });
    await expect(service.executeDestroyDeployment({ token: DESTROY_TOKEN })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/invalid or expired/u),
    });
    service.dispose();
  });

  it.each([
    { state: "pending" as const, instanceHealth: "ok" as const, systemHealth: "ok" as const },
    { state: "running" as const, instanceHealth: "initializing" as const, systemHealth: "ok" as const },
    { state: "running" as const, instanceHealth: "ok" as const, systemHealth: "initializing" as const },
  ])("refuses SSH provisioning until every EC2 status check passes (%o)", async (health) => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    provider.create.mockResolvedValueOnce({ ...awsResource(), ...health });
    const provisioner = fakeProvisioner();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner,
      awsProviderFactory: () => provider,
    });

    await expect(service.createDeployment(awsDeployment())).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/status checks did not pass; refusing SSH provisioning/u),
    });
    expect(provisioner.provision).not.toHaveBeenCalled();
    expect(store.getState().deployments[0]).toMatchObject({ status: "failed", phase: "failed" });
    service.dispose();
  });

  it("uses the stable private address in the operator profile when Elastic IP is disabled", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    const { elasticIp: _elasticIp, ...withoutElasticIp } = awsResource();
    provider.create.mockResolvedValueOnce(withoutElasticIp);
    const provisioner = fakeProvisioner();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner,
      awsProviderFactory: () => provider,
    });

    const created = await service.createDeployment(awsDeployment(false));

    expect(created).toMatchObject({ ok: true, value: { status: "running" } });
    expect(provisioner.provision).toHaveBeenCalledWith(expect.objectContaining({
      operatorEndpointHost: "10.0.0.20",
      ssh: expect.objectContaining({ host: "203.0.113.20" }),
    }));
    service.dispose();
  });

  it("creates, journals, and destroys a managed AWS network as GUI-owned infrastructure", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    const managedNetwork = {
      vpcId: "vpc-0123456789abcdef0",
      subnetId: "subnet-0123456789abcdef0",
      internetGatewayId: "igw-0123456789abcdef0",
      routeTableId: "rtb-0123456789abcdef0",
      routeTableAssociationId: "rtbassoc-0123456789abcdef0",
    } as const;
    provider.create.mockImplementationOnce(async (_input, onMutation) => {
      const resource = { ...awsResource(), managedNetwork };
      await onMutation?.({ phase: "key-pair", resources: { keyPair: resource.keyPair } });
      await onMutation?.({ phase: "vpc", resources: { keyPair: resource.keyPair, vpcId: managedNetwork.vpcId } });
      await onMutation?.({
        phase: "internet-gateway",
        resources: {
          keyPair: resource.keyPair,
          vpcId: managedNetwork.vpcId,
          internetGatewayId: managedNetwork.internetGatewayId,
        },
      });
      await onMutation?.({
        phase: "subnet",
        resources: {
          keyPair: resource.keyPair,
          vpcId: managedNetwork.vpcId,
          internetGatewayId: managedNetwork.internetGatewayId,
          subnetId: managedNetwork.subnetId,
        },
      });
      await onMutation?.({
        phase: "route-table",
        resources: { keyPair: resource.keyPair, ...managedNetwork },
      });
      return resource;
    });
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
      idFactory: () => DESTROY_TOKEN,
      now: () => NOW.getTime(),
    });
    const request = awsDeployment();
    const created = await service.createDeployment({
      ...request,
      spec: {
        ...request.spec,
        vpcId: null,
        subnetId: null,
        networkMode: "managed",
        managedVpcCidr: "10.42.0.0/16",
        managedSubnetCidr: "10.42.1.0/24",
      },
    });
    if (!created.ok) throw new Error(created.error);

    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({
      network: {
        mode: "managed",
        vpcCidrBlock: "10.42.0.0/16",
        subnetCidrBlock: "10.42.1.0/24",
      },
    }), expect.any(Function));
    expect(created.value).toMatchObject({
      runtime: managedNetwork,
      managedAssets: expect.arrayContaining([
        expect.objectContaining({ resourceType: "ec2-vpc", resourceId: managedNetwork.vpcId, tagged: true }),
        expect.objectContaining({ resourceType: "ec2-subnet", resourceId: managedNetwork.subnetId, tagged: true }),
        expect.objectContaining({ resourceType: "ec2-internet-gateway", resourceId: managedNetwork.internetGatewayId, tagged: true }),
        expect.objectContaining({ resourceType: "ec2-route-table", resourceId: managedNetwork.routeTableId, tagged: true }),
        expect.objectContaining({
          resourceType: "ec2-route-table-association",
          resourceId: managedNetwork.routeTableAssociationId,
          tagged: false,
        }),
      ]),
    });
    const plan = service.prepareDestroyDeployment({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
    });
    if (!plan.ok) throw new Error(plan.error);
    await expect(service.executeDestroyDeployment({ token: plan.value.token })).resolves.toMatchObject({ ok: true });
    expect(provider.destroy).toHaveBeenCalledWith(expect.objectContaining({ managedNetwork }));
    service.dispose();
  });

  it("uses but never tracks or destroys an existing key pair that matches the credential key", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    const existingKeyPair = {
      id: "key-0123456789abcdef0",
      name: "operator-existing",
      managed: false,
    } as const;
    provider.create.mockImplementationOnce(async (_input, onMutation) => {
      const resource = { ...awsResource(), keyPair: existingKeyPair };
      await onMutation?.({
        phase: "security-group",
        resources: { keyPair: existingKeyPair, securityGroupId: resource.securityGroupId },
      });
      await onMutation?.({
        phase: "instance",
        resources: {
          keyPair: existingKeyPair,
          securityGroupId: resource.securityGroupId,
          instanceId: resource.instanceId,
        },
      });
      return resource;
    });
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
      idFactory: () => DESTROY_TOKEN,
      now: () => NOW.getTime(),
    });
    const request = awsDeployment();
    const created = await service.createDeployment({
      ...request,
      spec: {
        ...request.spec,
        vpcId: "vpc-0123456789abcdef0",
        subnetId: "subnet-a0000000000000000",
        sshKeyMode: "existing",
        existingKeyPairName: existingKeyPair.name,
        keyPairName: existingKeyPair.name,
      },
    });
    if (!created.ok) throw new Error(created.error);

    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({
      sshKeyPair: { mode: "existing", name: existingKeyPair.name },
    }), expect.any(Function));
    expect(created.value.managedAssets).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceType: "ec2-key-pair" }),
    ]));
    const plan = service.prepareDestroyDeployment({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
    });
    if (!plan.ok) throw new Error(plan.error);
    await expect(service.executeDestroyDeployment({ token: plan.value.token })).resolves.toMatchObject({ ok: true });
    expect(provider.destroy.mock.calls[0]?.[0]).not.toHaveProperty("keyPair");
    service.dispose();
  });

  it("creates and tests a credential without exposing secrets in the snapshot", async () => {
    const store = await CloudDeploymentStore.load(rootDirectory, { idFactory: () => DEPLOYMENT_ID });
    const safeStorage = new XorSafeStorage();
    const vault = new CloudCredentialVault(rootDirectory, safeStorage, {
      idFactory: () => CREDENTIAL_ID,
      clock: () => NOW,
    });
    const keys = fakePrivateKeys();
    const provider = new FakeAwsProvider();
    const permissionChecker = fakeAwsPermissionChecker();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      privateKeyCapabilities: keys,
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
      awsPermissionCheckerFactory: () => permissionChecker,
    });

    const created = await service.createCredential({
      provider: "aws",
      label: "Production AWS",
      defaultRegion: "us-west-2",
      sshUsername: "ubuntu",
      sshPrivateKeyToken: "44444444-4444-4444-8444-444444444444",
      accessKeyId: "AKIAEXAMPLE00000001",
      secretAccessKey: "secret-cloud-value",
      sessionToken: null,
      sshPassphrase: null,
    });
    expect(created).toMatchObject({
      ok: true,
      value: { id: CREDENTIAL_ID, provider: "aws", persistence: "secure" },
    });
    expect(keys.consume).toHaveBeenCalledOnce();
    const tested = await service.testCredential({ credentialId: CREDENTIAL_ID });
    expect(tested).toMatchObject({
      ok: true,
      value: {
        provider: "aws",
        summary: expect.stringMatching(/^AWS us-west-2: [0-9]+\/[0-9]+ required IAM permissions verified/u),
        permissions: { missing: [], unverifiable: ["ec2:CreateTags", "ec2:ModifyVpcAttribute", "ec2:ModifySubnetAttribute"] },
      },
    });
    expect(permissionChecker.check).toHaveBeenCalledOnce();
    const snapshot = await service.getSnapshot();
    expect(snapshot).toMatchObject({ ok: true, value: { secureCredentialStorage: true } });
    expect(JSON.stringify(snapshot)).not.toContain("secret-cloud-value");
    expect(await service.deleteCredential({ credentialId: CREDENTIAL_ID })).toEqual({ ok: true });
    service.dispose();
    expect(keys.dispose).toHaveBeenCalledOnce();
  });

  it("returns renderer-safe AWS deployment options for the selected credential and region", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => new FakeAwsProvider(),
    });

    const discovered = await service.discoverAwsOptions({
      credentialId: CREDENTIAL_ID,
      region: "us-west-2",
    });

    expect(discovered).toMatchObject({
      ok: true,
      value: {
        region: "us-west-2",
        instanceTypes: [{ name: "t3.micro", architecture: "x86_64", memoryMiB: 1024 }],
        images: [{ distribution: "ubuntu", sshUsername: "ubuntu" }],
        vpcs: [{ id: "vpc-0123456789abcdef0", isDefault: true }],
        credentialKey: { fingerprint: expect.stringMatching(/^SHA256:/u) },
      },
    });
    expect(JSON.stringify(discovered)).not.toMatch(/PRIVATE KEY|secret-cloud-value/u);
    service.dispose();
  });

  it("tests Proxmox against its effective provider privileges without a mutation", async () => {
    const { store, vault } = await dependencies();
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    await vault.create(proxmoxCredential(privateKey));
    const provider = new FakeProxmoxProvider();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      proxmoxProviderFactory: () => provider,
    });

    const tested = await service.testCredential({ credentialId: CREDENTIAL_ID });

    expect(tested).toMatchObject({
      ok: true,
      value: {
        provider: "proxmox",
        summary: expect.stringMatching(/^Proxmox 8\.4\.0: [0-9]+\/[0-9]+ required privileges verified/u),
        permissions: { missing: [], unverifiable: [] },
      },
    });
    expect(provider.checkPermissions).toHaveBeenCalledOnce();
    expect(provider.create).not.toHaveBeenCalled();
    service.dispose();
  });

  it("generates and securely stores an Ed25519 key when no private key is selected", async () => {
    const store = await CloudDeploymentStore.load(rootDirectory, { idFactory: () => DEPLOYMENT_ID });
    const safeStorage = new XorSafeStorage();
    const vault = new CloudCredentialVault(rootDirectory, safeStorage, {
      idFactory: () => CREDENTIAL_ID,
      clock: () => NOW,
    });
    const keys = fakePrivateKeys();
    const keyGenerator = vi.fn(generateEd25519SshKeyPair);
    const provider = new FakeAwsProvider();
    const provisioner = fakeProvisioner();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      privateKeyCapabilities: keys,
      sshKeyGenerator: keyGenerator,
      provisioner,
      awsProviderFactory: () => provider,
    });

    const created = await service.createCredential({
      provider: "aws",
      label: "Generated SSH key",
      defaultRegion: "us-west-2",
      sshUsername: "ubuntu",
      sshPrivateKeyToken: null,
      accessKeyId: "AKIAEXAMPLE00000001",
      secretAccessKey: "secret-cloud-value",
      sessionToken: null,
      sshPassphrase: null,
    });

    expect(created).toMatchObject({ ok: true, value: { id: CREDENTIAL_ID, persistence: "secure" } });
    expect(keyGenerator).toHaveBeenCalledOnce();
    expect(keys.consume).not.toHaveBeenCalled();
    await expect(vault.withCredential(CREDENTIAL_ID, "aws", (secret) => ({
      isGeneratedEd25519: secret.sshPrivateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----"),
      passphrase: secret.sshPassphrase,
    }))).resolves.toEqual({ isGeneratedEd25519: true, passphrase: null });
    expect(JSON.stringify(await service.getSnapshot())).not.toMatch(/OPENSSH PRIVATE KEY|secret-cloud-value/u);

    const deployed = await service.createDeployment(awsDeployment());
    expect(deployed).toMatchObject({ ok: true, value: { status: "running" } });
    expect(provider.create).toHaveBeenCalledWith(
      expect.objectContaining({ sshPublicKey: expect.stringMatching(/^ssh-ed25519 /u) }),
      expect.any(Function),
    );
    expect(provisioner.provision).toHaveBeenCalledWith(expect.objectContaining({
      ssh: expect.objectContaining({
        privateKey: expect.stringMatching(/^-----BEGIN OPENSSH PRIVATE KEY-----/u),
      }),
    }));
    service.dispose();
  });

  it("generates an Ed25519 key for an AWS CLI profile without contacting AWS", async () => {
    const store = await CloudDeploymentStore.load(rootDirectory, { idFactory: () => DEPLOYMENT_ID });
    const safeStorage = new XorSafeStorage();
    const vault = new CloudCredentialVault(rootDirectory, safeStorage, {
      idFactory: () => CREDENTIAL_ID,
      clock: () => NOW,
    });
    const keys = fakePrivateKeys();
    const keyGenerator = vi.fn(generateEd25519SshKeyPair);
    const profileSource: CloudAwsProfileSource = {
      list: vi.fn(async () => [{ name: "generals-network", region: "us-west-2" }]),
      credentialProvider: vi.fn(async () => async () => ({
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "must-not-be-resolved",
      })),
    };
    const awsProviderFactory = vi.fn(() => new FakeAwsProvider());
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      privateKeyCapabilities: keys,
      sshKeyGenerator: keyGenerator,
      provisioner: fakeProvisioner(),
      awsProfileSource: profileSource,
      awsProviderFactory,
    });

    await expect(service.createCredential({
      provider: "aws",
      label: "Generated profile key",
      defaultRegion: "us-west-2",
      sshUsername: "ubuntu",
      sshPrivateKeyToken: null,
      profileName: "generals-network",
      sshPassphrase: null,
    })).resolves.toMatchObject({ ok: true, value: { profileName: "generals-network" } });

    expect(keyGenerator).toHaveBeenCalledOnce();
    expect(keys.consume).not.toHaveBeenCalled();
    expect(profileSource.credentialProvider).not.toHaveBeenCalled();
    expect(awsProviderFactory).not.toHaveBeenCalled();
    await expect(vault.withCredential(CREDENTIAL_ID, "aws", (secret) => ({
      ...inspectStoredSshKey(secret),
      isExpectedProfile: "profileName" in secret && secret.profileName === "generals-network",
    }))).resolves.toEqual({ algorithm: "ssh-ed25519", isPrivate: true, passphrase: null, isExpectedProfile: true });
    service.dispose();
  });

  it("generates an Ed25519 key for Proxmox without contacting Proxmox", async () => {
    const store = await CloudDeploymentStore.load(rootDirectory, { idFactory: () => DEPLOYMENT_ID });
    const safeStorage = new XorSafeStorage();
    const vault = new CloudCredentialVault(rootDirectory, safeStorage, {
      idFactory: () => CREDENTIAL_ID,
      clock: () => NOW,
    });
    const keys = fakePrivateKeys();
    const keyGenerator = vi.fn(generateEd25519SshKeyPair);
    const proxmoxProviderFactory = vi.fn(() => new FakeProxmoxProvider());
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      privateKeyCapabilities: keys,
      sshKeyGenerator: keyGenerator,
      provisioner: fakeProvisioner(),
      proxmoxProviderFactory,
    });

    await expect(service.createCredential({
      provider: "proxmox",
      label: "Generated Proxmox key",
      sshUsername: "root",
      sshPrivateKeyToken: null,
      endpoint: "https://pve.example.test:8006",
      tokenId: "root@pam!sliver-gui",
      tokenSecret: "pve-secret",
      tlsCaCertificate: null,
      sshPassphrase: null,
    })).resolves.toMatchObject({ ok: true, value: { provider: "proxmox" } });

    expect(keyGenerator).toHaveBeenCalledOnce();
    expect(keys.consume).not.toHaveBeenCalled();
    expect(proxmoxProviderFactory).not.toHaveBeenCalled();
    await expect(vault.withCredential(CREDENTIAL_ID, "proxmox", inspectStoredSshKey))
      .resolves.toEqual({ algorithm: "ssh-ed25519", isPrivate: true, passphrase: null });
    service.dispose();
  });

  it("stores an AWS CLI profile reference and wires its refreshable provider without creating resources", async () => {
    const store = await CloudDeploymentStore.load(rootDirectory, { idFactory: () => DEPLOYMENT_ID });
    const safeStorage = new XorSafeStorage();
    const vault = new CloudCredentialVault(rootDirectory, safeStorage, {
      idFactory: () => CREDENTIAL_ID,
      clock: () => NOW,
    });
    const keys = fakePrivateKeys();
    const provider = new FakeAwsProvider();
    const resolvedCredentialProvider = vi.fn(async () => ({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "resolved-only-inside-sdk",
    }));
    const profileSource: CloudAwsProfileSource = {
      list: vi.fn(async () => [{ name: "generals-network", region: "us-west-2" }]),
      credentialProvider: vi.fn(async () => resolvedCredentialProvider),
    };
    const awsProviderFactory = vi.fn(() => provider);
    const awsPermissionCheckerFactory = vi.fn(() => fakeAwsPermissionChecker());
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      privateKeyCapabilities: keys,
      provisioner: fakeProvisioner(),
      awsProfileSource: profileSource,
      awsProviderFactory,
      awsPermissionCheckerFactory,
    });

    const created = await service.createCredential({
      provider: "aws",
      label: "Existing CLI profile",
      defaultRegion: "us-west-2",
      sshUsername: "ubuntu",
      sshPrivateKeyToken: "44444444-4444-4444-8444-444444444444",
      profileName: "generals-network",
      sshPassphrase: null,
    });
    expect(created).toMatchObject({
      ok: true,
      value: { provider: "aws", profileName: "generals-network", defaultRegion: "us-west-2" },
    });
    expect(keys.consume).toHaveBeenCalledOnce();

    const tested = await service.testCredential({ credentialId: CREDENTIAL_ID });
    expect(tested).toMatchObject({ ok: true, value: { provider: "aws" } });
    expect(profileSource.credentialProvider).toHaveBeenCalledWith("generals-network", "us-west-2");
    expect(awsPermissionCheckerFactory).toHaveBeenCalledWith({
      region: "us-west-2",
      credentials: resolvedCredentialProvider,
    });
    expect(awsProviderFactory).not.toHaveBeenCalled();
    expect(resolvedCredentialProvider).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();

    const snapshot = await service.getSnapshot();
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        awsProfiles: [{ name: "generals-network", region: "us-west-2" }],
        awsProfileDiscoveryError: null,
        credentials: [{ profileName: "generals-network" }],
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("resolved-only-inside-sdk");
    service.dispose();
  });

  it("rejects a disappeared AWS CLI profile before consuming the SSH key capability", async () => {
    const store = await CloudDeploymentStore.load(rootDirectory, { idFactory: () => DEPLOYMENT_ID });
    const safeStorage = new XorSafeStorage();
    const keys = fakePrivateKeys();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      privateKeyCapabilities: keys,
      provisioner: fakeProvisioner(),
      awsProfileSource: {
        list: vi.fn(async () => []),
        credentialProvider: vi.fn(async () => async () => ({
          accessKeyId: "AKIAIOSFODNN7EXAMPLE",
          secretAccessKey: "not-used",
        })),
      },
    });

    await expect(service.createCredential({
      provider: "aws",
      label: "Missing profile",
      defaultRegion: "us-west-2",
      sshUsername: "ubuntu",
      sshPrivateKeyToken: "44444444-4444-4444-8444-444444444444",
      profileName: "missing",
      sshPassphrase: null,
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/no longer available/u) });
    expect(keys.consume).not.toHaveBeenCalled();
    service.dispose();
  });

  it("destroys provider resources before refusing to remove a changed operator configuration", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
      idFactory: () => DESTROY_TOKEN,
      now: () => NOW.getTime(),
    });
    const created = await service.createDeployment(awsDeployment());
    if (!created.ok) throw new Error(created.error);
    const filePath = join(operatorConfigDirectory, `sliver-gui-cloud-${DEPLOYMENT_ID}.cfg`);
    await writeFile(filePath, "user-modified", { mode: 0o600 });
    const prepared = service.prepareDestroyDeployment({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
    });
    if (!prepared.ok) throw new Error(prepared.error);

    const result = await service.executeDestroyDeployment({ token: prepared.value.token });

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/changed after Cloud Deployment/u) });
    expect(provider.destroy).toHaveBeenCalledOnce();
    expect(await readFile(filePath, "utf8")).toBe("user-modified");
    expect(store.getState().deployments[0]).toMatchObject({ status: "failed", phase: "failed" });
    service.dispose();
  });

  it("retains the operator configuration until provider destruction succeeds", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    provider.destroy.mockRejectedValueOnce(new Error("provider teardown failed"));
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
      idFactory: () => DESTROY_TOKEN,
      now: () => NOW.getTime(),
    });
    const created = await service.createDeployment(awsDeployment());
    if (!created.ok) throw new Error(created.error);
    const filePath = join(operatorConfigDirectory, `sliver-gui-cloud-${DEPLOYMENT_ID}.cfg`);
    const firstPlan = service.prepareDestroyDeployment({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
    });
    if (!firstPlan.ok) throw new Error(firstPlan.error);

    await expect(service.executeDestroyDeployment({ token: firstPlan.value.token })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/provider teardown failed/u),
    });
    await expect(lstat(filePath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    expect(store.getState().deployments[0]).toMatchObject({
      operatorConfigFileName: `sliver-gui-cloud-${DEPLOYMENT_ID}.cfg`,
      operatorConfigDigest: created.value.operatorConfigDigest,
      status: "failed",
    });

    const retryPlan = service.prepareDestroyDeployment({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
    });
    if (!retryPlan.ok) throw new Error(retryPlan.error);
    await expect(service.executeDestroyDeployment({ token: retryPlan.value.token })).resolves.toMatchObject({
      ok: true,
      value: { deployments: [] },
    });
    expect(provider.destroy).toHaveBeenCalledTimes(2);
    await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    service.dispose();
  });

  it("can delete a failed preflight record that never acquired provider resources", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    provider.preflight = vi.fn(async () => { throw new Error("preflight denied"); });
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
      idFactory: () => DESTROY_TOKEN,
      now: () => NOW.getTime(),
    });

    await expect(service.createDeployment(awsDeployment())).resolves.toMatchObject({ ok: false });
    expect(store.getState().deployments[0]).toMatchObject({
      status: "failed",
      managedAssets: [],
      runtime: { instanceId: null, securityGroupIds: [] },
    });
    const plan = service.prepareDestroyDeployment({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
    });
    if (!plan.ok) throw new Error(plan.error);

    await expect(service.executeDestroyDeployment({ token: plan.value.token })).resolves.toMatchObject({
      ok: true,
      value: { deployments: [] },
    });
    expect(provider.destroy).not.toHaveBeenCalled();
    service.dispose();
  });

  it("durably journals and can delete an imported AWS key pair after a later create failure", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    provider.create.mockImplementationOnce(async (_input, onMutation) => {
      await onMutation?.({
        phase: "key-pair",
        resources: {
          keyPair: {
            id: "key-0123456789abcdef0",
            name: `sliver-gui-${DEPLOYMENT_ID}`,
          },
        },
      });
      throw new Error("instance launch interrupted");
    });
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
    });

    await expect(service.createDeployment(awsDeployment())).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/instance launch interrupted/u),
    });
    expect(store.getState().deployments[0]).toMatchObject({
      status: "failed",
      managedAssets: [{
        resourceType: "ec2-key-pair",
        resourceId: "key-0123456789abcdef0",
        displayName: `sliver-gui-${DEPLOYMENT_ID}`,
        tagged: true,
      }],
    });
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toEqual(store.getState());
    const plan = service.prepareDestroyDeployment({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
    });
    if (!plan.ok) throw new Error(plan.error);

    await expect(service.executeDestroyDeployment({ token: plan.value.token })).resolves.toMatchObject({
      ok: true,
      value: { deployments: [] },
    });
    expect(provider.destroy).toHaveBeenCalledWith({
      guid: DEPLOYMENT_ID,
      name: "Sliver AWS",
      region: "us-west-2",
      keyPair: {
        id: "key-0123456789abcdef0",
        name: `sliver-gui-${DEPLOYMENT_ID}`,
      },
    });
    service.dispose();
  });

  it("durably journals and can delete a partially created managed AWS network", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    provider.create.mockImplementationOnce(async (_input, onMutation) => {
      await onMutation?.({
        phase: "vpc",
        resources: { vpcId: "vpc-0123456789abcdef0" },
      });
      await onMutation?.({
        phase: "internet-gateway",
        resources: {
          vpcId: "vpc-0123456789abcdef0",
          internetGatewayId: "igw-0123456789abcdef0",
        },
      });
      throw new Error("managed subnet creation interrupted");
    });
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
    });
    const request = awsDeployment();

    await expect(service.createDeployment({
      ...request,
      spec: {
        ...request.spec,
        vpcId: null,
        subnetId: null,
        networkMode: "managed",
        managedVpcCidr: "10.42.0.0/16",
        managedSubnetCidr: "10.42.1.0/24",
      },
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/managed subnet creation interrupted/u),
    });
    expect(store.getState().deployments[0]).toMatchObject({
      status: "failed",
      runtime: {
        vpcId: "vpc-0123456789abcdef0",
        internetGatewayId: "igw-0123456789abcdef0",
      },
      managedAssets: expect.arrayContaining([
        expect.objectContaining({ resourceType: "ec2-vpc", resourceId: "vpc-0123456789abcdef0" }),
        expect.objectContaining({
          resourceType: "ec2-internet-gateway",
          resourceId: "igw-0123456789abcdef0",
        }),
      ]),
    });
    const plan = service.prepareDestroyDeployment({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: store.getState().revision,
    });
    if (!plan.ok) throw new Error(plan.error);

    await expect(service.executeDestroyDeployment({ token: plan.value.token })).resolves.toMatchObject({ ok: true });
    expect(provider.destroy).toHaveBeenCalledWith({
      guid: DEPLOYMENT_ID,
      name: "Sliver AWS",
      region: "us-west-2",
      managedNetwork: {
        vpcId: "vpc-0123456789abcdef0",
        internetGatewayId: "igw-0123456789abcdef0",
      },
    });
    service.dispose();
  });

  it("never replaces or removes an existing operator configuration on a name collision", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => new FakeAwsProvider(),
    });
    const filePath = join(operatorConfigDirectory, `sliver-gui-cloud-${DEPLOYMENT_ID}.cfg`);
    await mkdir(operatorConfigDirectory, { recursive: true, mode: 0o700 });
    await writeFile(filePath, "user-owned", { mode: 0o600 });

    const created = await service.createDeployment(awsDeployment());

    expect(created).toMatchObject({ ok: false });
    expect(await readFile(filePath, "utf8")).toBe("user-owned");
    expect(store.getState().deployments[0]).toMatchObject({ status: "failed", phase: "failed" });
    service.dispose();
  });

  it("provisions and tracks a GUID-tagged Proxmox VM", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const { store, vault } = await dependencies();
    await vault.create(proxmoxCredential(privateKey));
    const provider = new FakeProxmoxProvider();
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      proxmoxProviderFactory: () => provider,
    });

    const result = await service.createDeployment(proxmoxDeployment());
    if (!result.ok) throw new Error(result.error);

    expect(result).toMatchObject({
      ok: true,
      value: {
        provider: "proxmox",
        status: "running",
        phase: "ready",
        runtime: { vmId: 212, node: "pve1", ipAddress: "192.0.2.212" },
        managedAssets: [{
          resourceType: "proxmox-vm",
          resourceId: "212",
          displayName: "sliver-proxmox",
          tagged: true,
        }],
      },
    });
    expect(provider.create).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: DEPLOYMENT_ID,
        node: "pve1",
        sshPublicKey: expect.stringMatching(/^ssh-rsa /u),
      }),
      expect.any(Function),
    );
    service.dispose();
  });

  it("does not mutate a deployment when an optimistic revision is stale", async () => {
    const { store, vault } = await dependencies();
    await vault.create(awsCredential());
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage: new XorSafeStorage(),
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => new FakeAwsProvider(),
    });
    await service.createDeployment(awsDeployment());
    const before = store.getState();

    const result = await service.runLifecycleAction({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 0,
      action: "stop",
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/changed in another window/u) });
    expect(store.getState()).toBe(before);
    expect(store.getState().deployments[0]).toMatchObject({ status: "running", phase: "ready" });
    service.dispose();
  });

  it("serializes remote transitions globally before rechecking the shared revision", async () => {
    const safeStorage = new XorSafeStorage();
    const ids = [DEPLOYMENT_ID, SECOND_DEPLOYMENT_ID];
    const store = await CloudDeploymentStore.load(rootDirectory, {
      idFactory: () => ids.shift() ?? DEPLOYMENT_ID,
      clock: () => NOW,
    });
    const vault = new CloudCredentialVault(rootDirectory, safeStorage, {
      idFactory: () => CREDENTIAL_ID,
      clock: () => NOW,
    });
    await vault.create(awsCredential());
    const provider = new FakeAwsProvider();
    let releaseFirstStop: (() => void) | undefined;
    const firstStop = new Promise<void>((resolve) => { releaseFirstStop = resolve; });
    provider.stop.mockImplementation(async (resource) => {
      await firstStop;
      return { ...resource, state: "stopped" as const };
    });
    const service = await CloudDeploymentService.create({
      rootDirectory,
      operatorConfigDirectory,
      safeStorage,
      store,
      vault,
      privateKeyCapabilities: fakePrivateKeys(),
      provisioner: fakeProvisioner(),
      awsProviderFactory: () => provider,
    });
    await service.createDeployment(awsDeployment());
    await service.createDeployment({
      ...awsDeployment(),
      expectedRevision: store.getState().revision,
      name: "Second Sliver AWS",
    });
    const expectedRevision = store.getState().revision;

    const first = service.runLifecycleAction({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision,
      action: "stop",
    });
    await vi.waitFor(() => expect(provider.stop).toHaveBeenCalledTimes(1));
    const second = service.runLifecycleAction({
      deploymentId: SECOND_DEPLOYMENT_ID,
      expectedRevision,
      action: "stop",
    });
    await Promise.resolve();
    expect(provider.stop).toHaveBeenCalledTimes(1);
    releaseFirstStop?.();

    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/changed in another window/u),
    });
    expect(provider.stop).toHaveBeenCalledTimes(1);
    service.dispose();
  });
});

async function dependencies() {
  const safeStorage = new XorSafeStorage();
  const store = await CloudDeploymentStore.load(rootDirectory, {
    idFactory: () => DEPLOYMENT_ID,
    clock: () => NOW,
  });
  const vault = new CloudCredentialVault(rootDirectory, safeStorage, {
    idFactory: () => CREDENTIAL_ID,
    clock: () => NOW,
  });
  return { safeStorage, store, vault };
}

function awsCredential(): ResolvedAwsCloudCredentialInput {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    provider: "aws",
    label: "AWS",
    defaultRegion: "us-west-2",
    sshUsername: "ubuntu",
    secret: {
      accessKeyId: "AKIAEXAMPLE00000001",
      secretAccessKey: "secret-cloud-value",
      sessionToken: null,
      sshPrivateKey: privateKey,
      sshPassphrase: null,
    },
  };
}

function proxmoxCredential(privateKey: string): ResolvedProxmoxCloudCredentialInput {
  return {
    provider: "proxmox",
    label: "Proxmox",
    sshUsername: "root",
    secret: {
      endpoint: "https://pve.example.test:8006/",
      tokenId: "root@pam!sliver-gui",
      tokenSecret: "proxmox-secret",
      tlsCaCertificate: null,
      sshPrivateKey: privateKey,
      sshPassphrase: null,
    },
  };
}

function awsDeployment(useElasticIp = true): CreateAwsCloudDeploymentInput {
  return {
    provider: "aws",
    expectedRevision: 0,
    credentialId: CREDENTIAL_ID,
    name: "Sliver AWS",
    spec: {
      region: "us-west-2",
      imageId: "ami-0123456789abcdef0",
      instanceType: "t3.small",
      subnetId: "subnet-a0000000000000000",
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
      multiplayerPort: 31_337,
      volumeSizeGiB: 16,
      useElasticIp,
      sshCidrs: ["192.0.2.10/32"],
      operatorCidrs: ["198.51.100.0/24"],
    },
  };
}

function proxmoxDeployment(): CreateProxmoxCloudDeploymentInput {
  return {
    provider: "proxmox",
    expectedRevision: 0,
    credentialId: CREDENTIAL_ID,
    name: "Sliver Proxmox",
    spec: {
      node: "pve1",
      templateVmId: 9000,
      vmId: 212,
      storage: "local-lvm",
      bridge: "vmbr0",
      cores: 2,
      memoryMiB: 4096,
      diskGiB: 32,
      operatorName: "operator",
      sshPort: 22,
      multiplayerPort: 31_337,
      ipConfig: "ip=dhcp",
      gateway: null,
      sshCidrs: ["192.0.2.10/32"],
      operatorCidrs: ["198.51.100.0/24"],
    },
  };
}

function fakePrivateKeys(): CloudPrivateKeyCapabilities {
  return {
    choose: vi.fn(async () => ({ ok: false as const, error: "not used" })),
    consume: vi.fn(() => ({
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate material\n-----END OPENSSH PRIVATE KEY-----",
      publicKey: "ssh-ed25519 AAAA sliver-gui",
    })),
    dispose: vi.fn(),
  };
}

function inspectStoredSshKey(secret: { readonly sshPrivateKey: string; readonly sshPassphrase: string | null }) {
  const parsed = ssh2.utils.parseKey(secret.sshPrivateKey);
  return {
    algorithm: parsed instanceof Error ? null : parsed.type,
    isPrivate: parsed instanceof Error ? false : parsed.isPrivateKey(),
    passphrase: secret.sshPassphrase,
  };
}

function fakeProvisioner(): CloudSliverProvisioner & { provision: ReturnType<typeof vi.fn> } {
  return {
    provision: vi.fn(async (input) => {
      input.onOutput?.({ type: "stage", label: "Installing the Sliver server" });
      input.onOutput?.({ type: "stdout", chunk: new TextEncoder().encode("sliver-server active\n") });
      const operatorConfig = Buffer.from(JSON.stringify({
        operator: input.operatorName ?? `slivergui${input.deploymentId.replaceAll("-", "")}`,
        lhost: input.operatorEndpointHost,
        lport: input.multiplayerPort ?? 31_337,
        ca_certificate: "MANAGED-SLIVER-CA",
        certificate: "CLIENT-CERTIFICATE",
        private_key: "CLIENT-PRIVATE-KEY",
        token: "token",
      }));
      return {
        deploymentId: input.deploymentId,
        hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        architecture: "amd64" as const,
        version: "v1.5.42",
        serverSha256: "a".repeat(64),
        serviceName: `sliver-gui-${input.deploymentId}.service`,
        remoteBinaryPath: `/opt/sliver-gui/${input.deploymentId}/sliver-server`,
        operatorConfig,
        operatorConfigSha256: createHash("sha256").update(operatorConfig).digest("hex"),
      };
    }),
  };
}

class FakeAwsProvider implements CloudAwsProvider {
  readonly create = vi.fn(async (
    _input: Parameters<CloudAwsProvider["create"]>[0],
    onMutation?: Parameters<CloudAwsProvider["create"]>[1],
  ) => {
    const resource = awsResource();
    const elasticIp = resource.elasticIp;
    if (!elasticIp) throw new Error("Expected the AWS fixture to include an Elastic IP");
    await onMutation?.({ phase: "key-pair", resources: { keyPair: resource.keyPair } });
    await onMutation?.({
      phase: "security-group",
      resources: { keyPair: resource.keyPair, securityGroupId: resource.securityGroupId },
    });
    await onMutation?.({
      phase: "instance",
      resources: {
        keyPair: resource.keyPair,
        securityGroupId: resource.securityGroupId,
        instanceId: resource.instanceId,
      },
    });
    await onMutation?.({
      phase: "instance-running",
      resources: {
        keyPair: resource.keyPair,
        securityGroupId: resource.securityGroupId,
        instanceId: resource.instanceId,
      },
    });
    await onMutation?.({
      phase: "instance-status-ok",
      resources: {
        keyPair: resource.keyPair,
        securityGroupId: resource.securityGroupId,
        instanceId: resource.instanceId,
      },
    });
    await onMutation?.({
      phase: "system-status-ok",
      resources: {
        keyPair: resource.keyPair,
        securityGroupId: resource.securityGroupId,
        instanceId: resource.instanceId,
      },
    });
    await onMutation?.({
      phase: "elastic-ip",
      resources: {
        keyPair: resource.keyPair,
        securityGroupId: resource.securityGroupId,
        instanceId: resource.instanceId,
        elasticIpAllocationId: elasticIp.allocationId,
        ...(elasticIp.associationId ? { elasticIpAssociationId: elasticIp.associationId } : {}),
        elasticIpPublicAddress: elasticIp.publicIp,
      },
    });
    return resource;
  });
  readonly start = vi.fn(async (_resource: AwsEc2DeploymentResource) => ({
    ...awsResource(),
    state: "running" as const,
  }));
  readonly stop = vi.fn(async (_resource: AwsEc2DeploymentResource) => ({
    ...awsResource(),
    state: "stopped" as const,
  }));
  readonly reboot = vi.fn(async (_resource: AwsEc2DeploymentResource) => ({
    ...awsResource(),
    state: "running" as const,
  }));
  readonly replaceFirewall = vi.fn(async (_resource: AwsEc2DeploymentResource) => awsResource());
  readonly destroy = vi.fn(async (_resource?: unknown) => undefined);

  async preflight() {
    return { region: "us-west-2", availabilityZones: [{}, {}] };
  }

  async discover() {
    return {
      region: "us-west-2",
      availabilityZones: [{ name: "us-west-2a", state: "available" }],
      instanceTypes: [{
        name: "t3.micro",
        architecture: "x86_64" as const,
        vCpuCount: 2,
        memoryMiB: 1024,
        processor: "Intel or AMD",
        description: "2 vCPU · 1 GiB memory",
      }],
      images: [{
        id: "ami-0123456789abcdef0",
        architecture: "x86_64",
        distribution: "ubuntu" as const,
        version: "24.04 LTS",
        sshUsername: "ubuntu",
      }],
      vpcs: [{ id: "vpc-0123456789abcdef0", isDefault: true }],
      subnets: [
        { id: "subnet-f0000000000000000", vpcId: "vpc-0123456789abcdef0", mapPublicIpOnLaunch: true },
        { id: "subnet-a0000000000000000", vpcId: "vpc-0123456789abcdef0", mapPublicIpOnLaunch: true },
      ],
      keyPairs: [],
    };
  }
}

function awsResource(): AwsEc2DeploymentResource {
  return {
    guid: DEPLOYMENT_ID,
    name: "Sliver AWS",
    region: "us-west-2",
    keyPair: {
      id: "key-0123456789abcdef0",
      name: `sliver-gui-${DEPLOYMENT_ID}`,
    },
    instanceId: "i-0123456789abcdef0",
    securityGroupId: "sg-0123456789abcdef0",
    volumeIds: ["vol-0123456789abcdef0"],
    networkInterfaceIds: ["eni-0123456789abcdef0"],
    state: "running",
    instanceHealth: "ok",
    systemHealth: "ok",
    availabilityZone: "us-west-2a",
    privateIpAddress: "10.0.0.20",
    publicIpAddress: "203.0.113.20",
    elasticIp: {
      allocationId: "eipalloc-0123456789abcdef0",
      associationId: "eipassoc-0123456789abcdef0",
      publicIp: "203.0.113.20",
    },
  };
}

class FakeProxmoxProvider implements CloudProxmoxProvider {
  readonly create = vi.fn(async (_input, onMutation) => {
    const resources = proxmoxResources();
    await onMutation?.({ phase: "allocated", resources });
    await onMutation?.({ phase: "configured", resources });
    await onMutation?.({ phase: "firewall", resources });
    await onMutation?.({ phase: "started", resources });
    return proxmoxResult();
  });
  readonly refresh = vi.fn(async () => proxmoxResult());
  readonly start = vi.fn(async () => undefined);
  readonly stop = vi.fn(async () => undefined);
  readonly reboot = vi.fn(async () => undefined);
  readonly updateFirewall = vi.fn(async () => undefined);
  readonly destroy = vi.fn(async () => undefined);

  async preflight() {
    return { version: "8.4.0", nodes: ["pve1"], permissions: ["VM.Allocate"] };
  }

  readonly checkPermissions = vi.fn(async () => {
    const statuses = new Map(cloudRequiredPermissions("proxmox").map(({ id }) => [id, "verified" as const]));
    return {
      version: "8.4.0",
      nodes: ["pve1"],
      clusterFirewallEnabled: true,
      permissions: createCloudPermissionEvaluation("proxmox", statuses),
    };
  });
}

function fakeAwsPermissionChecker() {
  const statuses = new Map<string, "verified" | "missing" | "unverifiable">(
    cloudRequiredPermissions("aws").map(({ id }) => [id, "verified"]),
  );
  statuses.set("ec2:ModifyVpcAttribute", "unverifiable");
  statuses.set("ec2:ModifySubnetAttribute", "unverifiable");
  statuses.set("ec2:CreateTags", "unverifiable");
  return {
    check: vi.fn(async () => createCloudPermissionEvaluation("aws", statuses)),
  };
}

function proxmoxResources(): ProxmoxResources {
  return { node: "pve1", vmId: 212, vmName: "sliver-proxmox" };
}

function proxmoxResult(): ProxmoxDeploymentResult {
  return { resources: proxmoxResources(), address: "192.0.2.212", state: "running" };
}

class XorSafeStorage implements CloudSafeStorageAdapter {
  isEncryptionAvailable(): boolean {
    return true;
  }

  getSelectedStorageBackend(): string {
    return "keychain";
  }

  encryptString(plainText: string): Buffer {
    return xor(Buffer.from(plainText, "utf8"));
  }

  decryptString(encrypted: Buffer): string {
    return xor(Buffer.from(encrypted)).toString("utf8");
  }
}

function xor(input: Buffer): Buffer {
  const output = Buffer.alloc(input.length);
  for (let index = 0; index < input.length; index += 1) output[index] = input[index]! ^ 0xa5;
  return output;
}
