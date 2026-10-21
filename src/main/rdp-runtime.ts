import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { RDP_MAX_CLIPBOARD_BYTES, RDP_MAX_CONTROL_BYTES, RDP_MAX_PAYLOAD_BYTES, RDP_PROTOCOL_VERSION, type RdpCursor, type RdpFrame, type RdpSessionPhase } from "../shared/rdp-contracts.js";
import { rdpBoolean, rdpDimensions, rdpInteger, rdpRecord, rdpString } from "../shared/rdp-validation.js";

export type RdpRuntimeEvent =
  | Omit<RdpFrame, "data"> & { data: ArrayBuffer }
  | RdpCursor
  | { type: "ready"; protocol: 1 }
  | { type: "state"; state: RdpSessionPhase; code?: string }
  | { type: "certificate" | "peerCertificate"; requestId?: string; endpoint: string; fingerprint: string; certificateDer: string; validationKind: string; canOverride: boolean }
  | { type: "clipboard"; text: string }
  | { type: "clipboardAvailable"; available: boolean }
  | { type: "clipboardReady" | "resizeFallback" }
  | { type: "error" | "terminated"; code: string };

const MAX_HEADER = 16 * 1024;

export function rdpRuntimeEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR"]);
  return { ...Object.fromEntries(Object.entries(environment).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase()))), RUST_LOG: "off" };
}

/** Length-prefixed private-pipe decoder. Reject lengths before allocating. */
export class RdpWireDecoder {
  #pending = Buffer.alloc(0);
  push(chunk: Buffer, receive: (event: RdpRuntimeEvent) => void): void {
    // Node's pipe reads are bounded, but callers/tests may supply multiple records.
    for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
      this.#pending = Buffer.concat([this.#pending, chunk.subarray(offset, offset + 64 * 1024)]);
      while (this.#pending.length >= 8) {
        const headerLength = this.#pending.readUInt32LE(0);
        const payloadLength = this.#pending.readUInt32LE(4);
        if (!headerLength || headerLength > RDP_MAX_CONTROL_BYTES || payloadLength > RDP_MAX_PAYLOAD_BYTES) throw new Error("Invalid RDP runtime record length");
        const length = 8 + headerLength + payloadLength;
        if (this.#pending.length < length) break;
        const header: unknown = JSON.parse(this.#pending.subarray(8, 8 + headerLength).toString("utf8"));
        const payload = this.#pending.subarray(8 + headerLength, length);
        const event = parseRdpRuntimeEvent(header, payload);
        if (headerLength > MAX_HEADER && event.type !== "clipboard") throw new Error("Oversized RDP runtime header");
        this.#pending = this.#pending.subarray(length);
        receive(event);
      }
    }
  }
  finish(): void { if (this.#pending.length) throw new Error("Truncated RDP runtime record"); }
}

export function parseRdpRuntimeEvent(raw: unknown, payload: Buffer): RdpRuntimeEvent {
  const item = rdpRecord(raw);
  const type = item["type"];
  if (type !== "frame" && type !== "cursor" && payload.length) throw new Error("Unexpected RDP binary payload");
  switch (type) {
    case "ready":
      if (item["protocol"] !== RDP_PROTOCOL_VERSION) throw new Error("Incompatible RDP runtime protocol");
      return { type, protocol: 1 };
    case "frame": {
      const size = rdpDimensions(item["width"], item["height"]);
      const x = rdpInteger(item["x"], 0, size.width - 1), y = rdpInteger(item["y"], 0, size.height - 1);
      const tileWidth = rdpInteger(item["tileWidth"], 1, size.width - x), tileHeight = rdpInteger(item["tileHeight"], 1, size.height - y);
      if (payload.length !== tileWidth * tileHeight * 4) throw new Error("Invalid RDP pixel payload");
      return { type, ...size, x, y, tileWidth, tileHeight, seq: rdpInteger(item["seq"], 1, Number.MAX_SAFE_INTEGER),
        frameId: rdpInteger(item["frameId"], 0, Number.MAX_SAFE_INTEGER), geometry: rdpInteger(item["geometry"], 0, Number.MAX_SAFE_INTEGER),
        full: rdpBoolean(item["full"]), first: rdpBoolean(item["first"]), last: rdpBoolean(item["last"]), data: Uint8Array.from(payload).buffer };
    }
    case "cursor": {
      const kind = item["kind"];
      if (kind === "default" || kind === "hidden") { if (payload.length) throw new Error("Unexpected cursor bytes"); return { type, kind }; }
      if (kind === "position") { if (payload.length) throw new Error("Unexpected cursor bytes"); return { type, kind, x: rdpInteger(item["x"], 0, 8191), y: rdpInteger(item["y"], 0, 8191) }; }
      if (kind !== "bitmap") throw new Error("Invalid RDP cursor");
      const width = rdpInteger(item["width"], 1, 256), height = rdpInteger(item["height"], 1, 256);
      if (payload.length !== width * height * 4) throw new Error("Invalid cursor payload");
      return { type, kind, width, height, hotspotX: rdpInteger(item["hotspotX"], 0, width - 1), hotspotY: rdpInteger(item["hotspotY"], 0, height - 1), data: Uint8Array.from(payload).buffer };
    }
    case "state": {
      const state = item["state"];
      if (state !== "connecting" && state !== "authenticating" && state !== "active" && state !== "disconnected" && state !== "failed") throw new Error("Invalid RDP state");
      return { type, state, ...(item["code"] === undefined ? {} : { code: rdpString(item["code"], 120) }) };
    }
    case "certificate": case "peerCertificate": {
      const fingerprint = rdpString(item["fingerprint"], 64).toLowerCase();
      if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error("Invalid certificate fingerprint");
      return { type, endpoint: rdpString(item["endpoint"], 512), fingerprint, certificateDer: rdpString(item["certificateDer"], 12288),
        validationKind: rdpString(item["validationKind"], 100), canOverride: item["canOverride"] === true,
        ...(type === "certificate" ? { requestId: rdpString(item["requestId"], 128) } : {}) };
    }
    case "clipboard": {
      if (typeof item["text"] !== "string" || Buffer.byteLength(item["text"]) > RDP_MAX_CLIPBOARD_BYTES) throw new Error("Invalid RDP clipboard payload");
      return { type, text: item["text"] };
    }
    case "clipboardAvailable": return { type, available: rdpBoolean(item["available"]) };
    case "clipboardReady": case "resizeFallback": return { type };
    case "error": case "terminated": return { type, code: rdpString(item["code"], 120) };
    default: throw new Error("Unknown RDP runtime event");
  }
}

/** One helper per connection attempt. No command shell, sockets, or secret logs. */
export class RdpRuntime {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #finish: (code: string) => void;
  #closed = false;
  #stopping = false;
  #killTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(executable: string, receive: (event: RdpRuntimeEvent) => void, exited: (code: string) => void) {
    this.#child = spawn(executable, [], { stdio: "pipe", windowsHide: true, shell: false, env: rdpRuntimeEnvironment() });
    const decoder = new RdpWireDecoder();
    const finish = (code: string): void => {
      if (this.#closed) return;
      this.#closed = true;
      exited(code);
    };
    this.#finish = finish;
    this.#child.stdout.on("data", (chunk: Buffer) => {
      if (this.#closed || this.#stopping) return;
      try { decoder.push(chunk, receive); } catch { this.stop(); finish("runtime-protocol-error"); }
    });
    // Drain diagnostics without retaining output that could include credentials or desktop text.
    this.#child.stderr.resume();
    this.#child.stdin.on("error", () => { this.stop(); finish("runtime-pipe-closed"); });
    this.#child.once("error", () => finish("runtime-unavailable"));
    this.#child.once("close", (code) => {
      clearTimeout(this.#killTimer);
      try { decoder.finish(); } catch { finish("runtime-truncated"); return; }
      finish(this.#stopping || code === 0 ? "disconnected" : "runtime-exited");
    });
  }
  send(command: object): void {
    if (this.#closed || this.#stopping) return;
    const bytes = Buffer.from(`${JSON.stringify(command)}\n`, "utf8");
    if (bytes.length > RDP_MAX_CONTROL_BYTES || this.#child.stdin.writableLength > 2 * RDP_MAX_CONTROL_BYTES) {
      bytes.fill(0); this.stop(); this.#finish("runtime-input-limit"); return;
    }
    try { this.#child.stdin.write(bytes, () => bytes.fill(0)); }
    catch { bytes.fill(0); this.stop(); this.#finish("runtime-pipe-closed"); }
  }
  stop(): void {
    if (this.#stopping) return;
    this.#stopping = true;
    try {
      if (!this.#closed && this.#child.stdin.writableLength < RDP_MAX_CONTROL_BYTES && !this.#child.stdin.destroyed) {
        this.#child.stdin.write('{"type":"disconnect"}\n');
      }
      this.#child.stdin.end();
    } catch { /* Forced termination still owns cleanup if the pipe is already unavailable. */ }
    this.#killTimer = setTimeout(() => this.#child.kill("SIGKILL"), 3000);
    this.#killTimer.unref();
  }
}
