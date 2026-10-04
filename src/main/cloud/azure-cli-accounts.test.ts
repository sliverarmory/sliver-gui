// @vitest-environment node

import { AzureCliCredential } from "@azure/identity";
import { describe, expect, it, vi } from "vitest";

import {
  AZURE_CLI_ACCOUNT_LIST_ARGS,
  AZURE_CLI_CREDENTIAL_PROCESS_TIMEOUT_MS,
  AzureCliAccountSource,
  azureCliChildEnvironment,
  azureCliExecutableCandidates,
  createAzureCliCredential,
  parseAzureCliAccounts,
  prependAzureCliDirectoryToPath,
  type AzureCliCommandRequest,
} from "./azure-cli-accounts.js";

const SUBSCRIPTION_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SUBSCRIPTION_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

describe("Azure CLI account discovery", () => {
  it("runs one fixed bounded account-list query and returns frozen renderer-safe summaries", async () => {
    const runner = vi.fn(async (_request: AzureCliCommandRequest) => JSON.stringify([
      account({
        subscriptionId: SUBSCRIPTION_B,
        name: "Secondary",
        tenantId: TENANT_B,
        homeTenantId: null,
        isDefault: false,
      }),
      account({
        subscriptionId: SUBSCRIPTION_A.toUpperCase(),
        name: "Primary",
        tenantId: TENANT_A.toUpperCase(),
        homeTenantId: TENANT_A.toUpperCase(),
        isDefault: true,
      }),
    ]));
    const environment: NodeJS.ProcessEnv = {
      HOME: "/Users/operator",
      PATH: "/usr/bin:/bin:/tmp/untrusted",
    };
    const source = new AzureCliAccountSource({
      environment,
      platform: "darwin",
      executableResolver: vi.fn(() => "/opt/homebrew/bin/az"),
      runner,
    });

    const accounts = await source.list();

    expect(accounts).toEqual([
      {
        subscriptionId: SUBSCRIPTION_A,
        name: "Primary",
        tenantId: TENANT_A,
        homeTenantId: TENANT_A,
        isDefault: true,
        cloudName: "AzureCloud",
      },
      {
        subscriptionId: SUBSCRIPTION_B,
        name: "Secondary",
        tenantId: TENANT_B,
        homeTenantId: null,
        isDefault: false,
        cloudName: "AzureCloud",
      },
    ]);
    expect(Object.isFrozen(accounts)).toBe(true);
    expect(accounts.every(Object.isFrozen)).toBe(true);
    expect(runner).toHaveBeenCalledOnce();
    const request = runner.mock.calls[0]![0];
    expect(request.executablePath).toBe("/opt/homebrew/bin/az");
    expect(request.args).toEqual(AZURE_CLI_ACCOUNT_LIST_ARGS);
    expect(request.args.join(" ")).toContain("account list");
    expect(request.args.join(" ")).toContain("cloudName:cloudName");
    expect(request.args.join(" ")).not.toContain("environmentName");
    expect(request.args).not.toContain("set");
    expect(request.timeoutMs).toBe(15_000);
    expect(request.maxOutputBytes).toBe(512 * 1024);
    expect(request.cwd).toBe("/bin");
    expect(request.environment["PATH"]?.split(":")[0]).toBe("/opt/homebrew/bin");
    expect(request.environment["PATH"]).not.toContain("/tmp/untrusted");
  });

  it("returns an empty list for a signed-out CLI without manufacturing an identity", async () => {
    const source = new AzureCliAccountSource({
      environment: { PATH: "/usr/bin" },
      platform: "linux",
      executableResolver: () => "/usr/bin/az",
      runner: async () => "[]",
    });

    await expect(source.list()).resolves.toEqual([]);
  });

  it("maps runner failures to a stable error without exposing command output", async () => {
    const source = new AzureCliAccountSource({
      environment: { PATH: "/usr/bin" },
      platform: "linux",
      executableResolver: () => "/usr/bin/az",
      runner: async () => {
        throw new Error("token=DO_NOT_EXPOSE stderr=PRIVATE_ACCOUNT_NAME");
      },
    });

    const error = await source.list().catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "discovery-failed" });
    expect(String(error)).not.toMatch(/DO_NOT_EXPOSE|PRIVATE_ACCOUNT_NAME/u);
  });

  it("rejects resolver paths outside the fixed trusted locations", async () => {
    const runner = vi.fn(async () => "[]");
    const source = new AzureCliAccountSource({
      environment: { PATH: "/tmp/attacker:/usr/bin" },
      platform: "linux",
      executableResolver: () => "/tmp/attacker/az",
      runner,
    });

    const error = await source.list().catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "cli-unavailable" });
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("Azure CLI account parsing", () => {
  it("rejects duplicate subscriptions, multiple defaults, and unknown fields", () => {
    const first = account({ subscriptionId: SUBSCRIPTION_A, isDefault: true });
    expect(() => parseAzureCliAccounts(JSON.stringify([first, first]))).toThrow(/invalid/iu);
    expect(() => parseAzureCliAccounts(JSON.stringify([
      first,
      account({ subscriptionId: SUBSCRIPTION_B, tenantId: TENANT_B, isDefault: true }),
    ]))).toThrow(/invalid/iu);
    expect(() => parseAzureCliAccounts(JSON.stringify([{ ...first, accessToken: "DO_NOT_EXPOSE" }]))).toThrow(
      /invalid/iu,
    );
  });

  it("rejects malformed identifiers, control text, oversized output, and non-arrays", () => {
    expect(() => parseAzureCliAccounts(JSON.stringify([
      account({ subscriptionId: "not-a-guid" }),
    ]))).toThrow(/invalid/iu);
    expect(() => parseAzureCliAccounts(JSON.stringify([
      account({ name: "bad\nname" }),
    ]))).toThrow(/invalid/iu);
    expect(() => parseAzureCliAccounts("{}")).toThrow(/invalid/iu);
    expect(() => parseAzureCliAccounts("[]", 1)).toThrow(/invalid/iu);
  });
});

describe("Azure CLI executable environment", () => {
  it("adds Homebrew candidates for Finder-style macOS PATH values and ignores untrusted directories", () => {
    const candidates = azureCliExecutableCandidates(
      { PATH: "/usr/bin:/bin:/tmp/attacker" },
      "darwin",
    );

    expect(candidates).toContain("/opt/homebrew/bin/az");
    expect(candidates).toContain("/usr/local/bin/az");
    expect(candidates[0]).toBe("/usr/bin/az");
    expect(candidates.every((candidate) => !candidate.startsWith("/tmp/"))).toBe(true);
  });

  it("discovers standard Windows MSI locations and emits native before batch candidates", () => {
    const candidates = azureCliExecutableCandidates({
      Path: "C:\\Windows\\System32",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\operator\\AppData\\Local",
    }, "win32");

    expect(candidates.slice(0, 2)).toEqual([
      "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.exe",
      "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd",
    ]);
    expect(candidates).toContain(
      "C:\\Users\\operator\\AppData\\Local\\Programs\\Azure CLI\\wbin\\az.cmd",
    );
  });

  it("creates a telemetry-disabled child snapshot and prepends only a trusted resolved directory", () => {
    const original: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/tmp/attacker",
      HOME: "/Users/operator",
      AZURE_CONFIG_DIR: "/Users/operator/.azure",
    };
    const child = azureCliChildEnvironment(original, "darwin");
    expect(child).toMatchObject({
      HOME: "/Users/operator",
      AZURE_CONFIG_DIR: "/Users/operator/.azure",
      AZURE_CORE_COLLECT_TELEMETRY: "no",
      AZURE_CORE_ONLY_SHOW_ERRORS: "true",
      NO_COLOR: "1",
    });
    expect(child["PATH"]).not.toContain("/tmp/attacker");

    prependAzureCliDirectoryToPath(original, "/opt/homebrew/bin/az", "darwin");
    expect(original["PATH"]?.split(":")[0]).toBe("/opt/homebrew/bin");
    expect(() => prependAzureCliDirectoryToPath(original, "/tmp/attacker/az", "darwin")).toThrow(
      /untrusted/iu,
    );
  });
});

describe("Azure CLI credential factory", () => {
  it("pins the credential to the exact tenant and subscription with a bounded process timeout", () => {
    const credential = createAzureCliCredential({
      subscriptionId: SUBSCRIPTION_A.toUpperCase(),
      tenantId: TENANT_A.toUpperCase(),
    });

    expect(credential).toBeInstanceOf(AzureCliCredential);
    expect(credential as unknown as Record<string, unknown>).toMatchObject({
      subscription: SUBSCRIPTION_A,
      tenantId: TENANT_A,
      timeout: AZURE_CLI_CREDENTIAL_PROCESS_TIMEOUT_MS,
    });
    expect(() => createAzureCliCredential({
      subscriptionId: "not-a-subscription",
      tenantId: TENANT_A,
    })).toThrow(/subscription/iu);
    expect(() => createAzureCliCredential({
      subscriptionId: SUBSCRIPTION_A,
      tenantId: TENANT_A,
    }, 10)).toThrow(/timeout/iu);
  });
});

function account(overrides: Partial<Record<
  "subscriptionId" | "name" | "tenantId" | "homeTenantId" | "isDefault" | "cloudName",
  unknown
>> = {}): Record<string, unknown> {
  return {
    subscriptionId: SUBSCRIPTION_A,
    name: "Primary",
    tenantId: TENANT_A,
    homeTenantId: TENANT_A,
    isDefault: false,
    cloudName: "AzureCloud",
    ...overrides,
  };
}
