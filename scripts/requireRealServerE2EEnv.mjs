import { isAbsolute } from "node:path";

const configPath = process.env.SLIVER_GUI_E2E_CONFIG?.trim();
const portText = process.env.SLIVER_GUI_E2E_LISTENER_PORT?.trim();

if (!configPath || !isAbsolute(configPath)) {
  throw new Error("SLIVER_GUI_E2E_CONFIG must be set to an absolute mTLS operator-config path");
}
if (!portText || !/^\d+$/u.test(portText)) {
  throw new Error("SLIVER_GUI_E2E_LISTENER_PORT must be set to an unused numeric port");
}
const port = Number(portText);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("SLIVER_GUI_E2E_LISTENER_PORT must be between 1 and 65535");
}

console.log("Real-server packaged E2E opt-in environment validated");
