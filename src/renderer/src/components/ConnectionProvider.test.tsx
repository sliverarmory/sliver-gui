import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ConnectionStatus, ConnectionSummary, ManagedServerReference } from "../../../shared/contracts";
import { disconnectedSnapshot } from "../../../shared/contracts";
import { ConnectionProvider, useConnection } from "./ConnectionProvider";

const managedServer: ManagedServerReference = {
  deploymentId: "deployment-1",
  provider: "aws",
  name: "Managed lab",
};

function ConnectionProbe({ label = "connection" }: { readonly label?: string }): React.JSX.Element {
  const context = useConnection();
  return (
    <output aria-label={label}>
      {context.isManagedServer
        ? `${context.managedServer.deploymentId}:${context.managedServer.provider}:${context.managedServer.name}`
        : "unmanaged"}
    </output>
  );
}

afterEach(cleanup);

describe("ConnectionProvider", () => {
  it.each<ConnectionStatus>(["connected", "degraded", "reconnecting"])(
    "retains the managed association while the connection is %s",
    (status) => {
      render(
        <ConnectionProvider connection={{ status, managedServer }}>
          <ConnectionProbe />
        </ConnectionProvider>,
      );
      expect(screen.getByLabelText("connection")).toHaveTextContent("deployment-1:aws:Managed lab");
    },
  );

  it.each<ConnectionStatus>(["disconnected", "connecting", "incompatible"])(
    "does not expose stale managed metadata while the connection is %s",
    (status) => {
      render(
        <ConnectionProvider connection={{ status, managedServer }}>
          <ConnectionProbe />
        </ConnectionProvider>,
      );
      expect(screen.getByLabelText("connection")).toHaveTextContent("unmanaged");
    },
  );

  it("follows connection switches, metadata removal, and disconnects from its owning snapshot", () => {
    const view = (connection: ConnectionSummary | undefined): React.JSX.Element => (
      <ConnectionProvider connection={connection}>
        <ConnectionProbe />
      </ConnectionProvider>
    );
    const { rerender } = render(view(undefined));
    expect(screen.getByLabelText("connection")).toHaveTextContent("unmanaged");

    rerender(view({ status: "connected", managedServer }));
    expect(screen.getByLabelText("connection")).toHaveTextContent("deployment-1:aws:Managed lab");

    rerender(view({ status: "connecting", managedServer: null }));
    expect(screen.getByLabelText("connection")).toHaveTextContent("unmanaged");

    rerender(view({
      status: "connected",
      managedServer: { deploymentId: "deployment-2", provider: "azure", name: "Second lab" },
    }));
    expect(screen.getByLabelText("connection")).toHaveTextContent("deployment-2:azure:Second lab");

    rerender(view({ status: "connected", managedServer: null }));
    expect(screen.getByLabelText("connection")).toHaveTextContent("unmanaged");

    rerender(view(disconnectedSnapshot().connection));
    expect(screen.getByLabelText("connection")).toHaveTextContent("unmanaged");
  });

  it("keeps separate window scopes independent", () => {
    render(
      <>
        <ConnectionProvider connection={{ status: "connected", managedServer }}>
          <ConnectionProbe label="first window" />
        </ConnectionProvider>
        <ConnectionProvider connection={{ status: "connected", managedServer: null }}>
          <ConnectionProbe label="second window" />
        </ConnectionProvider>
      </>,
    );
    expect(screen.getByLabelText("first window")).toHaveTextContent("deployment-1:aws:Managed lab");
    expect(screen.getByLabelText("second window")).toHaveTextContent("unmanaged");
  });

  it("requires an owning window provider", () => {
    expect(() => render(<ConnectionProbe />)).toThrow("useConnection must be used within a ConnectionProvider");
  });
});
