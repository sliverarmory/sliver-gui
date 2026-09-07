import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  CLOUD_DEPLOYMENT_STATE_VERSION,
  parseCloudDeploymentState,
  parseCreateCloudDeploymentInput,
  parseDeleteCloudDeploymentInput,
  parseUpdateCloudDeploymentInput,
  type CloudDeploymentRecord,
  type CloudDeploymentState,
  type CreateCloudDeploymentInput,
  type DeleteCloudDeploymentInput,
  type UpdateCloudDeploymentInput,
} from "../shared/cloud-deployment-contracts.js";
import type { OperationResult } from "../shared/contracts.js";
import { readBoundedRegularFile, writePrivateFileAtomic } from "./secure-file.js";

export const CLOUD_DEPLOYMENT_STATE_FILE = "state.json";
export const CLOUD_DEPLOYMENT_STATE_MAX_BYTES = 2 * 1024 * 1024;
export const STALE_CLOUD_DEPLOYMENT_STATE_ERROR =
  "Cloud deployment state changed in another window. Review the latest state and try again.";

const INVALID_CLOUD_DEPLOYMENT_REQUEST_ERROR = "The cloud deployment request is invalid.";
const CLOUD_DEPLOYMENT_SAVE_ERROR = "Cloud deployment state could not be saved.";

export interface CloudDeploymentMutation {
  readonly state: CloudDeploymentState;
  readonly deployment: CloudDeploymentRecord;
}

export interface CloudDeploymentStoreOptions {
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
}

const EMPTY_CLOUD_DEPLOYMENT_STATE: CloudDeploymentState = parseCloudDeploymentState({
  v: CLOUD_DEPLOYMENT_STATE_VERSION,
  revision: 0,
  deployments: [],
});

/**
 * Owns non-secret cloud deployment state below an explicitly supplied root.
 * The application should pass ~/.sliver-client/gui/cloud-deployment/v1.
 */
export class CloudDeploymentStore {
  readonly rootDirectory: string;
  readonly filePath: string;

  #state: CloudDeploymentState;
  #mutationChain: Promise<void> = Promise.resolve();
  readonly #idFactory: () => string;
  readonly #clock: () => Date;

  private constructor(
    rootDirectory: string,
    state: CloudDeploymentState,
    options: CloudDeploymentStoreOptions,
  ) {
    this.rootDirectory = rootDirectory;
    this.filePath = join(rootDirectory, CLOUD_DEPLOYMENT_STATE_FILE);
    this.#state = state;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#clock = options.clock ?? (() => new Date());
  }

  static async load(
    rootDirectory: string,
    options: CloudDeploymentStoreOptions = {},
  ): Promise<CloudDeploymentStore> {
    assertRootDirectory(rootDirectory);
    await verifyStateRootIfPresent(rootDirectory);
    const filePath = join(rootDirectory, CLOUD_DEPLOYMENT_STATE_FILE);
    let state = EMPTY_CLOUD_DEPLOYMENT_STATE;
    try {
      const loaded = await readBoundedRegularFile(filePath, {
        label: "Cloud deployment state",
        maxBytes: CLOUD_DEPLOYMENT_STATE_MAX_BYTES,
        requirePrivateMode: true,
      });
      try {
        state = parseCloudDeploymentState(JSON.parse(loaded.data.toString("utf8")) as unknown);
      } catch (error) {
        throw new Error("Cloud deployment state is corrupt or unsupported", { cause: error });
      } finally {
        loaded.data.fill(0);
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    return new CloudDeploymentStore(rootDirectory, state, options);
  }

  getState(): CloudDeploymentState {
    return this.#state;
  }

  create(input: CreateCloudDeploymentInput): Promise<OperationResult<CloudDeploymentMutation>> {
    return this.#serializeMutation(async () => {
      let parsed: CreateCloudDeploymentInput;
      try {
        parsed = parseCreateCloudDeploymentInput(input);
      } catch {
        return { ok: false, error: INVALID_CLOUD_DEPLOYMENT_REQUEST_ERROR };
      }
      const revisionError = this.#checkRevision(parsed.expectedRevision);
      if (revisionError) return revisionError;

      const id = this.#idFactory();
      const timestamp = this.#clock().toISOString();
      let deployment: CloudDeploymentRecord;
      try {
        deployment = parseNewDeployment(id, timestamp, parsed);
      } catch {
        return { ok: false, error: CLOUD_DEPLOYMENT_SAVE_ERROR };
      }
      if (this.#state.deployments.some((candidate) => candidate.id === deployment.id)) {
        return { ok: false, error: CLOUD_DEPLOYMENT_SAVE_ERROR };
      }

      const stateResult = await this.#commit([...this.#state.deployments, deployment]);
      return stateResult.ok
        ? { ok: true, value: Object.freeze({ state: stateResult.value, deployment }) }
        : stateResult;
    });
  }

  update(input: UpdateCloudDeploymentInput): Promise<OperationResult<CloudDeploymentMutation>> {
    return this.#serializeMutation(async () => {
      let parsed: UpdateCloudDeploymentInput;
      try {
        parsed = parseUpdateCloudDeploymentInput(input);
      } catch {
        return { ok: false, error: INVALID_CLOUD_DEPLOYMENT_REQUEST_ERROR };
      }
      const revisionError = this.#checkRevision(parsed.expectedRevision);
      if (revisionError) return revisionError;

      const index = this.#state.deployments.findIndex(({ id }) => id === parsed.deployment.id);
      const current = this.#state.deployments[index];
      if (index < 0 || !current || !sameDeploymentIdentity(current, parsed.deployment)) {
        return { ok: false, error: INVALID_CLOUD_DEPLOYMENT_REQUEST_ERROR };
      }

      let deployment: CloudDeploymentRecord;
      try {
        deployment = parseCloudDeploymentWithTimestamp(parsed.deployment, this.#clock().toISOString());
      } catch {
        return { ok: false, error: CLOUD_DEPLOYMENT_SAVE_ERROR };
      }
      const deployments = [...this.#state.deployments];
      deployments[index] = deployment;
      const stateResult = await this.#commit(deployments);
      return stateResult.ok
        ? { ok: true, value: Object.freeze({ state: stateResult.value, deployment }) }
        : stateResult;
    });
  }

  delete(input: DeleteCloudDeploymentInput): Promise<OperationResult<CloudDeploymentState>> {
    return this.#serializeMutation(async () => {
      let parsed: DeleteCloudDeploymentInput;
      try {
        parsed = parseDeleteCloudDeploymentInput(input);
      } catch {
        return { ok: false, error: INVALID_CLOUD_DEPLOYMENT_REQUEST_ERROR };
      }
      const revisionError = this.#checkRevision(parsed.expectedRevision);
      if (revisionError) return revisionError;
      if (!this.#state.deployments.some(({ id }) => id === parsed.deploymentId)) {
        return { ok: false, error: INVALID_CLOUD_DEPLOYMENT_REQUEST_ERROR };
      }
      return this.#commit(this.#state.deployments.filter(({ id }) => id !== parsed.deploymentId));
    });
  }

  #checkRevision(expectedRevision: number): { ok: false; error: string } | undefined {
    if (expectedRevision !== this.#state.revision) {
      return { ok: false, error: STALE_CLOUD_DEPLOYMENT_STATE_ERROR };
    }
    if (this.#state.revision === Number.MAX_SAFE_INTEGER) {
      return { ok: false, error: CLOUD_DEPLOYMENT_SAVE_ERROR };
    }
    return undefined;
  }

  async #commit(deployments: readonly CloudDeploymentRecord[]): Promise<OperationResult<CloudDeploymentState>> {
    let next: CloudDeploymentState;
    try {
      next = parseCloudDeploymentState({
        v: CLOUD_DEPLOYMENT_STATE_VERSION,
        revision: this.#state.revision + 1,
        deployments,
      });
    } catch {
      return { ok: false, error: CLOUD_DEPLOYMENT_SAVE_ERROR };
    }

    const data = Buffer.from(JSON.stringify(next), "utf8");
    try {
      if (data.length > CLOUD_DEPLOYMENT_STATE_MAX_BYTES) {
        return { ok: false, error: CLOUD_DEPLOYMENT_SAVE_ERROR };
      }
      await writePrivateFileAtomic(this.filePath, data);
    } catch {
      return { ok: false, error: CLOUD_DEPLOYMENT_SAVE_ERROR };
    } finally {
      data.fill(0);
    }
    this.#state = next;
    return { ok: true, value: next };
  }

  #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationChain.then(operation);
    this.#mutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function parseNewDeployment(
  id: string,
  timestamp: string,
  input: CreateCloudDeploymentInput,
): CloudDeploymentRecord {
  const common = {
    id,
    name: input.name,
    credentialId: input.credentialId,
    status: "provisioning",
    phase: "validating",
    createdAt: timestamp,
    updatedAt: timestamp,
    operatorConfigFileName: null,
    operatorConfigDigest: null,
    remoteHost: null,
    lastError: null,
    managedAssets: [],
  } as const;
  if (input.provider === "aws") {
    return parseCloudDeploymentState({
      v: CLOUD_DEPLOYMENT_STATE_VERSION,
      revision: 0,
      deployments: [{
        ...common,
        provider: "aws",
        spec: input.spec,
        runtime: {
          instanceId: null,
          instanceState: "unknown",
          instanceHealth: "unknown",
          systemHealth: "unknown",
          securityGroupIds: [],
          volumeIds: [],
          networkInterfaceIds: [],
          publicIpAddress: null,
          privateIpAddress: null,
          availabilityZone: null,
          elasticIpAllocationId: null,
          vpcId: null,
          subnetId: null,
          internetGatewayId: null,
          routeTableId: null,
          routeTableAssociationId: null,
        },
      }],
    }).deployments[0]!;
  }
  return parseCloudDeploymentState({
    v: CLOUD_DEPLOYMENT_STATE_VERSION,
    revision: 0,
    deployments: [{
      ...common,
      provider: "proxmox",
      spec: input.spec,
      runtime: { vmId: null, node: input.spec.node, ipAddress: null },
    }],
  }).deployments[0]!;
}

function parseCloudDeploymentWithTimestamp(
  deployment: CloudDeploymentRecord,
  updatedAt: string,
): CloudDeploymentRecord {
  return parseCloudDeploymentState({
    v: CLOUD_DEPLOYMENT_STATE_VERSION,
    revision: 0,
    deployments: [{ ...deployment, updatedAt }],
  }).deployments[0]!;
}

function sameDeploymentIdentity(
  current: CloudDeploymentRecord,
  candidate: CloudDeploymentRecord,
): boolean {
  return current.id === candidate.id &&
    current.provider === candidate.provider &&
    current.credentialId === candidate.credentialId &&
    current.createdAt === candidate.createdAt;
}

function assertRootDirectory(rootDirectory: string): void {
  if (
    typeof rootDirectory !== "string" ||
    rootDirectory.trim() === "" ||
    !isAbsolute(rootDirectory) ||
    resolve(rootDirectory) !== rootDirectory ||
    dirname(rootDirectory) === rootDirectory
  ) {
    throw new TypeError("An absolute bounded cloud deployment state root is required");
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function verifyStateRootIfPresent(rootDirectory: string): Promise<void> {
  try {
    const stats = await lstat(rootDirectory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Cloud deployment state root must be a private regular directory");
    }
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new Error("Cloud deployment state root permissions must be private (0700 or stricter)");
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}
