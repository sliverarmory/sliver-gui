// @vitest-environment node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Client, ClientChannel, ConnectConfig, SFTPWrapper, Stats } from "ssh2";
import { describe, expect, it, vi } from "vitest";

import {
  SliverOperatorCreationError,
  SliverProvisionError,
  SliverProvisioner,
  type SliverProvisionOutputEvent,
} from "./sliver-provisioner.js";

const deploymentId = "8e577480-5dc2-4dde-aa58-23c8f1770627";
const deploymentRoot = `/var/lib/sliver-gui/${deploymentId}`;
const binaryPath = `/opt/sliver-gui/${deploymentId}/sliver-server`;
const serviceName = `sliver-gui-${deploymentId}.service`;
const servicePath = `/etc/systemd/system/${serviceName}`;
const operatorConfigPath = `${deploymentRoot}/operator-export/operator.cfg`;
const managedSwapPath = `${deploymentRoot}/managed.swap`;
const hostKey = Buffer.from("test host public key bytes", "utf8");
const hostKeySha256 = `SHA256:${createHash("sha256").update(hostKey).digest("base64").replace(/=+$/u, "")}`;
const officialInstallerSha256 = "19e7ebfdff1b06177d65587b78aba16db4043f1f780a510d4cba4646d2444096";
const minisignArchiveSha256 = "9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73";
const minisignAmd64Sha256 = "2c74dffcc1c9a5ee55957c60971998ace2b89f22585631594ec2152c588af8db";
const minisignArm64Sha256 = "cec9f88be8c975af76854a53b4d49c3d257feae38d916edb0d16fb55aacd3000";
const minisignBinaryPath = "/usr/local/bin/minisign";
const officialServerPath = "/root/sliver-server";
const installedServer = Buffer.from("officially installed sliver server", "utf8");
const installedServerSha256 = createHash("sha256").update(installedServer).digest("hex");

describe("SliverProvisioner", () => {
  it("pins SSH, runs the verified official installer, and preserves isolated direct-mTLS provisioning", async () => {
    const ssh = new FakeSshHost();
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: vi.fn()
        .mockReturnValueOnce("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        .mockReturnValueOnce("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        .mockReturnValueOnce("cccccccccccccccccccccccccccccccc"),
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const result = await provisioner.provision(provisionInput(hostKeySha256));

    expect(result).toMatchObject({
      deploymentId,
      hostKeySha256,
      architecture: "amd64",
      version: "v1.7.7",
      serverSha256: installedServerSha256,
      serviceName,
      remoteBinaryPath: binaryPath,
    });
    expect(JSON.parse(result.operatorConfig.toString("utf8"))).toMatchObject({
      operator: "cloudoperator",
      lhost: "server.example.test",
      lport: 31_337,
    });
    expect(result.operatorConfigSha256).toBe(createHash("sha256").update(result.operatorConfig).digest("hex"));
    expect(ssh.files.get(binaryPath)?.data).toEqual(installedServer);

    const unit = ssh.files.get(servicePath)?.data.toString("utf8");
    expect(unit).toContain(`Environment=SLIVER_ROOT_DIR=${deploymentRoot}/server`);
    expect(unit).toContain(`Environment=SLIVER_CLIENT_ROOT_DIR=${deploymentRoot}/client-runtime`);
    expect(unit).toContain(`ExecStart=${binaryPath} daemon --lhost 0.0.0.0 --lport 31337`);
    expect(ssh.commands.some((value) => value.includes("'operator'") && value.includes("'--permissions' 'all'"))).toBe(true);
    expect(ssh.commands.some((value) => value.includes("'sudo' '-n' 'sha256sum'") && value.includes(binaryPath))).toBe(true);
    const curl = ssh.commands.find((value) => value.includes("'curl'"));
    expect(curl).toContain("'--proto' '=https'");
    expect(curl).toContain("'--proto-redir' '=https'");
    expect(curl).toContain("'https://sliver.sh/install'");
    expect(curl).not.toContain("|");
    const installerIndex = ssh.commands.findIndex((value) => value.includes("'bash'") && value.includes(".official-installer-"));
    const stopStockIndex = ssh.commands.findIndex((value) => value.includes("'systemctl' 'stop' 'sliver.service'"));
    const copyIndex = ssh.commands.findIndex((value) => value.includes(officialServerPath) && value.includes(binaryPath));
    expect(installerIndex).toBeGreaterThan(-1);
    expect(stopStockIndex).toBeGreaterThan(installerIndex);
    expect(copyIndex).toBeGreaterThan(stopStockIndex);
    expect(ssh.commands.some((value) => value.includes("'systemctl' 'disable' 'sliver.service'"))).toBe(true);
    expect(ssh.commands.some((value) =>
      value.includes("'install' '-d' '-m' '0700' '-o' 'root' '-g' 'root'") &&
      value.includes(`${deploymentRoot}/operator-export`)
    )).toBe(true);
    expect((ssh.files.get(operatorConfigPath)?.mode ?? 0) & 0o777).toBe(0o600);
    expect(ssh.files.get(operatorConfigPath)?.uid).toBe(0);
    const handoffInstall = ssh.commands.find((value) =>
      value.includes(operatorConfigPath) && value.includes(".operator.cfg") && value.includes("'install'")
    );
    expect(handoffInstall).toContain("'install' '-m' '0600' '-o' '1000' '-g' '1000'");
    expect(ssh.commands.some((value) =>
      value.includes("'sudo' '-n' 'sha256sum'") && value.includes(operatorConfigPath)
    )).toBe(true);
    expect(ssh.commands.some((value) => value.includes("command -v minisign"))).toBe(true);
    expect(ssh.commands.some((value) => value.includes("minisign-0.12-linux.tar.gz"))).toBe(false);
    const cloudInitIndex = ssh.commands.findIndex((value) => value.includes("'cloud-init' 'status' '--wait'"));
    const curlIndex = ssh.commands.findIndex((value) => value.includes("'curl'"));
    expect(cloudInitIndex).toBeGreaterThan(-1);
    expect(curlIndex).toBeGreaterThan(cloudInitIndex);
    expect(ssh.sftpReadPaths).toHaveLength(1);
    expect(ssh.sftpReadPaths[0]).toMatch(/^\/tmp\/\.sliver-gui-.*\.operator\.cfg$/u);
    expect(ssh.sftpReadPaths).not.toContain(operatorConfigPath);
    expect([...ssh.files.keys()].filter((path) => path.startsWith("/tmp/"))).toEqual([]);
    expect([...ssh.files.keys()].some((path) => path.includes(".official-installer-"))).toBe(false);
    expect(ssh.ended).toBe(true);
    expect(ssh.sftpEnded).toBe(true);

    result.operatorConfig.fill(0);
  });

  it("streams official installer stdout while suppressing operator command output", async () => {
    const ssh = new FakeSshHost({
      installerStdout: "Installing Sliver from the official release\n",
      operatorStdout: "private-key-material\n",
    });
    const events: SliverProvisionOutputEvent[] = [];
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: vi.fn()
        .mockReturnValueOnce("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        .mockReturnValueOnce("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        .mockReturnValueOnce("cccccccccccccccccccccccccccccccc"),
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const result = await provisioner.provision({
      ...provisionInput(hostKeySha256),
      onOutput: (event) => events.push(event),
    });

    expect(events[0]).toEqual({ type: "stage", label: "Connecting to the deployment host" });
    const operatingSystemStage = events.findIndex((event) =>
      event.type === "stage" && event.label === "checking the remote operating system"
    );
    expect(operatingSystemStage).toBeGreaterThan(0);
    expect(events[operatingSystemStage + 1]).toMatchObject({ type: "stdout" });
    expect(Buffer.from((events[operatingSystemStage + 1] as { readonly chunk: Uint8Array }).chunk).toString("utf8"))
      .toBe("Linux");

    const stages = events
      .filter((event): event is Extract<SliverProvisionOutputEvent, { readonly type: "stage" }> => event.type === "stage")
      .map((event) => event.label);
    const stdout = Buffer.concat(events
      .filter((event): event is Extract<SliverProvisionOutputEvent, { readonly type: "stdout" }> => event.type === "stdout")
      .map((event) => Buffer.from(event.chunk)))
      .toString("utf8");

    expect(stages).toContain("generating the Sliver operator configuration");
    expect(stages.at(-1)).toBe("Sliver server provisioning complete");
    expect(stdout).toContain("Linux");
    expect(stdout).toContain("x86_64");
    expect(stdout).toContain("Installing Sliver from the official release");
    expect(stdout).toContain("active\n");
    expect(stdout).not.toContain("private-key-material");
    expect(JSON.stringify(stages)).not.toContain("192.0.2.10");
    expect(JSON.stringify(stages)).not.toContain("private SSH key that must not leak");

    result.operatorConfig.fill(0);
  });

  it("returns an observed host key mismatch without downloading or retrying", async () => {
    const ssh = new FakeSshHost();
    const createSshClient = vi.fn(() => ssh.asClient());
    const provisioner = new SliverProvisioner({
      createSshClient,
      wait: async () => undefined,
      connectTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.provision(provisionInput("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")));

    expect(failure).toBeInstanceOf(SliverProvisionError);
    expect(failure).toMatchObject({ code: "host-key-mismatch", hostKeySha256 });
    expect(createSshClient).toHaveBeenCalledOnce();
    expect(ssh.commands).toEqual([]);
    expect(ssh.sftpCalls).toBe(0);
  });

  it("skips the cloud-init wait when cloud-init is absent", async () => {
    const ssh = new FakeSshHost({ cloudInitPresent: false });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const result = await provisioner.provision(provisionInput(hostKeySha256));

    expect(ssh.commands.some((value) => value.includes("command -v cloud-init"))).toBe(true);
    expect(ssh.commands.some((value) => value.includes("'cloud-init' 'status' '--wait'"))).toBe(false);
    expect(ssh.commands.some((value) => value.includes("'curl'"))).toBe(true);
    result.operatorConfig.fill(0);
  });

  it("creates, activates, and persists enough private managed swap before installing on a low-memory host", async () => {
    const ssh = new FakeSshHost({ physicalMemoryKiB: 1024 * 1024 });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const result = await provisioner.provision(provisionInput(hostKeySha256));

    const memoryIndex = ssh.commands.findIndex((value) => value.includes("'/proc/meminfo'"));
    const allocationCommand = ssh.commands.find((value) => value.includes("'dd'") && value.includes("'count=2112'"));
    const allocationIndex = ssh.commands.indexOf(allocationCommand ?? "");
    const formatIndex = ssh.commands.findIndex((value) => value.includes("'mkswap'") && value.includes(".managed-swap-"));
    const activationIndex = ssh.commands.findIndex((value) => value.includes("'swapon'") && value.includes(managedSwapPath));
    const installerIndex = ssh.commands.findIndex((value) => value.includes("'bash'") && value.includes(".official-installer-"));
    expect(memoryIndex).toBeGreaterThan(-1);
    expect(allocationIndex).toBeGreaterThan(memoryIndex);
    const allocationArgs = quotedArguments(allocationCommand ?? "");
    const timeoutIndex = allocationArgs.indexOf("timeout");
    const killAfterSeconds = Number(allocationArgs[timeoutIndex + 2]?.replace(/^--kill-after=|s$/gu, ""));
    const remoteDeadlineSeconds = Number(allocationArgs[timeoutIndex + 3]?.replace(/s$/u, ""));
    expect(timeoutIndex).toBeGreaterThan(-1);
    expect((killAfterSeconds + remoteDeadlineSeconds) * 1_000).toBeLessThan(100);
    expect(formatIndex).toBeGreaterThan(allocationIndex);
    expect(activationIndex).toBeGreaterThan(formatIndex);
    expect(installerIndex).toBeGreaterThan(activationIndex);
    expect(ssh.swapFileSizes.get(managedSwapPath)).toBe(2112 * 1024 * 1024);
    expect(ssh.activeSwapPaths.has(managedSwapPath)).toBe(true);
    expect(ssh.files.get(managedSwapPath)).toMatchObject({ uid: 0, gid: 0 });
    expect((ssh.files.get(managedSwapPath)?.mode ?? 0) & 0o777).toBe(0o600);
    expect(ssh.fstabSwapPaths.has(managedSwapPath)).toBe(true);
    expect(ssh.fstabAppendCount).toBe(1);
    expect([...ssh.files.keys()].some((path) => path.includes(".managed-swap-") && path.endsWith(".tmp"))).toBe(false);

    if (process.platform !== "win32") {
      const persistenceCommand = ssh.commands.find((value) => value.includes("'sliver-gui-managed-swap'"));
      expect(persistenceCommand).toBeDefined();
      const decoded = spawnSync(
        "sh",
        ["-c", `set -- ${persistenceCommand ?? ""}; printf '%s\\0' "$@"`],
        { encoding: "buffer" },
      );
      expect(decoded.status, decoded.stderr.toString("utf8")).toBe(0);
      const decodedArguments = decoded.stdout.subarray(0, -1).toString("utf8").split("\0");
      expect(decodedArguments.slice(0, 4)).toEqual(["sudo", "-n", "sh", "-c"]);
      expect(decodedArguments.slice(5)).toEqual(["sliver-gui-managed-swap", managedSwapPath, "/etc/fstab"]);

      const persistenceScript = decodedArguments[4] ?? "";
      const syntax = spawnSync("sh", ["-n", "-c", persistenceScript], { encoding: "utf8" });
      expect(syntax.status, syntax.stderr).toBe(0);

      const temporaryRoot = mkdtempSync(join(tmpdir(), "sliver-fstab-test-"));
      const temporaryFstab = join(temporaryRoot, "fstab");
      try {
        writeFileSync(temporaryFstab, "LABEL=cloudimg-rootfs / ext4 defaults 0 1", { mode: 0o600 });
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const executed = spawnSync(
            "sh",
            ["-c", persistenceScript, "sliver-gui-managed-swap", managedSwapPath, temporaryFstab],
            { encoding: "utf8" },
          );
          expect(executed.status, executed.stderr).toBe(0);
        }
        expect(readFileSync(temporaryFstab, "utf8").split("\n").filter((line) => line.startsWith(managedSwapPath)))
          .toEqual([`${managedSwapPath} none swap sw,nofail 0 0`]);

        for (const conflictingEntries of [
          `${managedSwapPath} none swap defaults 0 0\n`,
          `${managedSwapPath} none swap sw,nofail 0 0\n${managedSwapPath} none swap sw,nofail 0 0\n`,
          `${managedSwapPath} none swap sw,nofail 0 0 # unexpected\n`,
        ]) {
          writeFileSync(temporaryFstab, conflictingEntries);
          const before = readFileSync(temporaryFstab);
          const rejected = spawnSync(
            "sh",
            ["-c", persistenceScript, "sliver-gui-managed-swap", managedSwapPath, temporaryFstab],
            { encoding: "utf8" },
          );
          expect(rejected.status, rejected.stderr).toBe(65);
          expect(readFileSync(temporaryFstab)).toEqual(before);
        }
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    }
    result.operatorConfig.fill(0);
  });

  it("adds swap for a high-capacity host when MemAvailable plus SwapFree is under pressure", async () => {
    const ssh = new FakeSshHost({
      physicalMemoryKiB: 4 * 1024 * 1024,
      availableMemoryKiB: 1024 * 1024,
    });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const result = await provisioner.provision(provisionInput(hostKeySha256));

    expect(ssh.swapFileSizes.get(managedSwapPath)).toBe(2112 * 1024 * 1024);
    expect(ssh.activeSwapPaths.has(managedSwapPath)).toBe(true);
    result.operatorConfig.fill(0);
  });

  it("does not create managed swap when physical memory already meets the installer target", async () => {
    const ssh = new FakeSshHost({ physicalMemoryKiB: 4 * 1024 * 1024 });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const result = await provisioner.provision(provisionInput(hostKeySha256));

    expect(ssh.commands.some((value) => value.includes("'dd'"))).toBe(false);
    expect(ssh.commands.some((value) => value.includes("'mkswap'"))).toBe(false);
    expect(ssh.commands.some((value) => value.includes("'swapon'"))).toBe(false);
    expect(ssh.fstabSwapPaths.size).toBe(0);
    result.operatorConfig.fill(0);
  });

  it("reuses an active managed swap file without duplicating its persistent entry", async () => {
    const ssh = new FakeSshHost({
      physicalMemoryKiB: 1024 * 1024,
      activeSwapKiB: 2 * 1024 * 1024,
      activeSwapPaths: [managedSwapPath],
      fstabSwapPaths: [managedSwapPath],
    });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const result = await provisioner.provision(provisionInput(hostKeySha256));

    expect(ssh.commands.some((value) => value.includes("'dd'"))).toBe(false);
    expect(ssh.commands.some((value) => value.includes("'mkswap'"))).toBe(false);
    expect(ssh.commands.some((value) => value.includes("'swapon'"))).toBe(false);
    expect(ssh.commands.some((value) => value.includes("sliver-gui-managed-swap"))).toBe(true);
    expect(ssh.fstabSwapPaths).toEqual(new Set([managedSwapPath]));
    expect(ssh.fstabAppendCount).toBe(0);
    result.operatorConfig.fill(0);
  });

  it("repairs missing persistence for an already-active managed swap without reallocating it", async () => {
    const ssh = new FakeSshHost({
      physicalMemoryKiB: 1024 * 1024,
      activeSwapKiB: 2 * 1024 * 1024,
      activeSwapPaths: [managedSwapPath],
    });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const result = await provisioner.provision(provisionInput(hostKeySha256));

    expect(ssh.commands.some((value) => value.includes("'dd'"))).toBe(false);
    expect(ssh.fstabSwapPaths.has(managedSwapPath)).toBe(true);
    expect(ssh.fstabAppendCount).toBe(1);
    result.operatorConfig.fill(0);
  });

  it.each([
    ["non-private permissions", { activeManagedSwapMode: 0o644 }],
    ["a size inconsistent with /proc/swaps", { activeManagedSwapFileSizeBytes: 2 * 1024 * 1024 * 1024 + 8192 }],
  ] as const)("rejects an active managed swap file with %s", async (_label, invalidFile) => {
    const ssh = new FakeSshHost({
      physicalMemoryKiB: 1024 * 1024,
      activeSwapKiB: 2 * 1024 * 1024,
      activeSwapPaths: [managedSwapPath],
      ...invalidFile,
    });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(failure).toMatchObject({ code: "remote-command-failed", hostKeySha256 });
    expect(ssh.fstabSwapPaths.has(managedSwapPath)).toBe(false);
    expect(ssh.commands.some((value) => value.includes("'bash'") && value.includes(".official-installer-"))).toBe(false);
  });

  it("fails before allocation when disk space cannot hold swap plus the Sliver installation reserve", async () => {
    const ssh = new FakeSshHost({
      physicalMemoryKiB: 1024 * 1024,
      availableDiskBytes: 5 * 1024 * 1024 * 1024,
    });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(failure).toMatchObject({ code: "remote-command-failed", hostKeySha256 });
    expect(failure.message).toContain("enough free disk space");
    expect(ssh.commands.some((value) => value.includes("'dd'"))).toBe(false);
    expect(ssh.commands.some((value) => value.includes("'bash'") && value.includes(".official-installer-"))).toBe(false);
  });

  it("rejects a conflicting persistent record for an active managed swap", async () => {
    const ssh = new FakeSshHost({
      physicalMemoryKiB: 1024 * 1024,
      activeSwapKiB: 2 * 1024 * 1024,
      activeSwapPaths: [managedSwapPath],
      invalidFstabSwapPaths: [managedSwapPath],
    });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(failure).toMatchObject({ code: "remote-command-failed", hostKeySha256 });
    expect(failure.message).toContain("persisting managed swap across reboots");
    expect(ssh.commands.some((value) => value.includes("'bash'") && value.includes(".official-installer-"))).toBe(false);
  });

  it("cleans up a partial managed swap allocation and does not run the installer after failure", async () => {
    const ssh = new FakeSshHost({
      physicalMemoryKiB: 1024 * 1024,
      failSwapCommand: "dd",
    });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(failure).toMatchObject({ code: "remote-command-failed", hostKeySha256 });
    expect(failure.message).toContain("allocating managed swap space");
    expect(ssh.commands.some((value) => value.includes("'bash'") && value.includes(".official-installer-"))).toBe(false);
    expect(ssh.fstabSwapPaths.has(managedSwapPath)).toBe(false);
    expect([...ssh.files.keys()].some((path) => path.includes(".managed-swap-"))).toBe(false);
  });

  it("requires the newly-created swap file to match the requested allocation exactly", async () => {
    const ssh = new FakeSshHost({
      physicalMemoryKiB: 1024 * 1024,
      allocatedSwapSizeDeltaBytes: 1,
    });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(failure.message).toContain("did not match its allocation");
    expect(ssh.commands.some((value) => value.includes("'swapon'"))).toBe(false);
    expect(ssh.files.has(managedSwapPath)).toBe(false);
  });

  it("removes the final swap file after swapon fails and /proc/swaps conclusively reports it inactive", async () => {
    const ssh = new FakeSshHost({ physicalMemoryKiB: 1024 * 1024, failSwapCommand: "swapon" });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(failure).toMatchObject({ code: "remote-command-failed", hostKeySha256 });
    expect(failure.message).toContain("activating managed swap space");
    expect(ssh.activeSwapPaths.has(managedSwapPath)).toBe(false);
    expect(ssh.files.has(managedSwapPath)).toBe(false);
    expect(ssh.commands.filter((value) => value.includes("'/proc/swaps'")).length).toBe(2);
  });

  it("preserves a managed swap file when swapon reports failure after activating it", async () => {
    const ssh = new FakeSshHost({
      physicalMemoryKiB: 1024 * 1024,
      failSwapCommand: "swapon",
      swaponFailureActivates: true,
    });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(ssh.activeSwapPaths.has(managedSwapPath)).toBe(true);
    expect(ssh.files.has(managedSwapPath)).toBe(true);
  });

  it("preserves a managed swap file when its state is ambiguous after swapon failure", async () => {
    const ssh = new FakeSshHost({
      physicalMemoryKiB: 1024 * 1024,
      failSwapCommand: "swapon",
      invalidSwapReportAfterSwaponFailure: true,
    });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(ssh.activeSwapPaths.has(managedSwapPath)).toBe(false);
    expect(ssh.files.has(managedSwapPath)).toBe(true);
  });

  it("cleans up when swapon exits successfully but a valid kernel report omits the file", async () => {
    const ssh = new FakeSshHost({
      physicalMemoryKiB: 1024 * 1024,
      swaponSucceedsWithoutActivation: true,
    });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(failure.message).toContain("did not become active");
    expect(ssh.files.has(managedSwapPath)).toBe(false);
    expect(ssh.commands.some((value) => value.includes("'bash'") && value.includes(".official-installer-"))).toBe(false);
  });

  it("bootstraps the pinned amd64 minisign binary only when it is absent", async () => {
    const ssh = new FakeSshHost({ minisignPresent: false });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const result = await provisioner.provision(provisionInput(hostKeySha256));

    const bootstrapCurl = ssh.commands.find((value) => value.includes("minisign-0.12-linux.tar.gz"));
    expect(bootstrapCurl).toContain("'--proto' '=https'");
    expect(bootstrapCurl).toContain("'--proto-redir' '=https'");
    const extraction = ssh.commands.find((value) => value.includes("'tar' '--extract'"));
    expect(extraction).toContain("'--strip-components=2' '--' 'minisign-linux/x86_64/minisign'");
    expect(extraction).not.toContain("*");
    expect(ssh.commands.some((value) =>
      value.includes("'sha256sum'") && value.includes(".minisign-bootstrap-") && value.includes("/minisign")
    )).toBe(true);
    expect(ssh.files.get(minisignBinaryPath)).toMatchObject({ uid: 0, gid: 0 });
    expect((ssh.files.get(minisignBinaryPath)?.mode ?? 0) & 0o777).toBe(0o755);
    expect([...ssh.files.keys()].some((path) => path.includes(".minisign-bootstrap-"))).toBe(false);
    result.operatorConfig.fill(0);
  });

  it("selects only the pinned aarch64 minisign member for an arm64 host", async () => {
    const ssh = new FakeSshHost({ architecture: "aarch64", minisignPresent: false });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const result = await provisioner.provision(provisionInput(hostKeySha256));

    const extraction = ssh.commands.find((value) => value.includes("'tar' '--extract'"));
    expect(extraction).toContain("'minisign-linux/aarch64/minisign'");
    expect(extraction).not.toContain("'minisign-linux/x86_64/minisign'");
    expect(ssh.commands.some((value) => value.includes(minisignBinaryPath))).toBe(true);
    result.operatorConfig.fill(0);
  });

  it("does not extract or install minisign when the archive hash is wrong", async () => {
    const ssh = new FakeSshHost({ minisignPresent: false, minisignArchiveDigest: "0".repeat(64) });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      transferTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(failure).toMatchObject({ code: "official-installer-failed", hostKeySha256 });
    expect(failure.message).toContain("minisign archive failed its SHA-256 check");
    expect(ssh.commands.some((value) => value.includes("'tar' '--extract'"))).toBe(false);
    expect(ssh.commands.some((value) => value.includes(".official-installer-"))).toBe(false);
    expect(ssh.files.has(minisignBinaryPath)).toBe(false);
    expect([...ssh.files.keys()].some((path) => path.includes(".minisign-bootstrap-"))).toBe(false);
  });

  it("does not install or run an unverified minisign binary", async () => {
    const ssh = new FakeSshHost({ minisignPresent: false, minisignBinaryDigest: "0".repeat(64) });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      transferTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(failure).toMatchObject({ code: "official-installer-failed", hostKeySha256 });
    expect(failure.message).toContain("minisign binary failed its SHA-256 check");
    expect(ssh.files.has(minisignBinaryPath)).toBe(false);
    expect(ssh.commands.some((value) => value.includes(".official-installer-"))).toBe(false);
    expect([...ssh.files.keys()].some((path) => path.includes(".minisign-bootstrap-"))).toBe(false);
  });

  it("rejects a linked minisign archive member before hashing or installation", async () => {
    const ssh = new FakeSshHost({ minisignPresent: false, minisignBinaryType: "symlink" });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      transferTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(failure).toMatchObject({ code: "official-installer-failed", hostKeySha256 });
    expect(failure.message).toContain("expected regular binary");
    expect(ssh.files.has(minisignBinaryPath)).toBe(false);
    expect(ssh.commands.some((value) => value.includes(".official-installer-"))).toBe(false);
  });

  it("uses a shorter server-side TERM/KILL timeout for cloud-init and the installer", async () => {
    const ssh = new FakeSshHost();
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const result = await provisioner.provision(provisionInput(hostKeySha256));

    expect(ssh.commands.some((value) => value === "command -v timeout >/dev/null 2>&1")).toBe(true);
    const cloudInit = ssh.commands.find((value) => value.includes("'cloud-init' 'status' '--wait'"));
    const installer = ssh.commands.find((value) => value.includes("'bash'") && value.includes(".official-installer-"));
    for (const remoteCommand of [cloudInit, installer]) {
      expect(remoteCommand).toContain("'timeout' '--signal=TERM' '--kill-after=15s' '4s'");
      expect(4_000 + 15_000).toBeLessThan(20_000);
    }
    result.operatorConfig.fill(0);
  });

  it("bounds the cloud-init wait before starting the installer", async () => {
    const ssh = new FakeSshHost({ hangCloudInit: true });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
    });

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(failure).toMatchObject({ code: "remote-command-failed", hostKeySha256 });
    expect(failure.message).toContain("waiting for cloud-init to complete");
    expect(ssh.commands.some((value) => value.includes("'curl'"))).toBe(false);
  });

  it("treats Sliver's exit-zero/no-file operator behavior as an unknown outcome", async () => {
    const ssh = new FakeSshHost({ generateOperatorConfig: false });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(failure).toMatchObject({ code: "operator-outcome-unknown", hostKeySha256 });
    expect(failure.message).not.toContain("private-key-material");
    expect(ssh.files.has(servicePath)).toBe(false);
    expect([...ssh.files.keys()].filter((path) => path.startsWith("/tmp/"))).toEqual([]);
    expect([...ssh.files.keys()].some((path) => path.includes(".official-installer-"))).toBe(false);
  });

  it("bounds remote output and never leaks captured output into the error", async () => {
    const secretOutput = `secret-${"x".repeat(100)}`;
    const ssh = new FakeSshHost({ unameOutput: secretOutput });
    const events: SliverProvisionOutputEvent[] = [];
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      outputLimitBytes: 64,
    });

    const failure = await captureFailure(provisioner.provision({
      ...provisionInput(hostKeySha256),
      onOutput: (event) => events.push(event),
    }));

    expect(failure).toMatchObject({ code: "remote-command-output-limit", hostKeySha256 });
    expect(failure.message).not.toContain(secretOutput);
    expect(events.some((event) => event.type === "stdout")).toBe(false);
    expect(ssh.sftpCalls).toBe(0);
  });

  it("does not execute a downloaded installer whose pinned hash does not match, and cleans it up", async () => {
    const ssh = new FakeSshHost({ installerDigest: "0".repeat(64) });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(failure).toMatchObject({ code: "official-installer-failed", hostKeySha256 });
    expect(failure.message).toContain("pinned SHA-256");
    expect(ssh.commands.some((value) => value.includes("'bash'") && value.includes(".official-installer-"))).toBe(false);
    expect(ssh.commands.some((value) => value.includes("'rm' '-f' '--'") && value.includes(".official-installer-"))).toBe(true);
    expect([...ssh.files.keys()].some((path) => path.includes(".official-installer-"))).toBe(false);
    expect(ssh.ended).toBe(true);
  });

  it("reports an installer command failure without mislabeling it as SSH and still cleans up", async () => {
    const ssh = new FakeSshHost({
      installerExitCode: 1,
      installerStdout: "Installer made safe partial progress\n",
    });
    const events: SliverProvisionOutputEvent[] = [];
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.provision({
      ...provisionInput(hostKeySha256),
      onOutput: (event) => events.push(event),
    }));

    expect(failure).toMatchObject({ code: "official-installer-failed", hostKeySha256 });
    expect(failure.message).toBe("Running the official Sliver installer failed");
    expect(failure.message).not.toMatch(/ssh/iu);
    expect(Buffer.concat(events
      .filter((event): event is Extract<SliverProvisionOutputEvent, { readonly type: "stdout" }> => event.type === "stdout")
      .map((event) => Buffer.from(event.chunk)))
      .toString("utf8"))
      .toContain("Installer made safe partial progress");
    expect(ssh.commands.some((value) => value.includes("'systemctl' 'stop' 'sliver.service'"))).toBe(true);
    expect([...ssh.files.keys()].some((path) => path.includes(".official-installer-"))).toBe(false);
    expect(ssh.ended).toBe(true);
  });

  it.each([
    ["mode", { handoffMode: 0o400 }, "permissions were not exactly 0600"],
    ["UID", { handoffUid: 1001 }, "ownership did not match"],
    ["GID", { handoffGid: 1001 }, "ownership did not match"],
  ] as const)("rejects a handoff with an unexpected %s", async (_field, options, expectedMessage) => {
    const ssh = new FakeSshHost(options);
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(failure).toMatchObject({ code: "remote-transfer-failed", hostKeySha256 });
    expect(failure.message).toContain(expectedMessage);
    expect(ssh.commands.some((value) =>
      value.includes("'id' '-u' 'ubuntu'")
    )).toBe(true);
    expect(ssh.commands.some((value) =>
      value.includes("'id' '-g' 'ubuntu'")
    )).toBe(true);
    expect([...ssh.files.keys()].some((path) => path.endsWith(".operator.cfg"))).toBe(false);
  });

  it("rejects a downloaded handoff whose digest differs from the privileged canonical config", async () => {
    const ssh = new FakeSshHost({ handoffDataTampered: true });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(failure).toMatchObject({ code: "operator-config-invalid", hostKeySha256 });
    expect(failure.message).toContain("did not match the canonical remote configuration");
    expect(ssh.commands.some((value) =>
      value.includes("'sudo' '-n' 'sha256sum'") && value.includes(operatorConfigPath)
    )).toBe(true);
    expect([...ssh.files.keys()].some((path) => path.endsWith(".operator.cfg"))).toBe(false);
  });

  it("tears down a stalled operator-config read and wipes both current and late bytes", async () => {
    const ssh = new FakeSshHost({ hangHandoffRead: true });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 10,
    });
    const startedAt = Date.now();

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(failure).toMatchObject({ code: "remote-transfer-timeout", hostKeySha256 });
    expect(failure.message).toContain("Retrieving the Sliver operator configuration timed out");
    expect(ssh.destroyed).toBe(true);
    expect(ssh.sftpEnded).toBe(true);
    expect(ssh.lastReadBuffer).toBeDefined();
    expect(ssh.lastReadBuffer?.every((value) => value === 0)).toBe(true);

    ssh.releasePendingRead();
    await Promise.resolve();
    await Promise.resolve();
    expect(ssh.lastReadBuffer?.every((value) => value === 0)).toBe(true);
  });

  it("tears down a stalled systemd-unit upload and wipes the retained write buffer", async () => {
    const ssh = new FakeSshHost({ hangUnitWrite: true });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 10,
    });
    const startedAt = Date.now();

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(failure).toMatchObject({ code: "remote-transfer-timeout", hostKeySha256 });
    expect(failure.message).toContain("Uploading the systemd unit timed out");
    expect(ssh.destroyed).toBe(true);
    expect(ssh.sftpEnded).toBe(true);
    expect(ssh.lastWriteBuffer).toBeDefined();
    expect(ssh.lastWriteBuffer?.every((value) => value === 0)).toBe(true);
  });

  it("does not retain the operator config when an SFTP close callback never returns", async () => {
    const ssh = new FakeSshHost({ hangSftpClose: true });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 10,
    });
    const startedAt = Date.now();

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(failure).toMatchObject({ code: "remote-transfer-timeout", hostKeySha256 });
    expect(ssh.destroyed).toBe(true);
    expect(ssh.sftpEnded).toBe(true);
    expect(ssh.lastReadBuffer).toBeDefined();
    expect(ssh.lastReadBuffer?.every((value) => value === 0)).toBe(true);
  });

  it("bounds final cleanup when an SFTP unlink callback never returns", async () => {
    const ssh = new FakeSshHost({ failHandoffRead: true, hangSftpUnlink: true });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 10,
    });
    const startedAt = Date.now();

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(failure).toMatchObject({ code: "remote-transfer-failed", hostKeySha256 });
    expect(ssh.destroyed).toBe(true);
    expect(ssh.sftpEnded).toBe(true);
  });

  it("removes the private operator handoff when SFTP retrieval fails", async () => {
    const ssh = new FakeSshHost({ failHandoffRead: true });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      cloudInitTimeoutMs: 20_000,
      installerTimeoutMs: 20_000,
      transferTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.provision(provisionInput(hostKeySha256)));

    expect(failure).toMatchObject({ code: "remote-transfer-failed", hostKeySha256 });
    expect(ssh.sftpReadPaths).toHaveLength(1);
    expect(ssh.sftpReadPaths[0]).toContain(".operator.cfg");
    expect(ssh.commands.some((value) => value.includes("'rm' '-f' '--'") && value.includes(".operator.cfg"))).toBe(true);
    expect([...ssh.files.keys()].some((path) => path.includes(".operator.cfg"))).toBe(false);
  });

  it("creates an additional operator once and resumes a matching recovery after a crash", async () => {
    const ssh = new FakeSshHost({ operatorStdout: "operator output must stay private\n" });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: vi.fn()
        .mockReturnValueOnce("dddddddddddddddddddddddddddddddd")
        .mockReturnValueOnce("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")
        .mockReturnValueOnce("ffffffffffffffffffffffffffffffff"),
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      transferTimeoutMs: 100,
    });

    const result = await provisioner.createOperator(createOperatorInput());

    expect(result).toMatchObject({
      deploymentId,
      operatorName: "secondoperator",
      operatorEndpointHost: "server.example.test",
      multiplayerPort: 44_331,
      permissions: "builder",
      hostKeySha256,
      remoteRecoveryPath: `${deploymentRoot}/operator-export/operator-dddddddddddddddddddddddddddddddd.cfg`,
    });
    expect(JSON.parse(result.operatorConfig.toString("utf8"))).toMatchObject({
      operator: "secondoperator",
      lhost: "server.example.test",
      lport: 44_331,
    });
    expect(result.operatorConfigSha256).toBe(createHash("sha256").update(result.operatorConfig).digest("hex"));

    const operatorCommands = ssh.commands.filter((value) => value.includes("'operator'"));
    expect(operatorCommands).toHaveLength(1);
    expect(operatorCommands[0]).toContain(`'SLIVER_ROOT_DIR=${deploymentRoot}/server'`);
    expect(operatorCommands[0]).toContain(`'SLIVER_CLIENT_ROOT_DIR=${deploymentRoot}/client-runtime'`);
    expect(operatorCommands[0]).toContain(`'${binaryPath}' 'operator'`);
    expect(operatorCommands[0]).toContain("'--permissions' 'builder'");
    expect(operatorCommands[0]).toContain(`'--save' '${result.remoteRecoveryPath}'`);

    const recovery = ssh.files.get(result.remoteRecoveryPath);
    expect((recovery?.mode ?? 0) & 0o777).toBe(0o600);
    expect(recovery?.uid).toBe(0);
    expect(recovery?.gid).toBe(0);
    expect(ssh.sftpReadPaths).toEqual([
      `/tmp/.sliver-gui-${deploymentId}-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.operator.cfg`,
    ]);
    const handoffInstall = ssh.commands.find((value) =>
      value.includes(result.remoteRecoveryPath) && value.includes("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.operator.cfg")
    );
    expect(handoffInstall).toContain("'install' '-m' '0600' '-o' '1000' '-g' '1000'");
    expect([...ssh.files.keys()].filter((path) => path.startsWith("/tmp/"))).toEqual([]);
    expect(ssh.files.has(result.remoteRecoveryPath)).toBe(true);
    expect(ssh.ended).toBe(true);
    expect(ssh.sftpEnded).toBe(true);

    result.operatorConfig.fill(0);

    const lockPath = `${deploymentRoot}/operator-export/operator-lock-${createHash("sha256")
      .update("secondoperator", "utf8")
      .digest("hex")}`;
    expect(ssh.directories.has(lockPath)).toBe(true);
    const lockMetadata = ssh.files.get(`${lockPath}/recovery-path`);
    expect(lockMetadata?.data.toString("utf8")).toBe(`${result.remoteRecoveryPath}\n`);
    expect((lockMetadata?.mode ?? 0) & 0o777).toBe(0o600);
    expect(lockMetadata?.uid).toBe(0);
    expect(lockMetadata?.gid).toBe(0);
    const requestMetadata = ssh.files.get(`${lockPath}/request-sha256`);
    expect(requestMetadata?.data.toString("utf8")).toMatch(/^[0-9a-f]{64}\n$/u);
    expect((requestMetadata?.mode ?? 0) & 0o777).toBe(0o600);
    expect(requestMetadata?.uid).toBe(0);
    expect(requestMetadata?.gid).toBe(0);
    const stateMetadata = ssh.files.get(`${lockPath}/state`);
    expect(stateMetadata?.data.toString("utf8")).toBe("created\n");
    expect((stateMetadata?.mode ?? 0) & 0o777).toBe(0o600);
    expect(stateMetadata?.uid).toBe(0);
    expect(stateMetadata?.gid).toBe(0);

    // Simulate a process crash after Sliver wrote the canonical config but
    // before the marker's final state transition reached disk.
    if (stateMetadata) stateMetadata.data = Buffer.from("reserved\n", "utf8");
    const recoveryProvisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: vi.fn()
        .mockReturnValueOnce("11111111111111111111111111111111")
        .mockReturnValueOnce("22222222222222222222222222222222"),
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      transferTimeoutMs: 100,
    });
    const recoveryAvailabilityCheck = vi.fn(async () => undefined);
    const recovered = await recoveryProvisioner.createOperator({
      ...createOperatorInput(),
      assertOperatorNameAvailable: recoveryAvailabilityCheck,
    });
    expect(recovered).toMatchObject({
      operatorName: "secondoperator",
      permissions: "builder",
      hostKeySha256,
      remoteRecoveryPath: result.remoteRecoveryPath,
    });
    expect(recovered.operatorConfig.equals(ssh.files.get(result.remoteRecoveryPath)?.data ?? Buffer.alloc(0)))
      .toBe(true);
    expect(ssh.files.get(`${lockPath}/state`)?.data.toString("utf8")).toBe("created\n");
    expect(ssh.commands.filter((value) => value.includes("'operator'"))).toHaveLength(1);
    expect(recoveryAvailabilityCheck).not.toHaveBeenCalled();
    recovered.operatorConfig.fill(0);
  });

  it.each(["all", "builder", "crackstation"] as const)(
    "passes the supported %s permission preset to the Sliver CLI",
    async (permissions) => {
      const ssh = new FakeSshHost();
      const provisioner = new SliverProvisioner({
        createSshClient: () => ssh.asClient(),
        createNonce: vi.fn()
          .mockReturnValueOnce("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
          .mockReturnValueOnce("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
        wait: async () => undefined,
        connectTimeoutMs: 100,
        commandTimeoutMs: 100,
        transferTimeoutMs: 100,
      });

      const result = await provisioner.createOperator({
        ...createOperatorInput(),
        operatorName: `operator-${permissions}`,
        permissions,
      });

      expect(result.permissions).toBe(permissions);
      expect(ssh.commands.find((command) => command.includes("'operator'")))
        .toContain(`'--permissions' '${permissions}'`);
      result.operatorConfig.fill(0);
    },
  );

  it("does not recover an existing operator config for a different permission request", async () => {
    const ssh = new FakeSshHost();
    const initialProvisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: vi.fn()
        .mockReturnValueOnce("33333333333333333333333333333333")
        .mockReturnValueOnce("44444444444444444444444444444444"),
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      transferTimeoutMs: 100,
    });
    const created = await initialProvisioner.createOperator(createOperatorInput());
    const retryProvisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "55555555555555555555555555555555",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      transferTimeoutMs: 100,
    });

    const retryAvailabilityCheck = vi.fn(async () => undefined);
    const failure = await captureFailure(retryProvisioner.createOperator({
      ...createOperatorInput(),
      permissions: "all",
      assertOperatorNameAvailable: retryAvailabilityCheck,
    }));

    expect(failure).toBeInstanceOf(SliverOperatorCreationError);
    expect(failure).toMatchObject({
      code: "operator-outcome-unknown",
      hostKeySha256,
      mutationState: "unknown",
      remoteRecoveryCandidatePath: created.remoteRecoveryPath,
    });
    expect(ssh.commands.filter((value) => value.includes("'operator'"))).toHaveLength(1);
    expect(retryAvailabilityCheck).not.toHaveBeenCalled();
    created.operatorConfig.fill(0);
  });

  it("treats an existing replay marker without valid recovery metadata as unknown", async () => {
    const ssh = new FakeSshHost();
    const lockPath = `${deploymentRoot}/operator-export/operator-lock-${createHash("sha256")
      .update("secondoperator", "utf8")
      .digest("hex")}`;
    ssh.directories.add(lockPath);
    ssh.files.set(
      `${lockPath}/recovery-path`,
      remoteFile(Buffer.from("/etc/shadow\n", "utf8"), 0o600, 0),
    );
    const provisioner = new SliverProvisioner({ createSshClient: () => ssh.asClient() });

    const failure = await captureFailure(provisioner.createOperator(createOperatorInput()));

    expect(failure).toBeInstanceOf(SliverOperatorCreationError);
    expect(failure).toMatchObject({
      code: "operator-outcome-unknown",
      hostKeySha256,
      mutationState: "unknown",
    });
    expect((failure as SliverOperatorCreationError).remoteRecoveryCandidatePath).toBeUndefined();
    expect(failure.message).toContain(`remove the recovery marker at ${lockPath}`);
    expect(ssh.commands.filter((value) => value.includes("'operator'"))).toHaveLength(0);
  });

  it("runs the availability preflight before reserving a fresh operator mutation", async () => {
    const ssh = new FakeSshHost();
    const availabilityFailure = new SliverProvisionError(
      "provisioning-failed",
      "That operator already exists on this managed server",
    );
    const assertOperatorNameAvailable = vi.fn(async () => {
      expect([...ssh.directories].some((path) => path.includes("operator-lock-"))).toBe(false);
      expect(ssh.commands.filter((value) => value.includes("'operator'"))).toHaveLength(0);
      throw availabilityFailure;
    });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: () => "66666666666666666666666666666666",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      transferTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.createOperator({
      ...createOperatorInput(),
      assertOperatorNameAvailable,
    }));

    expect(failure).not.toBeInstanceOf(SliverOperatorCreationError);
    expect(failure).toMatchObject({
      code: "provisioning-failed",
      message: "That operator already exists on this managed server",
      hostKeySha256,
    });
    expect(assertOperatorNameAvailable).toHaveBeenCalledOnce();
    expect([...ssh.directories].some((path) => path.includes("operator-lock-"))).toBe(false);
    expect(ssh.commands.filter((value) => value.includes("'operator'"))).toHaveLength(0);
  });

  it("rejects additional operator creation before connecting when the SSH host key is not pinned", async () => {
    const ssh = new FakeSshHost();
    const createSshClient = vi.fn(() => ssh.asClient());
    const provisioner = new SliverProvisioner({ createSshClient });

    const failure = await captureFailure(provisioner.createOperator({
      ...createOperatorInput(),
      ssh: {
        ...createOperatorInput().ssh,
        hostKeySha256: undefined as never,
      },
    }));

    expect(failure).toMatchObject({ code: "invalid-input" });
    expect(createSshClient).not.toHaveBeenCalled();
    expect(ssh.commands).toEqual([]);
  });

  it("rejects unsupported operator permissions before connecting", async () => {
    const ssh = new FakeSshHost();
    const createSshClient = vi.fn(() => ssh.asClient());
    const provisioner = new SliverProvisioner({ createSshClient });

    const failure = await captureFailure(provisioner.createOperator({
      ...createOperatorInput(),
      permissions: "administrator" as never,
    }));

    expect(failure).toMatchObject({ code: "invalid-input", message: "The operator permissions are invalid" });
    expect(createSshClient).not.toHaveBeenCalled();
    expect(ssh.commands).toEqual([]);
  });

  it("keeps an SFTP-open timeout retryable because the operator command never started", async () => {
    const ssh = new FakeSshHost({ hangSftpOpen: true });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      transferTimeoutMs: 10,
    });

    const failure = await captureFailure(provisioner.createOperator(createOperatorInput()));

    expect(failure).not.toBeInstanceOf(SliverOperatorCreationError);
    expect(failure).toMatchObject({ code: "remote-transfer-timeout", hostKeySha256 });
    expect(ssh.commands.filter((value) => value.includes("'operator'"))).toHaveLength(0);
    expect(ssh.destroyed).toBe(true);
  });

  it("does not retry an additional operator when Sliver reports success without writing the recovery config", async () => {
    const ssh = new FakeSshHost({ generateOperatorConfig: false });
    const createSshClient = vi.fn(() => ssh.asClient());
    const provisioner = new SliverProvisioner({
      createSshClient,
      createNonce: () => "dddddddddddddddddddddddddddddddd",
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      transferTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.createOperator(createOperatorInput()));

    expect(failure).toBeInstanceOf(SliverOperatorCreationError);
    expect(failure).toMatchObject({
      code: "operator-outcome-unknown",
      hostKeySha256,
      mutationState: "unknown",
      remoteRecoveryCandidatePath:
        `${deploymentRoot}/operator-export/operator-dddddddddddddddddddddddddddddddd.cfg`,
    });
    expect(createSshClient).toHaveBeenCalledOnce();
    expect(ssh.commands.filter((value) => value.includes("'operator'"))).toHaveLength(1);
    expect([...ssh.files.keys()].filter((path) => path.startsWith("/tmp/"))).toEqual([]);
    expect(ssh.sftpEnded).toBe(true);

    const lockPath = `${deploymentRoot}/operator-export/operator-lock-${createHash("sha256")
      .update("secondoperator", "utf8")
      .digest("hex")}`;
    expect(ssh.files.get(`${lockPath}/state`)?.data.toString("utf8")).toBe("reserved\n");
    const retryFailure = await captureFailure(provisioner.createOperator(createOperatorInput()));
    expect(retryFailure).toBeInstanceOf(SliverOperatorCreationError);
    expect(retryFailure).toMatchObject({
      code: "operator-outcome-unknown",
      mutationState: "unknown",
      remoteRecoveryCandidatePath:
        `${deploymentRoot}/operator-export/operator-dddddddddddddddddddddddddddddddd.cfg`,
    });
    expect(ssh.commands.filter((value) => value.includes("'operator'"))).toHaveLength(1);
  });

  it("rejects a tampered operator handoff, zeroes the retrieved bytes, and keeps the canonical recovery config", async () => {
    const ssh = new FakeSshHost({ handoffDataTampered: true });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: vi.fn()
        .mockReturnValueOnce("dddddddddddddddddddddddddddddddd")
        .mockReturnValueOnce("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      transferTimeoutMs: 100,
    });

    const failure = await captureFailure(provisioner.createOperator(createOperatorInput()));

    const recoveryPath = `${deploymentRoot}/operator-export/operator-dddddddddddddddddddddddddddddddd.cfg`;
    expect(failure).toBeInstanceOf(SliverOperatorCreationError);
    expect(failure).toMatchObject({
      code: "operator-config-invalid",
      hostKeySha256,
      mutationState: "created",
      remoteRecoveryPath: recoveryPath,
    });
    expect(ssh.lastReadBuffer).toBeDefined();
    expect(ssh.lastReadBuffer?.every((value) => value === 0)).toBe(true);
    expect(ssh.files.has(recoveryPath)).toBe(true);
    expect([...ssh.files.keys()].filter((path) => path.startsWith("/tmp/"))).toEqual([]);
  });

  it("surfaces the temporary path when a timed-out handoff cannot be cleaned up", async () => {
    const ssh = new FakeSshHost({
      failPrivilegedHandoffCleanup: true,
      hangHandoffRead: true,
    });
    const provisioner = new SliverProvisioner({
      createSshClient: () => ssh.asClient(),
      createNonce: vi.fn()
        .mockReturnValueOnce("dddddddddddddddddddddddddddddddd")
        .mockReturnValueOnce("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      transferTimeoutMs: 10,
    });

    const failure = await captureFailure(provisioner.createOperator(createOperatorInput()));

    const recoveryPath = `${deploymentRoot}/operator-export/operator-dddddddddddddddddddddddddddddddd.cfg`;
    const handoffPath = `/tmp/.sliver-gui-${deploymentId}-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.operator.cfg`;
    expect(failure).toBeInstanceOf(SliverOperatorCreationError);
    expect(failure).toMatchObject({
      code: "remote-transfer-timeout",
      hostKeySha256,
      mutationState: "created",
      remoteRecoveryPath: recoveryPath,
      remoteHandoffCandidatePath: handoffPath,
    });
    expect(ssh.destroyed).toBe(true);
    expect(ssh.sftpEnded).toBe(true);
    expect(ssh.files.has(recoveryPath)).toBe(true);
    expect([...ssh.files.keys()].filter((path) => path.startsWith("/tmp/"))).toEqual([handoffPath]);
    expect(ssh.lastReadBuffer?.every((value) => value === 0)).toBe(true);

    ssh.releasePendingRead();
    await Promise.resolve();
    await Promise.resolve();
    expect(ssh.lastReadBuffer?.every((value) => value === 0)).toBe(true);
  });

  it("rejects non-direct-mTLS operator configs and bounds the SFTP read", async () => {
    const nonMtlsSsh = new FakeSshHost({ operatorConfigOverrides: { wg: { server_public_key: "wg-key" } } });
    const nonMtlsProvisioner = new SliverProvisioner({
      createSshClient: () => nonMtlsSsh.asClient(),
      createNonce: vi.fn()
        .mockReturnValueOnce("dddddddddddddddddddddddddddddddd")
        .mockReturnValueOnce("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      transferTimeoutMs: 100,
    });

    const nonMtlsFailure = await captureFailure(nonMtlsProvisioner.createOperator(createOperatorInput()));

    expect(nonMtlsFailure).toMatchObject({
      code: "operator-config-invalid",
      hostKeySha256,
      mutationState: "created",
    });
    expect(nonMtlsSsh.lastReadBuffer?.every((value) => value === 0)).toBe(true);

    const oversizedSsh = new FakeSshHost();
    const boundedProvisioner = new SliverProvisioner({
      createSshClient: () => oversizedSsh.asClient(),
      createNonce: vi.fn()
        .mockReturnValueOnce("ffffffffffffffffffffffffffffffff")
        .mockReturnValueOnce("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      wait: async () => undefined,
      connectTimeoutMs: 100,
      commandTimeoutMs: 100,
      transferTimeoutMs: 100,
      operatorConfigLimitBytes: 64,
    });

    const oversizedFailure = await captureFailure(boundedProvisioner.createOperator(createOperatorInput()));

    expect(oversizedFailure).toMatchObject({
      code: "operator-config-invalid",
      hostKeySha256,
      mutationState: "created",
    });
    expect(oversizedFailure).toBeInstanceOf(SliverOperatorCreationError);
    expect((oversizedFailure as SliverOperatorCreationError).remoteHandoffCandidatePath).toBeUndefined();
    expect(oversizedSsh.lastReadBuffer).toBeUndefined();
    expect([...oversizedSsh.files.keys()].filter((path) => path.startsWith("/tmp/"))).toEqual([]);
    expect(oversizedSsh.files.has(
      `${deploymentRoot}/operator-export/operator-ffffffffffffffffffffffffffffffff.cfg`,
    )).toBe(true);
  });
});

function provisionInput(pinnedHostKey: string) {
  return {
    deploymentId,
    operatorEndpointHost: "server.example.test",
    operatorName: "cloudoperator",
    ssh: {
      host: "192.0.2.10",
      username: "ubuntu",
      privateKey: Buffer.from("private SSH key that must not leak", "utf8"),
      hostKeySha256: pinnedHostKey,
    },
  } as const;
}

function createOperatorInput() {
  return {
    deploymentId,
    operatorEndpointHost: "server.example.test",
    multiplayerPort: 44_331,
    operatorName: "secondoperator",
    permissions: "builder",
    assertOperatorNameAvailable: async () => undefined,
    ssh: {
      host: "192.0.2.10",
      username: "ubuntu",
      privateKey: Buffer.from("private SSH key that must not leak", "utf8"),
      hostKeySha256,
    },
  } as const;
}

async function captureFailure(promise: Promise<unknown>): Promise<SliverProvisionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SliverProvisionError) return error;
    throw error;
  }
  throw new Error("Expected the provision operation to fail");
}

interface FakeRemoteFile {
  data: Buffer;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
}

interface FakeSshHostOptions {
  readonly architecture?: "x86_64" | "aarch64";
  readonly cloudInitPresent?: boolean;
  readonly failHandoffRead?: boolean;
  readonly failPrivilegedHandoffCleanup?: boolean;
  readonly generateOperatorConfig?: boolean;
  readonly handoffDataTampered?: boolean;
  readonly handoffGid?: number;
  readonly handoffMode?: number;
  readonly handoffUid?: number;
  readonly hangHandoffRead?: boolean;
  readonly hangCloudInit?: boolean;
  readonly hangSftpClose?: boolean;
  readonly hangSftpOpen?: boolean;
  readonly hangSftpUnlink?: boolean;
  readonly hangUnitWrite?: boolean;
  readonly activeSwapPaths?: readonly string[];
  readonly activeManagedSwapFileSizeBytes?: number;
  readonly activeManagedSwapMode?: number;
  readonly allocatedSwapSizeDeltaBytes?: number;
  readonly availableDiskBytes?: number;
  readonly availableMemoryKiB?: number;
  readonly failSwapCommand?: "dd" | "mkswap" | "swapon" | "persist";
  readonly fstabSwapPaths?: readonly string[];
  readonly freeSwapKiB?: number;
  readonly invalidFstabSwapPaths?: readonly string[];
  readonly invalidSwapReportAfterSwaponFailure?: boolean;
  readonly installerDigest?: string;
  readonly installerExitCode?: number;
  readonly installerStdout?: string;
  readonly minisignArchiveDigest?: string;
  readonly minisignBinaryDigest?: string;
  readonly minisignBinaryType?: "regular" | "symlink";
  readonly minisignPresent?: boolean;
  readonly physicalMemoryKiB?: number;
  readonly systemPageSizeBytes?: number;
  readonly swaponSucceedsWithoutActivation?: boolean;
  readonly activeSwapKiB?: number;
  readonly operatorStdout?: string;
  readonly operatorConfigOverrides?: Readonly<Record<string, unknown>>;
  readonly remoteGid?: number;
  readonly remoteUid?: number;
  readonly swaponFailureActivates?: boolean;
  readonly unameOutput?: string;
}

class FakeSshHost extends EventEmitter {
  readonly files = new Map<string, FakeRemoteFile>();
  readonly directories = new Set<string>();
  readonly commands: string[] = [];
  readonly sftpReadPaths: string[] = [];
  readonly hostKey = hostKey;
  readonly architecture: "x86_64" | "aarch64";
  readonly cloudInitPresent: boolean;
  readonly failHandoffRead: boolean;
  readonly failPrivilegedHandoffCleanup: boolean;
  readonly generateOperatorConfig: boolean;
  readonly handoffDataTampered: boolean;
  readonly handoffGid: number | undefined;
  readonly handoffMode: number | undefined;
  readonly handoffUid: number | undefined;
  readonly hangHandoffRead: boolean;
  readonly hangCloudInit: boolean;
  readonly hangSftpClose: boolean;
  readonly hangSftpOpen: boolean;
  readonly hangSftpUnlink: boolean;
  readonly hangUnitWrite: boolean;
  readonly unameOutput: string;
  readonly operatorStdout: string;
  readonly operatorConfigOverrides: Readonly<Record<string, unknown>>;
  readonly installerDigest: string;
  readonly installerExitCode: number;
  readonly installerStdout: string;
  readonly minisignArchiveDigest: string;
  readonly minisignBinaryDigest: string;
  readonly minisignBinaryType: "regular" | "symlink";
  readonly minisignPresent: boolean;
  readonly physicalMemoryKiB: number;
  readonly systemPageSizeBytes: number;
  readonly availableMemoryKiB: number;
  readonly availableDiskBytes: number;
  readonly remoteGid: number;
  readonly remoteUid: number;
  readonly activeSwapPaths: Set<string>;
  readonly activeSwapSizesKiB = new Map<string, number>();
  readonly fstabSwapPaths: Set<string>;
  readonly invalidFstabSwapPaths: Set<string>;
  readonly failSwapCommand: "dd" | "mkswap" | "swapon" | "persist" | undefined;
  readonly invalidSwapReportAfterSwaponFailure: boolean;
  readonly swaponFailureActivates: boolean;
  readonly swapFileSizes = new Map<string, number>();
  readonly allocatedSwapSizeDeltaBytes: number;
  readonly swaponSucceedsWithoutActivation: boolean;
  activeSwapKiB: number;
  freeSwapKiB: number;
  fstabAppendCount = 0;
  swaponFailed = false;
  ended = false;
  destroyed = false;
  sftpEnded = false;
  sftpCalls = 0;
  lastReadBuffer: Buffer | undefined;
  lastWriteBuffer: Buffer | undefined;
  private nextHandle = 0;
  private readonly handles = new Map<string, string>();
  private pendingRead: (() => void) | undefined;

  constructor(options: FakeSshHostOptions = {}) {
    super();
    this.architecture = options.architecture ?? "x86_64";
    this.cloudInitPresent = options.cloudInitPresent ?? true;
    this.failHandoffRead = options.failHandoffRead ?? false;
    this.failPrivilegedHandoffCleanup = options.failPrivilegedHandoffCleanup ?? false;
    this.generateOperatorConfig = options.generateOperatorConfig ?? true;
    this.handoffDataTampered = options.handoffDataTampered ?? false;
    this.handoffGid = options.handoffGid;
    this.handoffMode = options.handoffMode;
    this.handoffUid = options.handoffUid;
    this.hangHandoffRead = options.hangHandoffRead ?? false;
    this.hangCloudInit = options.hangCloudInit ?? false;
    this.hangSftpClose = options.hangSftpClose ?? false;
    this.hangSftpOpen = options.hangSftpOpen ?? false;
    this.hangSftpUnlink = options.hangSftpUnlink ?? false;
    this.hangUnitWrite = options.hangUnitWrite ?? false;
    this.unameOutput = options.unameOutput ?? "Linux";
    this.operatorStdout = options.operatorStdout ?? "";
    this.operatorConfigOverrides = options.operatorConfigOverrides ?? {};
    this.installerDigest = options.installerDigest ?? officialInstallerSha256;
    this.installerExitCode = options.installerExitCode ?? 0;
    this.installerStdout = options.installerStdout ?? "";
    this.minisignArchiveDigest = options.minisignArchiveDigest ?? minisignArchiveSha256;
    this.minisignBinaryDigest = options.minisignBinaryDigest ?? (
      this.architecture === "aarch64" ? minisignArm64Sha256 : minisignAmd64Sha256
    );
    this.minisignBinaryType = options.minisignBinaryType ?? "regular";
    this.minisignPresent = options.minisignPresent ?? true;
    this.physicalMemoryKiB = options.physicalMemoryKiB ?? 8 * 1024 * 1024;
    this.systemPageSizeBytes = options.systemPageSizeBytes ?? 4096;
    this.availableMemoryKiB = options.availableMemoryKiB ?? this.physicalMemoryKiB;
    this.availableDiskBytes = options.availableDiskBytes ?? 20 * 1024 * 1024 * 1024;
    this.activeSwapKiB = options.activeSwapKiB ?? 0;
    this.freeSwapKiB = options.freeSwapKiB ?? this.activeSwapKiB;
    this.activeSwapPaths = new Set(options.activeSwapPaths ?? []);
    for (const path of this.activeSwapPaths) this.activeSwapSizesKiB.set(path, this.activeSwapKiB);
    if (this.activeSwapPaths.has(managedSwapPath)) {
      const sizeBytes = options.activeManagedSwapFileSizeBytes ?? this.activeSwapKiB * 1024 + this.systemPageSizeBytes;
      this.files.set(managedSwapPath, remoteFile(Buffer.alloc(0), options.activeManagedSwapMode ?? 0o600, 0));
      this.swapFileSizes.set(managedSwapPath, sizeBytes);
    }
    this.fstabSwapPaths = new Set(options.fstabSwapPaths ?? []);
    this.invalidFstabSwapPaths = new Set(options.invalidFstabSwapPaths ?? []);
    this.failSwapCommand = options.failSwapCommand;
    this.invalidSwapReportAfterSwaponFailure = options.invalidSwapReportAfterSwaponFailure ?? false;
    this.swaponFailureActivates = options.swaponFailureActivates ?? false;
    this.allocatedSwapSizeDeltaBytes = options.allocatedSwapSizeDeltaBytes ?? 0;
    this.swaponSucceedsWithoutActivation = options.swaponSucceedsWithoutActivation ?? false;
    this.remoteGid = options.remoteGid ?? 1000;
    this.remoteUid = options.remoteUid ?? 1000;
  }

  asClient(): Client {
    return this as unknown as Client;
  }

  connect(config: ConnectConfig): this {
    queueMicrotask(() => {
      const verifier = config.hostVerifier as ((key: Buffer) => boolean) | undefined;
      if (verifier?.(this.hostKey) === false) this.emit("error", new Error("untrusted host"));
      else this.emit("ready");
    });
    return this;
  }

  exec(
    command: string,
    callback: (error: Error | undefined, channel: ClientChannel) => void,
  ): this {
    this.commands.push(command);
    const channel = new FakeChannel();
    const result = this.run(command);
    queueMicrotask(() => {
      callback(undefined, channel as unknown as ClientChannel);
      queueMicrotask(() => {
        if (result.stdout.length > 0) channel.emit("data", result.stdout);
        if (result.stderr.length > 0) channel.stderr.emit("data", result.stderr);
        channel.emit("exit", result.exitCode);
        channel.emit("close");
      });
    });
    return this;
  }

  sftp(callback: (error: Error | undefined, sftp: SFTPWrapper) => void): this {
    this.sftpCalls += 1;
    if (!this.hangSftpOpen) queueMicrotask(() => callback(undefined, this.sftpObject()));
    return this;
  }

  end(): this {
    this.ended = true;
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  releasePendingRead(): void {
    const release = this.pendingRead;
    this.pendingRead = undefined;
    release?.();
  }

  private run(command: string): { readonly stdout: Buffer; readonly stderr: Buffer; readonly exitCode: number } {
    const args = quotedArguments(command);
    const stdout = (value = "") => ({ stdout: Buffer.from(value), stderr: Buffer.alloc(0), exitCode: 0 });
    if (args[0] === "uname" && args[1] === "-s") return stdout(this.unameOutput);
    if (args[0] === "uname" && args[1] === "-m") return stdout(this.architecture);
    if (args[0] === "cat" && args[1] === "/proc/meminfo") {
      return stdout([
        `MemTotal:       ${this.physicalMemoryKiB} kB`,
        `MemAvailable:   ${this.availableMemoryKiB} kB`,
        `SwapTotal:      ${this.activeSwapKiB} kB`,
        `SwapFree:       ${this.freeSwapKiB} kB`,
        "",
      ].join("\n"));
    }
    if (args[0] === "cat" && args[1] === "/proc/swaps") {
      if (this.swaponFailed && this.invalidSwapReportAfterSwaponFailure) return stdout("invalid swap report\n");
      return stdout([
        "Filename\t\t\t\tType\t\tSize\tUsed\tPriority",
        ...[...this.activeSwapPaths].map((path) => `${path}\tfile\t${this.activeSwapSizesKiB.get(path) ?? 0}\t0\t-2`),
        "",
      ].join("\n"));
    }
    const dfIndex = args.indexOf("df");
    if (dfIndex >= 0) return stdout(`Avail\n${this.availableDiskBytes}\n`);
    const getconfIndex = args.indexOf("getconf");
    if (getconfIndex >= 0) return stdout(`${this.systemPageSizeBytes}\n`);
    if (command.startsWith("command -v ")) return stdout();
    if (args[0] === "sudo" && args[2] === "true") return stdout();

    const shellScript = args.find((_value, index) => args[index - 1] === "-c");
    if (shellScript?.includes("command -v cloud-init")) {
      return stdout(this.cloudInitPresent ? "present" : "absent");
    }
    if (shellScript?.includes("command -v minisign")) {
      return stdout(this.minisignPresent ? "present" : "absent");
    }
    if (args.includes("sliver-gui-operator-lock-read")) {
      const markerIndex = args.indexOf("sliver-gui-operator-lock-read");
      const path = args[markerIndex + 1] ?? "";
      return stdout(`${this.directories.has(path) ? "exists" : "missing"}\n${["recovery-path", "request-sha256", "state"]
        .map((name) => this.files.get(`${path}/${name}`)?.data.toString("utf8") ?? "absent\n")
        .join("")}`);
    }
    if (args.includes("sliver-gui-operator-lock")) {
      const markerIndex = args.indexOf("sliver-gui-operator-lock");
      const path = args[markerIndex + 1] ?? "";
      const recoveryPath = args[markerIndex + 2] ?? "";
      const requestSha256 = args[markerIndex + 3] ?? "";
      if (this.directories.has(path)) return stdout("exists");
      this.directories.add(path);
      this.files.set(`${path}/recovery-path`, remoteFile(Buffer.from(`${recoveryPath}\n`, "utf8"), 0o600, 0));
      this.files.set(`${path}/request-sha256`, remoteFile(Buffer.from(`${requestSha256}\n`, "utf8"), 0o600, 0));
      this.files.set(`${path}/state`, remoteFile(Buffer.from("reserved\n", "utf8"), 0o600, 0));
      return stdout("created");
    }
    if (args.includes("sliver-gui-operator-lock-created")) {
      const markerIndex = args.indexOf("sliver-gui-operator-lock-created");
      const path = args[markerIndex + 1] ?? "";
      this.files.set(`${path}/state`, remoteFile(Buffer.from("created\n", "utf8"), 0o600, 0));
      return stdout();
    }
    if (args.includes("sliver-gui-managed-swap")) {
      if (this.failSwapCommand === "persist") {
        return { stdout: Buffer.alloc(0), stderr: Buffer.from("fstab failure"), exitCode: 1 };
      }
      const markerIndex = args.indexOf("sliver-gui-managed-swap");
      const path = args[markerIndex + 1] ?? "";
      if (this.invalidFstabSwapPaths.has(path)) {
        return { stdout: Buffer.alloc(0), stderr: Buffer.from("conflicting fstab entry"), exitCode: 65 };
      }
      if (!this.fstabSwapPaths.has(path)) {
        this.fstabSwapPaths.add(path);
        this.fstabAppendCount += 1;
      }
      return stdout();
    }
    if (args.includes("cloud-init") && args.includes("--wait")) {
      return this.hangCloudInit
        ? { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 124 }
        : stdout("status: done\n");
    }
    const idIndex = args.indexOf("id");
    if (idIndex >= 0 && args[idIndex + 1] === "-u") return stdout(`${this.remoteUid}\n`);
    if (idIndex >= 0 && args[idIndex + 1] === "-g") return stdout(`${this.remoteGid}\n`);
    if (shellScript?.includes("sliver-gui-file-check") || shellScript?.includes("test -f \"$1\"")) {
      return stdout(this.files.has(args.at(-1) ?? "") ? "present" : "absent");
    }

    const curlIndex = args.indexOf("curl");
    if (curlIndex >= 0) {
      const path = optionValue(args, "--output");
      const file = this.files.get(path);
      if (!file) return { stdout: Buffer.alloc(0), stderr: Buffer.from("missing"), exitCode: 1 };
      file.data = Buffer.from(path.includes(".minisign-bootstrap-") ? "pinned minisign archive" : "official Sliver installer", "utf8");
      return stdout();
    }

    const shaIndex = args.indexOf("sha256sum");
    if (shaIndex >= 0) {
      const path = args.at(-1) ?? "";
      const file = this.files.get(path);
      if (!file) return { stdout: Buffer.alloc(0), stderr: Buffer.from("missing"), exitCode: 1 };
      const digest = path.includes(".official-installer-")
        ? this.installerDigest
        : path.endsWith(".tar.gz") && path.includes(".minisign-bootstrap-")
          ? this.minisignArchiveDigest
          : path === minisignBinaryPath || path.endsWith("/minisign")
            ? this.minisignBinaryDigest
            : createHash("sha256").update(file.data).digest("hex");
      return stdout(`${digest}  ${path}\n`);
    }

    const statIndex = args.indexOf("stat");
    if (statIndex >= 0) {
      const path = args.at(-1) ?? "";
      const file = this.files.get(path);
      if (!file) return { stdout: Buffer.alloc(0), stderr: Buffer.from("missing"), exitCode: 1 };
      const size = this.swapFileSizes.get(path) ?? file.data.length;
      return stdout(`${file.mode.toString(16)}:${file.uid}:${file.gid}:${(file.mode & 0o777).toString(8)}:${size}\n`);
    }

    const tarIndex = args.indexOf("tar");
    if (tarIndex >= 0) {
      const directory = optionValue(args, "--directory");
      const type = this.minisignBinaryType === "symlink" ? 0o120000 : 0o100000;
      this.files.set(`${directory}/minisign`, remoteFile(Buffer.from("pinned minisign binary"), 0o755, 0, 0, type));
      return stdout();
    }

    const installIndex = args.indexOf("install");
    if (installIndex >= 0) {
      if (args[installIndex + 1] === "-d") return stdout();
      const source = args.at(-2) ?? "";
      const destination = args.at(-1) ?? "";
      const sourceFile = source === "/dev/null"
        ? remoteFile(Buffer.alloc(0), 0o600, 0)
        : this.files.get(source);
      if (!sourceFile) return { stdout: Buffer.alloc(0), stderr: Buffer.from("missing"), exitCode: 1 };
      const modeIndex = args.indexOf("-m", installIndex);
      const requestedMode = Number.parseInt(args[modeIndex + 1] ?? "0600", 8);
      const ownerIndex = args.indexOf("-o", installIndex);
      const requestedOwner = ownerIndex < 0 ? "root" : args[ownerIndex + 1];
      const groupIndex = args.indexOf("-g", installIndex);
      const requestedGroup = groupIndex < 0 ? requestedOwner : args[groupIndex + 1];
      const requestedUid = requestedOwner === "root" ? 0 : Number(requestedOwner ?? this.remoteUid);
      const requestedGid = requestedGroup === "root" ? 0 : Number(requestedGroup ?? this.remoteGid);
      const isHandoff = destination.endsWith(".operator.cfg");
      const installed = remoteFile(
        Buffer.from(sourceFile.data),
        isHandoff ? this.handoffMode ?? requestedMode : requestedMode,
        isHandoff ? this.handoffUid ?? requestedUid : requestedUid,
        isHandoff ? this.handoffGid ?? requestedGid : requestedGid,
      );
      if (isHandoff && this.handoffDataTampered) installed.data = Buffer.from("tampered operator configuration", "utf8");
      this.files.set(destination, installed);
      return stdout();
    }

    const ddIndex = args.indexOf("dd");
    if (ddIndex >= 0) {
      if (this.failSwapCommand === "dd") {
        return { stdout: Buffer.alloc(0), stderr: Buffer.from("allocation failure"), exitCode: 1 };
      }
      const output = args.find((value) => value.startsWith("of="))?.slice(3) ?? "";
      const count = Number(args.find((value) => value.startsWith("count="))?.slice(6));
      const file = this.files.get(output);
      if (!file || !Number.isSafeInteger(count) || count <= 0) {
        return { stdout: Buffer.alloc(0), stderr: Buffer.from("bad allocation"), exitCode: 1 };
      }
      this.swapFileSizes.set(output, count * 1024 * 1024 + this.allocatedSwapSizeDeltaBytes);
      return stdout();
    }

    const mkswapIndex = args.indexOf("mkswap");
    if (mkswapIndex >= 0) {
      if (this.failSwapCommand === "mkswap") {
        return { stdout: Buffer.alloc(0), stderr: Buffer.from("format failure"), exitCode: 1 };
      }
      return this.files.has(args.at(-1) ?? "")
        ? stdout()
        : { stdout: Buffer.alloc(0), stderr: Buffer.from("missing"), exitCode: 1 };
    }

    const mvIndex = args.indexOf("mv");
    if (mvIndex >= 0) {
      const source = args.at(-2) ?? "";
      const destination = args.at(-1) ?? "";
      const file = this.files.get(source);
      if (!file) return { stdout: Buffer.alloc(0), stderr: Buffer.from("missing"), exitCode: 1 };
      this.files.set(destination, file);
      this.files.delete(source);
      const size = this.swapFileSizes.get(source);
      if (size !== undefined) {
        this.swapFileSizes.set(destination, size);
        this.swapFileSizes.delete(source);
      }
      return stdout();
    }

    const swaponIndex = args.indexOf("swapon");
    if (swaponIndex >= 0) {
      const path = args.at(-1) ?? "";
      const size = this.swapFileSizes.get(path);
      if (!this.files.has(path) || size === undefined) {
        return { stdout: Buffer.alloc(0), stderr: Buffer.from("missing"), exitCode: 1 };
      }
      if (
        !this.swaponSucceedsWithoutActivation &&
        (this.failSwapCommand !== "swapon" || this.swaponFailureActivates) &&
        !this.activeSwapPaths.has(path)
      ) {
        const reportedSizeKiB = size / 1024 - this.systemPageSizeBytes / 1024;
        this.activeSwapPaths.add(path);
        this.activeSwapSizesKiB.set(path, reportedSizeKiB);
        this.activeSwapKiB += reportedSizeKiB;
        this.freeSwapKiB += reportedSizeKiB;
      }
      if (this.failSwapCommand === "swapon") {
        this.swaponFailed = true;
        return { stdout: Buffer.alloc(0), stderr: Buffer.from("activation failure"), exitCode: 1 };
      }
      return stdout();
    }

    const bashIndex = args.indexOf("bash");
    if (bashIndex >= 0 && (args[bashIndex + 1] ?? "").includes(".official-installer-")) {
      if (this.installerExitCode === 0) {
        this.files.set(officialServerPath, remoteFile(Buffer.from(installedServer), 0o755, 0));
      }
      return {
        stdout: Buffer.from(this.installerStdout),
        stderr: Buffer.alloc(0),
        exitCode: this.installerExitCode,
      };
    }

    if (args.includes(officialServerPath) && args.includes("version")) {
      return stdout("Sliver Server v1.7.7\n");
    }

    const testIndex = args.indexOf("test");
    if (testIndex >= 0) {
      const path = args.at(-1) ?? "";
      const file = this.files.get(path);
      const isRegular = file !== undefined && (file.mode & 0o170000) === 0o100000;
      const isSymlink = file !== undefined && (file.mode & 0o170000) === 0o120000;
      const matches = args[testIndex + 1] === "-f"
        ? isRegular
        : args[testIndex + 1] === "!" && args[testIndex + 2] === "-L"
          ? file !== undefined && !isSymlink
          : args[testIndex + 1] === "-x"
            ? file !== undefined && (file.mode & 0o111) !== 0
            : file !== undefined;
      return matches ? stdout() : { stdout: Buffer.alloc(0), stderr: Buffer.from("missing"), exitCode: 1 };
    }

    const rmIndex = args.indexOf("rm");
    if (rmIndex >= 0 && args[rmIndex + 1] === "-f") {
      const path = args.at(-1) ?? "";
      if (this.failPrivilegedHandoffCleanup && path.endsWith(".operator.cfg")) {
        return { stdout: Buffer.alloc(0), stderr: Buffer.from("cleanup failed"), exitCode: 1 };
      }
      this.files.delete(path);
      this.swapFileSizes.delete(path);
      return stdout();
    }
    if (rmIndex >= 0 && args[rmIndex + 1] === "-rf") {
      const root = args.at(-1) ?? "";
      for (const path of this.files.keys()) {
        if (path === root || path.startsWith(`${root}/`)) this.files.delete(path);
      }
      return stdout();
    }

    if (args.includes("operator")) {
      if (this.generateOperatorConfig) {
        const savePath = optionValue(args, "--save");
        const config = Buffer.from(JSON.stringify({
          operator: optionValue(args, "--name"),
          lhost: optionValue(args, "--lhost"),
          lport: Number(optionValue(args, "--lport")),
          token: "operator-token",
          ca_certificate: "ca-certificate",
          certificate: "operator-certificate",
          private_key: "private-key-material",
          ...this.operatorConfigOverrides,
        }));
        this.files.set(savePath, remoteFile(config, 0o600, 0));
      }
      return stdout(this.operatorStdout);
    }

    const chownIndex = args.indexOf("chown");
    if (chownIndex >= 0) {
      const file = this.files.get(args.at(-1) ?? "");
      if (file) {
        file.uid = args.includes("root:root") ? 0 : 1000;
        file.gid = file.uid;
      }
      return stdout();
    }
    const chmodIndex = args.indexOf("chmod");
    if (chmodIndex >= 0) {
      const file = this.files.get(args.at(-1) ?? "");
      if (file) file.mode = 0o100000 | Number.parseInt(args[chmodIndex + 1] ?? "0600", 8);
      return stdout();
    }
    if (args.includes("systemctl") && args.includes("is-active")) return stdout("active\n");
    return stdout();
  }

  private sftpObject(): SFTPWrapper {
    const owner = this;
    return {
      open(path: string, flags: string, modeOrCallback: number | ((error: Error | undefined, handle: Buffer) => void), maybeCallback?: (error: Error | undefined, handle: Buffer) => void): void {
        const callback = typeof modeOrCallback === "function" ? modeOrCallback : maybeCallback!;
        const mode = typeof modeOrCallback === "number" ? modeOrCallback : 0o600;
        if (flags === "wx" && owner.files.has(path)) {
          queueMicrotask(() => callback(sftpError(4), Buffer.alloc(0)));
          return;
        }
        if (flags === "r") owner.sftpReadPaths.push(path);
        if (flags === "r" && (
          path.startsWith(`${deploymentRoot}/`) ||
          (owner.failHandoffRead && path.endsWith(".operator.cfg")) ||
          !owner.files.has(path)
        )) {
          queueMicrotask(() => callback(sftpError(2), Buffer.alloc(0)));
          return;
        }
        if (flags === "wx") owner.files.set(path, remoteFile(Buffer.alloc(0), mode, 1000));
        const handle = Buffer.from(String(owner.nextHandle++));
        owner.handles.set(handle.toString("hex"), path);
        queueMicrotask(() => callback(undefined, handle));
      },
      close(_handle: Buffer, callback: (error?: Error) => void): void {
        if (owner.hangSftpClose) return;
        queueMicrotask(() => callback());
      },
      fstat(handle: Buffer, callback: (error: Error | undefined, stats: Stats) => void): void {
        const file = owner.fileForHandle(handle);
        queueMicrotask(() => callback(undefined, fakeStats(file)));
      },
      write(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: (error?: Error) => void): void {
        const file = owner.fileForHandle(handle);
        const path = owner.pathForHandle(handle);
        owner.lastWriteBuffer = buffer;
        if (owner.hangUnitWrite && path.endsWith(".service")) return;
        const required = position + length;
        if (file.data.length < required) {
          const expanded = Buffer.alloc(required);
          file.data.copy(expanded);
          file.data.fill(0);
          file.data = expanded;
        }
        buffer.copy(file.data, position, offset, offset + length);
        queueMicrotask(() => callback());
      },
      read(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: (error: Error | undefined, bytesRead: number, data: Buffer, readPosition: number) => void): void {
        const file = owner.fileForHandle(handle);
        const path = owner.pathForHandle(handle);
        const bytesRead = Math.min(length, Math.max(0, file.data.length - position));
        owner.lastReadBuffer = buffer;
        if (owner.hangHandoffRead && path.endsWith(".operator.cfg")) {
          file.data.copy(buffer, offset, position, position + Math.min(bytesRead, 16));
          owner.pendingRead = () => {
            file.data.copy(buffer, offset, position, position + bytesRead);
            callback(undefined, bytesRead, buffer, position);
          };
          return;
        }
        file.data.copy(buffer, offset, position, position + bytesRead);
        queueMicrotask(() => callback(undefined, bytesRead, buffer, position));
      },
      lstat(path: string, callback: (error: Error | undefined, stats: Stats) => void): void {
        const file = owner.files.get(path);
        queueMicrotask(() => file && !path.startsWith(`${deploymentRoot}/`)
          ? callback(undefined, fakeStats(file))
          : callback(sftpError(2), fakeStats(remoteFile(Buffer.alloc(0), 0o600, 0))));
      },
      unlink(path: string, callback: (error?: Error) => void): void {
        if (owner.hangSftpUnlink) return;
        const removed = owner.files.delete(path);
        queueMicrotask(() => callback(removed ? undefined : sftpError(2)));
      },
      end(): void {
        owner.sftpEnded = true;
      },
    } as unknown as SFTPWrapper;
  }

  private fileForHandle(handle: Buffer): FakeRemoteFile {
    const path = this.pathForHandle(handle);
    const file = this.files.get(path);
    if (!file) throw new Error("Unknown fake SFTP handle");
    return file;
  }

  private pathForHandle(handle: Buffer): string {
    const path = this.handles.get(handle.toString("hex"));
    if (path === undefined) throw new Error("Unknown fake SFTP handle");
    return path;
  }
}

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();

  close(): void {
    queueMicrotask(() => this.emit("close"));
  }
}

function quotedArguments(command: string): string[] {
  return [...command.matchAll(/'([^']*)'/gu)].map((match) => match[1] ?? "");
}

function optionValue(args: readonly string[], option: string): string {
  const index = args.indexOf(option);
  const value = args[index + 1];
  if (index < 0 || value === undefined) throw new Error(`Missing fake command option ${option}`);
  return value;
}

function remoteFile(data: Buffer, mode: number, uid: number, gid = uid, type = 0o100000): FakeRemoteFile {
  return { data, mode: type | mode, uid, gid, mtime: 1 };
}

function fakeStats(file: FakeRemoteFile): Stats {
  return {
    mode: file.mode,
    uid: file.uid,
    gid: file.gid,
    size: file.data.length,
    atime: 1,
    mtime: file.mtime,
    isDirectory: () => false,
    isFile: () => (file.mode & 0o170000) === 0o100000,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => (file.mode & 0o170000) === 0o120000,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function sftpError(code: number): Error {
  return Object.assign(new Error("fake SFTP failure"), { code });
}
