// @vitest-environment node

import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AwsCloudDeploymentRecord,
  CreateAwsCloudDeploymentInput,
  CreateAzureCloudDeploymentInput,
} from "../shared/cloud-deployment-contracts.js";
import {
  CLOUD_DEPLOYMENT_STATE_FILE,
  CloudDeploymentStore,
  RETIRED_PROXMOX_STATE_ARCHIVE_FILE,
  STALE_CLOUD_DEPLOYMENT_STATE_ERROR,
} from "./cloud-deployment-store.js";

const CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-06T18:00:00.000Z");

let temporaryDirectory = "";
let stateRoot = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "sliver-gui-cloud-state-"));
  stateRoot = join(temporaryDirectory, "gui", "cloud-deployment", "v1");
});

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("CloudDeploymentStore", () => {
  it("starts empty and creates a main-generated UUID-tagged AWS deployment", async () => {
    const store = await createStore();

    const result = await store.create(awsCreateInput());

    expect(result).toMatchObject({
      ok: true,
      value: {
        state: { v: 1, revision: 1 },
        deployment: {
          id: DEPLOYMENT_ID,
          provider: "aws",
          status: "provisioning",
          phase: "validating",
          operatorConfigFileName: null,
          operatorConfigDigest: null,
          runtime: { instanceId: null, elasticIpAllocationId: null },
        },
      },
    });
    expect(store.getState()).toBe(result.ok ? result.value.state : undefined);
    expect(Object.isFrozen(store.getState().deployments)).toBe(true);
    expect(JSON.parse(await readFile(join(stateRoot, CLOUD_DEPLOYMENT_STATE_FILE), "utf8"))).toEqual(store.getState());

    if (process.platform !== "win32") {
      expect((await lstat(stateRoot)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(stateRoot, CLOUD_DEPLOYMENT_STATE_FILE))).mode & 0o777).toBe(0o600);
    }
    expect(await readdir(stateRoot)).toEqual([CLOUD_DEPLOYMENT_STATE_FILE]);
  });

  it("serializes simultaneous mutations and rejects the stale expected revision", async () => {
    const store = await createStore();

    const [first, second] = await Promise.all([
      store.create(awsCreateInput()),
      store.create({ ...awsCreateInput(), name: "Second" }),
    ]);

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, error: STALE_CLOUD_DEPLOYMENT_STATE_ERROR });
    expect(store.getState()).toMatchObject({ revision: 1 });
    expect(store.getState().deployments).toHaveLength(1);
  });

  it("discards a cancelled status update before replacing persisted state", async () => {
    const store = await createStore();
    const created = await store.create(awsCreateInput());
    if (!created.ok) throw new Error(created.error);
    const originalState = store.getState();
    const originalFile = await readFile(store.filePath, "utf8");
    let checked = false;

    const result = await store.update({
      expectedRevision: originalState.revision,
      deployment: { ...created.value.deployment, remoteHost: "198.51.100.42" },
    }, () => {
      checked = true;
      throw new Error("Status read became stale");
    });

    expect(checked).toBe(true);
    expect(result.ok).toBe(false);
    expect(store.getState()).toBe(originalState);
    expect(await readFile(store.filePath, "utf8")).toBe(originalFile);
    expect(await readdir(stateRoot)).toEqual([CLOUD_DEPLOYMENT_STATE_FILE]);

    const next = await store.update({
      expectedRevision: originalState.revision,
      deployment: { ...created.value.deployment, remoteHost: "198.51.100.43" },
    });
    expect(next.ok).toBe(true);
    expect(store.getState().deployments[0]?.remoteHost).toBe("198.51.100.43");
  });

  it("creates an Azure deployment with empty provider runtime identities", async () => {
    const store = await createStore();
    const result = await store.create(azureCreateInput());

    expect(result).toMatchObject({
      ok: true,
      value: {
        deployment: {
          provider: "azure",
          spec: { location: "westus2", networkMode: "managed" },
          runtime: {
            resourceGroupName: null,
            vmId: null,
            networkSecurityGroupId: null,
            instanceState: "unknown",
          },
        },
      },
    });
  });

  it("archives exact legacy Proxmox state before removing it from active state", async () => {
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(stateRoot, 0o700);
    const legacy = {
      v: 1,
      revision: 7,
      deployments: [{ provider: "proxmox", id: DEPLOYMENT_ID, opaqueLegacyFields: true }],
    };
    const statePath = join(stateRoot, CLOUD_DEPLOYMENT_STATE_FILE);
    await writeFile(statePath, JSON.stringify(legacy), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(statePath, 0o600);

    const store = await CloudDeploymentStore.load(stateRoot);

    expect(store.getState()).toEqual({ v: 1, revision: 7, deployments: [] });
    expect(JSON.parse(await readFile(
      join(stateRoot, RETIRED_PROXMOX_STATE_ARCHIVE_FILE),
      "utf8",
    ))).toEqual(legacy);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(store.getState());
  });

  it("updates only an existing immutable identity and stamps updatedAt in main", async () => {
    let call = 0;
    const store = await CloudDeploymentStore.load(stateRoot, {
      idFactory: () => DEPLOYMENT_ID,
      clock: () => new Date(NOW.getTime() + call++ * 60_000),
    });
    const created = await store.create(awsCreateInput());
    expect(created.ok).toBe(true);
    const deployment = created.ok ? created.value.deployment as AwsCloudDeploymentRecord : undefined;
    if (!deployment) throw new Error("Expected deployment");

    const update = await store.update({
      expectedRevision: 1,
      deployment: {
        ...deployment,
        status: "running",
        phase: "ready",
        updatedAt: "2020-01-01T00:00:00.000Z",
        remoteHost: "203.0.113.40",
      },
    });

    expect(update).toMatchObject({
      ok: true,
      value: {
        state: { revision: 2 },
        deployment: {
          status: "running",
          updatedAt: "2026-09-06T18:01:00.000Z",
        },
      },
    });

    await expect(store.update({
      expectedRevision: 2,
      deployment: { ...deployment, credentialId: DEPLOYMENT_ID },
    })).resolves.toEqual({ ok: false, error: "The cloud deployment request is invalid." });
  });

  it("deletes an exact deployment with an optimistic revision", async () => {
    const store = await createStore();
    await store.create(awsCreateInput());

    const deleted = await store.delete({ expectedRevision: 1, deploymentId: DEPLOYMENT_ID });

    expect(deleted).toEqual({
      ok: true,
      value: { v: 1, revision: 2, deployments: [] },
    });
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toEqual(deleted.ok ? deleted.value : undefined);
  });

  it("fails closed instead of replacing corrupt, unsupported, or over-permissive state", async () => {
    await writeFile(join(temporaryDirectory, "corrupt.json"), "not json", { mode: 0o600 });
    await expect(CloudDeploymentStore.load(join(temporaryDirectory, "corrupt-root"))).resolves.toBeDefined();

    await writeFile(join(temporaryDirectory, "bad-state.json"), JSON.stringify({ v: 2 }), { mode: 0o600 });
    stateRoot = join(temporaryDirectory, "bad-root");
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(stateRoot, 0o700);
    await writeFile(join(stateRoot, CLOUD_DEPLOYMENT_STATE_FILE), JSON.stringify({ v: 1, revision: 0, deployments: [], extra: true }), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(join(stateRoot, CLOUD_DEPLOYMENT_STATE_FILE), 0o600);
    await expect(CloudDeploymentStore.load(stateRoot)).rejects.toThrow(/corrupt or unsupported/u);

    await chmod(join(stateRoot, CLOUD_DEPLOYMENT_STATE_FILE), 0o644);
    if (process.platform !== "win32") {
      await expect(CloudDeploymentStore.load(stateRoot)).rejects.toThrow(/permissions must be private/u);
    }
  });

  it("fails closed when the state path is a symbolic link", async () => {
    const target = join(temporaryDirectory, "target.json");
    await writeFile(target, JSON.stringify({ v: 1, revision: 0, deployments: [] }), { mode: 0o600 });
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(stateRoot, 0o700);
    await symlink(target, join(stateRoot, CLOUD_DEPLOYMENT_STATE_FILE));

    await expect(CloudDeploymentStore.load(stateRoot)).rejects.toThrow(/bounded regular file/u);
  });

  it("does not persist when the UUID factory or request is invalid", async () => {
    const badStore = await CloudDeploymentStore.load(stateRoot, { idFactory: () => "not-a-uuid" });

    await expect(badStore.create(awsCreateInput())).resolves.toEqual({
      ok: false,
      error: "Cloud deployment state could not be saved.",
    });
    await expect(lstat(badStore.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(badStore.create({
      ...awsCreateInput(),
      spec: { ...awsCreateInput().spec, sshPort: 31_337 },
    })).resolves.toEqual({ ok: false, error: "The cloud deployment request is invalid." });
  });

  it("requires an explicit absolute root below the filesystem root", async () => {
    await expect(CloudDeploymentStore.load("relative/cloud-deployment/v1")).rejects.toThrow(/absolute bounded/u);
    await expect(CloudDeploymentStore.load("/")).rejects.toThrow(/absolute bounded/u);
  });
});

async function createStore(): Promise<CloudDeploymentStore> {
  return CloudDeploymentStore.load(stateRoot, {
    idFactory: () => DEPLOYMENT_ID,
    clock: () => NOW,
  });
}

function awsCreateInput(): CreateAwsCloudDeploymentInput {
  return {
    provider: "aws",
    expectedRevision: 0,
    credentialId: CREDENTIAL_ID,
    name: "Sliver AWS",
    spec: {
      region: "us-west-2",
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
      keyPairName: "managed-by-sliver-gui",
      operatorName: "operator",
      sshPort: 22,
      multiplayerPort: 31_337,
      volumeSizeGiB: 16,
      useElasticIp: true,
      sshCidrs: ["192.0.2.10/32"],
      operatorCidrs: ["198.51.100.0/24"],
    },
  };
}

function azureCreateInput(): CreateAzureCloudDeploymentInput {
  return {
    provider: "azure",
    expectedRevision: 0,
    credentialId: CREDENTIAL_ID,
    name: "Sliver Azure",
    spec: {
      location: "westus2",
      imageReference: "Canonical:ubuntu-24_04-lts:server:latest",
      vmSize: "Standard_B2s",
      networkMode: "managed",
      vnetId: null,
      subnetId: null,
      managedVnetCidr: "10.42.0.0/16",
      managedSubnetCidr: "10.42.1.0/24",
      sshUsername: "azureuser",
      operatorName: "operator",
      sshPort: 22,
      multiplayerPort: 31_337,
      osDiskSizeGiB: 32,
      usePublicIp: true,
      sshCidrs: ["192.0.2.10/32"],
      operatorCidrs: ["198.51.100.0/24"],
    },
  };
}
