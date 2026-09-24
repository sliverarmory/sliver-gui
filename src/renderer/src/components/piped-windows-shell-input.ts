import { STREAM_MAX_FRAME_BYTES } from "../../../shared/stream-contracts";

const MAX_LINE_BYTES = STREAM_MAX_FRAME_BYTES - 1;
const BACKSPACE_ERASE = "\b \b";

type EscapeState = "normal" | "escape" | "csi" | "ss3" | "string" | "string-escape";

/**
 * Adapts Ghostty key data for a Windows shell connected through stdin/stdout
 * pipes. PowerShell echoes printable input itself, so only bytes intended for
 * the remote process are returned. Current-line lengths, rather than command
 * text or history, are retained to bound input and handle Backspace.
 */
export class PipedWindowsShellInput {
  readonly #characterByteLengths: number[] = [];
  #lineBytes = 0;
  #escapeState: EscapeState = "normal";
  #skipLineFeed = false;

  accept(data: string): string {
    let forwarded = "";

    for (const character of data) {
      if (this.#skipLineFeed) {
        this.#skipLineFeed = false;
        if (character === "\n") continue;
      }

      const codePoint = character.codePointAt(0)!;
      if (character === "\r" || character === "\n") {
        this.#escapeState = "normal";
        forwarded += "\r";
        this.#clearLine();
        this.#skipLineFeed = character === "\r";
        continue;
      }
      if (this.#escapeState !== "normal") {
        this.#consumeEscape(character, codePoint);
        continue;
      }

      if (character === "\u001b") {
        this.#escapeState = "escape";
        continue;
      }
      if (codePoint === 0x9b) {
        this.#escapeState = "csi";
        continue;
      }
      if (codePoint === 0x8f) {
        this.#escapeState = "ss3";
        continue;
      }
      if (codePoint === 0x9d) {
        this.#escapeState = "string";
        continue;
      }

      if (character === "\u007f" || character === "\b") {
        if (this.#characterByteLengths.length > 0) {
          this.#lineBytes -= this.#characterByteLengths.pop()!;
          forwarded += BACKSPACE_ERASE;
        }
        continue;
      }

      if ((codePoint < 0x20 && character !== "\t") ||
          (codePoint >= 0x80 && codePoint <= 0x9f) ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)) continue;

      const byteLength = utf8ByteLength(codePoint);
      if (this.#lineBytes + byteLength > MAX_LINE_BYTES) continue;
      this.#characterByteLengths.push(byteLength);
      this.#lineBytes += byteLength;
      forwarded += character;
    }

    return forwarded;
  }

  reset(): void {
    this.#clearLine();
    this.#escapeState = "normal";
    this.#skipLineFeed = false;
  }

  #clearLine(): void {
    this.#characterByteLengths.fill(0);
    this.#characterByteLengths.length = 0;
    this.#lineBytes = 0;
  }

  #consumeEscape(character: string, codePoint: number): void {
    switch (this.#escapeState) {
      case "escape":
        if (character === "[") this.#escapeState = "csi";
        else if (character === "O") this.#escapeState = "ss3";
        else if ("]PX^_".includes(character)) this.#escapeState = "string";
        else if (character !== "\u001b") this.#escapeState = "normal";
        break;
      case "csi":
        if (codePoint >= 0x40 && codePoint <= 0x7e) this.#escapeState = "normal";
        else if (character === "\u001b") this.#escapeState = "escape";
        break;
      case "ss3":
        this.#escapeState = character === "\u001b" ? "escape" : "normal";
        break;
      case "string":
        if (character === "\u0007" || codePoint === 0x9c) this.#escapeState = "normal";
        else if (character === "\u001b") this.#escapeState = "string-escape";
        break;
      case "string-escape":
        if (character === "\\" || character === "\u0007" || codePoint === 0x9c) {
          this.#escapeState = "normal";
        } else if (character !== "\u001b") {
          this.#escapeState = "string";
        }
        break;
      case "normal":
        break;
    }
  }
}

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}
