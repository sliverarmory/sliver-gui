import type { ConnectionStatus } from "../../shared/contracts";

/** Event-stream retries retain the backend pool and its validated inventory. */
export function isUsableConnection(status: ConnectionStatus): boolean {
  return status === "connected" || status === "degraded" || status === "reconnecting";
}
