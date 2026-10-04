import { describe, expect, it } from "vitest";

import type { GenerateInput, ShellcodeOptions } from "./contracts.js";
import { cloneGenerateInput, defaultGenerateInput } from "./generate-defaults.js";
import {
  firstGenerateInputError,
  parseGenerateC2Endpoints,
  validateGenerateInput,
} from "./generate-validation.js";

type GenerateOverrides = Partial<Omit<GenerateInput, "shellcode">> & {
  shellcode?: Partial<ShellcodeOptions>;
};

function generateInput(overrides: GenerateOverrides = {}): GenerateInput {
  const input = cloneGenerateInput(defaultGenerateInput);
  return {
    ...input,
    ...overrides,
    shellcode: { ...input.shellcode, ...overrides.shellcode },
  };
}

describe("Generate input validation", () => {
  it("accepts the default Generate form input", () => {
    const errors = validateGenerateInput(generateInput());

    expect(errors).toEqual({});
    expect(firstGenerateInputError(errors)).toBeUndefined();
  });

  it("reports endpoint errors on the C2 field without losing normalization behavior", () => {
    expect(validateGenerateInput(generateInput({ c2: "" }))).toMatchObject({
      c2: "At least one C2 endpoint is required",
    });
    expect(validateGenerateInput(generateInput({ c2: "ftp://c2.example.test" }))).toMatchObject({
      c2: "Unsupported C2 protocol 'ftp'",
    });
    expect(validateGenerateInput(generateInput({ c2: "https://" }))).toMatchObject({
      c2: "Invalid C2 endpoint: https://",
    });
    expect(validateGenerateInput(generateInput({ c2: "mtls:///" }))).toMatchObject({
      c2: "C2 endpoint requires a host: mtls:///",
    });
    expect(validateGenerateInput(generateInput({ c2: "namedpipe://./pipe/sliver", os: "linux" })))
      .toMatchObject({ c2: "Named pipe C2 is supported only for Windows targets" });
    expect(validateGenerateInput(generateInput({ c2: "namedpipe://./not-pipe/sliver", os: "windows" })))
      .toMatchObject({ c2: "Named pipe endpoints must include a /pipe/ path" });
    expect(validateGenerateInput(generateInput({
      c2: "mtls://primary.example.test, ftp://invalid.example.test",
    }))).toMatchObject({ c2: "Unsupported C2 protocol 'ftp'" });

    expect(parseGenerateC2Endpoints(
      "c2.example.test\nwg://wireguard.example.test, tcp-pivot://pivot.example.test",
      "windows",
    )).toEqual([
      { priority: 0, url: "mtls://c2.example.test:8888" },
      { priority: 1, url: "wg://wireguard.example.test:53" },
      { priority: 2, url: "tcppivot://pivot.example.test:9898" },
    ]);
  });

  it("maps each existing semantic rule to the field that can resolve it", () => {
    const errors = validateGenerateInput(generateInput({
      name: "../escape",
      os: "",
      arch: "",
      c2: "ftp://c2.example.test",
      reconnectSeconds: 1.5,
      pollTimeoutSeconds: -1,
      maxConnectionErrors: -1,
      wgKeyExchangePort: 0,
      wgTcpCommsPort: 65_536,
      format: "shared",
      exports: "",
    }));

    expect(errors).toEqual({
      target: "Target OS and architecture are required",
      name: "Implant name must be alphanumeric or use '.', '-', and '_' only",
      wgKeyExchangePort: "WireGuard key exchange port must be between 1 and 65535",
      wgTcpCommsPort: "WireGuard TCP communications port must be between 1 and 65535",
      maxConnectionErrors: "Maximum connection errors must be a non-negative whole number",
      reconnectSeconds: "Reconnect interval must be a non-negative whole number of seconds",
      pollTimeoutSeconds: "Poll timeout must be a non-negative whole number of seconds",
      c2: "Unsupported C2 protocol 'ftp'",
      exports: "Shared libraries and Go archives require at least one export",
    });
    expect(firstGenerateInputError(errors)).toBe("Target OS and architecture are required");
  });

  it("validates beacon-only timing rules only for beacon implants", () => {
    expect(validateGenerateInput(generateInput({
      implantType: "beacon",
      beaconIntervalSeconds: 4,
      beaconJitterSeconds: 5,
    }))).toMatchObject({
      beaconIntervalSeconds: "Beacon interval must be at least 5 seconds",
      beaconJitterSeconds: "Beacon jitter cannot exceed the beacon interval",
    });

    expect(validateGenerateInput(generateInput({
      implantType: "beacon",
      beaconIntervalSeconds: 5.5,
      beaconJitterSeconds: -1,
    }))).toMatchObject({
      beaconIntervalSeconds: "Beacon interval must be a non-negative whole number of seconds",
      beaconJitterSeconds: "Beacon jitter must be a non-negative whole number of seconds",
    });

    const sessionErrors = validateGenerateInput(generateInput({
      implantType: "session",
      beaconIntervalSeconds: -1,
      beaconJitterSeconds: 9_999,
    }));
    expect(sessionErrors.beaconIntervalSeconds).toBeUndefined();
    expect(sessionErrors.beaconJitterSeconds).toBeUndefined();
  });

  it("assigns target, export, and shellcode-entry-point combination errors consistently", () => {
    expect(validateGenerateInput(generateInput({
      format: "shellcode",
      os: "freebsd",
      arch: "amd64",
    }))).toMatchObject({ target: "Shellcode output is not supported for freebsd/amd64" });

    expect(validateGenerateInput(generateInput({ format: "archive", exports: "" }))).toMatchObject({
      exports: "Shared libraries and Go archives require at least one export",
    });

    expect(validateGenerateInput(generateInput({
      format: "shellcode",
      shellcode: { originalEntryPoint: -1 },
    }))).toMatchObject({ shellcode: "Original entry point must be a non-negative whole number" });

    expect(validateGenerateInput(generateInput({
      format: "executable",
      shellcode: { originalEntryPoint: -1 },
    })).shellcode).toBeUndefined();
  });
});
