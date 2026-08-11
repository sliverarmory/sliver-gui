import { describe, expect, it } from "vitest";

import { TerminalOutputSanitizer } from "./terminal-output-sanitizer";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("TerminalOutputSanitizer", () => {
  it("preserves ordinary UTF-8, C0 layout controls, and safe CSI exactly across chunks", () => {
    const sanitizer = new TerminalOutputSanitizer();
    const chunks = [
      encoder.encode("hello\tworld\r\n"),
      new Uint8Array([0x1b]),
      encoder.encode("[31mred"),
      new Uint8Array([0x1b, 0x5b, 0x30, 0x6d]),
      encoder.encode(" 👋🏽"),
    ];

    expect(concat(chunks.map((chunk) => sanitizer.filter(chunk)))).toEqual(
      concat(chunks),
    );
  });

  it("strips OSC title, hyperlink, clipboard, and iTerm file payloads plus BEL", () => {
    const sanitizer = new TerminalOutputSanitizer();
    const hostile = concat([
      encoder.encode("before"),
      encoder.encode("\u001b]0;hostile title\u0007"),
      encoder.encode("\u001b]2;other title\u001b\\"),
      encoder.encode("\u001b]8;;https://example.test\u001b\\click\u001b]8;;\u001b\\"),
      encoder.encode("\u001b]52;c;c2VjcmV0\u0007"),
      encoder.encode("\u001b]1337;File=name=dGVzdA==:ZmFrZQ==\u0007"),
      new Uint8Array([0x07]),
      encoder.encode("after"),
    ]);

    expect(decoder.decode(sanitizer.filter(hostile))).toBe("beforeclickafter");
  });

  it("strips split DCS, APC, PM, and SOS strings including raw C1 forms", () => {
    const sanitizer = new TerminalOutputSanitizer();
    const chunks = [
      encoder.encode("A\u001b"),
      encoder.encode("PqDCS"),
      new Uint8Array([0x1b]),
      encoder.encode("\\B\u001b_Gf=100;kitty"),
      new Uint8Array([0x1b, 0x5c]),
      encoder.encode("C\u001b^private\u001b\\D\u001bXsecret\u001b\\E"),
      new Uint8Array([0x90, 0x31, 0x32, 0x9c]),
      encoder.encode("F"),
      new Uint8Array([0x9f, 0x47, 0x9c, 0x9e, 0x78, 0x9c, 0x98, 0x79, 0x9c]),
      encoder.encode("G"),
    ];

    expect(decoder.decode(concat(chunks.map((chunk) => sanitizer.filter(chunk))))).toBe("ABCDEFG");
  });

  it("bounds an unterminated blocked sequence and recovers without retaining its payload", () => {
    const sanitizer = new TerminalOutputSanitizer(8);

    expect(sanitizer.filter(encoder.encode("\u001b]0;1234"))).toEqual(new Uint8Array());
    expect(decoder.decode(sanitizer.filter(encoder.encode("safe")))).toBe("safe");
  });

  it("flushes only a pending safe ESC and drops an unterminated blocked sequence", () => {
    const safe = new TerminalOutputSanitizer();
    expect(safe.filter(new Uint8Array([0x1b]))).toEqual(new Uint8Array());
    expect(safe.finish()).toEqual(new Uint8Array([0x1b]));

    const blocked = new TerminalOutputSanitizer();
    expect(blocked.filter(encoder.encode("\u001b]52;c;secret"))).toEqual(new Uint8Array());
    expect(blocked.finish()).toEqual(new Uint8Array());
  });
});

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
