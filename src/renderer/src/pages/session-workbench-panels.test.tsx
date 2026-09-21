import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toast, toast } from "@heroui/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type { SliverDesktopAPI } from "../../../shared/contracts";
import { SESSION_WORKBENCH_MAX_COMPLETE_FILE_BYTES } from "../../../shared/session-contracts";
import type {
  PrepareSessionDestructiveActionInput,
  SessionWorkbenchInput,
  SessionWorkbenchResult,
  SessionWorkbenchResultFor,
} from "../../../shared/session-contracts";
import type { SessionSummary } from "../../../shared/target-contracts";
import type { SessionWorkspacePanelContext } from "./SessionWorkspacePage";
import { renderWithApplicationContextMenu as render } from "../application-context-menu-test-utils";
import {
  SessionEnvironmentPanel,
  SessionFilesPanel,
  SessionNetworkPanel,
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
  toast.clear();
  vi.useRealTimers();
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
    onOperationSubmitted: vi.fn(() => true),
    isTargetTransitionPending: false,
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
    expect(screen.queryByRole("heading", { name: "Network" })).not.toBeInTheDocument();
    expect(api.runSessionWorkbench).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Capture" }));
    expect(await screen.findByRole("img", { name: "Screenshot from payments" })).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
    await user.click(screen.getByRole("button", { name: "Save as…" }));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({ operationId: "session.artifact.save", handle: "A".repeat(43) });
  });

  it("keeps overview identity failures separate from independently paged network inventories", async () => {
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

    const context = panelContext({ os: "windows", arch: "amd64", hostname: "prod-win" });
    const overview = render(<SessionOverviewPanel {...context} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Token owner unavailable");
    expect(screen.getByText("session-1")).toBeInTheDocument();
    expect(screen.getByText("host-1")).toBeInTheDocument();
    expect(screen.getByText("1.7.6")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Network" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("DOMAIN\\alice")).toBeInTheDocument();
    overview.unmount();
    render(<SessionNetworkPanel {...context} />);

    expect(screen.getByRole("heading", { name: "Network" })).toBeInTheDocument();
    expect(await screen.findByText("eth0")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.8:4444")).toBeInTheDocument();
    expect(screen.getByText("Loaded 1 of 2 interfaces · bounded")).toBeInTheDocument();
    expect(screen.getByText("Loaded 1 of 2 connections · bounded")).toBeInTheDocument();

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

    await user.click(screen.getByRole("button", { name: "New folder" }));
    const folderDialog = await screen.findByRole("dialog", { name: "New folder" });
    await user.type(within(folderDialog).getByRole("textbox", { name: "New folder name" }), "archive");
    await user.click(within(folderDialog).getByRole("button", { name: "Create folder" }));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({ operationId: "session.filesystem.mkdir", path: "/opt/archive" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New folder" })).not.toBeInTheDocument());

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

  it("puts Download and Add to Loot first in file actions and dispatches the exact row path", async () => {
    const user = userEvent.setup();
    const files = [{
      name: "alpha.txt",
      path: "/opt/alpha.txt",
      isDirectory: false,
      sizeBytes: "5",
      mode: "-rw-r--r--",
    }, {
      name: "beta.txt",
      path: "/opt/beta.txt",
      isDirectory: false,
      sizeBytes: "4",
      mode: "-rw-r--r--",
    }];
    const api = installAPI((input) => {
      switch (input.operationId) {
        case "session.filesystem.pwd": return workbench(input.operationId, { path: "/opt" });
        case "session.filesystem.ls": return workbench(input.operationId, {
          path: input.path,
          exists: true,
          items: files,
          page: { limit: 100, total: files.length, truncated: false },
        });
        case "session.filesystem.download": return workbench(input.operationId, { status: "canceled" });
        case "session.filesystem.add-to-loot": return workbench(input.operationId, {
          status: "added",
          fileName: input.path.split("/").at(-1)!,
          fileType: "text",
          size: 4,
          sha256: "c".repeat(64),
        });
        default: throw new Error(`Unexpected operation ${input.operationId}`);
      }
    });

    render(<SessionFilesPanel {...panelContext()} />);
    await screen.findByRole("row", { name: /beta\.txt/i });

    await user.click(screen.getByRole("button", { name: "More actions for beta.txt" }));
    const betaDownload = await screen.findByRole("menuitem", { name: "Download" });
    let menu = betaDownload.closest<HTMLElement>('[role="menu"]')!;
    expect(within(menu).getAllByRole("menuitem").slice(0, 3).map((item) => item.textContent)).toEqual([
      "Download",
      "Add to Loot",
      "Inspect file",
    ]);
    await user.click(within(menu).getByRole("menuitem", { name: "Add to Loot" }));
    await waitFor(() => expect(api.runSessionWorkbench).toHaveBeenCalledWith({
      operationId: "session.filesystem.add-to-loot",
      path: "/opt/beta.txt",
      maxBytes: SESSION_WORKBENCH_MAX_COMPLETE_FILE_BYTES,
    }));

    await waitFor(() => expect(screen.getByRole("button", { name: "More actions for alpha.txt" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "More actions for alpha.txt" }));
    const alphaDownload = await screen.findByRole("menuitem", { name: "Download" });
    menu = alphaDownload.closest<HTMLElement>('[role="menu"]')!;
    await user.click(within(menu).getByRole("menuitem", { name: "Download" }));
    await waitFor(() => expect(api.runSessionWorkbench).toHaveBeenCalledWith({
      operationId: "session.filesystem.download",
      path: "/opt/alpha.txt",
      maxBytes: SESSION_WORKBENCH_MAX_COMPLETE_FILE_BYTES,
    }));
  });

  it("shows a downloading spinner until the existing success toast replaces it", async () => {
    const user = userEvent.setup();
    const pendingDownload = deferred<unknown>();
    const file = {
      name: "report.txt",
      path: "/opt/report.txt",
      isDirectory: false,
      sizeBytes: "12",
      mode: "-rw-r--r--",
    };
    installAPI((input) => {
      if (input.operationId === "session.filesystem.pwd") return workbench(input.operationId, { path: "/opt" });
      if (input.operationId === "session.filesystem.ls") return workbench(input.operationId, {
        path: input.path,
        exists: true,
        items: [file],
        page: { limit: 100, total: 1, truncated: false },
      });
      if (input.operationId === "session.filesystem.download") return pendingDownload.promise;
      throw new Error(`Unexpected operation ${input.operationId}`);
    });

    render(
      <>
        <SessionFilesPanel {...panelContext()} />
        <Toast.Provider maxVisibleToasts={4} placement="bottom" />
      </>,
    );
    await screen.findByRole("row", { name: /report\.txt/i });
    await user.click(screen.getByRole("button", { name: "More actions for report.txt" }));
    await user.click(await screen.findByRole("menuitem", { name: "Download" }));

    expect(await screen.findByText("Downloading")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();

    pendingDownload.resolve(workbench("session.filesystem.download", {
      status: "saved",
      suggestedBasename: "report.txt",
      size: 12,
      sha256: "a".repeat(64),
    }));

    expect(await screen.findByText("File saved")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Downloading")).not.toBeInTheDocument());
  });

  it("clears the downloading spinner when the download fails", async () => {
    const user = userEvent.setup();
    const pendingDownload = deferred<unknown>();
    const file = {
      name: "report.txt",
      path: "/opt/report.txt",
      isDirectory: false,
      sizeBytes: "12",
      mode: "-rw-r--r--",
    };
    installAPI((input) => {
      if (input.operationId === "session.filesystem.pwd") return workbench(input.operationId, { path: "/opt" });
      if (input.operationId === "session.filesystem.ls") return workbench(input.operationId, {
        path: input.path,
        exists: true,
        items: [file],
        page: { limit: 100, total: 1, truncated: false },
      });
      if (input.operationId === "session.filesystem.download") return pendingDownload.promise;
      throw new Error(`Unexpected operation ${input.operationId}`);
    });

    render(
      <>
        <SessionFilesPanel {...panelContext()} />
        <Toast.Provider maxVisibleToasts={4} placement="bottom" />
      </>,
    );
    await screen.findByRole("row", { name: /report\.txt/i });
    await user.click(screen.getByRole("button", { name: "More actions for report.txt" }));
    await user.click(await screen.findByRole("menuitem", { name: "Download" }));
    expect(await screen.findByText("Downloading")).toBeInTheDocument();

    pendingDownload.reject(new Error("transport unavailable"));

    expect(await screen.findByText("Download failed")).toBeInTheDocument();
    expect(screen.getByText("transport unavailable")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Downloading")).not.toBeInTheDocument());
  });

  it("shows an Add to Loot spinner until the existing success toast replaces it", async () => {
    const user = userEvent.setup();
    const pendingAdd = deferred<unknown>();
    const file = {
      name: "report.txt",
      path: "/opt/report.txt",
      isDirectory: false,
      sizeBytes: "12",
      mode: "-rw-r--r--",
    };
    installAPI((input) => {
      if (input.operationId === "session.filesystem.pwd") return workbench(input.operationId, { path: "/opt" });
      if (input.operationId === "session.filesystem.ls") return workbench(input.operationId, {
        path: input.path,
        exists: true,
        items: [file],
        page: { limit: 100, total: 1, truncated: false },
      });
      if (input.operationId === "session.filesystem.add-to-loot") return pendingAdd.promise;
      throw new Error(`Unexpected operation ${input.operationId}`);
    });

    render(
      <>
        <SessionFilesPanel {...panelContext()} />
        <Toast.Provider maxVisibleToasts={4} placement="bottom" />
      </>,
    );
    await screen.findByRole("row", { name: /report\.txt/i });
    await user.click(screen.getByRole("button", { name: "More actions for report.txt" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add to Loot" }));

    expect(await screen.findByText("Adding to Loot")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();

    pendingAdd.resolve(workbench("session.filesystem.add-to-loot", {
      status: "added",
      fileName: "report.txt",
      fileType: "text",
      size: 12,
      sha256: "a".repeat(64),
    }));

    expect(await screen.findByText("File added to loot")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Adding to Loot")).not.toBeInTheDocument());
  });

  it("clears the Add to Loot spinner when the operation fails", async () => {
    const user = userEvent.setup();
    const pendingAdd = deferred<unknown>();
    const file = {
      name: "report.txt",
      path: "/opt/report.txt",
      isDirectory: false,
      sizeBytes: "12",
      mode: "-rw-r--r--",
    };
    installAPI((input) => {
      if (input.operationId === "session.filesystem.pwd") return workbench(input.operationId, { path: "/opt" });
      if (input.operationId === "session.filesystem.ls") return workbench(input.operationId, {
        path: input.path,
        exists: true,
        items: [file],
        page: { limit: 100, total: 1, truncated: false },
      });
      if (input.operationId === "session.filesystem.add-to-loot") return pendingAdd.promise;
      throw new Error(`Unexpected operation ${input.operationId}`);
    });

    render(
      <>
        <SessionFilesPanel {...panelContext()} />
        <Toast.Provider maxVisibleToasts={4} placement="bottom" />
      </>,
    );
    await screen.findByRole("row", { name: /report\.txt/i });
    await user.click(screen.getByRole("button", { name: "More actions for report.txt" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add to Loot" }));
    expect(await screen.findByText("Adding to Loot")).toBeInTheDocument();

    pendingAdd.reject(new Error("loot transport unavailable"));

    expect(await screen.findByText("Could not add file to loot")).toBeInTheDocument();
    expect(screen.getByText("loot transport unavailable")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Adding to Loot")).not.toBeInTheDocument());
  });

  it("scopes ordered context actions to files and clears them for folders and headers", async () => {
    const user = userEvent.setup();
    const files = [{
      name: "evidence.bin",
      path: "/opt/evidence.bin",
      isDirectory: false,
      sizeBytes: "16",
      mode: "-rw-------",
    }, {
      name: "archive",
      path: "/opt/archive",
      isDirectory: true,
      sizeBytes: "0",
      mode: "drwx------",
    }];
    const api = installAPI((input) => {
      if (input.operationId === "session.filesystem.pwd") return workbench(input.operationId, { path: "/opt" });
      if (input.operationId === "session.filesystem.ls") return workbench(input.operationId, {
        path: input.path,
        exists: true,
        items: files,
        page: { limit: 100, total: files.length, truncated: false },
      });
      if (input.operationId === "session.filesystem.download") return workbench(input.operationId, { status: "canceled" });
      if (input.operationId === "session.filesystem.add-to-loot") return workbench(input.operationId, {
        status: "added",
        fileName: "evidence.bin",
        fileType: "binary",
        size: 16,
        sha256: "d".repeat(64),
      });
      throw new Error(`Unexpected operation ${input.operationId}`);
    });
    const rendered = render(<SessionFilesPanel {...panelContext()} />);
    const grid = await screen.findByRole("grid", { name: "Files in /opt" });

    fireEvent.contextMenu(within(grid).getByRole("rowheader", { name: "evidence.bin" }));
    rendered.contextMenu.emit([{
      type: "action",
      actionId: "30000000-0000-4000-8000-000000000001",
      kind: "select-all",
      label: "Select All",
      enabled: true,
    }, {
      type: "action",
      actionId: "30000000-0000-4000-8000-000000000002",
      kind: "inspect",
      label: "Inspect Element",
      enabled: true,
    }]);
    let menu = await screen.findByRole("menu", { name: "Application context menu" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Download",
      "Add to Loot",
      "Select All",
      "Inspect Element",
    ]);
    await user.click(within(menu).getByRole("menuitem", { name: "Download" }));
    await waitFor(() => expect(api.runSessionWorkbench).toHaveBeenCalledWith({
      operationId: "session.filesystem.download",
      path: "/opt/evidence.bin",
      maxBytes: SESSION_WORKBENCH_MAX_COMPLETE_FILE_BYTES,
    }));

    await waitFor(() => expect(screen.getByRole("button", { name: "More actions for evidence.bin" })).toBeEnabled());
    fireEvent.contextMenu(within(grid).getByRole("rowheader", { name: "evidence.bin" }));
    rendered.contextMenu.emit();
    menu = await screen.findByRole("menu", { name: "Application context menu" });
    await user.click(within(menu).getByRole("menuitem", { name: "Add to Loot" }));
    await waitFor(() => expect(api.runSessionWorkbench).toHaveBeenCalledWith({
      operationId: "session.filesystem.add-to-loot",
      path: "/opt/evidence.bin",
      maxBytes: SESSION_WORKBENCH_MAX_COMPLETE_FILE_BYTES,
    }));

    for (const target of [
      within(grid).getByRole("rowheader", { name: "archive" }),
      within(grid).getByRole("columnheader", { name: "Name" }),
    ]) {
      fireEvent.contextMenu(target);
      rendered.contextMenu.emit();
      menu = await screen.findByRole("menu", { name: "Application context menu" });
      expect(within(menu).queryByRole("menuitem", { name: "Download" })).not.toBeInTheDocument();
      expect(within(menu).queryByRole("menuitem", { name: "Add to Loot" })).not.toBeInTheDocument();
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("menu", { name: "Application context menu" })).not.toBeInTheDocument());
    }

    await user.click(screen.getByRole("button", { name: "More actions for archive" }));
    const openFolder = await screen.findByRole("menuitem", { name: "Open folder" });
    menu = openFolder.closest<HTMLElement>('[role="menu"]')!;
    expect(within(menu).queryByRole("menuitem", { name: "Download" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Add to Loot" })).not.toBeInTheDocument();
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

  it.each([
    { platform: "linux", root: "/", child: "/reports" },
    { platform: "windows", root: "C:\\", child: "C:\\Reports" },
    { platform: "windows", root: "\\\\fileserver\\share", child: "\\\\fileserver\\share\\Reports" },
  ])("submits typed $platform paths with Enter and stops Up at $root", async ({ platform, root, child }) => {
    const user = userEvent.setup();
    const api = installAPI((input) => {
      if (input.operationId === "session.filesystem.pwd") return workbench(input.operationId, { path: root });
      if (input.operationId === "session.filesystem.ls") return workbench(input.operationId, {
        path: input.path,
        exists: true,
        items: [],
        page: { limit: 100, total: 0, truncated: false },
      });
      throw new Error(`Unexpected operation ${input.operationId}`);
    });

    render(<SessionFilesPanel {...panelContext({ os: platform })} />);
    const pathInput = screen.getByRole("textbox", { name: "Remote path" });
    await waitFor(() => expect(pathInput).toHaveValue(root));
    const up = screen.getByRole("button", { name: "Up one folder" });
    expect(up).toBeDisabled();

    await user.clear(pathInput);
    await user.type(pathInput, `${child}{Enter}`, { skipClick: true });
    await waitFor(() => expect(screen.getByRole("grid", { name: `Files in ${child}` })).toBeInTheDocument());
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({ operationId: "session.filesystem.ls", path: child, limit: 100 });
    expect(up).toBeEnabled();

    await user.click(up);
    await waitFor(() => expect(screen.getByRole("grid", { name: `Files in ${root}` })).toBeInTheDocument());
    expect(pathInput).toHaveValue(root);
    expect(up).toBeDisabled();
    const callsAtRoot = api.runSessionWorkbench.mock.calls.length;
    await user.click(up);
    expect(api.runSessionWorkbench).toHaveBeenCalledTimes(callsAtRoot);
  });

  it("cancels a new folder without creating it and clears the next dialog draft", async () => {
    const user = userEvent.setup();
    const api = installAPI((input) => {
      if (input.operationId === "session.filesystem.pwd") return workbench(input.operationId, { path: "/opt" });
      if (input.operationId === "session.filesystem.ls") return workbench(input.operationId, {
        path: "/opt",
        exists: true,
        items: [],
        page: { limit: 100, total: 0, truncated: false },
      });
      throw new Error(`Unexpected operation ${input.operationId}`);
    });

    render(<SessionFilesPanel {...panelContext()} />);
    await screen.findByText("This directory is empty.");
    expect(screen.queryByRole("textbox", { name: "New folder name" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New folder" }));
    const dialog = await screen.findByRole("dialog", { name: "New folder" });
    expect(within(dialog).getByRole("button", { name: "Create folder" })).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox", { name: "New folder name" }), "discarded");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New folder" })).not.toBeInTheDocument());
    expect(api.runSessionWorkbench.mock.calls.some(([input]) => input.operationId === "session.filesystem.mkdir")).toBe(false);

    await user.click(screen.getByRole("button", { name: "New folder" }));
    expect(await screen.findByRole("textbox", { name: "New folder name" })).toHaveValue("");
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
    const fileGrid = await screen.findByRole("grid", { name: "Files in /base" });
    expect(within(fileGrid).getByRole("row", { name: /next/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    act(() => within(fileGrid).getByRole("row", { name: /next/i }).focus());
    await user.keyboard("{Enter}");

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
    await user.type(pathInput, "/missing", { skipClick: true });
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
    await user.type(pathInput, "/missing", { skipClick: true });
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
    await user.click(screen.getByRole("button", { name: "New folder" }));
    const folderDialog = await screen.findByRole("dialog", { name: "New folder" });
    await user.type(within(folderDialog).getByRole("textbox", { name: "New folder name" }), "blocked");
    await user.click(within(folderDialog).getByRole("button", { name: "Create folder" }));

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
    await user.click(screen.getByRole("radio", { name: "Mounts" }));
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
    await user.click(screen.getByRole("button", { name: "Reveal API_TOKEN" }));
    expect(await screen.findByText("super-secret")).toBeInTheDocument();
  });

  it("fuzzy-filters loaded environment names and visible values locally without searching hidden secrets", async () => {
    const user = userEvent.setup();
    const api = installAPI((input) => {
      if (input.operationId === "session.environment.list") {
        return workbench(input.operationId, {
          items: [
            { name: "HTTP_PROXY", value: "http://127.0.0.1:8080", sensitive: false, redacted: false },
            { name: "TOOL_PATH", value: "/usr/local/bin", sensitive: false, redacted: false },
            { name: "API_TOKEN", sensitive: true, redacted: true },
          ],
          page: { limit: 100, total: 3, truncated: false },
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
    const filter = await screen.findByRole("searchbox", { name: "Filter environment variables" });
    const grid = screen.getByRole("grid", { name: "Session environment variables" });

    await user.type(filter, "hPxY");
    expect(within(grid).getByRole("row", { name: /HTTP_PROXY/u })).toBeInTheDocument();
    expect(within(grid).queryByRole("row", { name: /TOOL_PATH/u })).not.toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 3 loaded environment variables matching “hPxY”")).toBeInTheDocument();

    await user.clear(filter);
    await user.type(filter, "USR BN");
    expect(within(grid).getByRole("row", { name: /TOOL_PATH/u })).toBeInTheDocument();
    expect(within(grid).queryByRole("row", { name: /HTTP_PROXY/u })).not.toBeInTheDocument();

    await user.clear(filter);
    await user.type(filter, "suprscrt");
    expect(screen.getByText("Showing 0 of 3 loaded environment variables matching “suprscrt”")).toBeInTheDocument();
    expect(within(grid).queryByRole("row", { name: /API_TOKEN/u })).not.toBeInTheDocument();

    await user.clear(filter);
    await user.click(within(grid).getByRole("button", { name: "Reveal API_TOKEN" }));
    expect(await within(grid).findByText("super-secret")).toBeInTheDocument();
    await user.type(filter, "SuPrScRt");
    expect(within(grid).getByRole("row", { name: /API_TOKEN/u })).toBeInTheDocument();
    expect(within(grid).queryByRole("row", { name: /HTTP_PROXY/u })).not.toBeInTheDocument();

    expect(api.runSessionWorkbench.mock.calls.filter(([input]) => input.operationId === "session.environment.list")).toEqual([
      [{ operationId: "session.environment.list", limit: 100 }],
    ]);
  });

  it("keeps a fuzzy environment filter active while loading a matching continuation row", async () => {
    const user = userEvent.setup();
    const api = installAPI((input) => {
      if (input.operationId !== "session.environment.list") throw new Error(`Unexpected operation ${input.operationId}`);
      if (input.cursor === "environment-2") {
        return workbench(input.operationId, {
          items: [{ name: "M2_PAGE_105", value: "continuation-value", sensitive: false, redacted: false }],
          page: { limit: 100, total: 2, truncated: false },
        });
      }
      return workbench(input.operationId, {
        items: [{ name: "HOME", value: "/Users/e2e", sensitive: false, redacted: false }],
        page: { limit: 100, total: 2, truncated: true, nextCursor: "environment-2" },
      });
    });

    render(<SessionEnvironmentPanel {...panelContext()} />);
    const filter = await screen.findByRole("searchbox", { name: "Filter environment variables" });
    const grid = screen.getByRole("grid", { name: "Session environment variables" });
    await user.type(filter, "m2Pg105");

    expect(screen.getByText("Showing 0 of 1 loaded environment variables matching “m2Pg105”")).toBeInTheDocument();
    expect(within(grid).queryByRole("row", { name: /HOME/u })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more variables" })).toBeInTheDocument();
    expect(api.runSessionWorkbench).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Load more variables" }));
    expect(await within(grid).findByRole("row", { name: /M2_PAGE_105/u })).toBeInTheDocument();
    expect(filter).toHaveValue("m2Pg105");
    expect(within(grid).queryByRole("row", { name: /HOME/u })).not.toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 2 loaded environment variables matching “m2Pg105”")).toBeInTheDocument();
    expect(api.runSessionWorkbench).toHaveBeenLastCalledWith({
      operationId: "session.environment.list",
      limit: 100,
      cursor: "environment-2",
    });
  });

  it("stops fuzzy-matching a revealed environment value when the reveal expires", async () => {
    installAPI((input) => {
      if (input.operationId === "session.environment.list") {
        return workbench(input.operationId, {
          items: [{ name: "API_TOKEN", sensitive: true, redacted: true }],
          page: { limit: 100, total: 1, truncated: false },
        });
      }
      if (input.operationId === "session.environment.reveal") {
        return workbench(input.operationId, {
          name: input.name,
          value: "super-secret",
          sensitive: true,
          revealedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 1_000).toISOString(),
        });
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    });

    render(<SessionEnvironmentPanel {...panelContext()} />);
    const filter = await screen.findByRole("searchbox", { name: "Filter environment variables" });
    const grid = screen.getByRole("grid", { name: "Session environment variables" });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

    await act(async () => {
      fireEvent.click(within(grid).getByRole("button", { name: "Reveal API_TOKEN" }));
    });
    expect(within(grid).getByText("super-secret")).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "suprscrt" } });
    expect(within(grid).getByRole("row", { name: /API_TOKEN/u })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_010);
    });
    expect(screen.getByText("Showing 0 of 1 loaded environment variables matching “suprscrt”")).toBeInTheDocument();
    expect(within(grid).queryByRole("row", { name: /API_TOKEN/u })).not.toBeInTheDocument();
    expect(screen.queryByText("super-secret")).not.toBeInTheDocument();
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
    await user.click(await screen.findByRole("button", { name: "Reveal API_TOKEN" }));
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

  it("separates the Windows registry key tree from values and reads selected data", async () => {
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
          return workbench(input.operationId, { hive: input.hive, path: input.path, key: input.key, type: "string", value: "C:\\Program Files\\Sliver" });
        case "session.registry.read-hive":
          return workbench(input.operationId, { status: "canceled" });
        default: throw new Error(`Unexpected operation ${input.operationId}`);
      }
    });

    render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    expect(await screen.findByRole("row", { name: /InstallPath/i })).toBeInTheDocument();
    const tree = screen.getByRole("treegrid", { name: "Registry keys" });
    const values = screen.getByRole("grid", { name: "Registry values in HKCU" });
    const editor = screen.getByRole("region", { name: "Registry editor" });
    const keyScrollRegion = tree.closest<HTMLElement>('[data-registry-scroll-region="keys"]');
    const valueScrollRegion = values.closest<HTMLElement>('[data-registry-scroll-region="values"]');
    const valueTableScrollContainer = values.closest<HTMLElement>('[data-slot="table-scroll-container"]');
    expect(editor).toHaveClass("h-full", "max-h-full", "min-h-0", "overflow-hidden");
    expect(keyScrollRegion).toHaveClass("min-h-0", "flex-1", "overflow-auto", "overscroll-contain");
    expect(valueScrollRegion).toHaveClass("min-h-0", "flex-1", "overflow-hidden");
    expect(valueTableScrollContainer).toHaveClass("h-full", "max-h-full", "overflow-auto", "overscroll-contain");
    expect(within(tree).getByText("Software")).toBeInTheDocument();
    expect(within(tree).queryByText("InstallPath")).not.toBeInTheDocument();
    expect(within(values).queryByText("Software")).not.toBeInTheDocument();
    expect(within(values).getByRole("columnheader", { name: "Data" })).toBeInTheDocument();
    expect(api.runSessionWorkbench.mock.calls.some(([input]) => input.operationId === "session.registry.read")).toBe(false);
    expect(screen.getByRole("button", { name: "Save hive" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete registry key" })).toBeDisabled();
    await user.click(within(tree).getByText("Software"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save hive" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Save hive" }));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "session.registry.read-hive",
      rootHive: "HKCU",
      requestedHive: "Software",
    }));
    await user.click(screen.getByRole("button", { name: "Read InstallPath" }));
    expect(await within(screen.getByRole("region", { name: "Selected value data" })).findByText("C:\\Program Files\\Sliver")).toBeInTheDocument();
    expect(within(screen.getByRole("grid", { name: "Registry values in HKCU Software" })).getByText("C:\\Program Files\\Sliver")).toBeInTheDocument();
  });

  it("visually distinguishes typed registry strings, including empty values", async () => {
    const user = userEvent.setup();
    const stringValues = new Map([
      ["Color", "180 180 180"],
      ["Blank", ""],
      ["LiteralEmpty", "(empty)"],
    ]);
    installAPI((input) => {
      if (input.operationId === "session.registry.list-subkeys") {
        return workbench(input.operationId, { items: [], page: { limit: 500, total: 0, truncated: false } });
      }
      if (input.operationId === "session.registry.list-values") {
        return workbench(input.operationId, {
          items: [...stringValues.keys()],
          page: { limit: 500, total: stringValues.size, truncated: false },
        });
      }
      if (input.operationId === "session.registry.read") {
        return workbench(input.operationId, {
          hive: input.hive,
          path: input.path,
          key: input.key,
          type: "string",
          value: stringValues.get(input.key)!,
        });
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    });

    render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    const grid = await screen.findByRole("grid", { name: "Registry values in HKCU" });
    const details = screen.getByRole("region", { name: "Selected value data" });

    await user.click(within(grid).getByRole("button", { name: "Read Color" }));
    const colorRow = within(grid).getByRole("rowheader", { name: "Color" }).closest<HTMLElement>("[role=row]")!;
    const colorData = await within(colorRow).findByText("180 180 180");
    expect(colorData.parentElement).toHaveTextContent(/^"180 180 180"$/u);
    expect(within(colorRow).getByText("String")).toBeInTheDocument();
    const selectedColor = within(details).getByText("180 180 180");
    expect(selectedColor.parentElement).toHaveTextContent(/^"180 180 180"$/u);

    await user.click(within(grid).getByRole("button", { name: "Read Blank" }));
    const blankRow = within(grid).getByRole("rowheader", { name: "Blank" }).closest<HTMLElement>("[role=row]")!;
    const blankData = await within(blankRow).findByText("(empty)");
    expect(blankData).toHaveClass("italic", "text-muted");
    expect(blankData).toHaveTextContent("(empty)");
    const selectedBlank = within(details).getByText("(empty)");
    expect(selectedBlank).toHaveClass("italic", "text-muted");

    await user.click(within(grid).getByRole("button", { name: "Read LiteralEmpty" }));
    const literalRow = within(grid).getByRole("rowheader", { name: "LiteralEmpty" }).closest<HTMLElement>("[role=row]")!;
    const literalData = await within(literalRow).findByText("(empty)");
    expect(literalData.parentElement).toHaveTextContent(/^"\(empty\)"$/u);
    expect(literalData).not.toHaveClass("italic");
    expect(literalData).not.toHaveClass("text-muted");
    const selectedLiteral = within(details).getByText("(empty)");
    expect(selectedLiteral.parentElement).toHaveTextContent(/^"\(empty\)"$/u);
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
      limit: 100,
      cursor: "subkeys-2",
    });
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({
      operationId: "session.registry.list-values",
      hive: "HKCU",
      path: "",
      limit: 100,
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

    await user.click(within(screen.getByRole("treegrid", { name: "Registry keys" })).getByText("Software"));
    await user.click(await screen.findByRole("button", { name: "Delete registry key Software" }));
    expect(await screen.findByRole("alertdialog", { name: "Delete this registry key?" })).toBeInTheDocument();
    expect(api.prepareSessionDestructiveAction).toHaveBeenCalledWith({
      actionId: "session.registry.delete-key",
      hive: "HKCU",
      path: "",
      key: "Software",
    });
  });

  it("navigates full and abbreviated registry addresses with Enter and moves up to the hive root", async () => {
    const user = userEvent.setup();
    const api = installAPI((input) => {
      if (input.operationId === "session.registry.list-subkeys" || input.operationId === "session.registry.list-values") {
        return workbench(input.operationId, { items: [], page: { limit: 500, total: 0, truncated: false } });
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    });
    render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    await screen.findByText("This registry key has no values.");
    const address = screen.getByRole("textbox", { name: "Registry path" });
    expect(address).toHaveValue("Computer\\HKEY_CURRENT_USER");
    expect(screen.getByRole("button", { name: "Up one registry key" })).toBeDisabled();

    await user.clear(address);
    await user.type(address, "Computer\\HKEY_LOCAL_MACHINE\\Software\\Example{Enter}", { skipClick: true });
    expect(await screen.findByRole("grid", { name: "Registry values in HKLM Software\\Example" })).toBeInTheDocument();
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({
      operationId: "session.registry.list-subkeys", hive: "HKLM", path: "Software\\Example", limit: 100,
    });
    await user.click(screen.getByRole("button", { name: "Up one registry key" }));
    expect(await screen.findByRole("grid", { name: "Registry values in HKLM Software" })).toBeInTheDocument();
    expect(address).toHaveValue("Computer\\HKEY_LOCAL_MACHINE\\Software");
    await user.click(screen.getByRole("button", { name: "Up one registry key" }));
    expect(await screen.findByRole("grid", { name: "Registry values in HKLM" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Up one registry key" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save hive" })).toBeDisabled();

    await user.clear(address);
    await user.type(address, "hkcu\\Control Panel{Enter}", { skipClick: true });
    expect(await screen.findByRole("grid", { name: "Registry values in HKCU Control Panel" })).toBeInTheDocument();
    expect(address).toHaveValue("Computer\\HKEY_CURRENT_USER\\Control Panel");
    const callsBeforeInvalidAddress = api.runSessionWorkbench.mock.calls.length;
    await user.clear(address);
    await user.type(address, "Computer\\HKEY_UNKNOWN\\Software{Enter}", { skipClick: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a registry hive and path");
    expect(api.runSessionWorkbench).toHaveBeenCalledTimes(callsBeforeInvalidAddress);
  });

  it("preserves registry sibling keys while navigating and removes stale descendants on a parent reload", async () => {
    const user = userEvent.setup();
    let omitOldKey = false;
    installAPI((input) => {
      if (input.operationId === "session.registry.list-subkeys") {
        const items = input.path === "" ? ["Software", "System"]
          : input.path === "Software" ? omitOldKey ? ["KeepKey"] : ["OldKey", "KeepKey"]
          : input.path === "Software\\OldKey" ? ["Nested"]
          : input.path === "System" ? ["Policy"] : [];
        return workbench(input.operationId, { items, page: { limit: 500, total: items.length, truncated: false } });
      }
      if (input.operationId === "session.registry.list-values") {
        return workbench(input.operationId, { items: [], page: { limit: 500, total: 0, truncated: false } });
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    });
    render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    const tree = screen.getByRole("treegrid", { name: "Registry keys" });
    await user.click(await within(tree).findByText("Software"));
    await user.click(await within(tree).findByText("OldKey"));
    expect(await within(tree).findByText("Nested")).toBeInTheDocument();
    expect(within(tree).getByText("System")).toBeInTheDocument();

    omitOldKey = true;
    await user.click(within(tree).getByText("Software"));
    await screen.findByRole("grid", { name: "Registry values in HKCU Software" });
    expect(within(tree).queryByText("OldKey")).not.toBeInTheDocument();
    expect(within(tree).queryByText("Nested")).not.toBeInTheDocument();
    expect(within(tree).getByText("KeepKey")).toBeInTheDocument();
    expect(within(tree).getByText("System")).toBeInTheDocument();

    await user.click(within(tree).getByText("System"));
    expect(await within(tree).findByText("Policy")).toBeInTheDocument();
    expect(within(tree).getByText("KeepKey")).toBeInTheDocument();
    await user.click(within(tree).getByRole("button", { name: "Collapse Software" }));
    expect(within(tree).queryByText("KeepKey")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh registry" }));
    await screen.findByRole("grid", { name: "Registry values in HKCU System" });
    expect(within(tree).queryByText("KeepKey")).not.toBeInTheDocument();
  });

  it("reviews a selected registry key against its parent and returns to that parent after deletion", async () => {
    const user = userEvent.setup();
    let deleted = false;
    const api = installAPI((input) => {
      if (input.operationId === "session.registry.list-subkeys") {
        const items = input.path === "" ? ["Software"] : input.path === "Software" && !deleted ? ["Example"] : [];
        return workbench(input.operationId, { items, page: { limit: 500, total: items.length, truncated: false } });
      }
      if (input.operationId === "session.registry.list-values") {
        return workbench(input.operationId, { items: [], page: { limit: 500, total: 0, truncated: false } });
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    }, {
      prepare: (input) => preparedAction(input),
      execute: () => {
        deleted = true;
        return {
          ok: true,
          value: { actionId: "session.registry.delete-key", status: "succeeded", message: "Key deleted", payloadDigest: "b".repeat(64) },
        };
      },
    });
    render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    const tree = screen.getByRole("treegrid", { name: "Registry keys" });
    await user.click(await within(tree).findByText("Software"));
    await user.click(await within(tree).findByText("Example"));
    await screen.findByRole("grid", { name: "Registry values in HKCU Software\\Example" });
    await user.click(screen.getByRole("button", { name: "Delete registry key Example" }));
    const review = await screen.findByRole("alertdialog", { name: "Delete this registry key?" });
    expect(api.prepareSessionDestructiveAction).toHaveBeenCalledWith({
      actionId: "session.registry.delete-key", hive: "HKCU", path: "Software", key: "Example",
    });
    expect(api.executeSessionDestructiveActionPlan).not.toHaveBeenCalled();
    api.runSessionWorkbench.mockClear();
    await user.click(within(review).getByRole("button", { name: "Confirm action" }));
    await screen.findByRole("grid", { name: "Registry values in HKCU Software" });
    expect(api.executeSessionDestructiveActionPlan).toHaveBeenCalledWith({ token: "review-session.registry.delete-key" });
    expect(api.runSessionWorkbench.mock.calls.map(([input]) => input)).toEqual([
      { operationId: "session.registry.list-subkeys", hive: "HKCU", path: "Software", limit: 100 },
      { operationId: "session.registry.list-values", hive: "HKCU", path: "Software", limit: 100 },
    ]);
    expect(screen.getByRole("textbox", { name: "Registry path" })).toHaveValue("Computer\\HKEY_CURRENT_USER\\Software");
    expect(within(tree).queryByText("Example")).not.toBeInTheDocument();
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
    await screen.findByText("This registry key has no values.");
    await user.clear(pathInput);
    await user.type(pathInput, "Old", { skipClick: true });
    await user.click(screen.getByRole("button", { name: "Go" }));
    await user.clear(pathInput);
    await user.type(pathInput, "New", { skipClick: true });
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
    expect(screen.getByRole("grid", { name: /Registry values in HKCU New/i })).toBeInTheDocument();
    expect(pathInput).toHaveValue("Computer\\HKEY_CURRENT_USER\\New");
    expect(within(screen.getByRole("treegrid", { name: "Registry keys" })).queryByText("Old")).not.toBeInTheDocument();
  });

  it("keeps the latest registry selection while caching earlier completed reads", async () => {
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
        type: "string",
        value: "newest-data",
      }));
    });
    expect(await within(screen.getByRole("region", { name: "Selected value data" })).findByText("newest-data")).toBeInTheDocument();

    await act(async () => {
      firstRead.resolve(workbench("session.registry.read", {
        hive: "HKCU",
        path: "",
        key: "First",
        type: "string",
        value: "stale-data",
      }));
    });
    expect(within(screen.getByRole("region", { name: "Selected value data" })).getByText("newest-data")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Selected value data" })).queryByText("stale-data")).not.toBeInTheDocument();
    expect(within(screen.getByRole("grid", { name: "Registry values in HKCU" })).getByText("stale-data")).toBeInTheDocument();
  });

  async function navigateRegistryAddress(user: ReturnType<typeof userEvent.setup>, address: string, gridName: string) {
    const input = screen.getByRole("textbox", { name: "Registry path" });
    await user.clear(input);
    await user.type(input, `${address}{Enter}`, { skipClick: true });
    return screen.findByRole("grid", { name: gridName });
  }

  function registryContextWorkbench(input: SessionWorkbenchInput) {
    if (input.operationId === "session.registry.list-subkeys") {
      const items = input.path === "" ? ["Software", "Other"] : input.path === "Software" ? ["Current", "Target"] : [];
      return workbench(input.operationId, { items, page: { limit: 500, total: items.length, truncated: false } });
    }
    if (input.operationId === "session.registry.list-values") {
      return workbench(input.operationId, { items: ["Message"], page: { limit: 500, total: 1, truncated: false } });
    }
    if (input.operationId === "session.registry.read") {
      return workbench(input.operationId, { hive: input.hive, path: input.path, key: input.key, type: "unknown", value: "existing data" });
    }
    throw new Error(`Unexpected operation ${input.operationId}`);
  }

  it.each(["Create key", "Write value"] as const)("prefills %s from a right-clicked registry key without navigating to it", async (action) => {
    const user = userEvent.setup();
    const api = installAPI(registryContextWorkbench);
    const rendered = render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    await screen.findByRole("grid", { name: "Registry values in HKCU" });
    const clicked = within(screen.getByRole("treegrid", { name: "Registry keys" })).getByText("Software");
    fireEvent.contextMenu(clicked);
    rendered.contextMenu.emit();
    await user.click(await screen.findByRole("menuitem", { name: action }));
    const editor = await screen.findByRole("dialog", { name: "Review registry change" });
    expect(within(editor).getByRole("textbox", { name: "Registry location" })).toHaveValue("Computer\\HKEY_CURRENT_USER\\Software");
    expect(within(editor).getByRole("textbox", { name: action === "Create key" ? "New subkey name" : "Value name" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Registry path", hidden: true })).toHaveValue("Computer\\HKEY_CURRENT_USER");
    expect(api.runSessionWorkbench.mock.calls.filter(([input]) => input.operationId === "session.registry.list-values")).toHaveLength(1);
    expect(api.prepareSessionDestructiveAction).not.toHaveBeenCalled();
  });

  it.each(["Create key", "Write value"] as const)("prefills toolbar %s with the current location and reviews an edited normalized destination", async (action) => {
    const user = userEvent.setup();
    const api = installAPI(registryContextWorkbench, { prepare: (input) => preparedAction(input) });
    render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    await screen.findByRole("grid", { name: "Registry values in HKCU" });
    await navigateRegistryAddress(user, "HKCU\\Software\\Current", "Registry values in HKCU Software\\Current");
    await user.click(screen.getByRole("button", { name: action }));
    const editor = await screen.findByRole("dialog", { name: "Review registry change" });
    const location = within(editor).getByRole("textbox", { name: "Registry location" });
    expect(location).toHaveValue("Computer\\HKEY_CURRENT_USER\\Software\\Current");
    await user.clear(location);
    await user.type(location, "hklm/Software/Destination", { skipClick: true });
    await user.click(within(editor).getByRole("radio", { name: action === "Create key" ? "Write value" : "Create key" }));
    await user.click(within(editor).getByRole("radio", { name: action }));
    expect(location).toHaveValue("hklm/Software/Destination");
    if (action === "Create key") {
      await user.type(within(editor).getByRole("textbox", { name: "New subkey name" }), "NewChild");
      await user.click(within(editor).getByRole("button", { name: "Review create key" }));
      await screen.findByRole("alertdialog", { name: "Create this registry key?" });
      expect(api.prepareSessionDestructiveAction).toHaveBeenCalledWith({ actionId: "session.registry.create-key", hive: "HKLM", path: "Software\\Destination", key: "NewChild" });
    } else {
      await user.type(within(editor).getByRole("textbox", { name: "Value name" }), "Greeting");
      await user.type(within(editor).getByRole("textbox", { name: "String value" }), "updated data");
      await user.click(within(editor).getByRole("button", { name: "Review write value" }));
      await screen.findByRole("alertdialog", { name: "Write this registry value?" });
      expect(api.prepareSessionDestructiveAction).toHaveBeenCalledWith({ actionId: "session.registry.write", hive: "HKLM", path: "Software\\Destination", key: "Greeting", value: { type: "string", value: "updated data" } });
    }
    expect(api.executeSessionDestructiveActionPlan).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "String",
      type: "string" as const,
      value: "existing data",
      field: "String value",
      expected: { type: "string" as const, value: "existing data" },
    },
    {
      label: "Binary",
      type: "binary" as const,
      value: "007f80ff",
      field: "Hexadecimal bytes",
      expected: { type: "binary" as const, hex: "007f80ff" },
    },
    {
      label: "DWORD",
      type: "dword" as const,
      value: "1511506142",
      field: "Unsigned 32-bit value",
      expected: { type: "dword" as const, value: 1511506142 },
    },
    {
      label: "QWORD",
      type: "qword" as const,
      value: "18446744073709551615",
      field: "Unsigned 64-bit value",
      expected: { type: "qword" as const, value: "18446744073709551615" },
    },
  ])("prefills and directly reviews a known $label registry value", async ({ label, type, value, field, expected }) => {
    const user = userEvent.setup();
    const api = installAPI((input) => {
      if (input.operationId === "session.registry.list-subkeys") {
        return workbench(input.operationId, { items: [], page: { limit: 500, total: 0, truncated: false } });
      }
      if (input.operationId === "session.registry.list-values") {
        return workbench(input.operationId, { items: ["Message"], page: { limit: 500, total: 1, truncated: false } });
      }
      if (input.operationId === "session.registry.read") {
        return workbench(input.operationId, { hive: input.hive, path: input.path, key: input.key, type, value });
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    }, { prepare: (input) => preparedAction(input) });
    const rendered = render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    const grid = await screen.findByRole("grid", { name: "Registry values in HKCU" });
    fireEvent.contextMenu(within(grid).getByRole("rowheader", { name: "Message" }));
    rendered.contextMenu.emit();
    await user.click(await screen.findByRole("menuitem", { name: "Modify value" }));
    const editor = await screen.findByRole("dialog", { name: "Modify registry value" });
    expect(within(editor).getByRole("button", { name: /Registry value type/ })).toHaveTextContent(label);
    expect(within(editor).getByRole("textbox", { name: field })).toHaveValue(value);
    expect(within(editor).queryByText("The selected agent did not report this value's type. Choose it before reviewing.")).not.toBeInTheDocument();
    expect(within(editor).getByRole("button", { name: "Review write value" })).toBeEnabled();
    await user.click(within(editor).getByRole("button", { name: "Review write value" }));
    await screen.findByRole("alertdialog", { name: "Write this registry value?" });
    expect(api.prepareSessionDestructiveAction).toHaveBeenCalledExactlyOnceWith({
      actionId: "session.registry.write",
      hive: "HKCU",
      path: "",
      key: "Message",
      value: expected,
    });
    expect(api.executeSessionDestructiveActionPlan).not.toHaveBeenCalled();
  });

  it("preserves the manual type fallback for a legacy registry value", async () => {
    const user = userEvent.setup();
    const api = installAPI(registryContextWorkbench, { prepare: (input) => preparedAction(input) });
    const rendered = render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    const grid = await screen.findByRole("grid", { name: "Registry values in HKCU" });
    fireEvent.contextMenu(within(grid).getByRole("rowheader", { name: "Message" }));
    rendered.contextMenu.emit();
    await user.click(await screen.findByRole("menuitem", { name: "Modify value" }));
    const editor = await screen.findByRole("dialog", { name: "Modify registry value" });
    expect(within(editor).getByRole("textbox", { name: "Registry location" })).toHaveValue("Computer\\HKEY_CURRENT_USER");
    expect(within(editor).getByRole("textbox", { name: "Value name" })).toHaveValue("Message");
    expect(within(editor).getByRole("textbox", { name: "Value data" })).toHaveValue("existing data");
    expect(within(editor).getByText("Select value type")).toBeInTheDocument();
    expect(within(editor).getByText("The selected agent did not report this value's type. Choose it before reviewing.")).toBeInTheDocument();
    expect(within(editor).getByRole("button", { name: "Review write value" })).toBeDisabled();
    await user.click(within(editor).getByRole("button", { name: /Registry value type/ }));
    await user.click(await screen.findByRole("option", { name: "DWORD" }));
    expect(within(editor).getByRole("textbox", { name: "Unsigned 32-bit value" })).toHaveValue("existing data");
    expect(within(editor).getByRole("alert")).toHaveTextContent("DWORD must be an unsigned 32-bit decimal integer.");
    expect(within(editor).getByRole("button", { name: "Review write value" })).toBeDisabled();
    await user.click(within(editor).getByRole("button", { name: /Registry value type/ }));
    await user.click(await screen.findByRole("option", { name: "String" }));
    expect(within(editor).getByRole("textbox", { name: "String value" })).toHaveValue("existing data");
    await user.click(within(editor).getByRole("button", { name: "Review write value" }));
    await screen.findByRole("alertdialog", { name: "Write this registry value?" });
    expect(api.prepareSessionDestructiveAction).toHaveBeenCalledWith({ actionId: "session.registry.write", hive: "HKCU", path: "", key: "Message", value: { type: "string", value: "existing data" } });
    expect(api.executeSessionDestructiveActionPlan).not.toHaveBeenCalled();
  });

  it("reopens Modify from a typed cached registry value without another read", async () => {
    const user = userEvent.setup();
    let readCount = 0;
    const api = installAPI((input) => {
      if (input.operationId === "session.registry.list-subkeys") {
        return workbench(input.operationId, { items: [], page: { limit: 500, total: 0, truncated: false } });
      }
      if (input.operationId === "session.registry.list-values") {
        return workbench(input.operationId, { items: ["Message"], page: { limit: 500, total: 1, truncated: false } });
      }
      if (input.operationId === "session.registry.read") {
        readCount += 1;
        return workbench(input.operationId, {
          hive: input.hive,
          path: input.path,
          key: input.key,
          type: "binary",
          value: "deadbeef",
        });
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    });
    const rendered = render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    const grid = await screen.findByRole("grid", { name: "Registry values in HKCU" });
    const valueName = within(grid).getByRole("rowheader", { name: "Message" });

    fireEvent.contextMenu(valueName);
    rendered.contextMenu.emit();
    await user.click(await screen.findByRole("menuitem", { name: "Modify value" }));
    let editor = await screen.findByRole("dialog", { name: "Modify registry value" });
    expect(within(editor).getByRole("button", { name: /Registry value type/ })).toHaveTextContent("Binary");
    expect(within(editor).getByRole("textbox", { name: "Hexadecimal bytes" })).toHaveValue("deadbeef");
    expect(readCount).toBe(1);
    await user.click(within(editor).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Modify registry value" })).not.toBeInTheDocument());

    fireEvent.contextMenu(valueName);
    rendered.contextMenu.emit();
    await user.click(await screen.findByRole("menuitem", { name: "Modify value" }));
    editor = await screen.findByRole("dialog", { name: "Modify registry value" });
    expect(within(editor).getByRole("button", { name: /Registry value type/ })).toHaveTextContent("Binary");
    expect(within(editor).getByRole("textbox", { name: "Hexadecimal bytes" })).toHaveValue("deadbeef");
    expect(readCount).toBe(1);
    expect(api.runSessionWorkbench.mock.calls.filter(([input]) => input.operationId === "session.registry.read")).toHaveLength(1);
  });

  it("reviews deletion of the right-clicked registry key instead of the current selected key", async () => {
    const user = userEvent.setup();
    const api = installAPI(registryContextWorkbench, { prepare: (input) => preparedAction(input) });
    const rendered = render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    await screen.findByRole("grid", { name: "Registry values in HKCU" });
    await navigateRegistryAddress(user, "HKCU\\Software", "Registry values in HKCU Software");
    await user.click(within(screen.getByRole("treegrid", { name: "Registry keys" })).getByText("Current"));
    await screen.findByRole("grid", { name: "Registry values in HKCU Software\\Current" });
    fireEvent.contextMenu(within(screen.getByRole("treegrid", { name: "Registry keys" })).getByText("Target"));
    rendered.contextMenu.emit();
    await user.click(await screen.findByRole("menuitem", { name: "Delete key" }));
    await screen.findByRole("alertdialog", { name: "Delete this registry key?" });
    expect(api.prepareSessionDestructiveAction).toHaveBeenCalledWith({ actionId: "session.registry.delete-key", hive: "HKCU", path: "Software", key: "Target" });
    expect(api.executeSessionDestructiveActionPlan).not.toHaveBeenCalled();
  });

  it("omits registry Delete for hives and values and clears domain actions on headers and blank space", async () => {
    const user = userEvent.setup();
    installAPI(registryContextWorkbench);
    const rendered = render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    const grid = await screen.findByRole("grid", { name: "Registry values in HKCU" });
    fireEvent.contextMenu(within(screen.getByRole("treegrid", { name: "Registry keys" })).getByText("HKEY_CURRENT_USER"));
    rendered.contextMenu.emit();
    let menu = await screen.findByRole("menu", { name: "Application context menu" });
    expect(within(menu).getByRole("menuitem", { name: "Create key" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /Delete|Modify/ })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    fireEvent.contextMenu(within(grid).getByRole("rowheader", { name: "Message" }));
    rendered.contextMenu.emit();
    menu = await screen.findByRole("menu", { name: "Application context menu" });
    expect(within(menu).getByRole("menuitem", { name: "Modify value" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /Delete/ })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    for (const target of [within(grid).getByRole("columnheader", { name: "Name" }), grid]) {
      fireEvent.contextMenu(target);
      rendered.contextMenu.emit();
      menu = await screen.findByRole("menu", { name: "Application context menu" });
      expect(within(menu).queryByRole("menuitem", { name: /Create key|Write value|Modify value|Delete key/ })).not.toBeInTheDocument();
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    }
  });

  it.each(["navigation", "route change"] as const)("ignores registry context menu actions captured before %s", async (change) => {
    const user = userEvent.setup();
    const api = installAPI(registryContextWorkbench);
    const context = panelContext({ os: "windows", arch: "amd64" });
    const rendered = render(<SessionRegistryPanel {...context} />);
    await screen.findByRole("grid", { name: "Registry values in HKCU" });
    const address = screen.getByRole("textbox", { name: "Registry path" });
    fireEvent.contextMenu(within(screen.getByRole("treegrid", { name: "Registry keys" })).getByText("Software"));
    rendered.contextMenu.emit();
    const action = await screen.findByRole("menuitem", { name: "Create key" });
    if (change === "navigation") {
      fireEvent.change(address, { target: { value: "HKCU\\Other" } });
      fireEvent.submit(address.closest("form")!);
      await waitFor(() => expect(api.runSessionWorkbench).toHaveBeenCalledWith({ operationId: "session.registry.list-values", hive: "HKCU", path: "Other", limit: 100 }));
    } else rendered.rerender(<SessionRegistryPanel {...context} route={{ ...context.route, backendEpoch: context.route.backendEpoch + 1 }} />);
    await user.click(action);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    });
    expect(screen.queryByRole("dialog", { name: "Review registry change" })).not.toBeInTheDocument();
    expect(api.prepareSessionDestructiveAction).not.toHaveBeenCalled();
  });

  it.each(["navigation", "newer create", "newer delete"] as const)("does not reopen a registry Modify form after %s supersedes its value read", async (change) => {
    const user = userEvent.setup();
    const pendingRead = deferred<unknown>();
    const api = installAPI((input) => input.operationId === "session.registry.read" ? pendingRead.promise : registryContextWorkbench(input), { prepare: (input) => preparedAction(input) });
    const rendered = render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    const grid = await screen.findByRole("grid", { name: "Registry values in HKCU" });
    fireEvent.contextMenu(within(grid).getByRole("rowheader", { name: "Message" }));
    rendered.contextMenu.emit();
    await user.click(await screen.findByRole("menuitem", { name: "Modify value" }));
    await waitFor(() => expect(api.runSessionWorkbench).toHaveBeenCalledWith({ operationId: "session.registry.read", hive: "HKCU", path: "", key: "Message" }));
    if (change === "navigation") await navigateRegistryAddress(user, "HKCU\\Other", "Registry values in HKCU Other");
    else if (change === "newer create") {
      await user.click(screen.getByRole("button", { name: "Create key" }));
      await user.type(await screen.findByRole("textbox", { name: "New subkey name" }), "KeepThisDraft");
    } else {
      fireEvent.contextMenu(within(screen.getByRole("treegrid", { name: "Registry keys" })).getByText("Software"));
      rendered.contextMenu.emit();
      await user.click(await screen.findByRole("menuitem", { name: "Delete key" }));
      await screen.findByRole("alertdialog", { name: "Delete this registry key?" });
    }
    await act(async () => {
      pendingRead.resolve(workbench("session.registry.read", { hive: "HKCU", path: "", key: "Message", type: "string", value: "late data" }));
    });
    expect(screen.queryByRole("dialog", { name: "Modify registry value" })).not.toBeInTheDocument();
    if (change === "newer create") expect(screen.getByRole("textbox", { name: "New subkey name" })).toHaveValue("KeepThisDraft");
    else expect(screen.queryByRole("dialog", { name: "Review registry change" })).not.toBeInTheDocument();
    if (change === "newer delete") {
      expect(screen.getByRole("alertdialog", { name: "Delete this registry key?" })).toBeInTheDocument();
      expect(api.prepareSessionDestructiveAction).toHaveBeenCalledExactlyOnceWith({ actionId: "session.registry.delete-key", hive: "HKCU", path: "", key: "Software" });
    } else expect(api.prepareSessionDestructiveAction).not.toHaveBeenCalled();
    expect(api.executeSessionDestructiveActionPlan).not.toHaveBeenCalled();
  });

  it("caches registry values across paths and hives with case-insensitive names while explicit Read refetches", async () => {
    const user = userEvent.setup();
    let readCount = 0;
    const api = installAPI((input) => {
      if (input.operationId === "session.registry.list-subkeys") {
        return workbench(input.operationId, { items: [], page: { limit: 500, total: 0, truncated: false } });
      }
      if (input.operationId === "session.registry.list-values") {
        return workbench(input.operationId, { items: [input.path === "software" ? "name" : "Name"], page: { limit: 500, total: 1, truncated: false } });
      }
      if (input.operationId === "session.registry.read") {
        return workbench(input.operationId, { ...input, type: "string", value: `${input.hive}:${input.path.toLowerCase()}:${++readCount}` });
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    });
    render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    await screen.findByRole("grid", { name: "Registry values in HKCU" });
    let grid = await navigateRegistryAddress(user, "HKCU\\Software", "Registry values in HKCU Software");
    await user.click(within(grid).getByRole("rowheader", { name: "Name" }));
    expect(await within(screen.getByRole("region", { name: "Selected value data" })).findByText("HKCU:software:1")).toBeInTheDocument();

    grid = await navigateRegistryAddress(user, "HKCU\\Other", "Registry values in HKCU Other");
    expect(within(grid).queryByText("HKCU:software:1")).not.toBeInTheDocument();
    await user.click(within(grid).getByRole("rowheader", { name: "Name" }));
    expect(await within(screen.getByRole("region", { name: "Selected value data" })).findByText("HKCU:other:2")).toBeInTheDocument();
    grid = await navigateRegistryAddress(user, "HKLM\\Software", "Registry values in HKLM Software");
    await user.click(within(grid).getByRole("rowheader", { name: "Name" }));
    expect(await within(screen.getByRole("region", { name: "Selected value data" })).findByText("HKLM:software:3")).toBeInTheDocument();

    grid = await navigateRegistryAddress(user, "hkcu\\software", "Registry values in HKCU software");
    expect(within(grid).getByText("HKCU:software:1")).toBeInTheDocument();
    await user.click(within(grid).getByText("name", { exact: true }));
    expect(await within(screen.getByRole("region", { name: "Selected value data" })).findByText("HKCU:software:1")).toBeInTheDocument();
    expect(readCount).toBe(3);
    await user.click(screen.getByRole("button", { name: "Read name" }));
    expect(await within(screen.getByRole("region", { name: "Selected value data" })).findByText("HKCU:software:4")).toBeInTheDocument();
    expect(api.runSessionWorkbench).toHaveBeenLastCalledWith({ operationId: "session.registry.read", hive: "HKCU", path: "software", key: "name" });
  });

  it("refreshes registry listings and clears all value caches without accepting late reads from before refresh", async () => {
    const user = userEvent.setup();
    const staleRead = deferred<unknown>();
    let childReads = 0;
    let rootReads = 0;
    const api = installAPI((input) => {
      if (input.operationId === "session.registry.list-subkeys") {
        return workbench(input.operationId, { items: [], page: { limit: 500, total: 0, truncated: false } });
      }
      if (input.operationId === "session.registry.list-values") {
        return workbench(input.operationId, { items: ["Name"], page: { limit: 500, total: 1, truncated: false } });
      }
      if (input.operationId === "session.registry.read") {
        if (input.path === "Child" && ++childReads === 1) return staleRead.promise;
        return workbench(input.operationId, { ...input, type: "string", value: input.path === "Child" ? "fresh-child" : `root-${++rootReads}` });
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    });
    render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    let grid = await screen.findByRole("grid", { name: "Registry values in HKCU" });
    await user.click(within(grid).getByRole("rowheader", { name: "Name" }));
    expect(await within(grid).findByText("root-1")).toBeInTheDocument();
    grid = await navigateRegistryAddress(user, "HKCU\\Child", "Registry values in HKCU Child");
    await user.click(within(grid).getByRole("rowheader", { name: "Name" }));
    await waitFor(() => expect(childReads).toBe(1));
    const listingsBeforeRefresh = api.runSessionWorkbench.mock.calls.filter(([input]) => input.operationId === "session.registry.list-values" && input.path === "Child").length;
    await user.click(screen.getByRole("button", { name: "Refresh registry" }));
    await screen.findByRole("grid", { name: "Registry values in HKCU Child" });
    expect(api.runSessionWorkbench.mock.calls.filter(([input]) => input.operationId === "session.registry.list-values" && input.path === "Child")).toHaveLength(listingsBeforeRefresh + 1);
    grid = await navigateRegistryAddress(user, "HKCU", "Registry values in HKCU");
    expect(within(grid).queryByText("root-1")).not.toBeInTheDocument();
    await user.click(within(grid).getByRole("rowheader", { name: "Name" }));
    expect(await within(grid).findByText("root-2")).toBeInTheDocument();

    await act(async () => {
      staleRead.resolve(workbench("session.registry.read", { hive: "HKCU", path: "Child", key: "Name", type: "string", value: "before-refresh" }));
    });
    grid = await navigateRegistryAddress(user, "HKCU\\Child", "Registry values in HKCU Child");
    expect(within(grid).queryByText("before-refresh")).not.toBeInTheDocument();
    expect(within(grid).getByText("(not loaded)")).toBeInTheDocument();
    await user.click(within(grid).getByRole("rowheader", { name: "Name" }));
    expect(await within(grid).findByText("fresh-child")).toBeInTheDocument();
    expect(childReads).toBe(2);
  });

  it("eagerly reads only loaded registry values until Load more is pressed and retries failures only after refresh", async () => {
    const user = userEvent.setup();
    const firstRead = deferred<unknown>();
    const secondRead = deferred<unknown>();
    const reads = new Map<string, number>();
    const api = installAPI((input) => {
      if (input.operationId === "session.registry.list-subkeys") {
        return workbench(input.operationId, { items: ["Child"], page: { limit: 100, total: 2, truncated: true, nextCursor: "subkeys-2" } });
      }
      if (input.operationId === "session.registry.list-values") {
        return workbench(input.operationId, input.cursor ? {
          items: ["Third", ""], page: { limit: 100, total: 5, truncated: false },
        } : {
          items: ["First", "Second", "Denied"], page: { limit: 100, total: 5, truncated: true, nextCursor: "values-2" },
        });
      }
      if (input.operationId === "session.registry.read") {
        reads.set(input.key, (reads.get(input.key) ?? 0) + 1);
        if (input.key === "Denied") throw new Error("Access denied");
        if (input.key === "First" && reads.get(input.key) === 1) return firstRead.promise;
        if (input.key === "Second" && reads.get(input.key) === 1) return secondRead.promise;
        return workbench(input.operationId, { ...input, type: "string", value: input.key ? `${input.key}-data` : "" });
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    });
    render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    await screen.findByRole("grid", { name: "Registry values in HKCU" });
    const eager = screen.getByRole("checkbox", { name: "Load all values" });
    expect(eager).not.toBeChecked();
    expect(reads.size).toBe(0);
    await user.click(eager);
    await waitFor(() => expect([...reads.keys()].sort()).toEqual(["Denied", "First", "Second"]));
    const grid = screen.getByRole("grid", { name: "Registry values in HKCU" });
    await user.click(within(grid).getByText("First"));
    await act(async () => {
      firstRead.resolve(workbench("session.registry.read", { hive: "HKCU", path: "", key: "First", type: "string", value: "First-data" }));
    });
    const details = screen.getByRole("region", { name: "Selected value data" });
    expect(await within(details).findByText("First-data")).toBeInTheDocument();
    await act(async () => {
      secondRead.resolve(workbench("session.registry.read", { hive: "HKCU", path: "", key: "Second", type: "string", value: "Second-data" }));
    });
    await waitFor(() => expect(within(grid).getByText("Second-data")).toBeInTheDocument());
    expect([...reads.keys()].sort()).toEqual(["Denied", "First", "Second"]);
    expect(api.runSessionWorkbench.mock.calls.filter(([input]) => input.operationId === "session.registry.list-values" && input.cursor === "values-2")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Load more values" })).toBeInTheDocument();
    expect(within(grid).queryByText("Third")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more values" }));
    await waitFor(() => expect([...reads.keys()].sort()).toEqual(["", "Denied", "First", "Second", "Third"]));
    expect(api.runSessionWorkbench).toHaveBeenCalledWith({ operationId: "session.registry.list-values", hive: "HKCU", path: "", limit: 100, cursor: "values-2" });
    expect(within(grid).getByText("Second-data")).toBeInTheDocument();
    expect(within(details).getByText("First-data")).toBeInTheDocument();
    expect(reads.get("First")).toBe(1);
    expect(reads.get("Denied")).toBe(1);
    expect(api.runSessionWorkbench.mock.calls.filter(([input]) => input.operationId === "session.registry.list-subkeys")).toHaveLength(1);
    expect(api.runSessionWorkbench.mock.calls.every(([input]) => !String(input.operationId).startsWith("session.registry.") || !("path" in input) || input.path === "")).toBe(true);
    await user.click(within(grid).getByText("(Default)"));
    expect(await within(details).findByText("(empty)")).toHaveClass("italic", "text-muted");
    expect(reads.get("")).toBe(1);

    await user.click(screen.getByRole("button", { name: "Refresh registry" }));
    await waitFor(() => expect(reads.get("Denied")).toBe(2));
    expect(Object.fromEntries(reads)).toEqual({ First: 2, Second: 2, Denied: 2, Third: 1, "": 1 });
    expect(screen.getByRole("checkbox", { name: "Load all values" })).toBeChecked();
    expect(api.runSessionWorkbench.mock.calls.filter(([input]) => input.operationId === "session.registry.list-values" && input.cursor === "values-2")).toHaveLength(1);
  });

  it.each(["toggle off", "navigate away"] as const)("stops queued registry eager reads when users %s", async (stop) => {
    const user = userEvent.setup();
    const pending = new Map<string, ReturnType<typeof deferred<unknown>>>();
    const names = Array.from({ length: 8 }, (_, index) => `Value${index}`);
    const api = installAPI((input) => {
      if (input.operationId === "session.registry.list-subkeys") {
        return workbench(input.operationId, { items: [], page: { limit: 500, total: 0, truncated: false } });
      }
      if (input.operationId === "session.registry.list-values") {
        const items = input.path ? ["Next0", "Next1"] : names;
        return workbench(input.operationId, { items, page: { limit: 500, total: items.length, truncated: false } });
      }
      if (input.operationId === "session.registry.read") {
        const result = deferred<unknown>();
        pending.set(input.key, result);
        return result.promise;
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    });
    render(<SessionRegistryPanel {...panelContext({ os: "windows", arch: "amd64" })} />);
    await screen.findByRole("grid", { name: "Registry values in HKCU" });
    await user.click(screen.getByRole("checkbox", { name: "Load all values" }));
    await waitFor(() => expect(pending.size).toBe(4));
    if (stop === "toggle off") await user.click(screen.getByRole("checkbox", { name: "Load all values" }));
    else await navigateRegistryAddress(user, "HKCU\\Other", "Registry values in HKCU Other");
    expect(pending.size).toBe(4);
    await act(async () => {
      for (const [key, result] of [...pending]) {
        result.resolve(workbench("session.registry.read", { hive: "HKCU", path: "", key, type: "string", value: `${key}-data` }));
      }
    });
    if (stop === "navigate away") {
      await waitFor(() => expect(pending.size).toBe(6));
      expect(api.runSessionWorkbench.mock.calls.filter(([input]) => input.operationId === "session.registry.read" && input.path === "Other")).toHaveLength(2);
      await act(async () => {
        for (const key of ["Next0", "Next1"]) {
          pending.get(key)!.resolve(workbench("session.registry.read", { hive: "HKCU", path: "Other", key, type: "string", value: `${key}-data` }));
        }
      });
    } else expect(pending.size).toBe(4);
    expect(api.runSessionWorkbench.mock.calls.filter(([input]) => input.operationId === "session.registry.read" && input.path === "")).toHaveLength(4);
  });

  it("clears cached registry values when the session route changes", async () => {
    const user = userEvent.setup();
    let readCount = 0;
    installAPI((input) => {
      if (input.operationId === "session.registry.list-subkeys") {
        return workbench(input.operationId, { items: [], page: { limit: 500, total: 0, truncated: false } });
      }
      if (input.operationId === "session.registry.list-values") {
        return workbench(input.operationId, { items: ["Name"], page: { limit: 500, total: 1, truncated: false } });
      }
      if (input.operationId === "session.registry.read") return workbench(input.operationId, { ...input, type: "string", value: `session-data-${++readCount}` });
      throw new Error(`Unexpected operation ${input.operationId}`);
    });
    const context = panelContext({ os: "windows", arch: "amd64" });
    const { rerender } = render(<SessionRegistryPanel {...context} />);
    let grid = await screen.findByRole("grid", { name: "Registry values in HKCU" });
    await user.click(within(grid).getByRole("rowheader", { name: "Name" }));
    expect(await within(grid).findByText("session-data-1")).toBeInTheDocument();
    rerender(<SessionRegistryPanel {...context} route={{ ...context.route, backendEpoch: context.route.backendEpoch + 1 }} />);
    grid = await screen.findByRole("grid", { name: "Registry values in HKCU" });
    expect(within(grid).queryByText("session-data-1")).not.toBeInTheDocument();
    await user.click(within(grid).getByRole("rowheader", { name: "Name" }));
    expect(await within(grid).findByText("session-data-2")).toBeInTheDocument();
  });

  it("resets eager registry loading on a new session route before reading the previous path", async () => {
    const user = userEvent.setup();
    let newRoute = false;
    const api = installAPI((input) => {
      if (input.operationId === "session.registry.list-subkeys") {
        return workbench(input.operationId, { items: [], page: { limit: 500, total: 0, truncated: false } });
      }
      if (input.operationId === "session.registry.list-values") {
        const items = input.path === "PreviousPath" ? ["PreviousValue"] : [newRoute ? "NewRootValue" : "RootValue"];
        return workbench(input.operationId, { items, page: { limit: 500, total: 1, truncated: false } });
      }
      if (input.operationId === "session.registry.read") {
        return workbench(input.operationId, { ...input, type: "string", value: `${input.key}-data` });
      }
      throw new Error(`Unexpected operation ${input.operationId}`);
    });
    const context = panelContext({ os: "windows", arch: "amd64" });
    const { rerender } = render(<SessionRegistryPanel {...context} />);
    await screen.findByRole("grid", { name: "Registry values in HKCU" });
    const previousGrid = await navigateRegistryAddress(user, "HKCU\\PreviousPath", "Registry values in HKCU PreviousPath");
    await user.click(screen.getByRole("checkbox", { name: "Load all values" }));
    expect(await within(previousGrid).findByText("PreviousValue-data")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Load all values" })).toBeChecked();

    api.runSessionWorkbench.mockClear();
    newRoute = true;
    rerender(<SessionRegistryPanel {...context} route={{ ...context.route, backendEpoch: context.route.backendEpoch + 1 }} />);
    const nextGrid = await screen.findByRole("grid", { name: "Registry values in HKCU" });
    expect(within(nextGrid).getByRole("rowheader", { name: "NewRootValue" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Load all values" })).not.toBeChecked();
    expect(within(nextGrid).queryByText("PreviousValue-data")).not.toBeInTheDocument();
    expect(api.runSessionWorkbench.mock.calls.filter(([input]) => input.operationId === "session.registry.read")).toEqual([]);
    expect(api.runSessionWorkbench.mock.calls.every(([input]) => !("path" in input) || input.path === "")).toBe(true);
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
