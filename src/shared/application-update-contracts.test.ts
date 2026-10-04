// @vitest-environment node

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  APPLICATION_UPDATE_MESSAGE_MAX_LENGTH,
  initialApplicationUpdateDisabled,
  initialApplicationUpdateIdle,
  parseApplicationUpdateState,
  type ApplicationUpdateState,
} from "./application-update-contracts.js";

describe("bounded application update contracts", () => {
  it.each<ApplicationUpdateState>([
    { status: "disabled", revision: 0, currentVersion: "0.1.0", disabledReason: "Updates require a packaged build." },
    { status: "idle", revision: 1, currentVersion: "0.1.0" },
    { status: "checking", revision: 2, currentVersion: "0.1.0" },
    { status: "trust-required", revision: 3, currentVersion: "0.1.0", message: "Approve the developer certificate to enable updates." },
    { status: "available", revision: 3, currentVersion: "0.1.0", availableVersion: "0.2.0" },
    { status: "downloading", revision: 4, currentVersion: "0.1.0", availableVersion: "0.2.0", progressPercent: 42.25 },
    { status: "ready", revision: 5, currentVersion: "0.1.0", availableVersion: "0.2.0" },
    { status: "up-to-date", revision: 6, currentVersion: "0.2.0" },
    { status: "error", revision: 7, currentVersion: "0.1.0", error: "The update check failed (HTTP 503)." },
  ])("accepts and freezes the exact $status state", (state) => {
    const parsed = parseApplicationUpdateState(state);
    expect(parsed).toEqual(state);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    { status: "idle", revision: -1, currentVersion: "0.1.0" },
    { status: "idle", revision: 1.5, currentVersion: "0.1.0" },
    { status: "idle", revision: 1, currentVersion: "../0.1.0" },
    { status: "checking", revision: 1, currentVersion: "0.1.0", releaseNotes: "unbounded" },
    { status: "trust-required", revision: 1, currentVersion: "0.1.0" },
    { status: "trust-required", revision: 1, currentVersion: "0.1.0", message: "https://example.test/certificate" },
    { status: "trust-required", revision: 1, currentVersion: "0.1.0", message: "Approve trust.", certificate: "unbounded" },
    { status: "available", revision: 1, currentVersion: "0.1.0" },
    { status: "available", revision: 1, currentVersion: "0.1.0", availableVersion: "0.2.0", url: "https://example.test/update" },
    { status: "downloading", revision: 1, currentVersion: "0.1.0", availableVersion: "0.2.0", progressPercent: -0.1 },
    { status: "downloading", revision: 1, currentVersion: "0.1.0", availableVersion: "0.2.0", progressPercent: 100.1 },
    { status: "ready", revision: 1, currentVersion: "0.1.0", availableVersion: "0.2.0", path: "/private/update.zip" },
    { status: "error", revision: 1, currentVersion: "0.1.0", error: "See https://example.test/update" },
    { status: "error", revision: 1, currentVersion: "0.1.0", error: "Read C:\\private\\update.log" },
    { status: "error", revision: 1, currentVersion: "0.1.0", error: `x${"y".repeat(APPLICATION_UPDATE_MESSAGE_MAX_LENGTH)}` },
    { status: "disabled", revision: 1, currentVersion: "0.1.0", disabledReason: "Line one\nLine two" },
  ])("rejects malformed, over-broad, or sensitive state %#", (state) => {
    expect(() => parseApplicationUpdateState(state)).toThrow(/Invalid application update state/u);
  });

  it("creates validated initial states", () => {
    expect(initialApplicationUpdateIdle("0.1.0")).toEqual({
      status: "idle",
      revision: 0,
      currentVersion: "0.1.0",
    });
    expect(initialApplicationUpdateDisabled("0.1.0", "Updates require a packaged build.", 3)).toEqual({
      status: "disabled",
      revision: 3,
      currentVersion: "0.1.0",
      disabledReason: "Updates require a packaged build.",
    });
    expectTypeOf(initialApplicationUpdateIdle("0.1.0")).toMatchTypeOf<ApplicationUpdateState>();
  });
});
