// @vitest-environment node

import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CloudDnsProvider, CloudDnsZone } from "../shared/cloud-dns-contracts.js";
import type { CreateAwsAlbRedirectorDeploymentInput, CreateAwsCloudDeploymentInput } from "../shared/cloud-deployment-contracts.js";
import { CloudCredentialVault, type CloudSafeStorageAdapter } from "./cloud-credential-vault.js";
import { CloudDeploymentStore } from "./cloud-deployment-store.js";
import {
  CloudDeploymentService,
  type CloudAwsAlbAliasFactory,
  type CloudAwsAlbProviderFactory,
  type CloudSliverListenerClient,
} from "./cloud-deployment-service.js";
import type { AwsAlbRedirectorResource } from "./cloud/aws-alb-provider.js";
import { AwsAlbAliasChangeAcceptedError } from "./cloud/aws-alb-alias.js";
import { SshHostKeyStore } from "./ssh-host-key-store.js";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
const DESTROY_TOKEN = "33333333-3333-4333-8333-333333333333";
const ALB_ID = "44444444-4444-4444-8444-444444444444";
const REGION = "us-west-2";
const VPC_ID = "vpc-0123456789abcdef0";
const SERVER_SUBNET_ID = "subnet-aaaaaaaaaaaaaaaaa";
const SECOND_SUBNET_ID = "subnet-bbbbbbbbbbbbbbbbb";
const CERTIFICATE_ARN = "arn:aws:acm:us-west-2:123456789012:certificate/12345678-1234-1234-1234-123456789abc";
const DOMAIN = "c2.example.test";
const HOSTED_ZONE_ID = "ZEXAMPLE123";
const NOW = new Date("2026-11-19T18:00:00.000Z");
const SSH_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

const ZONE: CloudDnsZone = {
  id: HOSTED_ZONE_ID, name: "example.test", provider: "aws", private: false,
  recordCount: 0, resourceGroupName: null,
};

const RESOURCE: AwsAlbRedirectorResource = {
  guid: ALB_ID,
  name: "External redirector",
  region: REGION,
  serverGuid: SERVER_ID,
  serverInstanceId: "i-0123456789abcdef0",
  serverSecurityGroupId: "sg-0123456789abcdef0",
  vpcId: VPC_ID,
  subnetIds: [SERVER_SUBNET_ID, SECOND_SUBNET_ID],
  certificateArn: CERTIFICATE_ARN,
  backendPort: 8080,
  healthCheckPath: "/",
  healthCheckSuccessCodes: "404",
  securityGroupId: "sg-0a1b2c3d4e5f67890",
  albIngressRuleId: "sgr-0123456789abcdef0",
  albEgressRuleId: "sgr-11111111111111111",
  serverIngressRuleId: "sgr-22222222222222222",
  targetGroupArn: "arn:aws:elasticloadbalancing:us-west-2:123456789012:targetgroup/sliver/0123456789abcdef",
  loadBalancerArn: "arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/sliver/0123456789abcdef",
  listenerArn: "arn:aws:elasticloadbalancing:us-west-2:123456789012:listener/app/sliver/0123456789abcdef/0123456789abcdef",
  dnsName: "sliver-123456789.us-west-2.elb.amazonaws.com",
  canonicalHostedZoneId: "Z1H1FL5HABSF5",
};

let temporaryDirectory = "";

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

function xor(input: Buffer): Buffer {
  const output = Buffer.from(input);
  for (let index = 0; index < output.length; index += 1) output[index]! ^= 0xa5;
  return output;
}

function serverInput(): CreateAwsCloudDeploymentInput {
  return {
    provider: "aws", expectedRevision: 0, credentialId: CREDENTIAL_ID, name: "Sliver AWS",
    spec: {
      region: REGION, imageId: "ami-0123456789abcdef0", instanceType: "t3.small",
      subnetId: SERVER_SUBNET_ID, vpcId: VPC_ID, networkMode: "existing",
      managedVpcCidr: null, managedSubnetCidr: null,
      sshKeyMode: "managed", existingKeyPairName: null, keyPairName: "managed-by-sliver-gui",
      sshUsername: "ubuntu", sshPort: 22, operatorName: "operator", multiplayerPort: 31_337,
      volumeSizeGiB: 16, useElasticIp: false,
      sshCidrs: ["192.0.2.10/32"], operatorCidrs: ["198.51.100.0/24"],
    },
  };
}

function albInput(expectedRevision: number): CreateAwsAlbRedirectorDeploymentInput {
  return {
    expectedRevision, serverDeploymentId: SERVER_ID, name: "External redirector",
    spec: {
      region: REGION, vpcId: VPC_ID, subnetIds: [SERVER_SUBNET_ID, SECOND_SUBNET_ID],
      additionalSubnet: null, certificateArn: CERTIFICATE_ARN, domain: DOMAIN,
      hostedZoneId: HOSTED_ZONE_ID, backendPort: 8080,
      listener: { mode: "create", port: 8080 },
    },
  };
}

function existingAlbInput(expectedRevision: number): CreateAwsAlbRedirectorDeploymentInput {
  const input = albInput(expectedRevision);
  return { ...input, spec: { ...input.spec, backendPort: 80,
    listener: { mode: "existing", port: 80, jobId: 1 } } };
}

async function fixture() {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "sliver-gui-alb-service-"));
  const rootDirectory = join(temporaryDirectory, "cloud-deployment", "v1");
  const operatorConfigDirectory = join(temporaryDirectory, "configs");
  const safeStorage: CloudSafeStorageAdapter = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "keychain",
    encryptString: (value) => xor(Buffer.from(value, "utf8")),
    decryptString: (value) => xor(value).toString("utf8"),
  };
  const ids = [SERVER_ID, ALB_ID];
  const store = await CloudDeploymentStore.load(rootDirectory, {
    idFactory: () => ids.shift() ?? ALB_ID,
    clock: () => NOW,
  });
  const vault = new CloudCredentialVault(rootDirectory, safeStorage, {
    idFactory: () => CREDENTIAL_ID,
    clock: () => NOW,
  });
  await vault.create({
    provider: "aws", label: "AWS", defaultRegion: REGION, sshUsername: "ubuntu",
    secret: { accessKeyId: "AKIAEXAMPLE00000001", secretAccessKey: "fixture-secret", sessionToken: null,
      sshPrivateKey: SSH_KEY, sshPassphrase: null },
  });
  const created = await store.create(serverInput());
  if (!created.ok || created.value.deployment.provider !== "aws") throw new Error("Could not create AWS server fixture");
  const configFileName = `sliver-gui-cloud-${SERVER_ID}.cfg`;
  const config = JSON.stringify({
    operator: "operator", lhost: "203.0.113.20", lport: 31_337,
    ca_certificate: "MANAGED-SLIVER-CA", certificate: "CLIENT-CERTIFICATE",
    private_key: "CLIENT-PRIVATE-KEY", token: "token",
  });
  await mkdir(operatorConfigDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(operatorConfigDirectory, configFileName), config, { mode: 0o600 });
  const updated = await store.update({
    expectedRevision: store.getState().revision,
    deployment: {
      ...created.value.deployment, status: "running", phase: "ready", remoteHost: "203.0.113.20",
      operatorConfigFileName: configFileName,
      operatorConfigDigest: createHash("sha256").update(config).digest("hex"),
      runtime: {
        ...created.value.deployment.runtime,
        instanceId: "i-0123456789abcdef0", instanceState: "running",
        instanceHealth: "ok", systemHealth: "ok",
        securityGroupIds: ["sg-0123456789abcdef0"],
        publicIpAddress: "203.0.113.20", privateIpAddress: "10.0.0.20",
        vpcId: VPC_ID, subnetId: SERVER_SUBNET_ID, availabilityZone: "us-west-2a",
      },
    },
  });
  if (!updated.ok) throw new Error(updated.error);
  const sshHostKeyStore = await SshHostKeyStore.load(join(rootDirectory, "ssh-host-keys.json"));
  await sshHostKeyStore.remember(SERVER_ID, "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

  const network = {
    publicSubnets: [
      { id: SERVER_SUBNET_ID, availabilityZone: "us-west-2a" },
      { id: SECOND_SUBNET_ID, availabilityZone: "us-west-2b" },
    ],
    suggestedAdditionalSubnet: null,
  };
  const alb = {
    discoverNetworkOptions: vi.fn(async () => network),
    create: vi.fn(async () => RESOURCE),
    destroy: vi.fn(async () => undefined),
    refresh: vi.fn(async () => ({
      dnsName: RESOURCE.dnsName, canonicalHostedZoneId: RESOURCE.canonicalHostedZoneId, targetHealth: "healthy",
    })),
    dispose: vi.fn(),
  } satisfies ReturnType<CloudAwsAlbProviderFactory>;
  const certificate = { arn: CERTIFICATE_ARN, domainName: "*.example.test", subjectAlternativeNames: [] };
  const acm = { listIssued: vi.fn(async () => [certificate]) };
  const dns = {
    listZones: vi.fn(async () => [ZONE, { ...ZONE, id: "ZPRIVATE", private: true }]),
    listRecords: vi.fn(async () => []),
    createRecord: vi.fn(async () => undefined),
    updateRecord: vi.fn(async () => undefined),
    deleteRecord: vi.fn(async () => undefined),
    dispose: vi.fn(),
  } satisfies CloudDnsProvider;
  const alias = {
    create: vi.fn(async () => ({ owned: true })),
    deleteIfMatches: vi.fn(async () => true),
    matches: vi.fn(async () => true),
    dispose: vi.fn(),
  } satisfies ReturnType<CloudAwsAlbAliasFactory>;
  const jobs: Array<{ ID: number; Name: string; Protocol: string; Port: number }> = [];
  const client = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    getJobs: vi.fn(async () => ({ Active: [...jobs] })),
    startHTTPListenerWithOptions: vi.fn(async (options: { host: string; port: number }) => {
      jobs.push({ ID: 41, Name: "http", Protocol: "tcp", Port: options.port });
      return { JobID: 41 };
    }),
    killJob: vi.fn(async (id: number) => {
      const index = jobs.findIndex((job) => job.ID === id);
      if (index >= 0) jobs.splice(index, 1);
      return { ID: id, Success: index >= 0 };
    }),
  };
  const probePrivateHttpListener = vi.fn(async () => 404);
  const probeExistingPrivateHttpListener = vi.fn(async () => 404);
  const awsAlbProviderFactory = vi.fn(() => alb);
  const awsAcmDiscoveryFactory = vi.fn(() => acm);
  const awsDnsProviderFactory = vi.fn(() => dns);
  const awsAlbAliasFactory = vi.fn(() => alias);
  const unexpectedAwsEc2 = vi.fn(() => { throw new Error("Unexpected EC2 provider call"); });
  const unexpectedAzure = vi.fn(() => { throw new Error("Unexpected Azure provider call"); });
  const service = await CloudDeploymentService.create({
    rootDirectory, operatorConfigDirectory, safeStorage, store, vault, sshHostKeyStore,
    now: () => NOW.getTime(), idFactory: () => DESTROY_TOKEN,
    awsAlbProviderFactory, awsAcmDiscoveryFactory, awsDnsProviderFactory, awsAlbAliasFactory,
    awsAlbListenerProbe: { probePrivateHttpListener, probeExistingPrivateHttpListener },
    sliverListenerClientFactory: () => client as unknown as CloudSliverListenerClient,
    awsProviderFactory: unexpectedAwsEc2,
    azureProviderFactory: unexpectedAzure,
    azureAccountSource: { list: vi.fn(async () => []) },
  });
  return {
    service, store, alb, acm, dns, alias, client, jobs, probePrivateHttpListener, probeExistingPrivateHttpListener, network,
    awsAlbProviderFactory, awsAcmDiscoveryFactory, awsDnsProviderFactory, awsAlbAliasFactory,
    unexpectedAwsEc2, unexpectedAzure,
  };
}

describe("CloudDeploymentService ALB redirectors", () => {
  it("discovers only the parent VPC options and public Route 53 zones through mocked providers", async () => {
    const f = await fixture();
    try {
      f.jobs.push({ ID: 1, Name: "http", Protocol: "tcp", Port: 80 });
      const result = await f.service.discoverAlbRedirectorOptions({
        credentialId: CREDENTIAL_ID, serverDeploymentId: SERVER_ID,
      });
      expect(result).toEqual({ ok: true, value: {
        region: REGION, vpcId: VPC_ID, publicSubnets: f.network.publicSubnets,
        suggestedAdditionalSubnet: null,
        certificates: [{ arn: CERTIFICATE_ARN, domainName: "*.example.test", subjectAlternativeNames: [] }],
        hostedZones: [{ id: HOSTED_ZONE_ID, name: "example.test" }],
        existingHttpListeners: [{ jobId: 1, port: 80, description: expect.any(String) }],
      } });
      expect(f.alb.discoverNetworkOptions).toHaveBeenCalledExactlyOnceWith({
        vpcId: VPC_ID, serverSubnetId: SERVER_SUBNET_ID, serverGuid: SERVER_ID,
      });
      expect(f.awsAlbProviderFactory).toHaveBeenCalledWith(expect.objectContaining({ region: REGION }));
      expect(f.acm.listIssued).toHaveBeenCalledTimes(1);
      expect(f.dns.listZones).toHaveBeenCalledTimes(1);
      expect(f.client.getJobs).toHaveBeenCalledTimes(1);
      expect(f.alb.create).not.toHaveBeenCalled();
      expect(f.alias.create).not.toHaveBeenCalled();
      expect(f.unexpectedAwsEc2).not.toHaveBeenCalled();
      expect(f.unexpectedAzure).not.toHaveBeenCalled();
    } finally { f.service.dispose(); }
  });

  it("rejects stale, cross-VPC, certificate, and same-AZ requests before creating resources", async () => {
    const f = await fixture();
    try {
      const stale = await f.service.createAlbRedirectorDeployment(albInput(0));
      expect(stale).toMatchObject({ ok: false });
      const valid = albInput(f.store.getState().revision);
      const crossVpc = await f.service.createAlbRedirectorDeployment({
        ...valid, spec: { ...valid.spec, vpcId: "vpc-11111111111111111" },
      });
      expect(crossVpc).toMatchObject({ ok: false, error: expect.stringMatching(/VPC/u) });
      const result = await f.service.createAlbRedirectorDeployment({
        ...valid, spec: { ...valid.spec, domain: "other.invalid.test" },
      });
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/certificate/u) });
      f.network.publicSubnets[1]!.availabilityZone = "us-west-2a";
      const sameAz = await f.service.createAlbRedirectorDeployment(valid);
      expect(sameAz).toMatchObject({ ok: false, error: expect.stringMatching(/availability zones/u) });
      expect(f.store.getState().dependentDeployments).toEqual([]);
      expect(f.client.startHTTPListenerWithOptions).not.toHaveBeenCalled();
      expect(f.alb.create).not.toHaveBeenCalled();
      expect(f.alias.create).not.toHaveBeenCalled();
      expect(f.unexpectedAwsEc2).not.toHaveBeenCalled();
    } finally { f.service.dispose(); }
  });

  it("creates an ALB with a private Sliver listener and removes it only through a reviewed destroy plan", async () => {
    const f = await fixture();
    try {
      const created = await f.service.createAlbRedirectorDeployment(albInput(f.store.getState().revision));
      expect(created).toMatchObject({ ok: true, value: {
        id: ALB_ID, kind: "alb-redirector", status: "running", phase: "ready",
        runtime: { listenerJobId: 41, listenerOwnership: "managed", dnsName: RESOURCE.dnsName,
          aliasRecordOwned: true, targetHealth: "healthy" },
      } });
      expect(f.client.startHTTPListenerWithOptions).toHaveBeenCalledExactlyOnceWith({
        host: "10.0.0.20", port: 8080, domain: "", website: "", enforceOTP: true,
      });
      expect(f.probePrivateHttpListener).toHaveBeenCalledWith(expect.objectContaining({
        privateIp: "10.0.0.20", port: 8080,
      }));
      expect(f.alb.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        guid: ALB_ID, serverGuid: SERVER_ID, serverInstanceId: RESOURCE.serverInstanceId,
        serverSecurityGroupId: RESOURCE.serverSecurityGroupId, vpcId: VPC_ID,
        subnetIds: [SERVER_SUBNET_ID, SECOND_SUBNET_ID], certificateArn: CERTIFICATE_ARN,
        backendPort: 8080, healthCheckSuccessCodes: "404",
      }), expect.any(Function));
      expect(f.alias.create).toHaveBeenCalledExactlyOnceWith({
        hostedZoneId: HOSTED_ZONE_ID, domain: DOMAIN, loadBalancerDnsName: RESOURCE.dnsName,
        loadBalancerHostedZoneId: RESOURCE.canonicalHostedZoneId,
      });
      const serverPlan = f.service.prepareDestroyDeployment({
        deploymentId: SERVER_ID, expectedRevision: f.store.getState().revision,
      });
      expect(serverPlan).toMatchObject({ ok: false, error: expect.stringMatching(/dependent deployments/u) });
      expect(f.alb.destroy).not.toHaveBeenCalled();
      expect(f.alias.deleteIfMatches).not.toHaveBeenCalled();

      const prepared = f.service.prepareDestroyDeployment({
        deploymentId: ALB_ID, expectedRevision: f.store.getState().revision,
      });
      expect(prepared).toMatchObject({ ok: true, value: { token: DESTROY_TOKEN, deploymentId: ALB_ID } });
      if (!prepared.ok) throw new Error(prepared.error);
      const destroyed = await f.service.executeDestroyDeployment({ token: prepared.value.token });
      expect(destroyed).toMatchObject({ ok: true, value: { dependentDeployments: [] } });
      expect(f.alias.deleteIfMatches).toHaveBeenCalledExactlyOnceWith({
        hostedZoneId: HOSTED_ZONE_ID, domain: DOMAIN, loadBalancerDnsName: RESOURCE.dnsName,
        loadBalancerHostedZoneId: RESOURCE.canonicalHostedZoneId,
      });
      expect(f.alb.destroy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        guid: ALB_ID, serverGuid: SERVER_ID, vpcId: VPC_ID,
        loadBalancerArn: RESOURCE.loadBalancerArn, targetGroupArn: RESOURCE.targetGroupArn,
        serverIngressRuleId: RESOURCE.serverIngressRuleId,
      }));
      expect(f.client.killJob).toHaveBeenCalledExactlyOnceWith(41);
      expect(f.store.getState().deployments).toHaveLength(1);
      expect(f.unexpectedAwsEc2).not.toHaveBeenCalled();
      expect(f.unexpectedAzure).not.toHaveBeenCalled();
    } finally { f.service.dispose(); }
  });

  it("reuses an existing HTTP job on port 80 and leaves that job running after ALB removal", async () => {
    const f = await fixture();
    f.jobs.push({ ID: 1, Name: "http", Protocol: "tcp", Port: 80 });
    try {
      const created = await f.service.createAlbRedirectorDeployment(existingAlbInput(f.store.getState().revision));
      expect(created).toMatchObject({ ok: true, value: {
        kind: "alb-redirector", status: "running", spec: { backendPort: 80,
          listener: { mode: "existing", port: 80, jobId: 1 } },
        runtime: { listenerJobId: 1, listenerOwnership: "existing" },
      } });
      expect(f.client.startHTTPListenerWithOptions).not.toHaveBeenCalled();
      expect(f.probeExistingPrivateHttpListener).toHaveBeenCalledWith(expect.objectContaining({
        privateIp: "10.0.0.20", port: 80,
      }));
      expect(f.probePrivateHttpListener).not.toHaveBeenCalled();
      expect(f.alb.create).toHaveBeenCalledWith(expect.objectContaining({ backendPort: 80,
        healthCheckSuccessCodes: "404" }), expect.any(Function));
      const plan = f.service.prepareDestroyDeployment({
        deploymentId: ALB_ID, expectedRevision: f.store.getState().revision,
      });
      if (!plan.ok) throw new Error(plan.error);
      await expect(f.service.executeDestroyDeployment({ token: plan.value.token })).resolves
        .toMatchObject({ ok: true, value: { dependentDeployments: [] } });
      expect(f.alias.deleteIfMatches).toHaveBeenCalledTimes(1);
      expect(f.alb.destroy).toHaveBeenCalledTimes(1);
      expect(f.client.killJob).not.toHaveBeenCalled();
      expect(f.jobs).toEqual([{ ID: 1, Name: "http", Protocol: "tcp", Port: 80 }]);
    } finally { f.service.dispose(); }
  });

  it("refuses ALB creation if the selected existing HTTP job changes after discovery", async () => {
    const f = await fixture();
    const liveJob = { ID: 1, Name: "http", Protocol: "tcp", Port: 80 };
    f.jobs.push(liveJob);
    f.client.getJobs.mockResolvedValueOnce({ Active: [liveJob] });
    f.client.getJobs.mockResolvedValueOnce({ Active: [{ ...liveJob, Port: 81 }] });
    try {
      const result = await f.service.createAlbRedirectorDeployment(existingAlbInput(f.store.getState().revision));
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/job changed/u) });
      expect(f.alb.create).not.toHaveBeenCalled();
      expect(f.alias.create).not.toHaveBeenCalled();
      expect(f.client.startHTTPListenerWithOptions).not.toHaveBeenCalled();
      expect(f.client.killJob).not.toHaveBeenCalled();
    } finally { f.service.dispose(); }
  });

  it("journals Route 53 alias ownership when CREATE was accepted but confirmation failed", async () => {
    const f = await fixture();
    try {
      f.alias.create.mockRejectedValueOnce(new AwsAlbAliasChangeAcceptedError("Route 53 confirmation timed out"));
      const result = await f.service.createAlbRedirectorDeployment(albInput(f.store.getState().revision));
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Route 53 confirmation timed out/u) });
      const record = f.store.getState().dependentDeployments[0];
      expect(record).toMatchObject({
        id: ALB_ID, kind: "alb-redirector", status: "failed",
        runtime: {
          aliasRecordOwned: true, aliasRecordName: DOMAIN,
          dnsName: RESOURCE.dnsName, canonicalHostedZoneId: RESOURCE.canonicalHostedZoneId,
          loadBalancerArn: RESOURCE.loadBalancerArn, listenerJobId: 41,
        },
      });
      expect(f.alb.destroy).not.toHaveBeenCalled();
      expect(f.alias.deleteIfMatches).not.toHaveBeenCalled();

      const plan = f.service.prepareDestroyDeployment({
        deploymentId: ALB_ID, expectedRevision: f.store.getState().revision,
      });
      if (!plan.ok) throw new Error(plan.error);
      const destroyed = await f.service.executeDestroyDeployment({ token: plan.value.token });
      expect(destroyed).toMatchObject({ ok: true, value: { dependentDeployments: [] } });
      expect(f.alias.deleteIfMatches).toHaveBeenCalledExactlyOnceWith({
        hostedZoneId: HOSTED_ZONE_ID, domain: DOMAIN,
        loadBalancerDnsName: RESOURCE.dnsName,
        loadBalancerHostedZoneId: RESOURCE.canonicalHostedZoneId,
      });
      expect(f.alb.destroy).toHaveBeenCalledTimes(1);
      expect(f.client.killJob).toHaveBeenCalledExactlyOnceWith(41);
      expect(f.unexpectedAwsEc2).not.toHaveBeenCalled();
      expect(f.unexpectedAzure).not.toHaveBeenCalled();
    } finally { f.service.dispose(); }
  });
});
