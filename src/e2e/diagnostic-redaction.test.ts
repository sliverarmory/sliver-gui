// @vitest-environment node

import { describe, expect, it } from "vitest";

import { redactDiagnosticText, stringifyRedactedDiagnostics } from "./diagnostic-redaction.js";

describe("packaged E2E diagnostic redaction", () => {
  it("redacts multiline secrets and Windows paths before JSON escaping", () => {
    const certificate = "-----BEGIN CERTIFICATE-----\nfixture-secret\n-----END CERTIFICATE-----";
    const windowsPath = "C:\\Users\\runner\\fixture\\operator.cfg";
    const diagnostics = stringifyRedactedDiagnostics(
      {
        certificate: `load failed for ${certificate}`,
        path: `could not open ${windowsPath}`,
      },
      [certificate, windowsPath],
    );

    expect(diagnostics).not.toContain("fixture-secret");
    expect(diagnostics).not.toContain("runner");
    expect(JSON.parse(diagnostics)).toEqual({
      certificate: "load failed for [REDACTED]",
      path: "could not open [REDACTED]",
    });
  });

  it("bounds individual diagnostic strings", () => {
    expect(redactDiagnosticText("x".repeat(10), [], 4)).toBe("xxxx");
  });
});
