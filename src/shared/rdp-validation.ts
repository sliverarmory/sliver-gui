import { parseSocks5ProxyId } from "./network-forwarding-contracts.js";
import { RDP_MAX_CLIPBOARD_FILES, RDP_MAX_CLIPBOARD_FILE_BYTES, RDP_MAX_PIXELS, RDP_PREVIEW_MAX_DATA_URL_LENGTH, RDP_PREVIEW_MAX_HEIGHT, RDP_PREVIEW_MAX_WIDTH, type RdpFileTransferProgress, type RdpConnectInput, type RdpConnectionOptions, type RdpPreview, type RdpSavePreviewInput, type RdpSaveProfileInput, type RdpViewerMessage } from "./rdp-contracts.js";

/** Only bounded counters and sanitized status cross into the desktop renderer. */
export function parseRdpFileTransferProgress(raw: unknown): RdpFileTransferProgress {
  const value = rdpRecord(raw);
  if (Object.keys(value).some((key) => !["id", "direction", "phase", "transferredBytes", "totalBytes", "completedFiles", "totalFiles", "error"].includes(key))) throw new Error("Unexpected RDP transfer field");
  const id = rdpString(value["id"], 256), direction = value["direction"], phase = value["phase"];
  if (direction !== "send" && direction !== "receive") throw new Error("Invalid RDP transfer direction");
  if (phase !== "preparing" && phase !== "transferring" && phase !== "completed" && phase !== "failed" && phase !== "canceled") throw new Error("Invalid RDP transfer phase");
  const totalBytes = rdpInteger(value["totalBytes"], 0, RDP_MAX_CLIPBOARD_FILE_BYTES);
  const transferredBytes = rdpInteger(value["transferredBytes"], 0, totalBytes);
  const totalFiles = rdpInteger(value["totalFiles"], 0, RDP_MAX_CLIPBOARD_FILES);
  const completedFiles = rdpInteger(value["completedFiles"], 0, totalFiles);
  if ((phase === "transferring" || phase === "completed") && totalFiles === 0) throw new Error("Invalid RDP transfer file count");
  if (phase === "completed" && (transferredBytes !== totalBytes || completedFiles !== totalFiles)) throw new Error("Incomplete RDP file transfer");
  return Object.freeze({ id, direction, phase, totalBytes, transferredBytes, totalFiles, completedFiles,
    ...(value["error"] === undefined ? {} : { error: rdpString(value["error"], 512) }) });
}

/** Bound JPEG dimensions before the native decoder or renderer sees the image. */
export function rdpPreviewDimensions(value: unknown): { dataUrl: string; width: number; height: number } {
  if (typeof value !== "string" || value.length > RDP_PREVIEW_MAX_DATA_URL_LENGTH || !value.startsWith("data:image/jpeg;base64,")) throw new Error("Invalid RDP preview image");
  const encoded = value.slice("data:image/jpeg;base64,".length);
  if (!encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error("Invalid RDP preview image");
  const bytes = atob(encoded);
  const byte = (index: number): number => bytes.charCodeAt(index);
  if (byte(0) !== 0xff || byte(1) !== 0xd8 || byte(bytes.length - 2) !== 0xff || byte(bytes.length - 1) !== 0xd9) throw new Error("Invalid RDP preview image");
  for (let offset = 2; offset + 3 < bytes.length;) {
    if (byte(offset++) !== 0xff) break;
    while (byte(offset) === 0xff) offset += 1;
    const marker = byte(offset++);
    if (marker === 0xda || marker === 0xd9) break;
    const length = byte(offset) * 256 + byte(offset + 1);
    if (length < 2 || offset + length > bytes.length) break;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (length < 8 || byte(offset + 2) !== 8) break;
      return { dataUrl: value, width: rdpInteger(byte(offset + 5) * 256 + byte(offset + 6), 1, RDP_PREVIEW_MAX_WIDTH),
        height: rdpInteger(byte(offset + 3) * 256 + byte(offset + 4), 1, RDP_PREVIEW_MAX_HEIGHT) };
    }
    offset += length;
  }
  throw new Error("Invalid RDP preview image");
}

export function parseRdpPreview(value: unknown): RdpPreview {
  const input = rdpRecord(value);
  if (Object.keys(input).some((key) => !["dataUrl", "capturedAt", "width", "height"].includes(key))) throw new Error("Unexpected RDP preview field");
  const image = rdpPreviewDimensions(input["dataUrl"]);
  if (input["width"] !== image.width || input["height"] !== image.height) throw new Error("Invalid RDP preview dimensions");
  const capturedAt = rdpString(input["capturedAt"], 32);
  if (!Number.isFinite(Date.parse(capturedAt)) || new Date(capturedAt).toISOString() !== capturedAt) throw new Error("Invalid RDP preview date");
  return Object.freeze({ ...image, capturedAt });
}

export function parseRdpSavePreview(value: unknown): RdpSavePreviewInput {
  const input = rdpRecord(value);
  if (Object.keys(input).some((key) => !["tabId", "attempt", "dataUrl"].includes(key))) throw new Error("Unexpected RDP preview field");
  return { tabId: rdpString(input["tabId"], 80), attempt: rdpInteger(input["attempt"], 1, Number.MAX_SAFE_INTEGER),
    dataUrl: rdpPreviewDimensions(input["dataUrl"]).dataUrl };
}

export function rdpRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid RDP request");
  return value as Record<string, unknown>;
}

export function rdpString(value: unknown, max = 256, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("Invalid RDP text");
  return value;
}

export function rdpInteger(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error("Invalid RDP number");
  return value as number;
}

export function rdpBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid RDP boolean");
  return value;
}

export function rdpDimensions(width: unknown, height: unknown): { width: number; height: number } {
  const size = { width: rdpInteger(width, 200, 8192), height: rdpInteger(height, 200, 8192) };
  if (size.width * size.height > RDP_MAX_PIXELS) throw new Error("RDP display exceeds the pixel limit");
  return size;
}

export function parseRdpOptions(value: unknown, allowMissingUsername = false): RdpConnectionOptions {
  const item = rdpRecord(value);
  const mode = item["signInMode"] === undefined ? "nla" : item["signInMode"];
  if (mode !== "nla" && mode !== "remote-screen") throw new Error("Invalid RDP sign-in mode");
  const remoteScreen = mode === "remote-screen";
  const username = rdpString(item["username"], 256, remoteScreen || allowMissingUsername), domain = rdpString(item["domain"], 256, true);
  if (remoteScreen && (username !== "" || domain !== "")) throw new Error("Enter credentials on the remote screen for this sign-in mode");
  const host = rdpString(item["host"], 253).trim().toLowerCase();
  if (!/^[a-z0-9.:%_-]+$/iu.test(host) || host.startsWith("-") || host.includes("%")) throw new Error("Enter a hostname or IP address without a URL or port");
  let networking: RdpConnectionOptions["networking"];
  if (item["networking"] !== undefined) {
    const route = rdpRecord(item["networking"]);
    if (route["kind"] === "socks5") {
      if (Object.keys(route).some((key) => key !== "kind" && key !== "proxyId")) throw new Error("Invalid RDP networking route");
      networking = Object.freeze({ kind: "socks5", proxyId: parseSocks5ProxyId(route["proxyId"]) });
    } else if (route["kind"] === "socks5-manual") {
      if (Object.keys(route).some((key) => !["kind", "host", "port", "username"].includes(key))) throw new Error("Invalid RDP networking route");
      const proxyHost = rdpString(route["host"], 253).trim().toLowerCase();
      if (!/^[a-z0-9._:-]+$/iu.test(proxyHost) || proxyHost.startsWith("-")) throw new Error("Enter a SOCKS proxy hostname or IP address without a URL or port");
      // A colon is only valid in an IPv6 literal, never a hostname:port pair.
      if (proxyHost.includes(":")) {
        try { if (new URL(`http://[${proxyHost}]/`).hostname.length < 3) throw new Error(); }
        catch { throw new Error("Enter a valid SOCKS proxy IPv6 address without brackets or a port"); }
      }
      const proxyUsername = route["username"] === undefined ? undefined : rdpString(route["username"], 255);
      if (proxyUsername !== undefined && new TextEncoder().encode(proxyUsername).length > 255) throw new Error("SOCKS username must contain between 1 and 255 UTF-8 bytes");
      networking = Object.freeze({ kind: "socks5-manual", host: proxyHost, port: rdpInteger(route["port"], 1, 65535),
        ...(proxyUsername === undefined ? {} : { username: proxyUsername }) });
    } else throw new Error("Invalid RDP networking route");
  }
  return { ...(networking ? { networking } : {}), host, port: rdpInteger(item["port"], 1, 65535), username, domain,
    ...(remoteScreen ? { signInMode: "remote-screen" as const } : {}),
    ...rdpDimensions(item["width"], item["height"]), clipboard: rdpBoolean(item["clipboard"]) };
}

export function parseRdpProfile(value: unknown): RdpSaveProfileInput {
  const item = rdpRecord(value);
  if (item["scaleMode"] !== "fit" && item["scaleMode"] !== "actual") throw new Error("Invalid RDP scale mode");
  return { ...parseRdpOptions(value, true), label: rdpString(item["label"], 120), scaleMode: item["scaleMode"],
    ...(item["id"] === undefined ? {} : { id: rdpString(item["id"], 80) }) };
}

export function rdpPassword(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) throw new Error("Invalid RDP password");
  return value;
}

export function rdpProxyPassword(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || new TextEncoder().encode(value).length > 255) {
    throw new Error("Enter a SOCKS proxy password between 1 and 255 UTF-8 bytes");
  }
  return value;
}

export function parseRdpProxyPassword(value: unknown, networking: RdpConnectionOptions["networking"]): string | undefined {
  if (networking?.kind === "socks5-manual" && networking.username !== undefined) return rdpProxyPassword(value);
  if (value !== undefined) throw new Error("A proxy password requires a manual SOCKS username");
  return undefined;
}

export function parseRdpConnect(value: unknown): RdpConnectInput {
  const item = rdpRecord(value);
  const { id: _id, ...profile } = parseRdpProfile(value);
  parseRdpOptions(value);
  if (item["persistence"] !== "none" && item["persistence"] !== "session" && item["persistence"] !== "secure") throw new Error("Invalid RDP credential preference");
  if (profile.signInMode === "remote-screen" && (item["persistence"] !== "none" || (item["password"] !== undefined && item["password"] !== ""))) throw new Error("Remote-screen sign-in does not accept or remember a password");
  const proxyPassword = parseRdpProxyPassword(item["proxyPassword"], profile.networking);
  return { ...profile, persistence: item["persistence"],
    ...(proxyPassword === undefined ? {} : { proxyPassword }),
    ...(item["temporaryId"] === undefined ? {} : { temporaryId: rdpString(item["temporaryId"], 80) }),
    ...(item["password"] === undefined ? {} : { password: rdpPassword(item["password"]) }),
    ...(item["profileId"] === undefined ? {} : { profileId: rdpString(item["profileId"], 80) }) };
}

export function parseRdpViewerMessage(value: unknown): RdpViewerMessage {
  const item = rdpRecord(value);
  switch (item["type"]) {
    case "ack": return { type: "ack", seq: rdpInteger(item["seq"], 1, Number.MAX_SAFE_INTEGER) };
    case "cursorAck": return { type: "cursorAck", seq: rdpInteger(item["seq"], 1, Number.MAX_SAFE_INTEGER) };
    case "releaseAll": return { type: "releaseAll" };
    case "snapshot": return { type: "snapshot" };
    case "resize": return { type: "resize", ...rdpDimensions(item["width"], item["height"]), scaleFactor: rdpInteger(item["scaleFactor"], 100, 500) };
    case "input": {
      if (!Array.isArray(item["events"]) || item["events"].length > 64) throw new Error("Invalid RDP input batch");
      return { type: "input", events: item["events"].map((raw: unknown) => {
        const event = rdpRecord(raw);
        switch (event["kind"]) {
          case "key": return { kind: "key" as const, scanCode: rdpInteger(event["scanCode"], 0, 255), extended: rdpBoolean(event["extended"]), down: rdpBoolean(event["down"]) };
          case "unicode": {
            const codePoint = rdpInteger(event["codePoint"], 0, 0x10ffff);
            if (codePoint >= 0xd800 && codePoint <= 0xdfff) throw new Error("Invalid Unicode input");
            return { kind: "unicode" as const, codePoint, down: rdpBoolean(event["down"]) };
          }
          case "mouse": {
            const button = event["button"];
            if (button !== undefined && button !== "left" && button !== "middle" && button !== "right" && button !== "back" && button !== "forward") throw new Error("Invalid RDP pointer button");
            return { kind: "mouse" as const, x: rdpInteger(event["x"], 0, 8191), y: rdpInteger(event["y"], 0, 8191),
              ...(button === undefined ? {} : { button }), ...(event["down"] === undefined ? {} : { down: rdpBoolean(event["down"]) }),
              ...(event["wheel"] === undefined ? {} : { wheel: rdpInteger(event["wheel"], -32767, 32767) }),
              ...(event["horizontal"] === undefined ? {} : { horizontal: rdpBoolean(event["horizontal"]) }) };
          }
          default: throw new Error("Invalid RDP input event");
        }
      }) };
    }
    default: throw new Error("Invalid RDP stream message");
  }
}
