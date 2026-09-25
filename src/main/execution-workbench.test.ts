// @vitest-environment node

import { clientpb } from "sliver-script";
import { describe, expect, it, vi } from "vitest";

import type {
  ExecutionActionDraft,
  ExecutionArtifactRole,
} from "../shared/execution-contracts.js";
import type { BeaconSummary, SessionSummary, TargetSummary } from "../shared/target-contracts.js";
import {
  EXECUTION_REMOTE_REJECTION_MESSAGE,
  EXECUTION_TARGET_REJECTION_MESSAGE,
  EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES,
  ExecutionRemoteRejectedError,
  ExecutionTargetRejectedError,
  ExecutionWorkbenchInputError,
  dispatchExecutionAction,
  runExecutionRead,
  type ExecutionWorkbenchClient,
  type ExecutionWorkbenchTarget,
} from "./execution-workbench.js";

describe("execution workbench action dispatcher", () => {
  it("dispatches all 17 reviewed actions through the closed method or psexec composite", async () => {
    for (const action of actionCases()) {
      const fake = fakeClient();
      const artifacts = action.artifacts();
      const psexec = vi.fn(async ({ onDispatch }: { onDispatch: () => void }) => {
        onDispatch();
        onDispatch();
        return { Pid: 700, Response: {} };
      });
      const onDispatch = vi.fn();
      const draft = action.draft();
      const result = await dispatchExecutionAction({
        client: fake.client,
        target: target(sessionSummary()),
        draft,
        artifacts,
        ...(action.implantConfig ? { implantConfig: action.implantConfig() } : {}),
        onDispatch,
        psexec,
      });

      if (action.sessionMethod === "psexec") {
        expect(psexec).toHaveBeenCalledOnce();
        expect(fake.calls).toHaveLength(0);
      } else {
        expect(fake.calls.map(({ method }) => method)).toEqual([action.sessionMethod]);
        expect(fake.calls[0]?.args[0]).toBe("target-1");
      }
      expect(onDispatch).toHaveBeenCalledOnce();
      expect(result.summary.length).toBeGreaterThan(0);
      result.stdout?.fill(0);
      result.stderr?.fill(0);
      for (const bytes of artifacts.values()) expect(isZero(bytes)).toBe(true);
      for (const credential of draftCredentials(draft)) expect(isZero(credential)).toBe(true);
    }
  });

  it("selects every beacon wrapper for actions supported in both modes", async () => {
    for (const action of actionCases().filter((candidate) => candidate.beaconMethod !== undefined)) {
      const fake = fakeClient({ beaconTask: true });
      const artifacts = action.artifacts();
      const draft = action.draft();
      const result = await dispatchExecutionAction({
        client: fake.client,
        target: target(beaconSummary()),
        draft,
        artifacts,
        ...(action.implantConfig ? { implantConfig: action.implantConfig() } : {}),
      });

      expect(fake.calls.map(({ method }) => method)).toEqual([action.beaconMethod]);
      expect(fake.calls[0]?.args[0]).toBe("target-1");
      expect(result.taskId).toBe("task-1");
      result.stdout?.fill(0);
      result.stderr?.fill(0);
    }
  });

  it("gives psexec only an expiring clone and lets the composite mark its first side effect", async () => {
    const source = Buffer.from("service-executable");
    let received: Buffer | undefined;
    const onDispatch = vi.fn();
    const psexec = vi.fn(async (input: { serviceExecutable?: Buffer; onDispatch: () => void }) => {
      received = input.serviceExecutable;
      expect(received?.toString()).toBe("service-executable");
      expect(received).not.toBe(source);
      input.onDispatch();
      input.onDispatch();
      return { Stdout: Buffer.from("installed"), Response: {} };
    });
    const draft = psexecDraft({ kind: "native-file" });

    const result = await dispatchExecutionAction({
      client: fakeClient().client,
      target: target(sessionSummary()),
      draft,
      artifacts: new Map([["service-executable", source]]),
      onDispatch,
      psexec,
    });

    expect(result.stdout?.toString()).toBe("installed");
    expect(onDispatch).toHaveBeenCalledOnce();
    expect(received && isZero(received)).toBe(true);
    expect(isZero(source)).toBe(true);
    result.stdout?.fill(0);
  });

  it("clears borrowed and cloned artifacts and credential buffers on success and failure", async () => {
    const assemblySource = Buffer.from("assembly-secret");
    let assemblyClone: Buffer | undefined;
    const assemblyClient = fakeClient({
      overrides: {
        executeAssemblySession: async (_id: unknown, data: unknown) => {
          assemblyClone = data as Buffer;
          throw new Error("transport failed");
        },
      },
    });
    await expect(dispatchExecutionAction({
      client: assemblyClient.client,
      target: target(sessionSummary()),
      draft: assemblyDraft(),
      artifacts: new Map([["assembly", assemblySource]]),
    })).rejects.toThrow("transport failed");
    expect(isZero(assemblySource)).toBe(true);
    expect(assemblyClone && isZero(assemblyClone)).toBe(true);

    const privateKey = Buffer.from("private-key-secret");
    let keyClone: Buffer | undefined;
    const sshClient = fakeClient({
      overrides: {
        runSshSession: async (_id: unknown, options: unknown) => {
          keyClone = (options as { privateKey: Buffer }).privateKey;
          return { Response: {} };
        },
      },
    });
    await dispatchExecutionAction({
      client: sshClient.client,
      target: target(sessionSummary()),
      draft: sshDraft({ kind: "private-key" }),
      artifacts: new Map([["ssh-private-key", privateKey]]),
    });
    expect(isZero(privateKey)).toBe(true);
    expect(keyClone && isZero(keyClone)).toBe(true);

    const password = Uint8Array.from(Buffer.from("credential-secret"));
    const runAsClient = fakeClient({
      overrides: { runAsSession: async () => { throw new Error("dispatch failed"); } },
    });
    await expect(dispatchExecutionAction({
      client: runAsClient.client,
      target: target(sessionSummary()),
      draft: runAsDraft(password),
      artifacts: new Map(),
    })).rejects.toThrow("dispatch failed");
    expect(isZero(password)).toBe(true);
  });

  it("replaces Response.Err with a fixed error and clears attached response bytes", async () => {
    const raw = Buffer.from("output-never-returned");
    const client = fakeClient({
      overrides: {
        executeSession: async () => ({
          Stdout: raw,
          Stderr: Buffer.alloc(0),
          Response: { Err: "remote-secret-path and credential" },
        }),
      },
    });

    const failure = dispatchExecutionAction({
      client: client.client,
      target: target(sessionSummary()),
      draft: processDraft(),
      artifacts: new Map(),
    });
    await expect(failure).rejects.toBeInstanceOf(ExecutionRemoteRejectedError);
    await expect(failure).rejects.toThrow(EXECUTION_REMOTE_REJECTION_MESSAGE);
    await expect(failure).rejects.not.toThrow(/remote-secret-path|credential/u);
    expect(isZero(raw)).toBe(true);
  });

  it("bounds and marks binary and UTF-8 output truncation without returning raw buffers", async () => {
    const rawStdout = Buffer.alloc(EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES + 17, 0x41);
    const rawStderr = "é".repeat(EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES);
    const client = fakeClient({
      overrides: {
        executeSession: async () => ({
          Pid: 42,
          Stdout: rawStdout,
          Stderr: rawStderr,
          Response: {},
        }),
      },
    });

    const result = await dispatchExecutionAction({
      client: client.client,
      target: target(sessionSummary()),
      draft: processDraft(),
      artifacts: new Map(),
    });

    expect(result.pid).toBe(42);
    expect(result.stdout).toHaveLength(EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES);
    expect(result.stderr).toHaveLength(EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
    expect(result.stdout).not.toBe(rawStdout);
    expect(isZero(rawStdout)).toBe(true);
    result.stdout?.fill(0);
    result.stderr?.fill(0);
  });

  it("preserves process exit status only for captured foreground executions", async () => {
    for (const status of [0, 17]) {
      const client = fakeClient({ overrides: { executeSession: async () => ({ Status: status, Pid: 42, Response: {} }) } });
      const result = await dispatchExecutionAction({
        client: client.client,
        target: target(sessionSummary()),
        draft: processDraft(),
        artifacts: new Map(),
      });
      expect(result.exitCode).toBe(status);
    }

    for (const draft of [
      { ...processDraft(), captureOutput: false },
      { ...processDraft(), captureOutput: false, background: true },
    ]) {
      const client = fakeClient({ overrides: { executeSession: async () => ({ Status: 0, Pid: 42, Response: {} }) } });
      const result = await dispatchExecutionAction({
        client: client.client,
        target: target(sessionSummary()),
        draft,
        artifacts: new Map(),
      });
      expect(result.exitCode).toBeUndefined();
    }
  });

  it("treats assembly AnyCPU as x86 plus x64, never arm64", async () => {
    for (const arch of ["386", "amd64"] as const) {
      const artifact = Buffer.from(`assembly-${arch}`);
      const fake = fakeClient();
      const result = await dispatchExecutionAction({
        client: fake.client,
        target: target({ ...sessionSummary(), arch }),
        draft: { ...assemblyDraft(), architecture: "x84" },
        artifacts: new Map([["assembly", artifact]]),
      });

      expect(fake.calls.map(({ method }) => method)).toEqual(["executeAssemblySession"]);
      expect(isZero(artifact)).toBe(true);
      result.stdout?.fill(0);
      result.stderr?.fill(0);
    }

    const armArtifact = Buffer.from("assembly-arm64");
    await expect(dispatchExecutionAction({
      client: fakeClient().client,
      target: target({ ...sessionSummary(), arch: "arm64" }),
      draft: { ...assemblyDraft(), architecture: "x84" },
      artifacts: new Map([["assembly", armArtifact]]),
    })).rejects.toBeInstanceOf(ExecutionTargetRejectedError);
    expect(isZero(armArtifact)).toBe(true);
  });

  it("fails closed on target, platform, architecture, config, and artifact mismatches", async () => {
    const cases = [
      {
        target: target(beaconSummary()),
        draft: psexecDraft({ kind: "profile", profileName: "profile" }),
        artifacts: new Map<ExecutionArtifactRole, Buffer>(),
      },
      {
        target: target(linuxSession()),
        draft: assemblyDraft(),
        artifacts: new Map<ExecutionArtifactRole, Buffer>([["assembly", Buffer.from("assembly")]]),
      },
      {
        target: target(linuxSession()),
        draft: { ...processDraft(), inheritEnvironment: false, useToken: true },
        artifacts: new Map<ExecutionArtifactRole, Buffer>(),
      },
      {
        target: target(sessionSummary()),
        draft: shellcodeDraft("386"),
        artifacts: new Map<ExecutionArtifactRole, Buffer>([["shellcode", Buffer.from("shellcode")]]),
      },
      {
        target: target(sessionSummary()),
        draft: migrateDraft(),
        artifacts: new Map<ExecutionArtifactRole, Buffer>(),
        implantConfig: implantConfig("windows", "386"),
      },
    ];
    for (const candidate of cases) {
      const sourceBytes = [...candidate.artifacts.values()];
      const failure = dispatchExecutionAction({
        client: fakeClient().client,
        target: candidate.target,
        draft: candidate.draft,
        artifacts: candidate.artifacts,
        ...(candidate.implantConfig ? { implantConfig: candidate.implantConfig } : {}),
        psexec: async () => ({}),
      });
      await expect(failure).rejects.toBeInstanceOf(ExecutionTargetRejectedError);
      await expect(failure).rejects.toThrow(EXECUTION_TARGET_REJECTION_MESSAGE);
      for (const bytes of sourceBytes) expect(isZero(bytes)).toBe(true);
    }

    const unexpected = Buffer.from("unexpected");
    await expect(dispatchExecutionAction({
      client: fakeClient().client,
      target: target(sessionSummary()),
      draft: processDraft(),
      artifacts: new Map([["shellcode", unexpected]]),
    })).rejects.toBeInstanceOf(ExecutionWorkbenchInputError);
    expect(isZero(unexpected)).toBe(true);

    await expect(dispatchExecutionAction({
      client: fakeClient().client,
      target: target(sessionSummary()),
      draft: assemblyDraft(),
      artifacts: new Map(),
    })).rejects.toThrow(/missing a required artifact/u);
  });
});

describe("execution workbench reads", () => {
  it("normalizes and pages children and privilege inventories", async () => {
    const children = [1, 2, 3].map((pid) => ({
      Pid: pid,
      Path: `/bin/child-${pid}`,
      Args: ["--flag"],
      StartTime: "2026-08-15T12:00:00Z",
      Exited: pid === 3,
      ExitCode: pid === 3 ? 7 : 0,
      ExitTime: pid === 3 ? "2026-08-15T12:01:00Z" : "",
      Stdout: "out",
      Stderr: "err",
      Error: "",
    }));
    const childClient = fakeClient({
      overrides: { executeChildrenSession: async () => ({ Children: children, Response: {} }) },
    });
    const first = await runExecutionRead({
      client: childClient.client,
      target: target(sessionSummary()),
      input: { operationId: "execution.children", limit: 2 },
    });
    expect(first).toMatchObject({
      operationId: "execution.children",
      state: "completed",
      total: 3,
      truncated: true,
      items: [{ pid: 1 }, { pid: 2 }],
    });
    if (first.operationId !== "execution.children" || !first.nextCursor) throw new Error("Expected children cursor");
    const second = await runExecutionRead({
      client: childClient.client,
      target: target(sessionSummary()),
      input: { operationId: "execution.children", limit: 2, cursor: first.nextCursor },
    });
    expect(second).toMatchObject({ total: 3, truncated: false, items: [{ pid: 3, exitCode: 7 }] });
    expect(childClient.calls.map(({ method }) => method)).toEqual([
      "executeChildrenSession",
      "executeChildrenSession",
    ]);

    const privilegeClient = fakeClient({
      overrides: {
        getPrivsSession: async () => ({
          ProcessName: "implant.exe",
          ProcessIntegrity: "High",
          PrivInfo: [{
            Name: "SeDebugPrivilege",
            Description: "Debug programs",
            Enabled: true,
            EnabledByDefault: false,
            Removed: false,
            UsedForAccess: true,
          }],
          Response: {},
        }),
      },
    });
    const privileges = await runExecutionRead({
      client: privilegeClient.client,
      target: target(sessionSummary()),
      input: { operationId: "privilege.get" },
    });
    expect(privileges).toEqual({
      operationId: "privilege.get",
      state: "completed",
      processName: "implant.exe",
      processIntegrity: "High",
      privileges: [{
        name: "SeDebugPrivilege",
        description: "Debug programs",
        enabled: true,
        enabledByDefault: false,
        removed: false,
        usedForAccess: true,
      }],
      total: 1,
      truncated: false,
    });
  });

  it("selects beacon read methods and returns asynchronous task capabilities", async () => {
    for (const operationId of ["execution.children", "privilege.get"] as const) {
      const fake = fakeClient({ beaconTask: true });
      const onDispatch = vi.fn();
      const result = await runExecutionRead({
        client: fake.client,
        target: target(beaconSummary()),
        input: { operationId },
        onDispatch,
      });
      expect(result).toMatchObject({
        operationId,
        state: "submitted",
        taskId: "task-1",
        total: 0,
        truncated: false,
      });
      expect(fake.calls.map(({ method }) => method)).toEqual([
        operationId === "execution.children" ? "executeChildrenBeacon" : "getPrivsBeacon",
      ]);
      expect(onDispatch).toHaveBeenCalledOnce();
    }
  });

  it("never returns a raw read Response.Err", async () => {
    const client = fakeClient({
      overrides: {
        getPrivsSession: async () => ({
          Response: { Err: "credential and raw server path" },
        }),
      },
    });
    const failure = runExecutionRead({
      client: client.client,
      target: target(sessionSummary()),
      input: { operationId: "privilege.get" },
    });
    await expect(failure).rejects.toThrow(EXECUTION_REMOTE_REJECTION_MESSAGE);
    await expect(failure).rejects.not.toThrow(/credential|raw server path/u);
  });
});

interface ActionCase {
  readonly sessionMethod: string;
  readonly beaconMethod?: string;
  readonly draft: () => ExecutionActionDraft;
  readonly artifacts: () => Map<ExecutionArtifactRole, Buffer>;
  readonly implantConfig?: () => clientpb.ImplantConfig;
}

function actionCases(): ActionCase[] {
  const none = (): Map<ExecutionArtifactRole, Buffer> => new Map();
  const one = (role: ExecutionArtifactRole) => (): Map<ExecutionArtifactRole, Buffer> =>
    new Map([[role, Buffer.from(`${role}-bytes`)]]);
  const config = (): clientpb.ImplantConfig => implantConfig("windows", "amd64");
  return [
    { sessionMethod: "executeSession", beaconMethod: "executeBeacon", draft: processDraft, artifacts: none },
    { sessionMethod: "executeAssemblySession", beaconMethod: "executeAssemblyBeacon", draft: assemblyDraft, artifacts: one("assembly") },
    { sessionMethod: "executeShellcodeSession", beaconMethod: "executeShellcodeBeacon", draft: () => shellcodeDraft("amd64"), artifacts: one("shellcode") },
    { sessionMethod: "sideloadSession", beaconMethod: "sideloadBeacon", draft: sideloadDraft, artifacts: one("shared-library") },
    { sessionMethod: "spawnDllSession", beaconMethod: "spawnDllBeacon", draft: spawnDllDraft, artifacts: one("reflective-dll") },
    { sessionMethod: "migrateSession", beaconMethod: "migrateBeacon", draft: migrateDraft, artifacts: none, implantConfig: config },
    { sessionMethod: "msfSession", beaconMethod: "msfBeacon", draft: msfDraft, artifacts: none },
    { sessionMethod: "msfRemoteSession", beaconMethod: "msfRemoteBeacon", draft: msfInjectDraft, artifacts: none },
    { sessionMethod: "psexec", draft: () => psexecDraft({ kind: "profile", profileName: "profile" }), artifacts: none },
    { sessionMethod: "runSshSession", draft: () => sshDraft({ kind: "password", password: secret("password") }), artifacts: none },
    { sessionMethod: "backdoorSession", draft: backdoorDraft, artifacts: none },
    { sessionMethod: "hijackDllSession", draft: dllHijackDraft, artifacts: none },
    { sessionMethod: "runAsSession", beaconMethod: "runAsBeacon", draft: () => runAsDraft(secret("password")), artifacts: none },
    { sessionMethod: "makeTokenSession", beaconMethod: "makeTokenBeacon", draft: () => makeTokenDraft(secret("password")), artifacts: none },
    { sessionMethod: "impersonateSession", beaconMethod: "impersonateBeacon", draft: impersonateDraft, artifacts: none },
    { sessionMethod: "revToSelfSession", beaconMethod: "revToSelfBeacon", draft: revertDraft, artifacts: none },
    { sessionMethod: "getSystemSession", draft: getSystemDraft, artifacts: none, implantConfig: config },
  ];
}

interface FakeClientOptions {
  readonly beaconTask?: boolean;
  readonly overrides?: Readonly<Record<string, (...args: unknown[]) => Promise<unknown>>>;
}

function fakeClient(options: FakeClientOptions = {}): {
  client: ExecutionWorkbenchClient;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const client = new Proxy({}, {
    get(_target, property): unknown {
      if (typeof property !== "string") return undefined;
      return async (...args: unknown[]): Promise<unknown> => {
        calls.push({ method: property, args });
        const override = options.overrides?.[property];
        if (override) return override(...args);
        if (options.beaconTask && property.endsWith("Beacon")) {
          return { Response: { Async: true, TaskID: "task-1" } };
        }
        switch (property) {
          case "executeSession":
          case "executeBeacon":
            return { Pid: 42, Stdout: Buffer.from("stdout"), Stderr: Buffer.from("stderr"), Response: {} };
          case "executeAssemblySession":
          case "executeAssemblyBeacon":
            return { Output: Buffer.from("assembly output"), Response: {} };
          case "sideloadSession":
          case "sideloadBeacon":
          case "spawnDllSession":
          case "spawnDllBeacon":
            return { Result: "payload output", Response: {} };
          case "runSshSession":
            return { StdOut: "ssh output", StdErr: "", Response: {} };
          case "runAsSession":
          case "runAsBeacon":
            return { Output: "run-as output", Response: {} };
          case "migrateSession":
          case "migrateBeacon":
            return { Success: true, Pid: 77, Response: {} };
          case "executeChildrenSession":
          case "executeChildrenBeacon":
            return { Children: [], Response: {} };
          case "getPrivsSession":
          case "getPrivsBeacon":
            return { PrivInfo: [], ProcessName: "", ProcessIntegrity: "", Response: {} };
          default:
            return { Response: {} };
        }
      };
    },
  }) as ExecutionWorkbenchClient;
  return { client, calls };
}

function processDraft(): ExecutionActionDraft {
  return {
    operationId: "execution.process",
    path: "/bin/echo",
    args: ["hello"],
    captureOutput: true,
    background: false,
    inheritEnvironment: true,
    environment: [],
    useToken: false,
    hideWindow: false,
    timeoutSeconds: 60,
  };
}

function assemblyDraft(): Extract<ExecutionActionDraft, { operationId: "execution.assembly" }> {
  return {
    operationId: "execution.assembly",
    args: ["one"],
    process: "notepad.exe",
    isDll: false,
    architecture: "x64",
    processArgs: [],
    inProcess: false,
    amsiBypass: false,
    etwBypass: false,
    timeoutSeconds: 60,
  };
}

function shellcodeDraft(architecture: "386" | "amd64" | "arm64"): ExecutionActionDraft {
  return {
    operationId: "execution.shellcode",
    declaredArchitecture: architecture,
    pid: 0,
    rwxPages: false,
    timeoutSeconds: 60,
  };
}

function sideloadDraft(): ExecutionActionDraft {
  return {
    operationId: "execution.sideload",
    process: "host.exe",
    args: [],
    entryPoint: "entry",
    unicode: false,
    keepAlive: false,
    processArgs: [],
    timeoutSeconds: 60,
  };
}

function spawnDllDraft(): ExecutionActionDraft {
  return {
    operationId: "execution.spawn-dll",
    process: "host.exe",
    args: [],
    entryPoint: "ReflectiveLoader",
    keepAlive: false,
    timeoutSeconds: 60,
  };
}

function migrateDraft(): ExecutionActionDraft {
  return { operationId: "execution.migrate", pid: 4242, encoder: "xor", timeoutSeconds: 60 };
}

function msfDraft(): ExecutionActionDraft {
  return {
    operationId: "execution.msf",
    payload: "meterpreter_reverse_https",
    lhost: "10.0.0.1",
    lport: 4444,
    iterations: 1,
    timeoutSeconds: 60,
  };
}

function msfInjectDraft(): ExecutionActionDraft {
  return {
    operationId: "execution.msf-inject",
    pid: 4242,
    payload: "meterpreter_reverse_https",
    lhost: "10.0.0.1",
    lport: 4444,
    iterations: 1,
    timeoutSeconds: 60,
  };
}

function psexecDraft(source: Extract<ExecutionActionDraft, { operationId: "execution.psexec" }>["source"]): ExecutionActionDraft {
  return {
    operationId: "execution.psexec",
    hostname: "remote-host",
    serviceName: "ServiceName",
    serviceDescription: "Service description",
    remotePath: "C:\\Windows\\Temp",
    source,
    timeoutSeconds: 180,
  };
}

function sshDraft(
  authentication: Extract<ExecutionActionDraft, { operationId: "execution.ssh" }>["authentication"],
): ExecutionActionDraft {
  return {
    operationId: "execution.ssh",
    hostname: "remote-host",
    port: 22,
    username: "operator",
    command: ["id"],
    authentication,
    timeoutSeconds: 60,
  };
}

function backdoorDraft(): ExecutionActionDraft {
  return {
    operationId: "execution.backdoor",
    remotePath: "C:\\Windows\\notepad.exe",
    profileName: "profile",
    name: "backdoored",
    timeoutSeconds: 180,
  };
}

function dllHijackDraft(): ExecutionActionDraft {
  return {
    operationId: "execution.dll-hijack",
    referenceDllPath: "C:\\Windows\\System32\\version.dll",
    targetLocation: "C:\\Windows\\Temp",
    source: { kind: "profile", profileName: "profile" },
    includeReferenceDll: false,
    name: "hijack",
    timeoutSeconds: 180,
  };
}

function runAsDraft(password: Uint8Array): ExecutionActionDraft {
  return {
    operationId: "privilege.run-as",
    username: "operator",
    domain: "DOMAIN",
    password,
    process: "cmd.exe",
    args: "/c whoami",
    showWindow: false,
    netOnly: false,
    timeoutSeconds: 30,
  };
}

function makeTokenDraft(password: Uint8Array): ExecutionActionDraft {
  return {
    operationId: "privilege.make-token",
    username: "operator",
    domain: "DOMAIN",
    password,
    logonType: "new-credentials",
    timeoutSeconds: 60,
  };
}

function impersonateDraft(): ExecutionActionDraft {
  return { operationId: "privilege.impersonate", username: "DOMAIN\\operator", timeoutSeconds: 30 };
}

function revertDraft(): ExecutionActionDraft {
  return { operationId: "privilege.revert", timeoutSeconds: 30 };
}

function getSystemDraft(): ExecutionActionDraft {
  return { operationId: "privilege.get-system", hostingProcess: "spoolsv.exe", timeoutSeconds: 180 };
}

function target(summary: TargetSummary): ExecutionWorkbenchTarget {
  return { id: summary.id, mode: summary.mode, summary };
}

function sessionSummary(): SessionSummary {
  return {
    mode: "session",
    id: "target-1",
    name: "workstation",
    hostname: "host",
    hostId: "host-1",
    username: "operator",
    os: "windows",
    arch: "amd64",
    transport: "mtls",
    remoteAddress: "127.0.0.1:4444",
    activeC2: "mtls://127.0.0.1:4444",
    executable: "implant.exe",
    version: "1",
    locale: "en-US",
    integrity: "High",
    burned: false,
    liveness: "active",
  };
}

function beaconSummary(): BeaconSummary {
  const session = sessionSummary();
  const { liveness: _liveness, ...base } = session;
  return { ...base, mode: "beacon", checkinStatus: "on-time" };
}

function linuxSession(): SessionSummary {
  return { ...sessionSummary(), os: "linux" };
}

function implantConfig(goos: string, goarch: string): clientpb.ImplantConfig {
  return clientpb.ImplantConfig.create({ GOOS: goos, GOARCH: goarch });
}

function secret(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "utf8"));
}

function draftCredentials(draft: ExecutionActionDraft): Uint8Array[] {
  switch (draft.operationId) {
    case "execution.ssh":
      return draft.authentication.kind === "password" ? [draft.authentication.password] : [];
    case "privilege.run-as":
    case "privilege.make-token":
      return [draft.password];
    default:
      return [];
  }
}

function isZero(value: Uint8Array): boolean {
  return value.every((byte) => byte === 0);
}
