import { describe, expect, it } from "vitest";

import {
  ARMORY_IPC_EVENTS,
  ARMORY_IPC_INVOKE,
  isArmoryTab,
  parseArmoryChooseLocalInput,
  parseArmoryInstallBundleInput,
  parseArmoryInstallInput,
  parseArmoryRemoveSourceInput,
  parseArmorySaveSourceInput,
  parseArmoryUninstallInput,
} from "./armory-contracts.js";

const source = {
  name: "Example",
  repoUrl: "https://armory.example.test/index",
  publicKey: "trusted-public-key",
  enabled: true,
};

describe("Armory contracts", () => {
  it("limits navigation to local package-management tabs", () => {
    for (const tab of ["manage", "install", "sources"]) expect(isArmoryTab(tab)).toBe(true);
    for (const tab of [undefined, null, "", "sessions", "beacons", "execute", "install/../sessions", {}, []]) {
      expect(isArmoryTab(tab)).toBe(false);
    }
    const channels = [...Object.values(ARMORY_IPC_INVOKE), ...Object.values(ARMORY_IPC_EVENTS)];
    expect(new Set(channels).size).toBe(channels.length);
    expect(channels.every((channel) => channel.startsWith("sliver:armory:"))).toBe(true);
    expect(channels.some((channel) => /session|beacon|execute|rpc/u.test(channel))).toBe(false);
  });

  it("preserves explicit replacement consent and opaque package identifiers", () => {
    expect(parseArmoryInstallInput({ packageId: "catalog-package" })).toEqual({ packageId: "catalog-package" });
    expect(parseArmoryInstallInput({ packageId: "catalog-package", replace: false }))
      .toEqual({ packageId: "catalog-package", replace: false });
    expect(parseArmoryInstallBundleInput({ bundleId: "catalog-bundle", replace: true }))
      .toEqual({ bundleId: "catalog-bundle", replace: true });
    expect(parseArmoryUninstallInput({ installedId: "installed-package" }))
      .toEqual({ installedId: "installed-package" });
    expect(parseArmoryRemoveSourceInput({ sourceId: "source" })).toEqual({ sourceId: "source" });
    expect(parseArmoryChooseLocalInput({ publicKey: "trusted-public-key", replace: true }))
      .toEqual({ publicKey: "trusted-public-key", replace: true });
  });

  const parsers = [
    ["install", parseArmoryInstallInput, { packageId: "package" }, "packageId"],
    ["bundle", parseArmoryInstallBundleInput, { bundleId: "bundle" }, "bundleId"],
    ["uninstall", parseArmoryUninstallInput, { installedId: "installed" }, "installedId"],
    ["remove source", parseArmoryRemoveSourceInput, { sourceId: "source" }, "sourceId"],
    ["local install", parseArmoryChooseLocalInput, { publicKey: "key" }, "publicKey"],
  ] as const;

  it.each(parsers)("rejects malformed %s requests before reaching native services", (_label, parse, input, required) => {
    for (const value of [undefined, null, [], "package", 1, true, {}]) expect(() => parse(value)).toThrow(TypeError);
    for (const invalid of [undefined, null, 7, "", "   ", "a\nvalue", "a\0value", "a\u007fvalue", "a".repeat(513)]) {
      expect(() => parse({ ...input, [required]: invalid })).toThrow(TypeError);
    }
    for (const extra of [
      { archivePath: "/tmp/arbitrary.tar.gz" }, { signaturePath: "/tmp/arbitrary.minisig" },
      { installPath: "/tmp/target" }, { rootPath: "/tmp/target" }, { sessionId: "session" },
      { beaconId: "beacon" }, { execute: true }, { rpc: "Shell" },
    ]) expect(() => parse({ ...input, ...extra })).toThrow(TypeError);
  });

  it("rejects truthy replacement values instead of silently granting replacement", () => {
    for (const replace of [null, 0, 1, "true", [], {}]) {
      expect(() => parseArmoryInstallInput({ packageId: "package", replace })).toThrow(TypeError);
      expect(() => parseArmoryInstallBundleInput({ bundleId: "bundle", replace })).toThrow(TypeError);
      expect(() => parseArmoryChooseLocalInput({ publicKey: "key", replace })).toThrow(TypeError);
    }
  });

  it("distinguishes omitted, replaced, and cleared console source credentials", () => {
    expect(parseArmorySaveSourceInput(source)).toEqual(source);
    expect(parseArmorySaveSourceInput(source)).not.toHaveProperty("authorization");
    expect(parseArmorySaveSourceInput({ ...source, id: "existing", authorization: "" }))
      .toEqual({ ...source, id: "existing", authorization: "" });
    expect(parseArmorySaveSourceInput({ ...source, authorization: "Bearer token" }).authorization).toBe("Bearer token");
  });

  it("rejects oversized source fields, header injection, and config-provided execution", () => {
    for (const invalid of [
      { name: "a".repeat(129) }, { repoUrl: "a".repeat(2049) }, { publicKey: "a".repeat(513) },
      { enabled: "true" }, { enabled: undefined }, { id: "" }, { authorization: "a".repeat(8193) },
      { authorization: "Bearer token\r\nX-Injected: yes" }, { authorization: null },
      { authorizationCmd: "arbitrary-program" }, { authorization_cmd: "arbitrary-program" },
      { installPath: "/tmp/arbitrary" },
    ]) expect(() => parseArmorySaveSourceInput({ ...source, ...invalid })).toThrow(TypeError);
  });
});
