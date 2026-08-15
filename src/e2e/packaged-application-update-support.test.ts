import { describe, expect, it } from "vitest";

import {
  assertPrivatePackagedUpdateConfiguration,
  parsePackagedUpdateVersions,
} from "./packaged-application-update-support.js";

describe("packaged application update E2E support", () => {
  it("accepts an increasing prerelease pair", () => {
    expect(parsePackagedUpdateVersions("0.1.0-updater-e2e.1", "0.1.0-updater-e2e.2")).toEqual({
      from: "0.1.0-updater-e2e.1",
      to: "0.1.0-updater-e2e.2",
    });
  });

  it.each([
    ["0.1.0", "0.1.1-updater-e2e.1"],
    ["0.1.0-updater-e2e.2", "0.1.0-updater-e2e.1"],
    ["0.1.0-updater-e2e.01", "0.1.0-updater-e2e.2"],
    ["0.1.0-updater-e2e.1+local", "0.1.0-updater-e2e.2"],
  ])("rejects an unsafe update pair %s -> %s", (from, to) => {
    expect(() => parsePackagedUpdateVersions(from, to)).toThrow();
  });

  it("accepts a private provider flag without a packaged credential", () => {
    expect(() => assertPrivatePackagedUpdateConfiguration([
      "owner: sliverarmory",
      "repo: sliver-gui",
      "provider: github",
      "private: true",
      "channel: latest",
      "updaterCacheDirName: sliver-gui-updater",
      "",
    ].join("\n"), "github_pat_runtime_only")).not.toThrow();
  });

  it("requires the exact latest channel used by private GitHub metadata", () => {
    const content = [
      "owner: sliverarmory",
      "repo: sliver-gui",
      "provider: github",
      "private: true",
      "channel: beta",
      "updaterCacheDirName: sliver-gui-updater",
      "",
    ].join("\n");
    expect(() => assertPrivatePackagedUpdateConfiguration(content, "github_pat_runtime_only")).toThrow(
      /channel beta does not match latest/u,
    );
  });

  it.each([
    "token: github_pat_runtime_only",
    "authorization: Bearer github_pat_runtime_only",
    "requestHeaders: unsafe",
    "  accessToken: unsafe",
  ])("rejects packaged credentials: %s", (credentialLine) => {
    const content = [
      "owner: sliverarmory",
      "repo: sliver-gui",
      "provider: github",
      "private: true",
      "channel: latest",
      "updaterCacheDirName: sliver-gui-updater",
      credentialLine,
      "",
    ].join("\n");
    expect(() => assertPrivatePackagedUpdateConfiguration(content, "github_pat_runtime_only")).toThrow();
  });

  it.each([
    "host: attacker.example",
    "protocol: http",
    "provider: github",
    "<<: {host: attacker.example, protocol: http}",
  ])("rejects an unexpected or duplicate routing field: %s", (routingLine) => {
    const content = [
      "owner: sliverarmory",
      "repo: sliver-gui",
      "provider: github",
      "private: true",
      "channel: latest",
      "updaterCacheDirName: sliver-gui-updater",
      routingLine,
      "",
    ].join("\n");
    expect(() => assertPrivatePackagedUpdateConfiguration(content, "github_pat_runtime_only")).toThrow();
  });
});
