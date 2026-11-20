// @vitest-environment node

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

import type { Client, ClientChannel, ConnectConfig } from "ssh2";
import { describe, expect, it } from "vitest";

import { LocalRedirectorDeployer, type LocalRedirectorSshTarget } from "./local-redirector-deployer.js";

const hostKey = Buffer.from("local redirector SSH host key", "utf8");
const fingerprint = `SHA256:${createHash("sha256").update(hostKey).digest("base64").replace(/=+$/u, "")}`;

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  close(): void { /* no pending I/O */ }
}

class FakeSsh extends EventEmitter {
  readonly commands: string[] = [];

  constructor(
    private readonly sockets: string,
    private readonly scriptStdout = "404",
    private readonly scriptStderr = "",
    private readonly scriptExitCode = 0,
    private readonly httpStatus = "404",
  ) { super(); }

  asClient(): Client { return this as unknown as Client; }

  connect(config: ConnectConfig): this {
    queueMicrotask(() => {
      const verified = (config.hostVerifier as (key: Buffer) => boolean)(hostKey);
      this.emit(verified ? "ready" : "error", verified ? undefined : new Error("untrusted host"));
    });
    return this;
  }

  exec(command: string, callback: (error: Error | undefined, channel: ClientChannel) => void): this {
    this.commands.push(command);
    const channel = new FakeChannel();
    queueMicrotask(() => {
      callback(undefined, channel as unknown as ClientChannel);
      queueMicrotask(() => {
        const script = command.includes("'bash' '-c'");
        const output = command.includes("'ss'") ? this.sockets : script ? this.scriptStdout : this.httpStatus;
        channel.emit("data", Buffer.from(output, "utf8"));
        if (script && this.scriptStderr) channel.stderr.emit("data", Buffer.from(this.scriptStderr, "utf8"));
        channel.emit("exit", script ? this.scriptExitCode : 0);
        channel.emit("close");
      });
    });
    return this;
  }

  end(): this { return this; }
  destroy(): this { return this; }
}

function ssh(hostKeySha256 = fingerprint): LocalRedirectorSshTarget {
  return { host: "example.org", username: "ubuntu", privateKey: "test key", hostKeySha256 };
}

describe("LocalRedirectorDeployer SSH guard", () => {
  it("confirms an HTTP listener bound only to the server private IP", async () => {
    const fake = new FakeSsh('LISTEN 0 4096 10.0.1.8:8443 0.0.0.0:* users:(("sliver-server",pid=41,fd=12))\n');
    const deployer = new LocalRedirectorDeployer({ createSshClient: () => fake.asClient(), connectTimeoutMs: 100, commandTimeoutMs: 100 });
    expect(await deployer.probePrivateHttpListener({ ssh: ssh(), privateIp: "10.0.1.8", port: 8443 })).toBe(404);
    expect(fake.commands[1]).toContain("http://10.0.1.8:8443/");
  });

  it("rejects a private HTTP listener with an additional public binding", async () => {
    const fake = new FakeSsh('LISTEN 0 4096 10.0.1.8:8443 0.0.0.0:* users:(("sliver-server",pid=41,fd=12))\nLISTEN 0 4096 0.0.0.0:8443 0.0.0.0:* users:(("sliver-server",pid=41,fd=13))\n');
    const deployer = new LocalRedirectorDeployer({ createSshClient: () => fake.asClient(), connectTimeoutMs: 100, commandTimeoutMs: 100 });
    expect(await deployer.probePrivateHttpListener({ ssh: ssh(), privateIp: "10.0.1.8", port: 8443 })).toBeNull();
    expect(fake.commands).toHaveLength(1);
  });

  it("accepts an existing Sliver HTTP listener on the private IP or IPv4 wildcard without changing the strict managed probe", async () => {
    const privateSocket = new FakeSsh('LISTEN 0 4096 10.0.1.8:8443 0.0.0.0:* users:(("sliver-server",pid=41,fd=12))\n');
    const privateProbe = new LocalRedirectorDeployer({ createSshClient: () => privateSocket.asClient(), connectTimeoutMs: 100, commandTimeoutMs: 100 });
    expect(await privateProbe.probeExistingPrivateHttpListener({ ssh: ssh(), privateIp: "10.0.1.8", port: 8443 })).toBe(404);

    const wildcardSocket = new FakeSsh('LISTEN 0 4096 0.0.0.0:8443 0.0.0.0:* users:(("sliver-server",pid=41,fd=12))\n');
    const wildcardProbe = new LocalRedirectorDeployer({ createSshClient: () => wildcardSocket.asClient(), connectTimeoutMs: 100, commandTimeoutMs: 100 });
    expect(await wildcardProbe.probeExistingPrivateHttpListener({ ssh: ssh(), privateIp: "10.0.1.8", port: 8443 })).toBe(404);
    expect(wildcardSocket.commands[1]).toContain("http://10.0.1.8:8443/");
    expect(await wildcardProbe.probePrivateHttpListener({ ssh: ssh(), privateIp: "10.0.1.8", port: 8443 })).toBeNull();
    expect(wildcardSocket.commands).toHaveLength(3);
  });

  it("recognizes the existing Sliver listener reported by ss as *:80 and probes its private address", async () => {
    const fake = new FakeSsh('LISTEN 0 4096 *:80 *:* users:(("sliver-server",pid=2478,fd=19))\n');
    const deployer = new LocalRedirectorDeployer({ createSshClient: () => fake.asClient(), connectTimeoutMs: 100, commandTimeoutMs: 100 });
    const input = { ssh: ssh(), privateIp: "172.31.4.96", port: 80 };
    expect(await deployer.probeExistingPrivateHttpListener(input)).toBe(404);
    expect(fake.commands[1]).toContain("http://172.31.4.96:80/");
    expect(await deployer.probePrivateHttpListener(input)).toBeNull();
    expect(fake.commands).toHaveLength(3);
  });

  it("rejects loopback, duplicate, non-Sliver, and unhealthy existing HTTP bindings", async () => {
    const input = { ssh: ssh(), privateIp: "10.0.1.8", port: 8443 };
    for (const sockets of [
      'LISTEN 0 4096 127.0.0.1:8443 0.0.0.0:* users:(("sliver-server",pid=41,fd=12))\n',
      'LISTEN 0 4096 0.0.0.0:8443 0.0.0.0:* users:(("other",pid=41,fd=12))\n',
      'LISTEN 0 4096 10.0.1.8:8443 0.0.0.0:* users:(("sliver-server",pid=41,fd=12))\nLISTEN 0 4096 [::]:8443 [::]:* users:(("sliver-server",pid=41,fd=13))\n',
    ]) {
      const fake = new FakeSsh(sockets);
      const deployer = new LocalRedirectorDeployer({ createSshClient: () => fake.asClient(), connectTimeoutMs: 100, commandTimeoutMs: 100 });
      expect(await deployer.probeExistingPrivateHttpListener(input)).toBeNull();
      expect(fake.commands).toHaveLength(1);
    }
    const unhealthy = new FakeSsh('LISTEN 0 4096 0.0.0.0:8443 0.0.0.0:* users:(("sliver-server",pid=41,fd=12))\n', "", "", 0, "503");
    const deployer = new LocalRedirectorDeployer({ createSshClient: () => unhealthy.asClient(), connectTimeoutMs: 100, commandTimeoutMs: 100 });
    expect(await deployer.probeExistingPrivateHttpListener(input)).toBeNull();
    await expect(deployer.probeExistingPrivateHttpListener({ ...input, ssh: ssh(`SHA256:${"A".repeat(43)}`) }))
      .rejects.toMatchObject({ code: "host-key-mismatch" });
  });

  it("accepts only a Sliver-owned IPv4 loopback socket with an HTTP response", async () => {
    const fake = new FakeSsh('LISTEN 0 4096 127.0.0.1:8000 0.0.0.0:* users:(("sliver-server",pid=41,fd=12))\n');
    const deployer = new LocalRedirectorDeployer({ createSshClient: () => fake.asClient(), connectTimeoutMs: 100, commandTimeoutMs: 100 });
    expect(await deployer.probeLoopbackListener({ ssh: ssh(), kind: "http", port: 8000 })).toBe(true);
    expect(fake.commands).toHaveLength(2);
    expect(fake.commands[0]).toContain("'sudo' '-n' 'ss' '-H' '-ltnp'");
  });

  it("rejects a second wildcard binding even when loopback is present", async () => {
    const fake = new FakeSsh('LISTEN 0 4096 127.0.0.1:8000 0.0.0.0:* users:(("sliver-server",pid=41,fd=12))\nLISTEN 0 4096 0.0.0.0:8000 0.0.0.0:* users:(("other",pid=42,fd=13))\n');
    const deployer = new LocalRedirectorDeployer({ createSshClient: () => fake.asClient(), connectTimeoutMs: 100, commandTimeoutMs: 100 });
    expect(await deployer.probeLoopbackListener({ ssh: ssh(), kind: "http", port: 8000 })).toBe(false);
    expect(fake.commands).toHaveLength(1);
  });

  it("rejects an unrelated process and an untrusted SSH host key", async () => {
    const fake = new FakeSsh('LISTEN 0 4096 127.0.0.1:8000 0.0.0.0:* users:(("other",pid=42,fd=13))\n');
    const deployer = new LocalRedirectorDeployer({ createSshClient: () => fake.asClient(), connectTimeoutMs: 100, commandTimeoutMs: 100 });
    expect(await deployer.probeLoopbackListener({ ssh: ssh(), kind: "http", port: 8000 })).toBe(false);
    await expect(deployer.probeLoopbackListener({ ssh: ssh(`SHA256:${"A".repeat(43)}`), kind: "http", port: 8000 }))
      .rejects.toMatchObject({ code: "host-key-mismatch" });
  });

  it("streams bounded installation stdout and stderr without exposing the remote command", async () => {
    const fake = new FakeSsh(
      'LISTEN 0 4096 127.0.0.1:8000 0.0.0.0:* users:(("sliver-server",pid=41,fd=12))\n',
      "x".repeat(20 * 1024),
      "installation warning\n",
    );
    const deployer = new LocalRedirectorDeployer({ createSshClient: () => fake.asClient(), connectTimeoutMs: 100, commandTimeoutMs: 100 });
    const input = {
      ssh: ssh(), installationId: "44444444-4444-4444-8444-444444444444", recipeId: "caddy" as const,
      domains: [], publicIp: "203.0.113.20", backendKind: "http" as const, backendPort: 8000,
      serviceName: "sliver-gui-caddy-44444444-4444-4444-8444-444444444444.service",
    };
    const output: Array<{ stream: string; chunk: Uint8Array }> = [];

    await expect(deployer.install(input, (event) => output.push(event))).resolves.toMatchObject({
      publicUrl: "http://203.0.113.20", frontendPorts: [80],
    });
    expect(output.map(({ stream }) => stream)).toEqual(["stdout", "stdout", "stderr"]);
    expect(output.every(({ chunk }) => chunk.byteLength <= 16 * 1024)).toBe(true);
    expect(Buffer.concat(output.filter(({ stream }) => stream === "stdout").map(({ chunk }) => Buffer.from(chunk))).toString("utf8"))
      .toBe("x".repeat(20 * 1024));
    expect(Buffer.from(output[2]?.chunk ?? []).toString("utf8")).toBe("installation warning\n");
    expect(output.map(({ chunk }) => Buffer.from(chunk).toString("utf8")).join(""))
      .not.toContain("privateKey");
    await expect(deployer.verify(input, () => { throw new Error("UI closed"); })).resolves.toBe(true);
  });

  it("delivers stderr before a remote installation failure", async () => {
    const fake = new FakeSsh(
      'LISTEN 0 4096 127.0.0.1:8000 0.0.0.0:* users:(("sliver-server",pid=41,fd=12))\n',
      "", "package installation failed\n", 1,
    );
    const deployer = new LocalRedirectorDeployer({ createSshClient: () => fake.asClient(), connectTimeoutMs: 100, commandTimeoutMs: 100 });
    const output: string[] = [];
    await expect(deployer.install({
      ssh: ssh(), installationId: "44444444-4444-4444-8444-444444444444", recipeId: "nginx",
      domains: [], publicIp: "203.0.113.20", backendKind: "http", backendPort: 8000,
      serviceName: "sliver-gui-nginx-44444444-4444-4444-8444-444444444444.service",
    }, ({ chunk }) => output.push(Buffer.from(chunk).toString("utf8"))))
      .rejects.toMatchObject({ code: "remote-command-failed" });
    expect(output).toEqual(["package installation failed\n"]);
  });
});
