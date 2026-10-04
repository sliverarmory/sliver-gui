import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CloudDeploymentAPI, CloudProvisioningTranscript } from "../../../shared/cloud-deployment-ipc";
import type { GhosttyTerminalProps } from "./GhosttyTerminal";

const mockedTerminal = vi.hoisted(() => ({ props: undefined as GhosttyTerminalProps | undefined }));

vi.mock("./GhosttyTerminal", () => ({
  GhosttyTerminal: (props: GhosttyTerminalProps) => {
    mockedTerminal.props = props;
    return <div aria-label={props.ariaLabel} data-disable-input={String(props.disableInput)} />;
  },
}));

import {
  CloudProvisioningTerminal,
  ReadonlyProvisioningTransport,
} from "./CloudProvisioningTerminal";

afterEach(() => {
  cleanup();
  mockedTerminal.props = undefined;
});

describe("CloudProvisioningTerminal", () => {
  it("loads the main-process runtime and always disables terminal input", async () => {
    const getTerminalRuntime = vi.fn(async () => ({
      ok: true as const,
      value: {
        version: "0.4.0" as const,
        sha256: "a".repeat(64),
        bytes: new Uint8Array([0, 97, 115, 109]),
      },
    }));
    const transcript = provisioningTranscript([
      { sequence: 0, bytes: new TextEncoder().encode("ready\r\n") },
    ]);

    render(
      <CloudProvisioningTerminal
        api={{ getTerminalRuntime } as unknown as CloudDeploymentAPI}
        deploymentId="a48987b1-7b88-46dc-b72b-7f34dd5e0e92"
        transcript={transcript}
      />,
    );

    const terminal = await screen.findByLabelText(/Read-only SSH provisioning output for/u);
    expect(terminal).toHaveAttribute("data-disable-input", "true");
    expect(getTerminalRuntime).toHaveBeenCalledOnce();
    expect(mockedTerminal.props?.wasmBytes).toEqual(new Uint8Array([0, 97, 115, 109]));
  });

  it("delivers each sequenced stdout chunk once and never sends input", () => {
    const transport = new ReadonlyProvisioningTransport();
    const output: string[] = [];
    const onOutput = vi.fn((bytes: Uint8Array) => output.push(new TextDecoder().decode(bytes)));
    const onClose = vi.fn();

    transport.update(provisioningTranscript([
      { sequence: 4, bytes: new TextEncoder().encode("before subscribe\n") },
    ]));
    const unsubscribe = transport.subscribe({ onOutput, onClose });
    transport.update(provisioningTranscript([
      { sequence: 4, bytes: new TextEncoder().encode("duplicate\n") },
      { sequence: 5, bytes: new TextEncoder().encode("live\n") },
    ]));
    transport.send(new TextEncoder().encode("ignored"), "operator");
    transport.resize(120, 40);

    expect(output).toEqual(["before subscribe\n", "live\n"]);
    expect(onClose).not.toHaveBeenCalled();
    unsubscribe();
    transport.update(provisioningTranscript([
      { sequence: 6, bytes: new TextEncoder().encode("queued\n") },
    ]));
    const laterOutput = vi.fn();
    transport.subscribe({ onOutput: laterOutput, onClose });
    expect(laterOutput).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(laterOutput.mock.calls[0]?.[0])).toBe("queued\n");
  });

  it("replays bounded history and closes completed or failed terminals exactly once", () => {
    const transport = new ReadonlyProvisioningTransport();
    const completed = {
      ...provisioningTranscript([
        { sequence: 8, bytes: new TextEncoder().encode("final output\n") },
      ]),
      status: "complete" as const,
    };
    transport.update(completed);

    const firstOutput = vi.fn();
    const firstClose = vi.fn();
    transport.subscribe({ onOutput: firstOutput, onClose: firstClose });
    expect(new TextDecoder().decode(firstOutput.mock.calls[0]?.[0])).toBe("final output\n");
    expect(firstClose).toHaveBeenCalledOnce();
    expect(firstClose).toHaveBeenCalledWith("SSH provisioning complete");

    const replayOutput = vi.fn();
    const replayClose = vi.fn();
    transport.subscribe({ onOutput: replayOutput, onClose: replayClose });
    expect(new TextDecoder().decode(replayOutput.mock.calls[0]?.[0])).toBe("final output\n");
    expect(replayClose).toHaveBeenCalledOnce();
  });

  it("shows a bounded-transcript notice without exposing an editable control", async () => {
    const api = {
      getTerminalRuntime: vi.fn(async () => ({
        ok: true as const,
        value: {
          version: "0.4.0" as const,
          sha256: "b".repeat(64),
          bytes: new Uint8Array([0, 97, 115, 109]),
        },
      })),
    } as unknown as CloudDeploymentAPI;
    render(
      <CloudProvisioningTerminal
        api={api}
        deploymentId="a48987b1-7b88-46dc-b72b-7f34dd5e0e92"
        transcript={{ ...provisioningTranscript([]), truncated: true }}
      />,
    );

    expect(screen.getByText(/Earlier output was removed/u)).toBeInTheDocument();
    await waitFor(() => expect(mockedTerminal.props?.disableInput).toBe(true));
  });

  it("labels a pre-SSH provider failure as failed instead of waiting", async () => {
    const api = {
      getTerminalRuntime: vi.fn(async () => ({
        ok: true as const,
        value: {
          version: "0.4.0" as const,
          sha256: "c".repeat(64),
          bytes: new Uint8Array([0, 97, 115, 109]),
        },
      })),
    } as unknown as CloudDeploymentAPI;
    render(
      <CloudProvisioningTerminal
        api={api}
        deploymentId="a48987b1-7b88-46dc-b72b-7f34dd5e0e92"
        transcript={{ ...provisioningTranscript([]), status: "failed" }}
      />,
    );

    expect(screen.getByText("Session failed")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for SSH")).not.toBeInTheDocument();
  });

  it("accepts software installation labels without changing the read-only terminal", async () => {
    const api = {
      getTerminalRuntime: vi.fn(async () => ({
        ok: true as const,
        value: {
          version: "0.4.0" as const,
          sha256: "d".repeat(64),
          bytes: new Uint8Array([0, 97, 115, 109]),
        },
      })),
    } as unknown as CloudDeploymentAPI;
    const labels = {
      sectionAriaLabel: "Software installation output",
      title: "Installation output",
      description: "Read-only output from the SSH installation session.",
      terminalAriaLabel: "Read-only software installation output",
      waiting: "Waiting for installer",
      failed: "Installation failed",
    };
    const props = {
      api,
      deploymentId: "a48987b1-7b88-46dc-b72b-7f34dd5e0e92",
      labels,
    };
    const { rerender } = render(<CloudProvisioningTerminal {...props} transcript={undefined} />);

    expect(screen.getByLabelText("Software installation output")).toBeInTheDocument();
    expect(screen.getByText("Installation output")).toBeInTheDocument();
    expect(screen.getByText("Read-only output from the SSH installation session.")).toBeInTheDocument();
    expect(screen.getByText("Waiting for installer")).toBeInTheDocument();
    const terminal = await screen.findByLabelText("Read-only software installation output");
    expect(terminal).toHaveAttribute("data-disable-input", "true");

    rerender(<CloudProvisioningTerminal {...props} transcript={{ ...provisioningTranscript([]), status: "failed" }} />);
    expect(screen.getByText("Installation failed")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for installer")).not.toBeInTheDocument();
  });
});

function provisioningTranscript(
  chunks: CloudProvisioningTranscript["chunks"],
): CloudProvisioningTranscript {
  return {
    deploymentId: "a48987b1-7b88-46dc-b72b-7f34dd5e0e92",
    status: "streaming",
    truncated: false,
    chunks,
  };
}
