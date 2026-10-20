import { RDP_MAX_PIXELS, type RdpConnectInput, type RdpConnectionOptions, type RdpSaveProfileInput, type RdpViewerMessage } from "./rdp-contracts.js";

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

export function parseRdpOptions(value: unknown): RdpConnectionOptions {
  const item = rdpRecord(value);
  const host = rdpString(item["host"], 253).trim().toLowerCase();
  if (!/^[a-z0-9.:%_-]+$/iu.test(host) || host.startsWith("-") || host.includes("%")) throw new Error("Enter a hostname or IP address without a URL or port");
  return { host, port: rdpInteger(item["port"], 1, 65535), username: rdpString(item["username"], 256),
    domain: rdpString(item["domain"], 256, true), ...rdpDimensions(item["width"], item["height"]), clipboard: rdpBoolean(item["clipboard"]) };
}

export function parseRdpProfile(value: unknown): RdpSaveProfileInput {
  const item = rdpRecord(value);
  if (item["scaleMode"] !== "fit" && item["scaleMode"] !== "actual") throw new Error("Invalid RDP scale mode");
  return { ...parseRdpOptions(value), label: rdpString(item["label"], 120), scaleMode: item["scaleMode"],
    ...(item["id"] === undefined ? {} : { id: rdpString(item["id"], 80) }) };
}

export function rdpPassword(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) throw new Error("Invalid RDP password");
  return value;
}

export function parseRdpConnect(value: unknown): RdpConnectInput {
  const item = rdpRecord(value);
  const { id: _id, ...profile } = parseRdpProfile(value);
  if (item["persistence"] !== "none" && item["persistence"] !== "session" && item["persistence"] !== "secure") throw new Error("Invalid RDP credential preference");
  return { ...profile, persistence: item["persistence"],
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
