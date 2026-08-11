const ESC = 0x1b;
const BEL = 0x07;
const C1_DCS = 0x90;
const C1_SOS = 0x98;
const C1_OSC = 0x9d;
const C1_PM = 0x9e;
const C1_APC = 0x9f;
const C1_ST = 0x9c;

const ESC_DCS = 0x50; // P
const ESC_SOS = 0x58; // X
const ESC_OSC = 0x5d; // ]
const ESC_PM = 0x5e; // ^
const ESC_APC = 0x5f; // _
const ESC_ST = 0x5c; // \

export const DEFAULT_BLOCKED_SEQUENCE_BYTE_LIMIT = 64 * 1024;

type BlockedSequenceKind = "osc" | "other";
type ParserState =
  | { kind: "ground" }
  | { kind: "escape" }
  | { kind: "blocked"; sequence: BlockedSequenceKind; bytes: number }
  | { kind: "blocked-escape"; sequence: BlockedSequenceKind; bytes: number };

const GROUND: ParserState = { kind: "ground" };
const ESCAPE: ParserState = { kind: "escape" };

/**
 * Incrementally removes terminal string controls before bytes reach the
 * emulator. Those controls can carry titles, hyperlinks, clipboard payloads,
 * notifications, images, and file transfers. CSI and ordinary text are passed
 * through byte-for-byte.
 */
export class TerminalOutputSanitizer {
  private state: ParserState = GROUND;
  private utf8ContinuationBytes = 0;

  constructor(
    private readonly blockedSequenceByteLimit = DEFAULT_BLOCKED_SEQUENCE_BYTE_LIMIT,
  ) {
    if (
      !Number.isSafeInteger(blockedSequenceByteLimit) ||
      blockedSequenceByteLimit < 4
    ) {
      throw new RangeError("blockedSequenceByteLimit must be an integer of at least 4 bytes");
    }
  }

  filter(chunk: Uint8Array): Uint8Array {
    if (chunk.byteLength === 0) return new Uint8Array();

    // A pending safe ESC from the previous chunk can add at most one byte.
    const output = new Uint8Array(chunk.byteLength + 1);
    let outputLength = 0;

    for (const byte of chunk) {
      let reprocess = true;
      while (reprocess) {
        reprocess = false;

        switch (this.state.kind) {
          case "ground": {
            if (this.utf8ContinuationBytes > 0) {
              if (byte >= 0x80 && byte <= 0xbf) {
                output[outputLength++] = byte;
                this.utf8ContinuationBytes -= 1;
                break;
              }
              // Invalid/truncated UTF-8 must not hide a following terminal
              // control. Re-evaluate this byte as protocol data.
              this.utf8ContinuationBytes = 0;
              reprocess = true;
              break;
            }
            if (byte === BEL || byte === C1_ST) break;
            if (byte === ESC) {
              this.state = ESCAPE;
              break;
            }

            const c1Sequence = c1BlockedSequence(byte);
            if (c1Sequence) {
              this.state = { kind: "blocked", sequence: c1Sequence, bytes: 1 };
              break;
            }

            output[outputLength++] = byte;
            this.utf8ContinuationBytes = utf8ContinuationLength(byte);
            break;
          }

          case "escape": {
            const escapedSequence = escapedBlockedSequence(byte);
            if (escapedSequence) {
              this.state = { kind: "blocked", sequence: escapedSequence, bytes: 2 };
              break;
            }

            // The ESC was not a blocked string introducer. Preserve it and
            // process this byte normally so split CSI and ordinary escapes are
            // emitted exactly.
            output[outputLength++] = ESC;
            this.state = GROUND;
            reprocess = true;
            break;
          }

          case "blocked": {
            if (byte === C1_ST || (this.state.sequence === "osc" && byte === BEL)) {
              this.state = GROUND;
              break;
            }
            if (byte === ESC) {
              this.advanceBlocked("blocked-escape");
              break;
            }
            this.advanceBlocked("blocked");
            break;
          }

          case "blocked-escape": {
            if (byte === ESC_ST || byte === C1_ST) {
              this.state = GROUND;
              break;
            }
            if (this.state.sequence === "osc" && byte === BEL) {
              this.state = GROUND;
              break;
            }
            this.advanceBlocked(byte === ESC ? "blocked-escape" : "blocked");
            break;
          }
        }
      }
    }

    return output.slice(0, outputLength);
  }

  /** Flushes a pending safe ESC. Unterminated blocked strings remain dropped. */
  finish(): Uint8Array {
    const result = this.state.kind === "escape"
      ? new Uint8Array([ESC])
      : new Uint8Array();
    this.state = GROUND;
    this.utf8ContinuationBytes = 0;
    return result;
  }

  reset(): void {
    this.state = GROUND;
    this.utf8ContinuationBytes = 0;
  }

  private advanceBlocked(nextKind: "blocked" | "blocked-escape"): void {
    if (this.state.kind !== "blocked" && this.state.kind !== "blocked-escape") return;
    const bytes = this.state.bytes + 1;
    if (bytes >= this.blockedSequenceByteLimit) {
      // Recover after a bounded amount of hostile/invalid output instead of
      // allowing one unterminated string to suppress the stream indefinitely.
      this.state = GROUND;
      return;
    }
    this.state = { kind: nextKind, sequence: this.state.sequence, bytes };
  }
}

function escapedBlockedSequence(byte: number): BlockedSequenceKind | undefined {
  if (byte === ESC_OSC) return "osc";
  if (
    byte === ESC_DCS ||
    byte === ESC_APC ||
    byte === ESC_PM ||
    byte === ESC_SOS
  ) return "other";
  return undefined;
}

function c1BlockedSequence(byte: number): BlockedSequenceKind | undefined {
  if (byte === C1_OSC) return "osc";
  if (
    byte === C1_DCS ||
    byte === C1_APC ||
    byte === C1_PM ||
    byte === C1_SOS
  ) return "other";
  return undefined;
}

function utf8ContinuationLength(byte: number): number {
  if (byte >= 0xc2 && byte <= 0xdf) return 1;
  if (byte >= 0xe0 && byte <= 0xef) return 2;
  if (byte >= 0xf0 && byte <= 0xf4) return 3;
  return 0;
}
