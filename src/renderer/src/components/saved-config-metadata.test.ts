// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  configEndpoint,
  formatConfigModifiedAt,
  safeConfigFilename,
} from "./saved-config-metadata";

describe("saved configuration metadata", () => {
  it("renders only a safe basename for POSIX and Windows paths", () => {
    expect(safeConfigFilename("/Users/operator/.sliver-client/configs/red-team.cfg")).toBe("red-team.cfg");
    expect(safeConfigFilename("C:\\Users\\operator\\configs\\blue-team.cfg")).toBe("blue-team.cfg");
  });

  it("removes control characters and supplies a readable fallback", () => {
    expect(safeConfigFilename("/private/path/team\u0000.cfg\n")).toBe("team.cfg");
    expect(safeConfigFilename("/private/path/\u0000\n")).toBe("Unnamed configuration");
  });

  it("formats DNS, IPv4, and IPv6 endpoints without ambiguity", () => {
    expect(configEndpoint("c2.example.test", 31337)).toBe("c2.example.test:31337");
    expect(configEndpoint("127.0.0.1", 8888)).toBe("127.0.0.1:8888");
    expect(configEndpoint("2001:db8::5", 8888)).toBe("[2001:db8::5]:8888");
    expect(configEndpoint("[2001:db8::5]", 8888)).toBe("[2001:db8::5]:8888");
  });

  it("handles invalid timestamps without exposing an invalid date", () => {
    expect(formatConfigModifiedAt("not-a-date")).toBe("Modified time unavailable");
    expect(formatConfigModifiedAt("2026-08-08T12:00:00.000Z")).not.toContain("Invalid");
  });
});
