import { RDP_MAX_PIXELS, type RdpConnectionOptions } from "../../../../shared/rdp-contracts";
import { rdpPassword, rdpProxyPassword, rdpString } from "../../../../shared/rdp-validation";

export const RDP_RESOLUTIONS = ([
  [1024, 768], [1280, 720], [1280, 800], [1366, 768], [1440, 900],
  [1600, 900], [1920, 1080], [1920, 1200], [2560, 1440], [2560, 1600], [3840, 2160],
] as const).map(([width, height]) => ({ value: `${width}x${height}`, width, height }));

export interface RdpConnectFormValues {
  label: string;
  host: string;
  port: string;
  username: string;
  domain: string;
  password: string;
  width: string;
  height: string;
  signInMode?: RdpConnectionOptions["signInMode"];
  manualProxy?: boolean;
  proxyHost?: string;
  proxyPort?: string;
  proxyUsername?: string;
  proxyPassword?: string;
}

export type RdpConnectFormField = Exclude<keyof RdpConnectFormValues, "signInMode" | "manualProxy">;
export type RdpConnectFormErrors = Partial<Record<RdpConnectFormField, string>>;

export function validateRdpConnectForm(values: RdpConnectFormValues, requirePassword: boolean, requireUsername = true): RdpConnectFormErrors {
  const errors: RdpConnectFormErrors = {};
  if (!validText(values.label, 120, true)) errors.label = "Use at most 120 characters without control characters.";
  if (!values.host.trim()) errors.host = "Enter a hostname or IP address.";
  else if (!validHost(values.host.trim())) errors.host = "Enter a valid hostname or IP address without a scheme, path, or port.";
  if (!decimalInRange(values.port, 1, 65535)) errors.port = "Enter a whole number from 1 to 65535.";
  if (values.signInMode !== "remote-screen") {
    if (requireUsername && !values.username.trim()) errors.username = "Enter the Windows username.";
    else if (!validText(values.username, 256, !requireUsername)) errors.username = "Use at most 256 characters without control characters.";
    if (!validText(values.domain, 256, true)) errors.domain = "Use at most 256 characters without control characters.";
    if (requirePassword && values.password.length === 0) errors.password = "Enter the Windows account password.";
    else {
      try { rdpPassword(values.password); }
      catch { errors.password = "Use at most 4096 characters without NUL characters."; }
    }
  }
  if (!decimalInRange(values.width, 200, 8192)) errors.width = "Enter a whole number from 200 to 8192 pixels.";
  if (!decimalInRange(values.height, 200, 8192)) errors.height = "Enter a whole number from 200 to 8192 pixels.";
  if (!errors.width && !errors.height && Number(values.width) * Number(values.height) > RDP_MAX_PIXELS) {
    errors.width = errors.height = "Width × height must not exceed 16,777,216 pixels.";
  }
  if (values.manualProxy) {
    const host = values.proxyHost?.trim() ?? "", username = values.proxyUsername?.trim() ?? "";
    if (!validHost(host)) errors.proxyHost = "Enter a valid proxy hostname or IP address without a scheme, path, or port.";
    if (!decimalInRange(values.proxyPort ?? "", 1, 65535)) errors.proxyPort = "Enter a whole number from 1 to 65535.";
    if (!validText(values.proxyUsername ?? "", 255, true) || new TextEncoder().encode(values.proxyUsername ?? "").length > 255) {
      errors.proxyUsername = "Use at most 255 UTF-8 bytes without control characters.";
    }
    if (username && (requireUsername || values.proxyPassword)) {
      try { rdpProxyPassword(values.proxyPassword); }
      catch { errors.proxyPassword = "Enter a proxy password from 1 to 255 UTF-8 bytes without NUL characters."; }
    }
  }
  return errors;
}

function validText(value: string, max: number, empty = false): boolean {
  try { rdpString(value, max, empty); return true; }
  catch { return false; }
}

function decimalInRange(value: string, min: number, max: number): boolean {
  return /^\d+$/u.test(value) && Number(value) >= min && Number(value) <= max;
}

function validHost(host: string): boolean {
  if (!validText(host, 253) || /[\s/\\@%?#\[\]]/u.test(host)) return false;
  if (host.includes(":")) {
    // URL parsing validates a bare IPv6 literal without any network access.
    try { return new URL(`http://[${host}]/`).hostname.startsWith("["); }
    catch { return false; }
  }
  if (/^[\d.]+$/u.test(host)) {
    const octets = host.split(".");
    return octets.length === 4 && octets.every((part) => /^(0|[1-9]\d{0,2})$/u.test(part) && Number(part) <= 255);
  }
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  return name.split(".").every((part) =>
    part.length > 0 && part.length <= 63 && /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/iu.test(part));
}
