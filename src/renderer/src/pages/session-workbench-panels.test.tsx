import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type { SliverDesktopAPI } from "../../../shared/contracts";
import type {
  PrepareSessionDestructiveActionInput,
  SessionWorkbenchInput,
  SessionWorkbenchResult,
  SessionWorkbenchResultFor,
} from "../../../shared/session-contracts";
import type { SessionSummary } from "../../../shared/target-contracts";
import type { SessionWorkspacePanelContext } from "./SessionWorkspacePage";
import {
  SessionEnvironmentPanel,
  SessionFilesPanel,
  SessionOverviewPanel,
  SessionProcessesPanel,
  SessionRegistryPanel,
} from "./session-workbench-panels";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

afterEach(() => {
  cleanup();
});

const session: SessionSummary = {
  mode: "session",
  id: "session-1",
  name: "payments",
  hostname: "prod-linux",
  hostId: "host-1",
  username: "alice",
  uid: "1000",
  gid: "1000",
  os: "linux",
  arch: "amd64",
  transport: "mtls",
  remoteAddress: "10.0.0.8:4444",
  activeC2: "mtls://10.0.0.8:4444",
  executable: "/tmp/agent",
  version: "1.7.6",
  locale: "en-US",
  integrity: "High",
  burned: false,
  pid: 4001,
  liveness: "active",
};

function panelContext(overrides: Partial<SessionSummary> = {}): SessionWorkspacePanelContext {
  return {
    route: { sessionId: session.id, backendEpoch: 7, connectionIncarnation: 4 },
    session: { ...session, ...overrides },
    snapshot: disconnectedSnapshot(),
    onSnapshot: vi.fn(),
  };
}

type WorkbenchHandler = (input: SessionWorkbenchInput) => Promise<unknown> | unknown;

function installAPI(
  handler: WorkbenchHandler,
  overrides: {
    prepare?: (input: PrepareSessionDestructiveActionInput) => Promise<unknown> | unknown;
    execute?: (input: { token: string }) => Promise<unknown> | unknown;
  } = {},
) {
  const runSessionWorkbench = vi.fn(async (input: SessionWorkbenchInput) => handler(input));
  const prepareSessionDestructiveAction = vi.fn(async (input: PrepareSessionDestructiveActionInput) =>
    overrides.prepare?.(input) ?? { ok: false, error: "Not configured" });
  const executeSessionDestructiveActionPlan = vi.fn(async (input: { token: string }) =>
    overrides.execute?.(input) ?? { ok: false, error: "Not configured" });
  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: {
      runSessionWorkbench,
      prepareSessionDestructiveAction,
      executeSessionDestructiveActionPlan,
    } as unknown as SliverDesktopAPI,
  });
  return { executeSessionDestructiveActionPlan, prepareSessionDestructiveAction, runSessionWorkbench };
}

function workbench<I extends SessionWorkbenchResult["operationId"]>(
  operationId: I,
  value: SessionWorkbenchResultFor<I>,
) {
  return {
    ok: true as const,
    value: {
      status: "completed" as const,
      result: { operationId, value } as SessionWorkbenchResult,
    },
  };
}

describe("session workbench panels", () => {
  it("loads a read-only overview and captures then saves a bounded screenshot", async () => {
    const user = userEvent.setup();
    const api = installAPI((input) => {
      switch (input.operationId) {
        case "session.network.interfaces":
          return workbench(input.operationId, {
            items: [{ index: 2, name: "eth0", macAddress: "00:11:22:33:44:55", addresses: ["10.0.0.8/24"] }],
            page: { limit: 100, total: 1, truncated: false },
          });
        case "session.network.connections":
          return workbench(input.operationId, {
            items: [],
            page: { limit: 100, total: 0, truncated: false },
          });
        case "session.screenshot.capture":
          return workbench(input.operationId, {
            status: "captured",
            artifact: {
              handle: "A".repeat(43),
              suggestedBasename: "payments-screen.png",
              mediaType: "image/png",
              size: 68,
              sha256: "a".repeat(64),
              createdAt: "2026-08-09T20:00:00.000Z",
              expiresAt: "2099-08-10T00:00:00.000Z",
            },
            preview: {
              mediaType: "image/png",
              dataUrl: "data:image/png;base64,iVBORw0KGgo=",
              size: 68,
            },
          });
        case "session.artifact.save":
          return workbench(input.operationId, {
            status: "saved",
            suggestedBasename: "payments-screen.png",
            size: 68,
            sha256: "a".repeat(64),
          });
        default:
          throw new Error(`Unexpected operation ${input.operationId}`);
      }
    });

    render(<SessionOverviewPanel {...panelContext()} />);

    expect(screen.getByText("Loading session overview…")).toBeInTheDocument();
    expect(await screen.findByText("eth0")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.8/24")).toBeInTheDocument();
    expect(api.runSessionWorkbench).not.toHaveBeenCalledWith({ operationId: "session.identity.current-token-owner" });

    await user.click(screen.getByRole("button", { name: "Capture" }));
    expect(await screen.findByRole("img", { name: "Screenshot from payments" })).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
    await user.click(screen.getByRole("button", { name: "Save as…" }));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({ operationId: "session.artifact.save", handle: "A".repeat(43) });
  });

  it("keeps file actions native and requires a reviewed plan before deletion", async () => {
    const user = userEvent.setup();
    const file = {
      name: "report.txt",
      path: "/opt/report.txt",
      isDirectory: false,
      sizeBytes: "2048",
      modifiedAt: "2026-08-09T20:00:00.000Z",
      mode: "-rw-r--r--",
    };
    const api = installAPI((input) => {
      switch (input.operationId) {
        case "session.filesystem.pwd": return workbench(input.operationId, { path: "/opt" });
        case "session.filesystem.ls": return workbench(input.operationId, {
          path: "/opt",
          exists: true,
          items: [file],
          page: { limit: 100, total: 1, truncated: false },
        });
        case "session.filesystem.download": return workbench(input.operationId, { status: "canceled" });
        case "session.filesystem.upload-open": return workbench(input.operationId, { status: "canceled" });
        case "session.filesystem.mkdir": return workbench(input.operationId, {
          changed: true,
          message: "created",
          path: "/opt/archive",
        });
        default: throw new Error(`Unexpected operation ${input.operationId}`);
      }
    }, {
      prepare: (input) => ({
        ok: true,
        value: {
          status: "prepared",
          plan: {
            token: "review-token",
            expiresAt: "2026-08-10T00:00:00.000Z",
            payloadDigest: "b".repeat(64),
            action: input,
            target: { name: "payments", hostname: "prod-linux", os: "linux" },
            warning: "This removes the selected remote file.",
          },
        },
      }),
      execute: () => ({
        ok: true,
        value: {
          actionId: "session.filesystem.rm",
          status: "succeeded",
          message: "Removed /opt/report.txt",
          payloadDigest: "b".repeat(64),
        },
      }),
    });

    render(<SessionFilesPanel {...panelContext()} />);
    expect(await screen.findByRole("row", { name: /report\.txt/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Download report.txt" }));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith(expect.objectContaining({ operationId: "session.filesystem.download", path: file.path }));
    await user.click(screen.getByRole("button", { name: "Upload" }));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith(expect.objectContaining({ operationId: "session.filesystem.upload-open", remotePath: "/opt" }));

    await user.type(screen.getByRole("textbox", { name: "New folder name" }), "archive");
    await user.click(screen.getByRole("button", { name: "New folder" }));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({ operationId: "session.filesystem.mkdir", path: "/opt/archive" });

    await user.click(screen.getByRole("button", { name: "Delete report.txt" }));
    expect(await screen.findByRole("alertdialog", { name: "Delete this remote item?" })).toBeInTheDocument();
    expect(api.executeSessionDestructiveActionPlan).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm action" }));
    expect(api.prepareSessionDestructiveAction).toHaveBeenCalledWith({
      actionId: "session.filesystem.rm",
      path: file.path,
      recursive: false,
      force: false,
    });
    expect(api.executeSessionDestructiveActionPlan).toHaveBeenCalledWith({ token: "review-token" });
  });

  it("keeps sensitive environment values redacted until an explicit reveal", async () => {
    const user = userEvent.setup();
    installAPI((input) => {
      if (input.operationId === "session.environment.list") {
        return workbench(input.operationId, {
          items: [
            { name: "PATH", value: "/usr/bin", sensitive: false, redacted: false },
            { name: "API_TOKEN", sensitive: true, redacted: true },
          ],
          page: { limit: 500, total: 2, truncated: false },
        });
      }
      if (input.operationId === "session.environment.reveal") {
        return workbench(input.operationId, {
          name: input.name,
          value: "super-secret",
          sensitive: true,
          revealedAt: "2026-08-09T20:00:00.000Z",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    });

    render(<SessionEnvironmentPanel {...panelContext()} />);
    expect(await screen.findByText("/usr/bin")).toBeInTheDocument();
    expect(screen.queryByText("super-secret")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reveal" }));
    expect(await screen.findByText("super-secret")).toBeInTheDocument();
  });

  it("gates Windows-only process and registry surfaces", async () => {
    const api = installAPI((input) => {
      if (input.operationId === "session.process.list") {
        return workbench(input.operationId, {
          items: [{
            pid: 4001,
            parentPid: 1,
            executable: "agent",
            owner: "alice",
            architecture: "amd64",
            commandLine: ["agent", "--connect"],
          }],
          page: { limit: 100, total: 1, truncated: false },
        });
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    });

    const { rerender } = render(<SessionProcessesPanel {...panelContext()} />);
    expect(await screen.findByRole("row", { name: /agent/i })).toBeInTheDocument();
    expect(screen.queryByText("Services")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dump process 4001" })).not.toBeInTheDocument();

    rerender(<SessionRegistryPanel {...panelContext()} />);
    expect(screen.getByText("Registry unavailable")).toBeInTheDocument();
    expect(api.runSessionWorkbench.mock.calls.some(([input]) => String(input.operationId).startsWith("session.registry."))).toBe(false);
  });

  it("exposes Windows process dumps and a dedicated services segment", async () => {
    const user = userEvent.setup();
    const api = installAPI((input) => {
      switch (input.operationId) {
        case "session.process.list":
          return workbench(input.operationId, {
            items: [{
              pid: 4001,
              parentPid: 1,
              executable: "agent.exe",
              owner: "DOMAIN\\alice",
              architecture: "amd64",
              commandLine: ["agent.exe", "--connect"],
            }],
            page: { limit: 100, total: 1, truncated: false },
          });
        case "session.process.dump":
          return workbench(input.operationId, { status: "canceled" });
        case "session.service.list":
          return workbench(input.operationId, {
            items: [{
              name: "Spooler",
              displayName: "Print Spooler",
              description: "Queues print jobs",
              status: 4,
              startupType: 2,
              binaryPath: "C:\\Windows\\System32\\spoolsv.exe",
              account: "LocalSystem",
            }],
            page: { limit: 100, total: 1, truncated: false },
          });
        case "session.service.detail":
          return workbench(input.operationId, {
            name: "Spooler",
            displayName: "Print Spooler",
            description: "Queues print jobs",
            status: 4,
            startupType: 2,
            binaryPath: "C:\\Windows\\System32\\spoolsv.exe",
            account: "LocalSystem",
          });
        default: throw new Error(`Unexpected operation ${input.operationId}`);
      }
    });

    render(<SessionProcessesPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    expect(await screen.findByRole("row", { name: /agent\.exe/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dump process 4001" }));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({
      operationId: "session.process.dump",
      pid: 4001,
      dumpTimeoutSeconds: 120,
    });

    await user.click(screen.getByRole("radio", { name: "Services" }));
    const serviceRow = await screen.findByRole("row", { name: /Print Spooler/i });
    expect(screen.getByRole("button", { name: "Start Print Spooler" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop Print Spooler" })).toBeInTheDocument();
    await user.click(serviceRow);
    expect(await screen.findByText("C:\\Windows\\System32\\spoolsv.exe")).toBeInTheDocument();
  });

  it("browses and reads Windows registry values", async () => {
    const user = userEvent.setup();
    installAPI((input) => {
      switch (input.operationId) {
        case "session.registry.list-subkeys":
          return workbench(input.operationId, {
            items: ["Software"],
            page: { limit: 500, total: 1, truncated: false },
          });
        case "session.registry.list-values":
          return workbench(input.operationId, {
            items: ["InstallPath"],
            page: { limit: 500, total: 1, truncated: false },
          });
        case "session.registry.read":
          return workbench(input.operationId, { hive: input.hive, path: input.path, key: input.key, value: "C:\\Program Files\\Sliver" });
        default: throw new Error(`Unexpected operation ${input.operationId}`);
      }
    });

    render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    expect(await screen.findByRole("row", { name: /InstallPath/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Read InstallPath" }));
    expect(await screen.findByText("C:\\Program Files\\Sliver")).toBeInTheDocument();
  });

  it("renders a retryable error state", async () => {
    installAPI(() => {
      throw new Error("Session RPC timed out");
    });
    render(<SessionEnvironmentPanel {...panelContext()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Session RPC timed out");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
