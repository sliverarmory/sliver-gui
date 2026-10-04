import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { ConnectionSummary, ManagedServerReference } from "../../../shared/contracts";

export type ConnectionContextValue = {
  readonly connection: ConnectionSummary | undefined;
} & (
  | { readonly isManagedServer: true; readonly managedServer: ManagedServerReference }
  | { readonly isManagedServer: false; readonly managedServer: null }
);

const ConnectionContext = createContext<ConnectionContextValue | undefined>(undefined);

/** Publishes the owning window's existing snapshot without another subscription. */
export function ConnectionProvider({
  connection,
  children,
}: {
  readonly connection: ConnectionSummary | undefined;
  readonly children: ReactNode;
}): React.JSX.Element {
  const value = useMemo<ConnectionContextValue>(() => {
    const hasActiveConnection = connection?.status === "connected" ||
      connection?.status === "degraded" || connection?.status === "reconnecting";
    const managedServer = hasActiveConnection ? connection.managedServer : null;
    return managedServer
      ? { connection, isManagedServer: true, managedServer }
      : { connection, isManagedServer: false, managedServer: null };
  }, [connection]);

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionContextValue {
  const connection = useContext(ConnectionContext);
  if (!connection) throw new Error("useConnection must be used within a ConnectionProvider");
  return connection;
}
