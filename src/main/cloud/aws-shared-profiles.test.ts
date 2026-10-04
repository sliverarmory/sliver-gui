// @vitest-environment node

import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fromIni } from "@aws-sdk/credential-providers";
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
      { name: "commented-region", region: "us-west-2", authentication: { method: "unknown", canConsoleLogin: false } },
      { name: "default", region: "us-west-2", authentication: { method: "static", canConsoleLogin: false } },
      { name: "production", region: "eu-central-1", authentication: { method: "static", canConsoleLogin: false } },
      { name: "sso-admin", region: "us-east-1", authentication: { method: "sso", canConsoleLogin: false } },
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

describe("AWS shared profile authentication capabilities", () => {
  const arn = "arn:aws:iam::123456789012:user/example";

  it("exposes only safe summary metadata and retains the ARN only for direct console renewal", async () => {
    const paths = await profileFiles("", `[profile console]\nlogin_session=${arn}\nprivate_setting=DO_NOT_EXPOSE`);
    const credentialResolver = vi.fn();
    const source = new AwsSharedProfileSource({ paths, credentialResolver });
    const profiles = await source.list();
    expect(profiles).toEqual([{ name: "console", region: null, authentication: { method: "console-login", canConsoleLogin: true } }]);
    expect(JSON.stringify(profiles)).not.toContain(arn);
    expect(Object.isFrozen(profiles[0]?.authentication)).toBe(true);
    const authentication = await source.authentication("console");
    expect(authentication).toEqual({ method: "console-login", canConsoleLogin: true, loginSessionArn: arn });
    expect(Object.isFrozen(authentication)).toBe(true);
    expect(credentialResolver).not.toHaveBeenCalled();
  });

  it.each([
    ["static", "aws_access_key_id=DO_NOT_EXPOSE\naws_secret_access_key=DO_NOT_EXPOSE"],
    ["process", "credential_process=DO_NOT_EXECUTE private-command"],
    ["sso", "sso_session=private-company"],
    ["sso", "sso_start_url=https://private.example.test/start\nsso_region=us-west-2"],
    ["role", "role_arn=arn:aws:iam::123456789012:role/Workload\nweb_identity_token_file=/DO_NOT_READ"],
  ])("does not advertise console renewal when %s takes precedence", async (method, settings) => {
    const paths = await profileFiles("", `[profile selected]\nlogin_session=${arn}\n${settings}`);
    const credentialResolver = vi.fn();
    const source = new AwsSharedProfileSource({ paths, credentialResolver });
    expect(await source.authentication("selected")).toEqual({ method, canConsoleLogin: false });
    expect(await source.loginSessionArn("selected")).toBeNull();
    expect(JSON.stringify(await source.list())).not.toMatch(/DO_NOT|private-company|private\.example|arn:aws/u);
    expect(credentialResolver).not.toHaveBeenCalled();
  });

  it("merges credentials keys over configuration before choosing the effective method", async () => {
    const credentialsArn = "arn:aws:iam::999999999999:user/credential-file";
    const paths = await profileFiles(
      `[selected]\naws_access_key_id=AKIAIOSFODNN7EXAMPLE\naws_secret_access_key=synthetic-secret\n[console]\nlogin_session=${credentialsArn}`,
      `[profile selected]\nlogin_session=${arn}\ncredential_process=DO_NOT_EXECUTE\n[profile console]\nlogin_session=${arn}`,
    );
    const source = new AwsSharedProfileSource({ paths });
    expect(await source.authentication("selected")).toEqual({ method: "static", canConsoleLogin: false });
    expect(await source.loginSessionArn("selected")).toBeNull();
    expect(await source.loginSessionArn("console")).toBe(credentialsArn);
    // This resolution uses the real SDK and a synthetic static profile only.
    expect((await source.resolve("selected")).credentials.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
  });

  it("follows source-profile chains without offering direct renewal of the assumed role", async () => {
    const paths = await profileFiles("", [
      "[profile selected]", "role_arn=arn:aws:iam::123456789012:role/Outer", "source_profile=intermediate", `login_session=${arn}`,
      "[profile intermediate]", "role_arn=arn:aws:iam::123456789012:role/Inner", "source_profile=console",
      "[profile console]", `login_session=${arn}`,
    ].join("\n"));
    const source = new AwsSharedProfileSource({ paths, credentialResolver: vi.fn() });
    expect(await source.authentication("selected")).toEqual({ method: "role", canConsoleLogin: false });
    expect(await source.loginSessionArn("selected")).toBeNull();
    expect(await source.authentication("console")).toEqual({ method: "console-login", canConsoleLogin: true, loginSessionArn: arn });
  });

  it.each(["Environment", "EcsContainer", "Ec2InstanceMetadata"])("recognizes %s role sources without requesting credentials", async (credentialSource) => {
    const paths = await profileFiles("", `[profile selected]\nrole_arn=arn:aws:iam::123456789012:role/Workload\ncredential_source=${credentialSource}\nlogin_session=${arn}`);
    const credentialResolver = vi.fn();
    const source = new AwsSharedProfileSource({ paths, credentialResolver });
    expect(await source.authentication("selected")).toEqual({ method: "role", canConsoleLogin: false });
    expect(credentialResolver).not.toHaveBeenCalled();
  });

  it("rejects missing or cyclic role sources instead of falling through to console login", async () => {
    const paths = await profileFiles("", [
      "[profile missing-source]", "role_arn=role", "source_profile=absent", `login_session=${arn}`,
      "[profile cycle-a]", "role_arn=role", "source_profile=cycle-b", `login_session=${arn}`,
      "[profile cycle-b]", "role_arn=role", "source_profile=cycle-a",
    ].join("\n"));
    const source = new AwsSharedProfileSource({ paths });
    for (const name of ["missing-source", "cycle-a", "cycle-b"]) {
      expect(await source.authentication(name)).toEqual({ method: "unknown", canConsoleLogin: false });
      expect(await source.loginSessionArn(name)).toBeNull();
    }
  });

  it("gives root role settings precedence but terminates a source chain at static credentials", async () => {
    const paths = await profileFiles("", [
      "[profile selected]", "role_arn=role", "source_profile=selected",
      "aws_access_key_id=synthetic-key", "aws_secret_access_key=synthetic-secret", `login_session=${arn}`,
    ].join("\n"));
    expect(await new AwsSharedProfileSource({ paths }).authentication("selected")).toEqual({ method: "role", canConsoleLogin: false });
    const roleAssumer = vi.fn(async (_credentials: { accessKeyId: string; secretAccessKey: string }) => ({ accessKeyId: "ASIAIOSFODNN7EXAMPLE", secretAccessKey: "synthetic-role-secret" }));
    await fromIni({ profile: "selected", filepath: paths.credentialsFilePath, configFilepath: paths.configFilePath, ignoreCache: true, roleAssumer })();
    expect(roleAssumer).toHaveBeenCalledOnce();
    expect(roleAssumer.mock.calls[0]?.[0]).toMatchObject({ accessKeyId: "synthetic-key", secretAccessKey: "synthetic-secret" });
  });

  it("does not confuse nested or differently cased settings with SDK authentication keys", async () => {
    const paths = await profileFiles("", [
      "[profile nested]", "service =", `  login_session=${arn}`,
      "[profile uppercase]", `LOGIN_SESSION=${arn}`,
      "[profile selected]", "service =", `  login_session=${arn}`, `login_session=${arn}`,
    ].join("\n"));
    const source = new AwsSharedProfileSource({ paths });
    for (const name of ["nested", "uppercase"]) {
      expect(await source.authentication(name)).toEqual({ method: "unknown", canConsoleLogin: false });
    }
    expect(await source.loginSessionArn("selected")).toBe(arn);
  });

  it("does not treat prefixed credentials sections ignored by the SDK as direct console profiles", async () => {
    const paths = await profileFiles(`[profile selected]\nlogin_session=${arn}\n[unsupported selected]\nlogin_session=${arn}`, "");
    const source = new AwsSharedProfileSource({ paths });
    for (const profile of await source.list()) {
      expect(profile.authentication).toEqual({ method: "unknown", canConsoleLogin: false });
      expect(await source.loginSessionArn(profile.name)).toBeNull();
    }
  });

  it("returns safe failures for absent, malformed, ambiguous, or oversized input", async () => {
    const paths = await profileFiles("", `[profile selected]\nlogin_session=${arn}\nlogin_session=DO_NOT_EXPOSE`);
    const source = new AwsSharedProfileSource({ paths });
    await expect(source.authentication("missing")).rejects.toMatchObject({ code: "profile-not-found" });
    await expect(source.authentication("bad\nname")).rejects.toMatchObject({ code: "invalid-input" });
    await expect(source.authentication("selected")).rejects.toMatchObject({ code: "profile-files-unavailable" });
    expect(await source.list()).toEqual([{ name: "selected", region: null, authentication: { method: "unknown", canConsoleLogin: false } }]);
    const failure = await new AwsSharedProfileSource({ paths, maxFileBytes: 8 }).authentication("selected").catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "profile-files-unavailable" });
    expect(String(failure)).not.toMatch(/DO_NOT_EXPOSE|123456789012/u);
    expect(String(failure)).not.toContain(paths.configFilePath);
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
      profile: { name: "operator", region: "us-gov-west-1", authentication: { method: "unknown", canConsoleLogin: false } },
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
      profile: { name: "sdk-static", region: "ap-southeast-2", authentication: { method: "static", canConsoleLogin: false } },
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
      { name: "quoted-operator", region: "eu-west-1", authentication: { method: "static", canConsoleLogin: false } },
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
      credentialsFilePath: join("/tmp/aws-profile-home", ".aws", "work-credentials"),
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
