// @vitest-environment node

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { E2E_AWS_DEPLOYMENT, E2E_AZURE_DEPLOYMENT } from "../e2e/cloud-deployment-fixture.js";
import type { AwsDeploymentHealth, CloudProvider } from "../shared/cloud-deployment-contracts.js";
import { resolveManagedServerFromDeployments } from "./managed-server-resolver.js";

const CONFIG_BYTES = Buffer.from('{"operator":"alice","lhost":"203.0.113.20"}');
const CONFIG_DIGEST = digest(CONFIG_BYTES);
const DEPLOYMENT = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "aws" as const,
  name: "Team server",
  operatorConfigDigest: CONFIG_DIGEST,
};

describe("resolveManagedServerFromDeployments", () => {
  it.each<CloudProvider>(["aws", "azure"])("returns only the safe identity for a unique %s deployment", (provider) => {
    const record = {
      ...DEPLOYMENT,
      provider,
      credentialId: "credential-reference",
      operatorConfigFileName: "private-operator.cfg",
      remoteHost: "203.0.113.20",
    };
    const result = resolveManagedServerFromDeployments(CONFIG_DIGEST, [record]);

    expect(result).toEqual({ deploymentId: record.id, provider, name: record.name });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("recognizes byte-identical copies independently of file name", () => {
    const copiedBytes = Buffer.from(CONFIG_BYTES);
    expect(resolveManagedServerFromDeployments(digest(copiedBytes), [DEPLOYMENT])).toEqual({
      deploymentId: DEPLOYMENT.id,
      provider: DEPLOYMENT.provider,
      name: DEPLOYMENT.name,
    });
  });

  it("returns null for missing, unknown, reformatted, or changed config digests", () => {
    expect(resolveManagedServerFromDeployments(CONFIG_DIGEST, [])).toBeNull();
    expect(resolveManagedServerFromDeployments("", [DEPLOYMENT])).toBeNull();
    expect(resolveManagedServerFromDeployments("b".repeat(64), [DEPLOYMENT])).toBeNull();
    expect(resolveManagedServerFromDeployments(CONFIG_DIGEST, [{ ...DEPLOYMENT, operatorConfigDigest: null }])).toBeNull();
    expect(resolveManagedServerFromDeployments(digest(Buffer.from(`${CONFIG_BYTES.toString()}\n`)), [DEPLOYMENT])).toBeNull();
    expect(resolveManagedServerFromDeployments(digest(Buffer.from('{"operator":"bob","lhost":"203.0.113.20"}')), [DEPLOYMENT])).toBeNull();
  });

  it("returns null when multiple deployments claim the config", () => {
    const duplicate = { ...DEPLOYMENT, id: "55555555-5555-4555-8555-555555555555", provider: "azure" as const };
    expect(resolveManagedServerFromDeployments(CONFIG_DIGEST, [DEPLOYMENT, duplicate])).toBeNull();
    expect(resolveManagedServerFromDeployments(CONFIG_DIGEST, [duplicate, DEPLOYMENT])).toBeNull();
  });

  it("ignores nonmatching deployments and reflects updated or removed metadata", () => {
    const unrelated = { ...DEPLOYMENT, id: "other", operatorConfigDigest: "b".repeat(64) };
    const renamed = { ...DEPLOYMENT, name: "Renamed team server" };
    expect(resolveManagedServerFromDeployments(CONFIG_DIGEST, [unrelated, renamed])).toEqual({
      deploymentId: renamed.id,
      provider: renamed.provider,
      name: renamed.name,
    });
    expect(resolveManagedServerFromDeployments(CONFIG_DIGEST, [unrelated])).toBeNull();
  });

  it("projects only cached display metadata from AWS records", () => {
    const deployment = { ...E2E_AWS_DEPLOYMENT, operatorConfigDigest: CONFIG_DIGEST };
    const result = resolveManagedServerFromDeployments(CONFIG_DIGEST, [deployment]);

    expect(result).toEqual({
      deploymentId: deployment.id,
      provider: "aws",
      name: deployment.name,
      overview: {
        region: "us-west-2",
        size: "t3.small",
        instanceState: "running",
        health: "ok",
        publicIpAddress: "198.51.100.24",
        privateIpAddress: "10.0.0.24",
        updatedAt: deployment.updatedAt,
      },
    });
    expect(Object.isFrozen(result?.overview)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(deployment.credentialId);
    expect(JSON.stringify(result)).not.toContain(CONFIG_DIGEST);
    expect(JSON.stringify(result)).not.toContain(deployment.operatorConfigFileName);
  });

  it("normalizes Azure location and size without inventing health or missing addresses", () => {
    const deployment = {
      ...E2E_AZURE_DEPLOYMENT,
      operatorConfigDigest: CONFIG_DIGEST,
      runtime: { ...E2E_AZURE_DEPLOYMENT.runtime, publicIpAddress: null, privateIpAddress: null },
    };
    const result = resolveManagedServerFromDeployments(CONFIG_DIGEST, [deployment]);

    expect(result).toEqual({
      deploymentId: deployment.id,
      provider: "azure",
      name: deployment.name,
      overview: {
        region: deployment.spec.location,
        size: deployment.spec.vmSize,
        instanceState: deployment.runtime.instanceState,
        publicIpAddress: null,
        privateIpAddress: null,
        updatedAt: deployment.updatedAt,
      },
    });
    expect(Object.isFrozen(result?.overview)).toBe(true);
  });

  it.each<[AwsDeploymentHealth, AwsDeploymentHealth, AwsDeploymentHealth]>([
    ["ok", "unknown", "unknown"],
    ["unknown", "ok", "unknown"],
    ["ok", "initializing", "initializing"],
    ["impaired", "ok", "impaired"],
    ["initializing", "impaired", "impaired"],
  ])("reports AWS checks %s / %s as %s", (instanceHealth, systemHealth, expected) => {
    const deployment = {
      ...E2E_AWS_DEPLOYMENT,
      operatorConfigDigest: CONFIG_DIGEST,
      runtime: { ...E2E_AWS_DEPLOYMENT.runtime, instanceHealth, systemHealth },
    };
    expect(resolveManagedServerFromDeployments(CONFIG_DIGEST, [deployment])?.overview?.health).toBe(expected);
  });
});

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
