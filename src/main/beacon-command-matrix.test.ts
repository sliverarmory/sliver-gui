// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clientpb } from "sliver-script";
import { SliverRPCDefinition } from "sliver-script/lib/pb/rpcpb/services.js";

import { normalizeBeaconSummary, normalizeSessionSummary } from "./target-store.js";
import {
  BEACON_COMMAND_BASELINE_COMMIT,
  BEACON_COMMAND_MATRIX,
  BEACON_RESPONSE_CEILINGS,
  PINNED_COMPILER_TARGET_ARCHITECTURES,
  beaconCommandCapability,
} from "./beacon-command-matrix.js";

interface ReviewedParityCommand {
  id: string;
  milestone: string;
  meaningfulOptions: string[];
  restrictionReview: { targetModes: string[] };
}

const annotations = JSON.parse(readFileSync(new URL("../../docs/operator-parity.annotations.json", import.meta.url), "utf8")) as {
  baselineCommit: string;
  commands: ReviewedParityCommand[];
};
const generated = JSON.parse(readFileSync(new URL("../../docs/operator-parity.generated.json", import.meta.url), "utf8")) as {
  baseline: { commit: string };
  commands: Array<{ id: string; source: { file: string; line: number } }>;
};

/** Reviewed paths from the pinned Sliver checkout, which CI need not clone. */
const PINNED_RUNTIME_FILES = new Set([
  "client/command/exec/psexec.go",
  "client/command/exec/ssh.go",
  "client/command/environment/commands.go",
  "client/command/info/info.go",
  "client/command/pivots/commands.go",
  "client/command/reconfig/rename.go",
  "client/command/screenshot/screenshot.go",
  "client/command/sessions/background.go",
  "client/command/sessions/close.go",
  "client/command/sessions/interactive.go",
  "client/command/wireguard/commands.go",
  "implant/sliver/handlers/handlers_darwin.go",
  "implant/sliver/handlers/handlers_linux.go",
  "implant/sliver/handlers/handlers_windows.go",
  "implant/sliver/handlers/tun.go",
  "implant/sliver/runner/runner.go",
  "server/rpc/rpc-backdoor.go",
  "server/rpc/rpc-beacons.go",
  "server/rpc/rpc-hijack.go",
  "server/rpc/rpc-kill.go",
  "server/rpc/rpc-reconfig.go",
  "server/rpc/rpc-sessions.go",
  "server/rpc/rpc-shell.go",
  "server/rpc/rpc.go",
]);

function beacon(os = "linux", arch = "amd64", transport = "mtls") {
  return normalizeBeaconSummary(clientpb.Beacon.create({
    ID: "beacon-1",
    UUID: "host-1",
    OS: os,
    Arch: arch,
    Transport: transport,
  }));
}

describe("beacon command matrix", () => {
  it("covers exactly the pinned beacon-visible parity rows, source locations, and reviewed options", () => {
    expect(BEACON_COMMAND_BASELINE_COMMIT).toBe(annotations.baselineCommit);
    expect(BEACON_COMMAND_BASELINE_COMMIT).toBe(generated.baseline.commit);
    const visible = annotations.commands.filter((row) => row.restrictionReview.targetModes.includes("beacon"));
    expect(visible).toHaveLength(92);
    expect(Object.keys(BEACON_COMMAND_MATRIX).sort()).toEqual(visible.map((row) => row.id).sort());
    const sourceById = new Map(generated.commands.map((row) => [row.id, {
      file: row.source.file,
      line: row.source.line,
    }]));

    for (const row of visible) {
      const descriptor = BEACON_COMMAND_MATRIX[row.id as keyof typeof BEACON_COMMAND_MATRIX];
      expect(descriptor.milestone, row.id).toBe(row.milestone);
      expect(descriptor.source, row.id).toEqual(sourceById.get(row.id));
      expect(descriptor.consoleOptions, row.id).toEqual(row.meaningfulOptions);
      const boundary = descriptor.optionBoundary;
      const classified = [
        ...boundary.request,
        ...boundary.local,
        ...boundary.main,
        ...boundary.pending,
      ];
      expect(classified.length, row.id).toBe(new Set(classified).size);
      expect(classified.sort(), row.id).toEqual([...row.meaningfulOptions].sort());
      expect(descriptor.runtimeEvidence.length, row.id).toBeGreaterThan(0);
      for (const file of descriptor.runtimeEvidence) {
        expect(PINNED_RUNTIME_FILES.has(file) || generated.commands.some((source) => source.source.file === file), `${row.id}: ${file}`).toBe(true);
      }
    }
  });

  it("records task request/response identity and finite current or proposed bounds", () => {
    const rpcMethods = new Set<string>(Object.values(SliverRPCDefinition.methods).map((method) => method.name));
    for (const [id, descriptor] of Object.entries(BEACON_COMMAND_MATRIX)) {
      for (const step of descriptor.protocol) {
        expect(rpcMethods.has(step.rpcMethod), `${id}: ${step.rpcMethod}`).toBe(true);
        expect(step.rpcRequestType).toMatch(/^[A-Z][A-Za-z0-9]*$/u);
        expect(step.rpcResponseType).toMatch(/^[A-Z][A-Za-z0-9]*$/u);
      }
    }
    const tasks = Object.values(BEACON_COMMAND_MATRIX).flatMap((row) => {
      if (row.route.kind === "task") return [row.route];
      if (row.route.kind === "existing-execution") return [row.route.task];
      if (row.route.kind === "existing-main" && row.route.task) return [row.route.task];
      return [];
    });
    expect(tasks.length).toBeGreaterThan(40);
    for (const route of tasks) {
      expect(route.steps.length).toBeGreaterThan(0);
      expect(route.maximumResponseBytes).toBe(BEACON_RESPONSE_CEILINGS[route.responsePolicy]);
      expect(Number.isSafeInteger(route.maximumResponseBytes)).toBe(true);
      if (route.responsePolicy === "none") {
        expect(route.maximumResponseBytes).toBe(0);
        expect(route.steps.every((step) => step.taskResponseType === "none")).toBe(true);
      } else {
        expect(route.maximumResponseBytes).toBeGreaterThan(0);
      }
      for (const step of route.steps) {
        expect(step.rpcMethod).toMatch(/^[A-Z][A-Za-z0-9]*$/u);
        expect(step.requestType).toMatch(/^[A-Z][A-Za-z0-9]*$/u);
        expect(step.responseType).toMatch(/^[A-Z][A-Za-z0-9]*$/u);
        if (step.taskResponseType === "none") {
          expect(step).toMatchObject({
            requestType: "Request",
            rpcRequestType: "KillReq",
            taskDescription: "KillReq",
          });
        } else {
          expect(step.taskDescription).toBe(step.requestType);
        }
      }
    }
    expect(BEACON_RESPONSE_CEILINGS["current-preview"]).toBe(64 * 1024);
    expect(BEACON_RESPONSE_CEILINGS["proposed-bounded-fetch"]).toBe(1024 * 1024);
    expect(BEACON_RESPONSE_CEILINGS["proposed-native-artifact"]).toBe(64 * 1024 * 1024);
    expect(BEACON_COMMAND_MATRIX["implant.msf-inject"].protocol).toEqual([
      { rpcMethod: "MsfRemote", rpcRequestType: "MSFRemoteReq", rpcResponseType: "Task" },
    ]);
    expect(BEACON_COMMAND_MATRIX["implant.msf-inject"].route).toMatchObject({
      task: { steps: [{ requestType: "TaskReq", rpcRequestType: "MSFRemoteReq" }] },
    });
    expect(BEACON_COMMAND_MATRIX["implant.kill"].route).toMatchObject({
      kind: "existing-main",
      task: { steps: [{ requestType: "Request", rpcRequestType: "KillReq", taskDescription: "KillReq", responseType: "Empty", taskResponseType: "none" }], effectProof: "unverifiable" },
    });
  });

  it("keeps M2 metadata, navigation, hybrid, and composite workflows distinct", () => {
    const m2 = Object.entries(BEACON_COMMAND_MATRIX).filter(([, row]) => row.milestone === "M2");
    expect(m2).toHaveLength(45);
    expect(BEACON_COMMAND_MATRIX["implant.getpid"].route).toMatchObject({ kind: "metadata", fields: ["pid"] });
    expect(BEACON_COMMAND_MATRIX["implant.getuid"].route).toMatchObject({ kind: "metadata", fields: ["uid"] });
    expect(BEACON_COMMAND_MATRIX["implant.getgid"].route).toMatchObject({ kind: "metadata", fields: ["gid"] });
    expect(BEACON_COMMAND_MATRIX["implant.whoami"].route).toMatchObject({
      kind: "hybrid",
      fields: ["username"],
      windowsSteps: [{ taskDescription: "CurrentTokenOwnerReq" }],
    });
    expect(BEACON_COMMAND_MATRIX["implant.registry"].route.kind).toBe("navigation");
    expect(BEACON_COMMAND_MATRIX["implant.env"].route).toMatchObject({ kind: "task", steps: [{ requestType: "EnvReq" }] });
    expect(BEACON_COMMAND_MATRIX["implant.memfiles"].route).toMatchObject({ kind: "task", steps: [{ requestType: "MemfilesListReq" }] });
    expect(BEACON_COMMAND_MATRIX["implant.services"].route).toMatchObject({ kind: "task", steps: [{ requestType: "ServicesReq" }] });
    expect(BEACON_COMMAND_MATRIX["implant.edit"].route).toMatchObject({
      kind: "task",
      steps: [{ requestType: "DownloadReq" }, { requestType: "UploadReq" }],
    });
  });

  it("exposes the six BC-03 execution commands through their closed current response boundary", () => {
    const delivered = [
      ["implant.execute.children", "execution.children", "ExecuteChildrenReq"],
      ["implant.getprivs", "privilege.get", "GetPrivsReq"],
      ["implant.runas", "privilege.run-as", "RunAsReq"],
      ["implant.make-token", "privilege.make-token", "MakeTokenReq"],
      ["implant.impersonate", "privilege.impersonate", "ImpersonateReq"],
      ["implant.rev2self", "privilege.revert", "RevToSelfReq"],
    ] as const;
    for (const [id, operationId, description] of delivered) {
      const row = BEACON_COMMAND_MATRIX[id];
      expect(row.delivery).toBe("existing");
      expect(row.route).toMatchObject({
        kind: "existing-execution",
        executionOperationId: operationId,
        task: {
          responsePolicy: "current-execution",
          maximumResponseBytes: BEACON_RESPONSE_CEILINGS["current-execution"],
          steps: [{ taskDescription: description }],
        },
      });
      expect(beaconCommandCapability(id, beacon("windows"))).toEqual({ available: true });
    }
    expect(beaconCommandCapability("implant.execute.children", beacon("linux"))).toEqual({ available: true });
    expect(beaconCommandCapability("implant.getprivs", beacon("linux"))).toEqual({ available: false, reason: "unsupported-platform" });
    expect(BEACON_COMMAND_MATRIX["implant.runas"].optionBoundary.pending).toEqual([]);
    expect(BEACON_COMMAND_MATRIX["implant.make-token"].optionBoundary.pending).toEqual([]);
  });

  it("fails closed for unknown, future, unsupported, and unknown-target routes", () => {
    expect(beaconCommandCapability("implant.unknown", beacon())).toEqual({ available: false, reason: "unknown-command" });
    expect(beaconCommandCapability("implant.netstat", beacon())).toEqual({ available: false, reason: "not-delivered" });
    expect(beaconCommandCapability("implant.pwd", beacon())).toEqual({ available: true });
    expect(beaconCommandCapability("implant.pwd", beacon("freebsd"))).toEqual({ available: false, reason: "unsupported-platform" });
    expect(beaconCommandCapability("implant.pwd", beacon("linux", "unknown"))).toEqual({ available: false, reason: "unsupported-architecture" });
    expect(beaconCommandCapability("implant.pwd", beacon("linux", "amd64", "unknown"))).toEqual({ available: false, reason: "unsupported-transport" });
    expect(PINNED_COMPILER_TARGET_ARCHITECTURES.darwin).toEqual(["amd64", "arm64"]);
    expect(BEACON_COMMAND_MATRIX["implant.pwd"].architecturesByPlatform.darwin).toEqual(["amd64", "arm64"]);
    expect(beaconCommandCapability("implant.pwd", beacon("darwin", "386"))).toEqual({ available: false, reason: "unsupported-architecture" });
    expect(beaconCommandCapability("implant.wg-socks", beacon("linux", "amd64", "wg")).available).toBe(false);
    const session = normalizeSessionSummary(clientpb.Session.create({ ID: "session-1", UUID: "host-1", OS: "linux", Arch: "amd64", Transport: "mtls" }));
    expect(beaconCommandCapability("implant.pwd", session)).toEqual({ available: false, reason: "requires-beacon" });
  });

  it("records pinned platform and option boundaries without treating console visibility as runtime support", () => {
    expect(BEACON_COMMAND_MATRIX["implant.memfiles"].platforms).toEqual(["linux"]);
    expect(BEACON_COMMAND_MATRIX["implant.chmod"].platforms).toEqual(["linux", "darwin"]);
    expect(BEACON_COMMAND_MATRIX["implant.screenshot"].platforms).toEqual(["windows", "linux"]);
    expect(BEACON_COMMAND_MATRIX["implant.registry.read"].platforms).toEqual(["windows"]);
    expect(BEACON_COMMAND_MATRIX["implant.services"].platforms).toEqual(["windows"]);
    expect(BEACON_COMMAND_MATRIX["implant.head"].optionBoundary.request).toEqual(expect.arrayContaining(["bytes", "lines"]));
    expect(BEACON_COMMAND_MATRIX["implant.hex-edit"].optionBoundary.request).toContain("max-size");
    expect(BEACON_COMMAND_MATRIX["implant.ps"].optionBoundary.local).toContain("pid");
    expect(BEACON_COMMAND_MATRIX["implant.wg-socks"].transports).toEqual(["wg"]);
    expect(BEACON_COMMAND_MATRIX["implant.pivots.graph"].route.kind).toBe("operator-workflow");
    expect(BEACON_COMMAND_MATRIX["implant.backdoor"].support).toBe("session-only");
    expect(BEACON_COMMAND_MATRIX["implant.ssh"].support).toBe("pending-runtime");
  });
});
