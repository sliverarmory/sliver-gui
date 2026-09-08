// @vitest-environment node

import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AwsSharedProfileError,
  AwsSharedProfileSource,
  defaultAwsSharedProfilePaths,
  type AwsSharedProfilePaths,
} from "./aws-shared-profiles.js";

describe("AWS shared profile discovery", () => {
  it("reads only the selected profile's console login identity and rejects ambiguous identity changes", async () => {
    const arn = "arn:aws:sts::123456789012:assumed-role/Admin/session";
    const paths = await profileFiles("", `[profile selected]\nlogin_session = ${arn} # comment\nsecret = never-return\n[profile another]\nlogin_session = arn:aws:iam::999999999999:root`);
    const source = new AwsSharedProfileSource({ paths });
    expect(await source.loginSessionArn("selected")).toBe(arn);
    expect(await source.loginSessionArn("missing")).toBeNull();
    await writeFile(paths.configFilePath, `[profile selected]\nlogin_session = ${arn}\nlogin_session = arn:aws:iam::999999999999:root`);
    await expect(source.loginSessionArn("selected")).rejects.toMatchObject({ code: "profile-files-unavailable" });
  });

  it("rejects resolved credentials after their expiration without exposing token values", async () => {
    const paths = await profileFiles("[default]", "");
    const source = new AwsSharedProfileSource({ paths, now: () => 100_000, credentialResolver: async () => ({
      accessKeyId: "ASIAEXAMPLE00000001", secretAccessKey: "must-not-be-returned", expiration: new Date(99_999),
    }) });
    const provider = await source.credentialProvider("default");
    await expect(provider()).rejects.toMatchObject({ code: "credential-resolution-failed" });
    await expect(provider()).rejects.not.toThrow(/must-not-be-returned/u);
  });

  it("merges and sorts credentials/config profiles without returning secret values", async () => {
    const paths = await profileFiles(
      [
        "[production]",
        "aws_access_key_id = AKIA_DO_NOT_EXPOSE",
        "aws_secret_access_key = credential-file-secret",
        "",
        "[default]",
        "aws_access_key_id = AKIA_ALSO_PRIVATE",
        "aws_secret_access_key = another-secret",
      ].join("\n"),
      [
        "[default]",
        "region = us-west-2",
        "",
        "[profile production]",
        "region = eu-central-1",
        "credential_process = /bin/echo do-not-expose-this-command",
        "",
        "[profile sso-admin]",
        "sso_session = company",
        "region = us-east-1",
        "",
        "[profile commented-region]",
        "region = us-west-2 # DO_NOT_EXPOSE_REGION_COMMENT",
        "",
        "[sso-session company]",
        "sso_start_url = https://secret.example.test/start",
        "",
        "[services local]",
        "endpoint_url = https://ignored.example.test",
      ].join("\n"),
    );
    const credentialResolver = vi.fn(async () => ({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "must-not-be-resolved-during-listing",
    }));
    const source = new AwsSharedProfileSource({ paths, credentialResolver });

    const profiles = await source.list();

    expect(profiles).toEqual([
      { name: "commented-region", region: "us-west-2" },
      { name: "default", region: "us-west-2" },
      { name: "production", region: "eu-central-1" },
      { name: "sso-admin", region: "us-east-1" },
    ]);
    const serialized = JSON.stringify(profiles);
    expect(serialized).not.toMatch(/DO_NOT_EXPOSE|PRIVATE|secret|credential_process|start_url|REGION_COMMENT/iu);
    expect(Object.isFrozen(profiles)).toBe(true);
    expect(profiles.every(Object.isFrozen)).toBe(true);
    expect(credentialResolver).not.toHaveBeenCalled();
  });

  it("treats absent standard files as an empty profile list", async () => {
    const root = await mkdtemp(join(tmpdir(), "sliver-aws-profiles-missing-"));
    const source = new AwsSharedProfileSource({
      paths: {
        credentialsFilePath: join(root, "credentials"),
        configFilePath: join(root, "config"),
      },
    });

    await expect(source.list()).resolves.toEqual([]);
  });

  it("rejects oversized or symlinked files with a stable error that omits paths and content", async () => {
    const paths = await profileFiles("[default]\nsecret=DO_NOT_EXPOSE", "");
    const oversized = new AwsSharedProfileSource({ paths, maxFileBytes: 8 });

    const sizeError = await oversized.list().catch((error: unknown) => error);
    expect(sizeError).toMatchObject({ code: "profile-files-unavailable" });
    expect(String(sizeError)).not.toContain(paths.credentialsFilePath);
    expect(String(sizeError)).not.toContain("DO_NOT_EXPOSE");

    if (process.platform !== "win32") {
      const root = await mkdtemp(join(tmpdir(), "sliver-aws-profiles-link-"));
      const target = join(root, "target");
      const linked = join(root, "credentials");
      await writeFile(target, "[default]\naws_access_key_id=DO_NOT_EXPOSE", { mode: 0o600 });
      await symlink(target, linked);
      const linkedSource = new AwsSharedProfileSource({
        paths: { credentialsFilePath: linked, configFilePath: join(root, "missing") },
      });
      const linkError = await linkedSource.list().catch((error: unknown) => error);
      expect(linkError).toMatchObject({ code: "profile-files-unavailable" });
      expect(String(linkError)).not.toContain(target);
      expect(String(linkError)).not.toContain("DO_NOT_EXPOSE");
    }
  });
});

describe("AWS shared profile resolution", () => {
  it("passes only an exact discovered profile and injected paths to the resolver", async () => {
    const paths = await profileFiles("[operator]\naws_access_key_id=ignored", "[profile operator]\nregion=us-gov-west-1");
    const credentialResolver = vi.fn(async () => ({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "provider-secret",
      sessionToken: "provider-session-token",
    }));
    const source = new AwsSharedProfileSource({ paths, credentialResolver });

    const resolved = await source.resolve("operator");

    expect(credentialResolver).toHaveBeenCalledOnce();
    expect(credentialResolver).toHaveBeenCalledWith({
      profileName: "operator",
      credentialsFilePath: paths.credentialsFilePath,
      configFilePath: paths.configFilePath,
      region: "us-gov-west-1",
    });
    expect(resolved).toEqual({
      profile: { name: "operator", region: "us-gov-west-1" },
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "provider-secret",
        sessionToken: "provider-session-token",
      },
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.credentials)).toBe(true);
  });

  it("returns a lazy refreshable provider with an explicit client-region override", async () => {
    const paths = await profileFiles("[operator]\naws_access_key_id=ignored", "[profile operator]\nregion=us-west-2");
    const credentialResolver = vi.fn(async () => ({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "provider-secret",
    }));
    const source = new AwsSharedProfileSource({ paths, credentialResolver });

    const provider = await source.credentialProvider("operator", "eu-west-1");
    expect(credentialResolver).not.toHaveBeenCalled();
    await expect(provider()).resolves.toMatchObject({ accessKeyId: "AKIAIOSFODNN7EXAMPLE" });
    await expect(provider()).resolves.toMatchObject({ accessKeyId: "AKIAIOSFODNN7EXAMPLE" });
    expect(credentialResolver).toHaveBeenCalledTimes(2);
    expect(credentialResolver).toHaveBeenLastCalledWith({
      profileName: "operator",
      credentialsFilePath: paths.credentialsFilePath,
      configFilePath: paths.configFilePath,
      region: "eu-west-1",
    });
  });

  it("uses the official SDK INI provider for a static temporary profile", async () => {
    const paths = await profileFiles(
      [
        "[sdk-static]",
        "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
        "aws_secret_access_key = official-provider-secret",
        "aws_session_token = official-provider-session",
      ].join("\n"),
      "[profile sdk-static]\nregion = ap-southeast-2",
    );
    const source = new AwsSharedProfileSource({ paths });

    await expect(source.resolve("sdk-static")).resolves.toEqual({
      profile: { name: "sdk-static", region: "ap-southeast-2" },
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "official-provider-secret",
        sessionToken: "official-provider-session",
      },
    });
  });

  it("normalizes quoted profile headers and trailing comments exactly enough for SDK resolution", async () => {
    const paths = await profileFiles(
      "",
      [
        "[profile \"quoted-operator\"] # profile comment",
        "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
        "aws_secret_access_key = official-provider-secret",
        "region = eu-west-1 ; region comment",
      ].join("\n"),
    );
    const source = new AwsSharedProfileSource({ paths });

    await expect(source.list()).resolves.toEqual([
      { name: "quoted-operator", region: "eu-west-1" },
    ]);
    await expect(source.resolve("quoted-operator")).resolves.toMatchObject({
      profile: { name: "quoted-operator", region: "eu-west-1" },
      credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE" },
    });
  });

  it("never invokes a resolver for an absent or malformed profile name", async () => {
    const paths = await profileFiles("[known]\naws_access_key_id=ignored", "");
    const credentialResolver = vi.fn(async () => ({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "secret",
    }));
    const source = new AwsSharedProfileSource({ paths, credentialResolver });

    await expect(source.resolve("missing")).rejects.toMatchObject({ code: "profile-not-found" });
    await expect(source.resolve(" known ")).rejects.toMatchObject({ code: "invalid-input" });
    await expect(source.resolve("bad\nname")).rejects.toMatchObject({ code: "invalid-input" });
    expect(credentialResolver).not.toHaveBeenCalled();
  });

  it("wraps resolver failures and malformed identities without exposing provider details", async () => {
    const paths = await profileFiles("[known]\naws_access_key_id=ignored", "");
    const secret = "provider-error-secret";
    const failing = new AwsSharedProfileSource({
      paths,
      credentialResolver: async () => {
        throw new Error(`${secret} at ${paths.credentialsFilePath}`);
      },
    });

    const failure = await failing.resolve("known").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AwsSharedProfileError);
    expect(failure).toMatchObject({ code: "credential-resolution-failed" });
    expect(String(failure)).not.toContain(secret);
    expect(String(failure)).not.toContain(paths.credentialsFilePath);

    const malformed = new AwsSharedProfileSource({
      paths,
      credentialResolver: async () => ({ accessKeyId: secret, secretAccessKey: "" }),
    });
    await expect(malformed.resolve("known")).rejects.toMatchObject({
      code: "credential-resolution-failed",
      message: "The selected AWS profile returned invalid credentials.",
    });
  });
});

describe("AWS shared profile path selection", () => {
  it("uses AWS CLI environment overrides and expands a home-relative path", () => {
    const paths = defaultAwsSharedProfilePaths({
      homeDirectory: "/tmp/aws-profile-home",
      environment: {
        AWS_SHARED_CREDENTIALS_FILE: "~/.aws/work-credentials",
        AWS_CONFIG_FILE: "/tmp/aws-config",
      },
    });

    expect(paths).toEqual({
      credentialsFilePath: "/tmp/aws-profile-home/.aws/work-credentials",
      configFilePath: "/tmp/aws-config",
    });
  });
});

async function profileFiles(credentials: string, config: string): Promise<AwsSharedProfilePaths> {
  const root = await mkdtemp(join(tmpdir(), "sliver-aws-profiles-"));
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
