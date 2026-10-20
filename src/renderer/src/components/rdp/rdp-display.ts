import {
  RDP_MAX_PAYLOAD_BYTES,
  RDP_MAX_PIXELS,
  type RdpFrame,
} from "../../../../shared/rdp-contracts";

/** Full snapshots are invisible until their final tile has arrived. */
export class RdpDisplay {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  #pending: HTMLCanvasElement | undefined;
  #pendingContext: CanvasRenderingContext2D | undefined;
  #frameId: number | undefined;
  #geometry = -1;
  #nextGeometry = -1;
  #sequence: number | undefined;
  #full = false;
  #width = 0;
  #height = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas rendering is unavailable.");
    this.#context = context;
  }

  apply(frame: RdpFrame): boolean {
    validateRdpFrame(frame);
    if (this.#sequence !== undefined && frame.seq !== this.#sequence + 1) throw new Error("Display sequence changed");
    this.#sequence = frame.seq;
    if (this.#geometry === -1 && this.#frameId === undefined && (!frame.full || !frame.first)) return false;
    if (frame.first) {
      if (this.#frameId !== undefined && !frame.full) throw new Error("Incomplete display frame");
      if (!frame.full && (frame.geometry !== this.#geometry || this.#canvas.width !== frame.width || this.#canvas.height !== frame.height)) {
        throw new Error("Desktop geometry needs a full snapshot");
      }
      this.#frameId = frame.frameId;
      this.#nextGeometry = frame.geometry;
      this.#full = frame.full;
      this.#width = frame.width;
      this.#height = frame.height;
      if (frame.full) {
        this.#pending = document.createElement("canvas");
        this.#pending.width = frame.width;
        this.#pending.height = frame.height;
        this.#pendingContext = this.#pending.getContext("2d", { alpha: false }) ?? undefined;
        if (!this.#pendingContext) throw new Error("Canvas rendering is unavailable");
      }
    }
    if (this.#frameId !== frame.frameId || this.#nextGeometry !== frame.geometry || this.#full !== frame.full || this.#width !== frame.width || this.#height !== frame.height) throw new Error("Display batch changed");
    const target = this.#full ? this.#pendingContext : this.#context;
    if (!target) throw new Error("Missing desktop snapshot");
    target.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.tileWidth, frame.tileHeight), frame.x, frame.y);
    if (!frame.last) return false;
    if (this.#full) {
      if (!this.#pending || this.#pending.width !== frame.width || this.#pending.height !== frame.height) throw new Error("Snapshot dimensions changed");
      this.#canvas.width = frame.width;
      this.#canvas.height = frame.height;
      this.#context.drawImage(this.#pending, 0, 0);
    }
    this.#geometry = frame.geometry;
    this.#frameId = undefined;
    this.#pending = undefined;
    this.#pendingContext = undefined;
    return true;
  }
}

export function validateRdpFrame(frame: RdpFrame): void {
  if (frame.type !== "frame" || !integer(frame.seq, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(frame.frameId, 0, Number.MAX_SAFE_INTEGER) || !integer(frame.geometry, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(frame.width, 1, 8192) || !integer(frame.height, 1, 8192) || frame.width * frame.height > RDP_MAX_PIXELS ||
    !integer(frame.tileWidth, 1, frame.width) || !integer(frame.tileHeight, 1, frame.height) ||
    !integer(frame.x, 0, frame.width - frame.tileWidth) || !integer(frame.y, 0, frame.height - frame.tileHeight) ||
    typeof frame.full !== "boolean" || typeof frame.first !== "boolean" || typeof frame.last !== "boolean" ||
    !(frame.data instanceof ArrayBuffer) || frame.data.byteLength > RDP_MAX_PAYLOAD_BYTES ||
    frame.data.byteLength !== frame.tileWidth * frame.tileHeight * 4) throw new Error("Invalid desktop tile");
}

function integer(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
