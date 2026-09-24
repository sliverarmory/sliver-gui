import { describe, expect, it } from "vitest";

import { STREAM_MAX_FRAME_BYTES } from "../../../shared/stream-contracts";

import { PipedWindowsShellInput } from "./piped-windows-shell-input";

describe("PipedWindowsShellInput", () => {
  it("forwards printable input immediately and normalizes Enter", () => {
    const input = new PipedWindowsShellInput();

    expect(input.accept("Write-Output 'ready'"))
      .toBe("Write-Output 'ready'");
    expect(input.accept("\r")).toBe("\r");
    expect(input.accept("pwd\r")).toBe("pwd\r");
  });

  it("translates DEL and BS into the erase sequence only for a nonempty line", () => {
    const input = new PipedWindowsShellInput();

    expect(input.accept("\u007f\bwhoamX")).toBe("whoamX");
    expect(input.accept("\u007f")).toBe("\b \b");
    expect(input.accept("i\r")).toBe("i\r");
    expect(input.accept("\b")).toBe("");
    expect(input.accept("x\b")).toBe("x\b \b");
  });

  it("drops split CSI, SS3, and other escape controls without contaminating the command", () => {
    const input = new PipedWindowsShellInput();

    expect(input.accept("abc\u001b[")).toBe("abc");
    expect(input.accept("1;5")).toBe("");
    expect(input.accept("Ddef\u001bO")).toBe("def");
    expect(input.accept("A\u001b]0;title")).toBe("");
    expect(input.accept("\u0007\u0003\u0015\u0000\r")).toBe("\r");
    expect(input.accept("next\u001bPignored\u001b")).toBe("next");
    expect(input.accept("\\\r")).toBe("\r");
  });

  it("coalesces CRLF across chunks and handles multiline paste without an extra empty command", () => {
    const input = new PipedWindowsShellInput();

    expect(input.accept("one\r")).toBe("one\r");
    expect(input.accept("\ntwo\r\nthree\nfour\r")).toBe("two\rthree\rfour\r");
    expect(input.accept("\nfive\titems\r")).toBe("five\titems\r");
  });

  it("recovers from unterminated escape sequences when Enter is pressed", () => {
    const input = new PipedWindowsShellInput();

    expect(input.accept("first\u001b[")).toBe("first");
    expect(input.accept("\r\nsecond\u001b]0;unfinished"))
      .toBe("\rsecond");
    expect(input.accept("\nthird\u001bO")).toBe("\rthird");
    expect(input.accept("\rfourth\r")).toBe("\rfourth\r");
  });

  it("caps each line by UTF-8 bytes and starts a fresh budget after Enter", () => {
    const input = new PipedWindowsShellInput();
    const maximum = STREAM_MAX_FRAME_BYTES - 1;

    expect(input.accept("a".repeat(maximum - 2))).toBe("a".repeat(maximum - 2));
    expect(input.accept("🦊")).toBe("");
    expect(input.accept("é")).toBe("é");
    expect(input.accept("x")).toBe("");
    expect(input.accept("\rnext")).toBe("\rnext");
  });

  it("clears the line budget and partial control sequence on reset", () => {
    const input = new PipedWindowsShellInput();

    expect(input.accept("a".repeat(STREAM_MAX_FRAME_BYTES - 1))).toHaveLength(STREAM_MAX_FRAME_BYTES - 1);
    expect(input.accept("\u001b[")).toBe("");
    input.reset();
    expect(input.accept("fresh\r")).toBe("fresh\r");
    expect(input.accept("\nsecond\r")).toBe("second\r");
  });
});
