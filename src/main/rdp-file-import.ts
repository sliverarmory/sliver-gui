import { isIP } from "node:net";
import { basename } from "node:path";
import type { RdpSaveProfileInput } from "../shared/rdp-contracts.js";
import { rdpDimensions, rdpString } from "../shared/rdp-validation.js";

export const RDP_IMPORT_MAX_BYTES = 256 * 1024;
const MAX_LINES = 1_024;
const MAX_LINE_LENGTH = 8_192;
type Field = { readonly type: string; readonly value: string };
export interface ParsedRdpFile {
  /** A missing NLA username stays empty; the connection form must ask for it before connecting. */
  readonly profile: Omit<RdpSaveProfileInput, "id">;
  readonly warnings: readonly string[];
}

/** Pure, bounded import. The caller owns secure file reads, persistence, and any connection action.
 * Field semantics: https://learn.microsoft.com/en-us/azure/virtual-desktop/rdp-properties
 * Gateway/address semantics: https://learn.microsoft.com/en-us/windows/win32/api/rdpappcontainerclient/nf-rdpappcontainerclient-iremotedesktopclientsettings-setrdpproperty
 */
export function parseRdpFile(contents: Uint8Array | string, fileName: string): ParsedRdpFile {
  const fields = parseFields(decode(contents));
  const consumed = new Set<string>();
  const warnings = new Set<string>();
  const string = (name: string): string => {
    consumed.add(name);
    const field = fields.get(name);
    if (!field) return "";
    if (field.type !== "s") throw new Error(`The .rdp setting "${name}" must be text`);
    return field.value.trim();
  };
  const integer = (name: string, minimum: number, maximum: number): number | undefined => {
    consumed.add(name);
    const field = fields.get(name);
    if (!field) return undefined;
    if (field.type !== "i" || !/^-?\d+$/u.test(field.value.trim())) throw new Error(`The .rdp setting "${name}" must be an integer`);
    const value = Number(field.value);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`The .rdp setting "${name}" is out of range`);
    return value;
  };
  const unsupportedText = (name: string, feature: string): void => {
    if (string(name)) throw new Error(`This .rdp file requires ${feature}, which is not supported`);
  };
  const address = string("full address");
  if (!address) throw new Error("The .rdp file must specify a full address");
  const endpoint = parseAddress(address);
  const serverPort = integer("server port", 1, 65_535);
  if (endpoint.port !== undefined && serverPort !== undefined && endpoint.port !== serverPort) {
    throw new Error("The .rdp file specifies conflicting server ports");
  }
  const port = endpoint.port ?? serverPort ?? 3389;
  const gateway = string("gatewayhostname");
  const gatewayUsage = integer("gatewayusagemethod", 0, 4);
  if ((gatewayUsage !== undefined && gatewayUsage !== 0 && gatewayUsage !== 4) || (gateway && gatewayUsage === undefined)) {
    throw new Error("This .rdp file requires an RD Gateway, which is not supported");
  }
  if (gateway) warnings.add("Disabled RD Gateway settings were not imported. This profile connects directly to the computer.");
  integer("gatewayprofileusagemethod", 0, 1);
  integer("gatewaycredentialssource", 0, 5);
  integer("promptcredentialonce", 0, 1);
  if (integer("remoteapplicationmode", 0, 1) === 1) throw new Error("RemoteApp .rdp files are not supported");
  for (const name of ["remoteapplicationprogram", "remoteapplicationname", "remoteapplicationcmdline", "remoteapplicationfile", "remoteapplicationworkingdir"]) {
    unsupportedText(name, "RemoteApp");
  }
  unsupportedText("alternate shell", "an alternate remote shell");
  unsupportedText("shell working directory", "an alternate remote shell");
  for (const name of ["loadbalanceinfo", "workspace id", "pcb", "preconnectionblob", "full address 2", "redirected server name"]) {
    unsupportedText(name, "broker or preconnection routing");
  }
  if (integer("use redirection server name", 0, 1) === 1) throw new Error("This .rdp file requires broker redirection, which is not supported");
  const alternate = string("alternate full address");
  if (alternate) {
    const next = parseAddress(alternate);
    if (next.host !== endpoint.host || (next.port ?? serverPort ?? 3389) !== port) throw new Error("This .rdp file specifies an unsupported alternate endpoint");
  }
  for (const name of ["enablerdsaadauth", "targetisaadjoined", "restricted admin mode", "disablecredentialsdelegation", "require pre-authentication"]) {
    if (integer(name, 0, 1) === 1) throw new Error("This .rdp file requires an unsupported authentication method");
  }
  for (const name of ["login web page address", "pre-authentication server address", "kdcproxyname"]) unsupportedText(name, "an alternate authentication service");
  if (integer("negotiate security layer", 0, 1) === 0) throw new Error("This .rdp file requires legacy RDP security; this client requires TLS");
  const authentication = integer("authentication level", 0, 3);
  if (authentication === 1) throw new Error("This .rdp file requires a strict certificate policy that this client cannot preserve");
  if (authentication === 0) warnings.add("The file's certificate bypass setting was ignored. Server certificates will still be checked.");
  const remoteScreen = integer("enablecredsspsupport", 0, 1) === 0;
  if (remoteScreen) warnings.add("This file disables NLA. Sign in on the remote screen; the server must allow connections without NLA.");
  const identity = parseIdentity(string("username"), string("domain"));
  const sizeId = integer("desktop size id", 0, 4);
  const preset = sizeId === undefined ? [1280, 800] : [[640, 480], [800, 600], [1024, 768], [1280, 1024], [1600, 1200]][sizeId]!;
  const width = integer("desktopwidth", 200, 8192) ?? preset[0]!;
  const height = integer("desktopheight", 200, 8192) ?? preset[1]!;
  const dimensions = rdpDimensions(width, height);
  const clipboard = integer("redirectclipboard", 0, 1) === 1;
  const smartSizing = integer("smart sizing", 0, 1);
  const screenMode = integer("screen mode id", 1, 2), multimon = integer("use multimon", 0, 1), span = integer("span monitors", 0, 1);
  if (screenMode === 2 || multimon === 1 || span === 1) {
    warnings.add("Full-screen and multi-monitor settings were not imported. The desktop opens in one window.");
  }
  for (const [name, field] of fields) {
    if (name.includes("password")) {
      consumed.add(name);
      if (field.value.trim()) warnings.add("Saved passwords were not imported. Enter credentials when connecting.");
    }
    if (name === "signature" || name === "signscope") {
      consumed.add(name);
      if (field.value.trim()) warnings.add("The .rdp file signature was not verified. Server certificates will still be checked.");
    }
  }
  if ([...fields.keys()].some((name) => !consumed.has(name))) {
    warnings.add("Other unsupported .rdp settings were not imported. Review the saved profile before connecting.");
  }
  const profile = Object.freeze({ label: profileLabel(fileName), host: endpoint.host, port,
    username: remoteScreen ? "" : identity.username, domain: remoteScreen ? "" : identity.domain,
    ...dimensions, clipboard, scaleMode: smartSizing === 0 ? "actual" as const : "fit" as const,
    ...(remoteScreen ? { signInMode: "remote-screen" as const } : {}) });
  return Object.freeze({ profile, warnings: Object.freeze([...warnings]) });
}

function decode(contents: Uint8Array | string): string {
  if (typeof contents === "string") {
    if (Buffer.byteLength(contents, "utf8") > RDP_IMPORT_MAX_BYTES) throw new Error("The .rdp file exceeds the 256 KiB limit");
    if (contents !== Buffer.from(contents, "utf8").toString("utf8")) throw new Error("The .rdp file contains invalid Unicode");
    return contents.replace(/^\uFEFF/u, "");
  }
  if (!(contents instanceof Uint8Array) || contents.byteLength > RDP_IMPORT_MAX_BYTES) throw new Error("The .rdp file exceeds the 256 KiB limit");
  const utf16 = contents[0] === 0xff && contents[1] === 0xfe;
  if (contents[0] === 0xfe && contents[1] === 0xff) throw new Error("The .rdp file must use UTF-8 or UTF-16LE with a byte-order mark");
  try { return new TextDecoder(utf16 ? "utf-16le" : "utf-8", { fatal: true }).decode(contents); }
  catch { throw new Error("The .rdp file must use valid UTF-8 or UTF-16LE with a byte-order mark"); }
}

function parseFields(text: string): Map<string, Field> {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) throw new Error("The .rdp file contains unsupported control characters or encoding");
  const lines = text.split(/\r\n|\n|\r/u);
  if (lines.length > MAX_LINES) throw new Error("The .rdp file contains too many lines");
  const fields = new Map<string, Field>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.length > MAX_LINE_LENGTH) throw new Error("The .rdp file contains an oversized line");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const match = /^([a-z0-9][a-z0-9 ._-]{0,127}):([isb]):(.*)$/iu.exec(trimmed);
    if (!match) throw new Error(`The .rdp file contains an invalid setting on line ${index + 1}`);
    const name = match[1]!.trim().toLowerCase(), type = match[2]!.toLowerCase(), value = match[3]!.trim();
    const existing = fields.get(name);
    if (existing && (existing.type !== type || existing.value !== value)) throw new Error("The .rdp file contains conflicting duplicate settings");
    fields.set(name, { type, value });
  }
  return fields;
}

function parseAddress(value: string): { host: string; port?: number } {
  let host = value, port: number | undefined;
  if (value.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::(\d+))?$/u.exec(value);
    if (!match || isIP(match[1]!) !== 6) throw new Error("The .rdp file contains an invalid IPv6 address");
    host = match[1]!;
    if (match[2] !== undefined) port = Number(match[2]);
  } else if (isIP(value) !== 6 && value.includes(":")) {
    const match = /^([^:]+):(\d+)$/u.exec(value);
    if (!match) throw new Error("The .rdp full address must be a hostname or IP address with an optional port");
    host = match[1]!; port = Number(match[2]);
  }
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65_535)) throw new Error("The .rdp file contains an invalid port");
  if (host.length > 253 || host.includes("%") || (isIP(host) !== 6 && !/^[a-z0-9_][a-z0-9._-]*$/iu.test(host))) {
    throw new Error("The .rdp file contains an invalid computer address");
  }
  return { host: host.toLowerCase(), ...(port === undefined ? {} : { port }) };
}

function parseIdentity(rawUsername: string, rawDomain: string): { username: string; domain: string } {
  let username = rawUsername, domain = rawDomain;
  if (username.includes("\\")) {
    const parts = username.split("\\");
    if (parts.length !== 2 || !parts[0] || !parts[1] || (domain && domain.toLowerCase() !== parts[0].toLowerCase())) {
      throw new Error("The .rdp file contains a conflicting or invalid username and domain");
    }
    domain ||= parts[0]; username = parts[1];
  }
  return { username: rdpString(username, 256, true), domain: rdpString(domain, 256, true) };
}

function profileLabel(fileName: string): string {
  if (typeof fileName !== "string" || fileName.length > 32_768 || fileName.includes("\0")) throw new Error("Invalid .rdp file name");
  const name = basename(fileName.replaceAll("\\", "/"));
  if (!/\.rdp$/iu.test(name)) throw new Error("Choose a file with the .rdp extension");
  const label = name.slice(0, -4).replace(/[\x00-\x1f\x7f]/gu, " ").trim() || "Imported Remote Desktop";
  return [...label].reduce((result, character) => result.length + character.length <= 120 ? result + character : result, "");
}
