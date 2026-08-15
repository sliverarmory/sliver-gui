import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "@heroui/react";
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
  pathBreadcrumbs,
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
  Object.defineProperty(Element.prototype, "setPointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(Element.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => undefined,
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  Reflect.deleteProperty(Element.prototype, "setPointerCapture");
  Reflect.deleteProperty(Element.prototype, "releasePointerCapture");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
    route: {
      sessionId: session.id,
      backendEpoch: 7,
      connectionIncarnation: 4,
      targetFingerprint: "a".repeat(64),
    },
    session: { ...session, ...overrides },
    snapshot: disconnectedSnapshot(),
    onSnapshot: vi.fn(),
  };
}

type WorkbenchHandler = (input: SessionWorkbenchInput) => Promise<unknown> | unknown;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

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

function preparedAction(
  action: PrepareSessionDestructiveActionInput,
  artifact?: { suggestedBasename: string; size: number; sha256: string },
) {
  return {
    ok: true as const,
    value: {
      status: "prepared" as const,
      plan: {
        token: `review-${action.actionId}`,
        expiresAt: "2099-08-10T00:00:00.000Z",
        payloadDigest: "b".repeat(64),
        action,
        target: {
          backend: { id: "backend-1", displayName: "Production" },
          sessionId: "session-1",
          fingerprint: "a".repeat(64),
          name: "payments",
          hostname: "prod-linux",
          os: "linux",
        },
        warning: "Review the exact remote target before execution.",
        ...(artifact ? { artifact } : {}),
      },
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

    expect(screen.getByText("session-1")).toBeInTheDocument();
    expect(await screen.findByText("eth0")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.8/24")).toBeInTheDocument();
    expect(api.runSessionWorkbench).not.toHaveBeenCalledWith({ operationId: "session.identity.current-token-owner" });

    await user.click(screen.getByRole("button", { name: "Capture" }));
    expect(await screen.findByRole("img", { name: "Screenshot from payments" })).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
    await user.click(screen.getByRole("button", { name: "Save as…" }));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({ operationId: "session.artifact.save", handle: "A".repeat(43) });
  });

  it("keeps healthy overview resources visible when optional identity fails and pages network inventories independently", async () => {
    const user = userEvent.setup();
    let identityAttempts = 0;
    const api = installAPI((input) => {
      switch (input.operationId) {
        case "session.identity.current-token-owner":
          identityAttempts += 1;
          if (identityAttempts === 1) throw new Error("Token owner unavailable");
          return workbench(input.operationId, {
            tokenOwner: "DOMAIN\\alice",
            username: "alice",
            uid: "1000",
            gid: "1000",
            pid: 4001,
            executable: "C:\\agent.exe",
            hostname: "prod-win",
            os: "windows",
            arch: "amd64",
          });
        case "session.network.interfaces":
          return workbench(input.operationId, {
            items: input.cursor
              ? [{ index: 2, name: "vpn0", macAddress: "66:77:88:99:aa:bb", addresses: ["172.16.0.8/24"] }]
              : [{ index: 1, name: "eth0", macAddress: "00:11:22:33:44:55", addresses: ["10.0.0.8/24"] }],
            page: input.cursor
              ? { limit: 100, total: 2, truncated: true }
              : { limit: 100, total: 2, truncated: true, nextCursor: "interfaces-2" },
          });
        case "session.network.connections":
          return workbench(input.operationId, {
            items: input.cursor ? [{
              protocol: "udp",
              state: "",
              local: { address: "0.0.0.0", port: 53 },
            }] : [{
              protocol: "tcp",
              state: "ESTABLISHED",
              local: { address: "10.0.0.8", port: 4444 },
              remote: { address: "10.0.0.1", port: 443 },
            }],
            page: input.cursor
              ? { limit: 100, total: 2, truncated: true }
              : { limit: 100, total: 2, truncated: true, nextCursor: "connections-2" },
          });
        default: throw new Error(`Unexpected operation ${input.operationId}`);
      }
    });

    render(<SessionOverviewPanel {...panelContext({ os: "windows", arch: "amd64", hostname: "prod-win" })} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Token owner unavailable");
    expect(screen.getByText("session-1")).toBeInTheDocument();
    expect(screen.getByText("host-1")).toBeInTheDocument();
    expect(screen.getByText("1.7.6")).toBeInTheDocument();
    expect(await screen.findByText("eth0")).toBeInTheDocument();
    expect(screen.getAllByText("10.0.0.8:4444")).toHaveLength(2);
    expect(screen.getByText("Loaded 1 of 2 interfaces · bounded")).toBeInTheDocument();
    expect(screen.getByText("Loaded 1 of 2 connections · bounded")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("DOMAIN\\alice")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more interfaces" }));
    await user.click(screen.getByRole("button", { name: "Load more connections" }));
    expect(await screen.findByText("vpn0")).toBeInTheDocument();
    expect(await screen.findByText("0.0.0.0:53")).toBeInTheDocument();
    expect(screen.getByText("Loaded 2 of 2 interfaces")).toBeInTheDocument();
    expect(screen.getByText("Loaded 2 of 2 connections")).toBeInTheDocument();
    expect(screen.queryByText("The server returned a truncated interfaces result.")).not.toBeInTheDocument();
    expect(screen.queryByText("The server returned a truncated connections result.")).not.toBeInTheDocument();
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({ operationId: "session.network.interfaces", limit: 100, cursor: "interfaces-2" });
    expect(api.runSessionWorkbench).toHaveBeenCalledWith(expect.objectContaining({ operationId: "session.network.connections", cursor: "connections-2", limit: 100 }));
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
            target: {
              backend: { id: "backend-1", displayName: "Production" },
              sessionId: "session-1",
              fingerprint: "a".repeat(64),
              name: "payments",
              hostname: "prod-linux",
              os: "linux",
            },
            warning: "This removes the selected remote file.",
            ...(input.actionId === "session.filesystem.upload-overwrite" ? {
              artifact: {
                suggestedBasename: "replacement.txt",
                size: 12,
                sha256: "f".repeat(64),
              },
            } : {}),
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

    await user.click(screen.getByRole("button", { name: "More actions for report.txt" }));
    await user.click(await screen.findByRole("menuitem", { name: "Download" }));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith(expect.objectContaining({ operationId: "session.filesystem.download", path: file.path }));
    await user.click(screen.getByRole("button", { name: "Upload" }));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith(expect.objectContaining({ operationId: "session.filesystem.upload-open", remotePath: "/opt" }));

    await user.type(screen.getByRole("textbox", { name: "New folder name" }), "archive");
    await user.click(screen.getByRole("button", { name: "New folder" }));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({ operationId: "session.filesystem.mkdir", path: "/opt/archive" });

    await user.click(screen.getByRole("button", { name: "More actions for report.txt" }));
    await user.click(await screen.findByRole("menuitem", { name: /Delete/ }));
    expect(await screen.findByRole("alertdialog", { name: "Delete this remote item?" })).toBeInTheDocument();
    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getByTitle("Production (backend-1)")).toHaveTextContent("backend-1");
    expect(screen.getByTitle("session-1")).toHaveTextContent("session-1");
    expect(screen.getByTitle("a".repeat(64))).toHaveTextContent("a".repeat(64));
    expect(api.executeSessionDestructiveActionPlan).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm action" }));
    expect(api.prepareSessionDestructiveAction).toHaveBeenCalledWith({
      actionId: "session.filesystem.rm",
      path: file.path,
      recursive: false,
      force: false,
    });
    expect(api.executeSessionDestructiveActionPlan).toHaveBeenCalledWith({ token: "review-token" });

    await user.click(await screen.findByRole("button", { name: "More actions for report.txt" }));
    await user.click(await screen.findByRole("menuitem", { name: /Upload replacement/ }));
    expect(await screen.findByRole("alertdialog", { name: "Overwrite this remote file?" })).toBeInTheDocument();
    expect(screen.getByTitle("f".repeat(64))).toHaveTextContent(`SHA-256 ${"f".repeat(64)}`);
  });

  it("retries an initial working-directory failure and renders an explicit empty directory state", async () => {
    const user = userEvent.setup();
    let pwdAttempts = 0;
    const api = installAPI((input) => {
      if (input.operationId === "session.filesystem.pwd") {
        pwdAttempts += 1;
        if (pwdAttempts === 1) throw new Error("Working directory unavailable");
        return workbench(input.operationId, { path: "/empty" });
      }
      if (input.operationId === "session.filesystem.ls") {
        return workbench(input.operationId, {
          path: input.path,
          exists: true,
          items: [],
          page: { limit: 100, total: 0, truncated: false },
        });
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    });

    render(<SessionFilesPanel {...panelContext()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Working directory unavailable");
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("This directory is empty.")).toBeInTheDocument();
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({ operationId: "session.filesystem.pwd" });
    expect(pwdAttempts).toBe(2);
  });

  it("keeps the latest file navigation when an older same-route page request finishes late", async () => {
    const user = userEvent.setup();
    const olderPage = deferred<unknown>();
    const newerDirectory = deferred<unknown>();
    installAPI((input) => {
      if (input.operationId === "session.filesystem.pwd") {
        return workbench(input.operationId, { path: "/base" });
      }
      if (input.operationId !== "session.filesystem.ls") {
        throw new Error(`Unexpected operation ${input.operationId}`);
      }
      if (input.path === "/base" && input.cursor === "older-page") return olderPage.promise;
      if (input.path === "/next") return newerDirectory.promise;
      return workbench(input.operationId, {
        path: "/base",
        exists: true,
        items: [{
          name: "next",
          path: "/next",
          isDirectory: true,
          sizeBytes: "0",
          mode: "drwxr-xr-x",
        }],
        page: { limit: 100, total: 2, truncated: true, nextCursor: "older-page" },
      });
    });

    render(<SessionFilesPanel {...panelContext()} />);
    expect(await screen.findByRole("row", { name: /next/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await user.click(screen.getByRole("row", { name: /next/i }));

    await act(async () => {
      newerDirectory.resolve(workbench("session.filesystem.ls", {
        path: "/next",
        exists: true,
        items: [{
          name: "new.txt",
          path: "/next/new.txt",
          isDirectory: false,
          sizeBytes: "12",
          mode: "-rw-r--r--",
        }],
        page: { limit: 100, total: 1, truncated: false },
      }));
    });
    expect(await screen.findByRole("row", { name: /new\.txt/i })).toBeInTheDocument();

    await act(async () => {
      olderPage.resolve(workbench("session.filesystem.ls", {
        path: "/base",
        exists: true,
        items: [{
          name: "old.txt",
          path: "/base/old.txt",
          isDirectory: false,
          sizeBytes: "8",
          mode: "-rw-r--r--",
        }],
        page: { limit: 100, total: 2, truncated: false },
      }));
    });

    expect(screen.getByRole("grid", { name: "Files in /next" })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /old\.txt/i })).not.toBeInTheDocument();
  });

  it("keeps a failed requested path separate from the committed directory and disables location mutations", async () => {
    const user = userEvent.setup();
    installAPI((input) => {
      if (input.operationId === "session.filesystem.pwd") return workbench(input.operationId, { path: "/base" });
      if (input.operationId === "session.filesystem.ls" && input.path === "/base") {
        return workbench(input.operationId, {
          path: "/base",
          exists: true,
          items: [],
          page: { limit: 100, total: 0, truncated: false },
        });
      }
      if (input.operationId === "session.filesystem.ls" && input.path === "/missing") {
        throw new Error("Directory does not exist");
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    });

    render(<SessionFilesPanel {...panelContext()} />);
    const pathInput = await screen.findByRole("textbox", { name: "Remote path" });
    await waitFor(() => expect(pathInput).toHaveValue("/base"));
    await user.clear(pathInput);
    await user.type(pathInput, "/missing");
    await user.click(screen.getByRole("button", { name: "Go" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Directory does not exist");
    expect(pathInput).toHaveValue("/missing");
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh directory" })).toBeDisabled();
  });

  it("treats an exists-false listing as a retryable missing path without enabling location actions", async () => {
    const user = userEvent.setup();
    const api = installAPI((input) => {
      if (input.operationId === "session.filesystem.pwd") return workbench(input.operationId, { path: "/base" });
      if (input.operationId === "session.filesystem.ls" && input.path === "/base") {
        return workbench(input.operationId, {
          path: "/base",
          exists: true,
          items: [],
          page: { limit: 100, total: 0, truncated: false },
        });
      }
      if (input.operationId === "session.filesystem.ls" && input.path === "/missing") {
        return workbench(input.operationId, {
          path: "/missing",
          exists: false,
          items: [],
          page: { limit: 100, total: 0, truncated: false },
        });
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    });

    render(<SessionFilesPanel {...panelContext()} />);
    const pathInput = await screen.findByRole("textbox", { name: "Remote path" });
    await waitFor(() => expect(pathInput).toHaveValue("/base"));
    await user.clear(pathInput);
    await user.type(pathInput, "/missing");
    await user.click(screen.getByRole("button", { name: "Go" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Remote path /missing does not exist");
    expect(pathInput).toHaveValue("/missing");
    expect(screen.queryByText("This directory is empty.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh directory" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.runSessionWorkbench.mock.calls.filter(([input]) =>
      input.operationId === "session.filesystem.ls" && input.path === "/missing")).toHaveLength(2));
  });

  it("treats a confirmed mutation failure as danger rather than an outcome-unknown warning", async () => {
    const user = userEvent.setup();
    const danger = vi.spyOn(toast, "danger");
    const warning = vi.spyOn(toast, "warning");
    installAPI((input) => {
      if (input.operationId === "session.filesystem.pwd") return workbench(input.operationId, { path: "/base" });
      if (input.operationId === "session.filesystem.ls") {
        return workbench(input.operationId, {
          path: "/base",
          exists: true,
          items: [],
          page: { limit: 100, total: 0, truncated: false },
        });
      }
      if (input.operationId === "session.filesystem.mkdir") {
        return {
          ok: true,
          value: {
            status: "failed",
            operationId: input.operationId,
            message: "Access denied",
          },
        };
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    });

    render(<SessionFilesPanel {...panelContext()} />);
    expect(await screen.findByText("This directory is empty.")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "New folder name" }), "blocked");
    await user.click(screen.getByRole("button", { name: "New folder" }));

    await waitFor(() => expect(danger).toHaveBeenCalledWith("Could not create folder", { description: "Access denied" }));
    expect(warning).not.toHaveBeenCalledWith("Folder outcome unknown", expect.anything());
  });

  it("inspects bounded text and hex views and stages exact digest-bound save plans", async () => {
    const user = userEvent.setup();
    const digest = "c".repeat(64);
    const file = {
      name: "notes.txt",
      path: "/opt/notes.txt",
      isDirectory: false,
      sizeBytes: "5",
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
        case "session.filesystem.cat": return workbench(input.operationId, {
          path: file.path,
          mode: "cat",
          encoding: "utf-8",
          content: "hello",
          bytesRead: 5,
          truncated: false,
          sha256: digest,
        });
        case "session.filesystem.head": return workbench(input.operationId, {
          path: file.path,
          mode: "head",
          encoding: "utf-8",
          content: "partial",
          bytesRead: 65_536,
          truncated: true,
        });
        case "session.filesystem.read-hex": return workbench(input.operationId, {
          path: file.path,
          hex: "68656c6c6f",
          bytesRead: 5,
          truncated: false,
          sha256: digest,
        });
        case "session.filesystem.stage-text": return workbench(input.operationId, {
          status: "staged",
          artifact: {
            handle: "T".repeat(43),
            suggestedBasename: "edit.txt",
            mediaType: "text/plain;charset=utf-8",
            size: 7,
            sha256: "d".repeat(64),
            createdAt: "2026-08-09T20:00:00.000Z",
            expiresAt: "2099-08-10T00:00:00.000Z",
          },
        });
        case "session.filesystem.stage-hex": return workbench(input.operationId, {
          status: "staged",
          artifact: {
            handle: "H".repeat(43),
            suggestedBasename: "patch.bin",
            mediaType: "application/octet-stream",
            size: 2,
            sha256: "e".repeat(64),
            createdAt: "2026-08-09T20:00:00.000Z",
            expiresAt: "2099-08-10T00:00:00.000Z",
          },
        });
        default: throw new Error(`Unexpected operation ${input.operationId}`);
      }
    }, { prepare: (input) => preparedAction(input) });

    render(<SessionFilesPanel {...panelContext()} />);
    await user.click(await screen.findByRole("row", { name: /notes\.txt/i }));
    expect(await screen.findByRole("dialog", { name: "notes.txt" })).toBeInTheDocument();
    expect(await screen.findByText("Complete file")).toBeInTheDocument();
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({
      operationId: "session.filesystem.cat",
      path: file.path,
      maxBytes: 65_536,
    });

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const textEditor = screen.getByRole("textbox", { name: "UTF-8 text" });
    await user.clear(textEditor);
    await user.type(textEditor, "updated");
    await user.click(screen.getByRole("button", { name: "Review save" }));
    await waitFor(() => expect(api.prepareSessionDestructiveAction).toHaveBeenCalledWith({
      actionId: "session.filesystem.edit-text-overwrite",
      contentHandle: "T".repeat(43),
      remotePath: file.path,
      encoding: "utf-8",
      expectedSha256: digest,
    }));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({
      operationId: "session.filesystem.stage-text",
      content: "updated",
      encoding: "utf-8",
    });
    expect(await screen.findByRole("alertdialog", { name: "Save changes to this remote file?" })).toBeInTheDocument();
    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getByTitle("a".repeat(64))).toHaveTextContent("a".repeat(64));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("radio", { name: "Hex" }));
    expect(await screen.findByText("68656c6c6f")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const hexEditor = screen.getByRole("textbox", { name: "Hex bytes" });
    await user.clear(hexEditor);
    await user.type(hexEditor, "00ff");
    await user.click(screen.getByRole("button", { name: "Review save" }));
    await waitFor(() => expect(api.prepareSessionDestructiveAction).toHaveBeenCalledWith({
      actionId: "session.filesystem.patch-hex",
      patchHandle: "H".repeat(43),
      remotePath: file.path,
      expectedSha256: digest,
    }));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({ operationId: "session.filesystem.stage-hex", hex: "00ff" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("radio", { name: "Head" }));
    expect(await screen.findByText("Truncated at 64 KiB")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("keeps the latest inspector view when an older same-file response finishes late", async () => {
    const user = userEvent.setup();
    const lateCat = deferred<unknown>();
    const file = { name: "race.txt", path: "/race.txt", isDirectory: false, sizeBytes: "4", mode: "-rw-r--r--" };
    installAPI((input) => {
      if (input.operationId === "session.filesystem.pwd") return workbench(input.operationId, { path: "/" });
      if (input.operationId === "session.filesystem.ls") return workbench(input.operationId, {
        path: "/",
        exists: true,
        items: [file],
        page: { limit: 100, total: 1, truncated: false },
      });
      if (input.operationId === "session.filesystem.cat") return lateCat.promise;
      if (input.operationId === "session.filesystem.read-hex") return workbench(input.operationId, {
        path: file.path,
        hex: "6e6577",
        bytesRead: 3,
        truncated: false,
        sha256: "f".repeat(64),
      });
      throw new Error(`Unexpected operation ${input.operationId}`);
    });

    render(<SessionFilesPanel {...panelContext()} />);
    await user.click(await screen.findByRole("row", { name: /race\.txt/i }));
    await user.click(screen.getByRole("radio", { name: "Hex" }));
    expect(await screen.findByText("6e6577")).toBeInTheDocument();

    await act(async () => {
      lateCat.resolve(workbench("session.filesystem.cat", {
        path: file.path,
        mode: "cat",
        encoding: "utf-8",
        content: "stale text",
        bytesRead: 10,
        truncated: false,
        sha256: "1".repeat(64),
      }));
    });
    expect(screen.getByText("6e6577")).toBeInTheDocument();
    expect(screen.queryByText("stale text")).not.toBeInTheDocument();
  });

  it("shows retryable bounded grep results with recursive context and paging", async () => {
    const user = userEvent.setup();
    let firstAttempt = true;
    const api = installAPI((input) => {
      if (input.operationId === "session.filesystem.pwd") return workbench(input.operationId, { path: "/opt" });
      if (input.operationId === "session.filesystem.ls") return workbench(input.operationId, {
        path: "/opt",
        exists: true,
        items: [],
        page: { limit: 100, total: 0, truncated: false },
      });
      if (input.operationId === "session.filesystem.grep") {
        if (firstAttempt) {
          firstAttempt = false;
          throw new Error("Search timed out");
        }
        return workbench(input.operationId, {
          items: input.cursor ? [] : [{
            path: "/opt/app.log",
            lineNumber: "42",
            line: "needle",
            positions: [{ start: 0, end: 6 }],
            linesBefore: ["before"],
            linesAfter: ["after"],
            binary: false,
          }],
          page: input.cursor
            ? { limit: 100, total: 1, truncated: true }
            : { limit: 100, total: 1, truncated: true, nextCursor: "1" },
        });
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    });

    render(<SessionFilesPanel {...panelContext()} />);
    await screen.findByText("This directory is empty.");
    await user.click(screen.getByRole("radio", { name: "Search" }));
    await user.type(screen.getByRole("textbox", { name: "Pattern" }), "needle");
    await user.click(screen.getByRole("switch", { name: /Search recursively/ }));
    const before = screen.getByRole("spinbutton", { name: "Before" });
    const after = screen.getByRole("spinbutton", { name: "After" });
    await user.clear(before);
    await user.type(before, "3");
    await user.clear(after);
    await user.type(after, "4");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Search timed out");
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("row", { name: /app\.log/i })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Results are bounded");
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({
      operationId: "session.filesystem.grep",
      path: "/opt",
      pattern: "needle",
      recursive: true,
      linesBefore: 3,
      linesAfter: 4,
      limit: 100,
    });
    await user.click(screen.getByRole("button", { name: "Load more matches" }));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "session.filesystem.grep",
      cursor: "1",
      limit: 100,
    }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("lists paged mounts everywhere and gates Linux memory-file workflows by platform", async () => {
    const user = userEvent.setup();
    const api = installAPI((input) => {
      switch (input.operationId) {
        case "session.filesystem.pwd": return workbench(input.operationId, { path: "/" });
        case "session.filesystem.ls": return workbench(input.operationId, {
          path: "/",
          exists: true,
          items: [],
          page: { limit: 100, total: 0, truncated: false },
        });
        case "session.filesystem.mounts": return workbench(input.operationId, {
          items: input.cursor ? [{
            volumeName: "tmpfs",
            volumeType: "memory",
            mountPoint: "/run",
            label: "Runtime",
            filesystem: "tmpfs",
            usedBytes: "1024",
            freeBytes: "3072",
            totalBytes: "4096",
            options: "rw",
          }] : [{
            volumeName: "/dev/disk1",
            volumeType: "disk",
            mountPoint: "/",
            label: "System",
            filesystem: "ext4",
            usedBytes: "2048",
            freeBytes: "2048",
            totalBytes: "4096",
            options: "rw,relatime",
          }],
          page: input.cursor
            ? { limit: 100, total: 2, truncated: true }
            : { limit: 100, total: 2, truncated: true, nextCursor: "1" },
        });
        case "session.filesystem.memfiles.list": return workbench(input.operationId, {
          items: [{ fd: "7", name: "payload.bin", sizeBytes: "128" }],
          page: { limit: 100, total: 1, truncated: false },
        });
        case "session.filesystem.memfiles.add": return workbench(input.operationId, {
          changed: true,
          message: "Memory file added",
          fd: "8",
        });
        default: throw new Error(`Unexpected operation ${input.operationId}`);
      }
    }, { prepare: (input) => preparedAction(input) });

    const { rerender } = render(<SessionFilesPanel {...panelContext()} />);
    await screen.findByText("This directory is empty.");
    await user.click(screen.getByRole("radio", { name: "Storage" }));
    expect(await screen.findByText("System")).toBeInTheDocument();
    expect(await screen.findByRole("row", { name: /payload\.bin/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more mounts" }));
    expect(await screen.findByText("Runtime")).toBeInTheDocument();
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({ operationId: "session.filesystem.mounts", limit: 100, cursor: "1" });
    expect(screen.queryByText("The server returned a truncated mounts result.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add file" }));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({ operationId: "session.filesystem.memfiles.add" });
    await user.click(screen.getByRole("button", { name: "Remove memory file payload.bin" }));
    expect(await screen.findByRole("alertdialog", { name: "Remove this memory file?" })).toBeInTheDocument();
    expect(api.prepareSessionDestructiveAction).toHaveBeenCalledWith({ actionId: "session.filesystem.memfiles.rm", fd: "7" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const memoryCallsBeforePlatformChange = api.runSessionWorkbench.mock.calls.filter(([input]) =>
      input.operationId.startsWith("session.filesystem.memfiles.")).length;
    rerender(<SessionFilesPanel {...panelContext({ os: "darwin", arch: "arm64" })} />);
    expect(await screen.findByText("Memory files unavailable")).toBeInTheDocument();
    await waitFor(() => expect(api.runSessionWorkbench.mock.calls.filter(([input]) =>
      input.operationId.startsWith("session.filesystem.memfiles.")).length).toBe(memoryCallsBeforePlatformChange));
    expect(api.runSessionWorkbench.mock.calls.some(([input]) => input.operationId === "session.filesystem.mounts")).toBe(true);
  });

  it("locks an inspector review while prepare is pending and rejects re-entrant preparation", async () => {
    const user = userEvent.setup();
    const prepareGate = deferred<unknown>();
    const file = { name: "copy.txt", path: "/copy.txt", isDirectory: false, sizeBytes: "4", mode: "-rw-r--r--" };
    const api = installAPI((input) => {
      if (input.operationId === "session.filesystem.pwd") return workbench(input.operationId, { path: "/" });
      if (input.operationId === "session.filesystem.ls") return workbench(input.operationId, {
        path: "/",
        exists: true,
        items: [file],
        page: { limit: 100, total: 1, truncated: false },
      });
      throw new Error(`Unexpected operation ${input.operationId}`);
    }, { prepare: () => prepareGate.promise });

    render(<SessionFilesPanel {...panelContext()} />);
    await user.click(await screen.findByRole("button", { name: "More actions for copy.txt" }));
    await user.click(await screen.findByRole("menuitem", { name: /Copy/ }));
    const destination = await screen.findByRole("textbox", { name: "Destination path" });
    await user.type(destination, "/archive/copy.txt");
    const review = screen.getByRole("button", { name: "Review copy" });
    await user.click(review);
    await waitFor(() => expect(review).toBeDisabled());
    review.click();
    expect(api.prepareSessionDestructiveAction).toHaveBeenCalledTimes(1);

    await act(async () => {
      prepareGate.resolve(preparedAction({
        actionId: "session.filesystem.cp",
        source: file.path,
        destination: "/archive/copy.txt",
      }));
    });
    expect(await screen.findByRole("alertdialog", { name: "Copy this remote item?" })).toBeInTheDocument();
    expect(api.prepareSessionDestructiveAction).toHaveBeenCalledWith({
      actionId: "session.filesystem.cp",
      source: file.path,
      destination: "/archive/copy.txt",
    });
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

  it("pages environment variables while retaining reveals only for continuation and clearing them on refresh", async () => {
    const user = userEvent.setup();
    const refreshedList = deferred<unknown>();
    let freshLoads = 0;
    const api = installAPI((input) => {
      if (input.operationId === "session.environment.list") {
        if (input.cursor === "environment-2") {
          return workbench(input.operationId, {
            items: [{ name: "PATH", value: "/usr/bin", sensitive: false, redacted: false }],
            page: { limit: 100, total: 2, truncated: true },
          });
        }
        freshLoads += 1;
        if (freshLoads > 1) return refreshedList.promise;
        return workbench(input.operationId, {
          items: [{ name: "API_TOKEN", sensitive: true, redacted: true }],
          page: { limit: 100, total: 2, truncated: true, nextCursor: "environment-2" },
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
    await user.click(await screen.findByRole("button", { name: "Reveal" }));
    expect(await screen.findByText("super-secret")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more variables" }));
    expect(await screen.findByText("/usr/bin")).toBeInTheDocument();
    expect(screen.getByText("super-secret")).toBeInTheDocument();
    expect(screen.getByText("Loaded 2 of 2 environment variables")).toBeInTheDocument();
    expect(screen.queryByText("The server returned a truncated environment variables result.")).not.toBeInTheDocument();
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({
      operationId: "session.environment.list",
      limit: 100,
      cursor: "environment-2",
    });

    await user.click(screen.getByRole("button", { name: "Refresh environment" }));
    expect(screen.queryByText("super-secret")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("Loading environment");
    await act(async () => {
      refreshedList.resolve(workbench("session.environment.list", {
        items: [{ name: "API_TOKEN", sensitive: true, redacted: true }],
        page: { limit: 100, total: 1, truncated: false },
      }));
    });
    expect(await screen.findByRole("row", { name: /API_TOKEN/i })).toBeInTheDocument();
    expect(screen.queryByText("super-secret")).not.toBeInTheDocument();
  });

  it("shows Linux process dumps while gating Windows-only services and registry surfaces", async () => {
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
    expect(screen.getByRole("button", { name: "Dump process 4001" })).toBeInTheDocument();

    rerender(<SessionProcessesPanel {...panelContext({ os: "darwin", arch: "arm64" })} />);
    expect(screen.queryByRole("button", { name: "Dump process 4001" })).not.toBeInTheDocument();

    rerender(<SessionRegistryPanel {...panelContext()} />);
    expect(screen.getByText("Registry unavailable")).toBeInTheDocument();
    expect(api.runSessionWorkbench.mock.calls.some(([input]) => String(input.operationId).startsWith("session.registry."))).toBe(false);
  });

  it("uses bounded server-side process search, tree paging, and locks termination while review is pending", async () => {
    const user = userEvent.setup();
    const prepareGate = deferred<unknown>();
    const api = installAPI((input) => {
      if (input.operationId !== "session.process.list") throw new Error(`Unexpected operation ${input.operationId}`);
      if (input.query === "bash") {
        return workbench(input.operationId, {
          items: [{
            pid: 44,
            parentPid: 1,
            executable: "server-filtered",
            owner: "root",
            architecture: "amd64",
            commandLine: ["server-filtered", "--from-server"],
          }],
          page: { limit: 100, total: 1, truncated: false },
        });
      }
      if (input.cursor === "process-page-2") {
        return workbench(input.operationId, {
          items: [{
            pid: 3,
            parentPid: 1,
            executable: "worker",
            owner: "alice",
            architecture: "amd64",
            commandLine: ["worker"],
          }],
          page: { limit: 100, total: 3, truncated: true },
        });
      }
      return workbench(input.operationId, {
        items: [
          { pid: 1, parentPid: 0, executable: "init", owner: "root", architecture: "amd64", commandLine: ["init"] },
          { pid: 2, parentPid: 1, executable: "child", owner: "alice", architecture: "amd64", commandLine: ["child", "--worker"] },
        ],
        page: { limit: 100, total: 3, truncated: true, nextCursor: "process-page-2" },
      });
    }, { prepare: () => prepareGate.promise });

    render(<SessionProcessesPanel {...panelContext()} />);
    const childRow = await screen.findByRole("row", { name: /child/i });
    expect(screen.getByText("Loaded 2 of 3 processes · bounded")).toBeInTheDocument();
    await user.click(childRow);
    expect(screen.getByRole("heading", { name: "child" })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Tree" }));
    expect(screen.queryByRole("heading", { name: "child" })).not.toBeInTheDocument();
    expect(screen.getByRole("grid", { name: "Session process tree" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more processes" }));
    expect(await screen.findByRole("row", { name: /worker/i })).toBeInTheDocument();
    expect(screen.getByText("Loaded 3 of 3 processes")).toBeInTheDocument();
    expect(screen.queryByText("The server returned a truncated processes result.")).not.toBeInTheDocument();
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({
      operationId: "session.process.list",
      fullInfo: true,
      limit: 100,
      cursor: "process-page-2",
    });

    const terminate = screen.getByRole("button", { name: "Terminate process 2" });
    await user.click(terminate);
    await waitFor(() => expect(terminate).toBeDisabled());
    terminate.click();
    expect(api.prepareSessionDestructiveAction).toHaveBeenCalledTimes(1);
    await act(async () => {
      prepareGate.resolve(preparedAction({ actionId: "session.process.terminate", pid: 2, force: false }));
    });
    const terminateDialog = await screen.findByRole("alertdialog", { name: "Terminate process 2?" });
    expect(terminateDialog).toBeInTheDocument();
    await user.click(within(terminateDialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(terminateDialog).not.toBeInTheDocument());

    const processFilter = screen.getByRole("searchbox", { name: "Filter processes" });
    fireEvent.change(processFilter, { target: { value: "bash" } });
    expect(processFilter).toHaveValue("bash");
    await waitFor(
      () => expect(api.runSessionWorkbench).toHaveBeenCalledWith({
        operationId: "session.process.list",
        fullInfo: true,
        limit: 100,
        query: "bash",
      }),
      { timeout: 3_000 },
    );
    expect(await screen.findByRole("row", { name: /server-filtered/i })).toBeInTheDocument();
    expect(screen.getByText("Loaded 1 of 1 processes matching “bash”")).toBeInTheDocument();
  });

  it("exposes Windows process dumps and a dedicated services segment", async () => {
    const user = userEvent.setup();
    const stopPrepareGate = deferred<unknown>();
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
          if (input.query === "remote") {
            return workbench(input.operationId, {
              items: [{
                name: "QuerySvc",
                displayName: "Server Query Match",
                description: "Returned by the remote query",
                status: 1,
                startupType: 3,
                binaryPath: "C:\\query.exe",
                account: "LocalService",
              }],
              page: { limit: 100, total: 1, truncated: false },
            });
          }
          if (input.cursor === "services-2") {
            return workbench(input.operationId, {
              items: [{
                name: "RemoteRegistry",
                displayName: "Remote Registry",
                description: "Remote registry service",
                status: 1,
                startupType: 3,
                binaryPath: "C:\\Windows\\System32\\svchost.exe",
                account: "LocalService",
              }],
              page: { limit: 100, total: 3, truncated: true },
            });
          }
          return workbench(input.operationId, {
            items: [
              {
                name: "Spooler",
                displayName: "Print Spooler",
                description: "Queues print jobs",
                status: 4,
                startupType: 2,
                binaryPath: "C:\\Windows\\System32\\spoolsv.exe",
                account: "LocalSystem",
              },
              {
                name: "W32Time",
                displayName: "Windows Time",
                description: "Keeps system time synchronized",
                status: 1,
                startupType: 3,
                binaryPath: "C:\\Windows\\System32\\svchost.exe",
                account: "LocalService",
              },
            ],
            page: { limit: 100, total: 3, truncated: true, nextCursor: "services-2" },
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
        case "session.service.start":
          return workbench(input.operationId, {
            name: input.name,
            displayName: "Windows Time",
            description: "Keeps system time synchronized",
            status: 2,
            startupType: 3,
            binaryPath: "C:\\Windows\\System32\\svchost.exe",
            account: "LocalService",
          });
        default: throw new Error(`Unexpected operation ${input.operationId}`);
      }
    }, { prepare: () => stopPrepareGate.promise });

    render(<SessionProcessesPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    expect(await screen.findByRole("row", { name: /agent\.exe/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dump process 4001" }));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({
      operationId: "session.process.dump",
      pid: 4001,
      dumpTimeoutSeconds: 120,
    });

    await user.click(screen.getByRole("radio", { name: "Services" }));
    await screen.findByRole("row", { name: /Print Spooler/i });
    expect(screen.queryByRole("button", { name: "Start Print Spooler" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop Print Spooler" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Windows Time" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop Windows Time" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start Windows Time" }));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({ operationId: "session.service.start", name: "W32Time" });
    await user.click(await screen.findByRole("button", { name: "View Print Spooler details" }));
    expect(await screen.findByText("C:\\Windows\\System32\\spoolsv.exe")).toBeInTheDocument();
    expect(screen.getByText("Automatic")).toBeInTheDocument();

    const stop = screen.getByRole("button", { name: "Stop Print Spooler" });
    await user.click(stop);
    await waitFor(() => expect(stop).toBeDisabled());
    stop.click();
    expect(api.prepareSessionDestructiveAction).toHaveBeenCalledTimes(1);
    expect(api.prepareSessionDestructiveAction).toHaveBeenCalledWith({ actionId: "session.service.stop", name: "Spooler" });
    await act(async () => {
      stopPrepareGate.resolve(preparedAction({ actionId: "session.service.stop", name: "Spooler" }));
    });
    expect(await screen.findByRole("alertdialog", { name: "Stop service Spooler?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Load more services" }));
    expect(await screen.findByRole("row", { name: /Remote Registry/i })).toBeInTheDocument();
    expect(screen.getByText("Loaded 3 of 3 services")).toBeInTheDocument();
    expect(screen.queryByText("The server returned a truncated services result.")).not.toBeInTheDocument();
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({ operationId: "session.service.list", limit: 100, cursor: "services-2" });
    expect(screen.queryByText("C:\\Windows\\System32\\spoolsv.exe")).not.toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Filter services" }), "remote");
    expect(await screen.findByRole("row", { name: /Server Query Match/i })).toBeInTheDocument();
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({ operationId: "session.service.list", limit: 100, query: "remote" });
    expect(screen.getByText("Loaded 1 of 1 services matching “remote”")).toBeInTheDocument();
  });

  it("browses and reads Windows registry values", async () => {
    const user = userEvent.setup();
    const api = installAPI((input) => {
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
        case "session.registry.read-hive":
          return workbench(input.operationId, { status: "canceled" });
        default: throw new Error(`Unexpected operation ${input.operationId}`);
      }
    });

    render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    expect(await screen.findByRole("row", { name: /InstallPath/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save hive" })).toBeDisabled();
    expect(screen.getByText(/Select a registry subkey before saving/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Software" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save hive" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Save hive" }));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "session.registry.read-hive",
      rootHive: "HKCU",
      requestedHive: "Software",
    }));
    await user.click(screen.getByRole("button", { name: "Read InstallPath" }));
    expect(await screen.findByText("C:\\Program Files\\Sliver")).toBeInTheDocument();
  });

  it("pages registry subkeys and values independently and reviews exact create, write, and delete payloads", async () => {
    const user = userEvent.setup();
    const api = installAPI((input) => {
      if (input.operationId === "session.registry.list-subkeys") {
        return workbench(input.operationId, input.cursor === "subkeys-2" ? {
          items: ["Advanced"],
          page: { limit: 500, total: 2, truncated: true },
        } : {
          items: ["Software"],
          page: { limit: 500, total: 2, truncated: true, nextCursor: "subkeys-2" },
        });
      }
      if (input.operationId === "session.registry.list-values") {
        return workbench(input.operationId, input.cursor === "values-2" ? {
          items: ["Version"],
          page: { limit: 500, total: 2, truncated: true },
        } : {
          items: ["InstallPath"],
          page: { limit: 500, total: 2, truncated: true, nextCursor: "values-2" },
        });
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    }, { prepare: (input) => preparedAction(input) });

    render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    expect(await screen.findByRole("row", { name: /Software/i })).toBeInTheDocument();
    expect(screen.getByText("Loaded 1 of 2 subkeys · bounded")).toBeInTheDocument();
    expect(screen.getByText("Loaded 1 of 2 values · bounded")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more subkeys" }));
    await user.click(screen.getByRole("button", { name: "Load more values" }));
    expect(await screen.findByRole("row", { name: /Advanced/i })).toBeInTheDocument();
    expect(await screen.findByRole("row", { name: /Version/i })).toBeInTheDocument();
    expect(screen.getByText("Loaded 2 of 2 subkeys")).toBeInTheDocument();
    expect(screen.getByText("Loaded 2 of 2 values")).toBeInTheDocument();
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({
      operationId: "session.registry.list-subkeys",
      hive: "HKCU",
      path: "",
      limit: 500,
      cursor: "subkeys-2",
    });
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({
      operationId: "session.registry.list-values",
      hive: "HKCU",
      path: "",
      limit: 500,
      cursor: "values-2",
    });

    await user.click(screen.getByRole("button", { name: "Create key" }));
    const draftKey = await screen.findByRole("textbox", { name: "New subkey name" });
    await user.type(draftKey, "DiscardedDraft");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Create key" }));
    const keyName = await screen.findByRole("textbox", { name: "New subkey name" });
    expect(keyName).toHaveValue("");
    await user.type(keyName, "NewKey");
    await user.click(screen.getByRole("button", { name: "Review create key" }));
    expect(await screen.findByRole("alertdialog", { name: "Create this registry key?" })).toBeInTheDocument();
    expect(api.prepareSessionDestructiveAction).toHaveBeenCalledWith({
      actionId: "session.registry.create-key",
      hive: "HKCU",
      path: "",
      key: "NewKey",
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Write value" }));
    await user.type(await screen.findByRole("textbox", { name: "Value name" }), "Greeting");
    await user.type(screen.getByRole("textbox", { name: "String value" }), "hello registry");
    await user.click(screen.getByRole("button", { name: "Review write value" }));
    const writeReview = await screen.findByRole("alertdialog", { name: "Write this registry value?" });
    expect(writeReview).toHaveTextContent("Value type");
    expect(writeReview).toHaveTextContent("String");
    expect(writeReview).toHaveTextContent("Exact value");
    expect(writeReview).toHaveTextContent("hello registry");
    expect(writeReview).toHaveTextContent(`Plan payload SHA-256 ${"b".repeat(64)}`);
    expect(api.prepareSessionDestructiveAction).toHaveBeenCalledWith({
      actionId: "session.registry.write",
      hive: "HKCU",
      path: "",
      key: "Greeting",
      value: { type: "string", value: "hello registry" },
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Delete registry key Software" }));
    expect(await screen.findByRole("alertdialog", { name: "Delete this registry key?" })).toBeInTheDocument();
    expect(api.prepareSessionDestructiveAction).toHaveBeenCalledWith({
      actionId: "session.registry.delete-key",
      hive: "HKCU",
      path: "",
      key: "Software",
    });
  });

  it("keeps the latest registry navigation when an older same-route request finishes late", async () => {
    const user = userEvent.setup();
    const oldValues = deferred<unknown>();
    const newValues = deferred<unknown>();
    installAPI((input) => {
      if (input.operationId === "session.registry.list-subkeys") {
        return workbench(input.operationId, {
          items: [],
          page: { limit: 500, total: 0, truncated: false },
        });
      }
      if (input.operationId === "session.registry.list-values") {
        if (input.path === "Old") return oldValues.promise;
        if (input.path === "New") return newValues.promise;
        return workbench(input.operationId, {
          items: [],
          page: { limit: 500, total: 0, truncated: false },
        });
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    });

    render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    const pathInput = await screen.findByRole("textbox", { name: "Registry path" });
    await screen.findByText("This registry key has no visible subkeys or values.");
    await user.type(pathInput, "Old");
    await user.click(screen.getByRole("button", { name: "Go" }));
    await user.clear(pathInput);
    await user.type(pathInput, "New");
    await user.click(screen.getByRole("button", { name: "Go" }));

    await act(async () => {
      newValues.resolve(workbench("session.registry.list-values", {
        items: ["NewestValue"],
        page: { limit: 500, total: 1, truncated: false },
      }));
    });
    expect(await screen.findByRole("row", { name: /NewestValue/i })).toBeInTheDocument();

    await act(async () => {
      oldValues.resolve(workbench("session.registry.list-values", {
        items: ["StaleValue"],
        page: { limit: 500, total: 1, truncated: false },
      }));
    });
    expect(screen.queryByRole("row", { name: /StaleValue/i })).not.toBeInTheDocument();
    expect(screen.getByRole("grid", { name: /Registry entries in HKCU New/i })).toBeInTheDocument();
  });

  it("keeps only the latest registry value read and shows pending state on that row", async () => {
    const user = userEvent.setup();
    const firstRead = deferred<unknown>();
    const secondRead = deferred<unknown>();
    installAPI((input) => {
      if (input.operationId === "session.registry.list-subkeys") {
        return workbench(input.operationId, {
          items: [],
          page: { limit: 500, total: 0, truncated: false },
        });
      }
      if (input.operationId === "session.registry.list-values") {
        return workbench(input.operationId, {
          items: ["First", "Second"],
          page: { limit: 500, total: 2, truncated: false },
        });
      }
      if (input.operationId === "session.registry.read") {
        return input.key === "First" ? firstRead.promise : secondRead.promise;
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    });

    render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    await screen.findByRole("row", { name: /First/i });
    await user.click(screen.getByRole("button", { name: "Read First" }));
    expect(screen.getByRole("button", { name: "Read First" })).toHaveAttribute("data-pending", "true");
    expect(screen.getByRole("button", { name: "Read Second" })).not.toHaveAttribute("data-pending", "true");
    await user.click(screen.getByRole("button", { name: "Read Second" }));
    expect(screen.getByRole("button", { name: "Read Second" })).toHaveAttribute("data-pending", "true");

    await act(async () => {
      secondRead.resolve(workbench("session.registry.read", {
        hive: "HKCU",
        path: "",
        key: "Second",
        value: "newest-data",
      }));
    });
    expect(await screen.findByText("newest-data")).toBeInTheDocument();

    await act(async () => {
      firstRead.resolve(workbench("session.registry.read", {
        hive: "HKCU",
        path: "",
        key: "First",
        value: "stale-data",
      }));
    });
    expect(screen.getByText("newest-data")).toBeInTheDocument();
    expect(screen.queryByText("stale-data")).not.toBeInTheDocument();
  });

  it("builds UNC breadcrumbs from the server-share root", () => {
    expect(pathBreadcrumbs("\\\\fileserver\\share\\reports\\2026", true)).toEqual([
      { label: "\\\\fileserver\\share", path: "\\\\fileserver\\share" },
      { label: "reports", path: "\\\\fileserver\\share\\reports" },
      { label: "2026", path: "\\\\fileserver\\share\\reports\\2026" },
    ]);
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
