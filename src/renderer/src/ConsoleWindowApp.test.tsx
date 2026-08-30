import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openConsoleTransport = vi.fn();

vi.mock("./components/console-terminal-transport", () => ({
  ConsoleTerminalTransport: {
    open: (...args: unknown[]) => openConsoleTransport(...args),
  },
}));

vi.mock("./components/GhosttyTerminal", () => ({
  GhosttyTerminal: (props: {
    ariaLabel: string;
    onClose?: (reason?: string) => void;
    onError?: (error: Error) => void;
  }) => (
    <section aria-label={props.ariaLabel}>
      <button type="button" onClick={() => props.onClose?.("Sliver client exited with code 7")}>Exit client</button>
      <button type="button" onClick={() => props.onError?.(new Error("Ghostty failed"))}>Fail terminal</button>
    </section>
  ),
}));

import type { OperationResult } from "../../shared/contracts";
import type { ConsoleWindowLaunchContext } from "../../shared/console-contracts";
import type { TerminalRuntimeAsset } from "../../shared/stream-contracts";
import {
  ConsoleWindowApp,
  resetConsoleWindowStateForTest,
} from "./ConsoleWindowApp";

const launchContext: ConsoleWindowLaunchContext = {
  kind: "console",
  attachmentToken: "t".repeat(43),
  configName: "Production operator",
};

beforeEach(() => {
  resetConsoleWindowStateForTest();
  openConsoleTransport.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ConsoleWindowApp", () => {
  it("claims once under StrictMode and opens the exact main-owned console capability", async () => {
    const transport = fakeTransport();
    openConsoleTransport.mockResolvedValue(transport);
    const claimConsoleWindow = vi.fn().mockResolvedValue(ok(launchContext));
    const getTerminalRuntime = vi.fn().mockResolvedValue(ok(runtime()));
    installAPI({ claimConsoleWindow, getTerminalRuntime });

    render(
      <StrictMode>
        <ConsoleWindowApp />
      </StrictMode>,
    );

    expect(await screen.findByRole("main", { name: "Sliver client console window" })).toBeInTheDocument();
    expect(screen.getByText("Active configuration: Production operator")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Sliver client console using Production operator" })).toBeInTheDocument();
    expect(claimConsoleWindow).toHaveBeenCalledTimes(1);
    expect(getTerminalRuntime).toHaveBeenCalledTimes(1);
    expect(openConsoleTransport).toHaveBeenCalledTimes(1);
    expect(openConsoleTransport).toHaveBeenCalledWith({ attachmentToken: launchContext.attachmentToken });
    expect(document.title).toBe("Sliver console — Production operator");
  });

  it("fails closed when a generic window cannot claim the console", async () => {
    const claimConsoleWindow = vi.fn().mockResolvedValue({
      ok: false,
      error: "This window has no console capability",
    });
    installAPI({ claimConsoleWindow, getTerminalRuntime: vi.fn() });

    render(<ConsoleWindowApp />);

    expect(await screen.findByText("Sliver console unavailable")).toBeInTheDocument();
    expect(screen.getByText("This window has no console capability")).toBeInTheDocument();
    expect(openConsoleTransport).not.toHaveBeenCalled();
  });

  it("surfaces native-client exit status while preserving terminal scrollback", async () => {
    openConsoleTransport.mockResolvedValue(fakeTransport());
    installAPI({
      claimConsoleWindow: vi.fn().mockResolvedValue(ok(launchContext)),
      getTerminalRuntime: vi.fn().mockResolvedValue(ok(runtime())),
    });
    render(<ConsoleWindowApp />);
    await screen.findByRole("region", { name: "Sliver client console using Production operator" });

    fireEvent.click(screen.getByRole("button", { name: "Exit client" }));

    expect(screen.getByText("Console process exited")).toBeInTheDocument();
    const exitReason = screen.getByText("Sliver client exited with code 7");
    const alert = screen.getByRole("alert");
    expect(exitReason).toBeInTheDocument();
    expect(exitReason).toHaveClass("text-overlay-foreground");
    expect(exitReason).not.toHaveClass("opacity-80");
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(alert).toHaveClass("bg-overlay", "text-overlay-foreground", "shadow-overlay");
    expect(alert).not.toHaveClass("bg-warning-soft");
    expect(screen.getByText("Exited")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Sliver client console using Production operator" }))
      .toBeInTheDocument();
  });

  it("closes the PTY capability when Ghostty initialization fails", async () => {
    const transport = fakeTransport();
    openConsoleTransport.mockResolvedValue(transport);
    installAPI({
      claimConsoleWindow: vi.fn().mockResolvedValue(ok(launchContext)),
      getTerminalRuntime: vi.fn().mockResolvedValue(ok(runtime())),
    });
    render(<ConsoleWindowApp />);
    await screen.findByRole("region", { name: "Sliver client console using Production operator" });

    fireEvent.click(screen.getByRole("button", { name: "Fail terminal" }));

    expect(await screen.findByText("Sliver console unavailable")).toBeInTheDocument();
    expect(screen.getByText("Ghostty failed")).toBeInTheDocument();
    expect(transport.close).toHaveBeenCalled();
  });

  it("closes an attached PTY when loading the Ghostty runtime fails", async () => {
    const transport = fakeTransport();
    openConsoleTransport.mockResolvedValue(transport);
    installAPI({
      claimConsoleWindow: vi.fn().mockResolvedValue(ok(launchContext)),
      getTerminalRuntime: vi.fn().mockResolvedValue({
        ok: false,
        error: "Ghostty runtime failed integrity verification",
      }),
    });

    render(<ConsoleWindowApp />);

    expect(await screen.findByText("Sliver console unavailable")).toBeInTheDocument();
    expect(screen.getByText("Ghostty runtime failed integrity verification")).toBeInTheDocument();
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("disposes the native console transport when its dedicated window unmounts", async () => {
    const transport = fakeTransport();
    openConsoleTransport.mockResolvedValue(transport);
    installAPI({
      claimConsoleWindow: vi.fn().mockResolvedValue(ok(launchContext)),
      getTerminalRuntime: vi.fn().mockResolvedValue(ok(runtime())),
    });
    const rendered = render(<ConsoleWindowApp />);
    await screen.findByRole("region", { name: "Sliver client console using Production operator" });

    rendered.unmount();

    await waitFor(() => expect(transport.close).toHaveBeenCalledOnce());
  });
});

function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

function runtime(): TerminalRuntimeAsset {
  return {
    version: "0.4.0",
    sha256: "a".repeat(64),
    bytes: new Uint8Array([0, 97, 115, 109]),
  };
}

function fakeTransport() {
  return {
    close: vi.fn(),
    getSnapshot: vi.fn(),
    resize: vi.fn(),
    send: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    subscribeState: vi.fn(() => vi.fn()),
  };
}

function installAPI(api: {
  claimConsoleWindow: () => Promise<OperationResult<ConsoleWindowLaunchContext>>;
  getTerminalRuntime: () => Promise<OperationResult<TerminalRuntimeAsset>>;
}): void {
  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: api,
  });
}
