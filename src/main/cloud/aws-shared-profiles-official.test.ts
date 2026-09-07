// @vitest-environment node

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  fromIni: vi.fn(),
  provider: vi.fn(),
}));

vi.mock("@aws-sdk/credential-providers", () => ({ fromIni: sdkMocks.fromIni }));

import {
  AwsSharedProfileSource,
  type AwsSharedProfilePaths,
} from "./aws-shared-profiles.js";
import {
  AwsEc2Provider,
  type AwsEc2ClientConfiguration,
} from "./aws-ec2-provider.js";

describe("official AWS shared-profile provider integration", () => {
  beforeEach(() => {
    sdkMocks.fromIni.mockReset();
    sdkMocks.provider.mockReset();
  });

  it("passes the workload region as caller context and preserves temporary credential expiration", async () => {
    const paths = await profileFiles(
      "[operator]\naws_access_key_id=ignored",
      "[profile operator]\nregion=us-west-2",
    );
    const expiration = new Date("2030-01-02T03:04:05.000Z");
    sdkMocks.provider.mockResolvedValue({
      accessKeyId: "ASIAIOSFODNN7EXAMPLE",
      secretAccessKey: "temporary-provider-secret",
      sessionToken: "temporary-provider-session",
      expiration,
      accountId: "123456789012",
    });
    sdkMocks.fromIni.mockReturnValue(sdkMocks.provider);
    const source = new AwsSharedProfileSource({ paths });

    const profileProvider = await source.credentialProvider("operator", "eu-west-1");
    let clientConfiguration: AwsEc2ClientConfiguration | undefined;
    new AwsEc2Provider(
      { region: "eu-west-1", credentials: profileProvider },
      {
        clientFactory: (configuration) => {
          clientConfiguration = configuration;
          return { send: async () => ({}) };
        },
      },
    );
    if (typeof clientConfiguration?.credentials !== "function") {
      throw new Error("Expected a refreshable EC2 credential provider");
    }

    const credentials = await clientConfiguration.credentials();

    expect(sdkMocks.fromIni).toHaveBeenCalledWith({
      profile: "operator",
      filepath: paths.credentialsFilePath,
      configFilepath: paths.configFilePath,
      ignoreCache: true,
    });
    expect(sdkMocks.provider).toHaveBeenCalledOnce();
    const context = sdkMocks.provider.mock.calls[0]?.[0] as {
      callerClientConfig?: { region?: () => Promise<string> };
    } | undefined;
    expect(await context?.callerClientConfig?.region?.()).toBe("eu-west-1");
    expect(credentials).toMatchObject({
      accessKeyId: "ASIAIOSFODNN7EXAMPLE",
      sessionToken: "temporary-provider-session",
      expiration,
      accountId: "123456789012",
    });
    expect(credentials.expiration).not.toBe(expiration);
  });
});

async function profileFiles(credentials: string, config: string): Promise<AwsSharedProfilePaths> {
  const root = await mkdtemp(join(tmpdir(), "sliver-aws-provider-options-"));
  const awsDirectory = join(root, ".aws");
  await mkdir(awsDirectory, { mode: 0o700 });
  const paths = {
    credentialsFilePath: join(awsDirectory, "credentials"),
    configFilePath: join(awsDirectory, "config"),
  };
  await writeFile(paths.credentialsFilePath, credentials, { mode: 0o600 });
  await writeFile(paths.configFilePath, config, { mode: 0o600 });
  return paths;
}
