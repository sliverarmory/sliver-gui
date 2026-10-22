import { describe, expect, it } from "vitest";
import { parseRdpConnect, parseRdpOptions, parseRdpProfile, rdpProxyPassword } from "./rdp-validation.js";
import { rdpNetworkingKey } from "./rdp-contracts.js";

const options = { host: "windows.test", port: 3389, username: "Administrator", domain: "LAB", width: 1280, height: 800,
  clipboard: true, label: "Windows", scaleMode: "fit", persistence: "none" };
const remote = { ...options, username: "", domain: "", signInMode: "remote-screen" };

describe("RDP sign-in mode validation", () => {
  it("keeps old connections and profiles on NLA", () => {
    expect(parseRdpConnect(options)).not.toHaveProperty("signInMode");
    expect(parseRdpProfile({ ...options, signInMode: "nla" })).not.toHaveProperty("signInMode");
    expect(() => parseRdpConnect({ ...options, username: "" })).toThrow();
  });
  it("accepts explicit remote-screen sign-in without connection credentials", () => {
    expect(parseRdpConnect(remote)).toMatchObject({ signInMode: "remote-screen", username: "", domain: "", persistence: "none" });
    expect(parseRdpProfile(remote)).toHaveProperty("signInMode", "remote-screen");
  });
  it.each([null, false, "", "auto", "tls", "NLA"])("rejects an unknown mode: %s", (signInMode) => {
    expect(() => parseRdpOptions({ ...options, signInMode })).toThrow(/sign-in mode/);
  });
  it.each([{ username: "Administrator" }, { domain: "LAB" }, { password: "private" }, { persistence: "session" }, { persistence: "secure" }])("rejects remote-screen credentials or persistence: %j", (patch) => {
    expect(() => parseRdpConnect({ ...remote, ...patch })).toThrow();
  });
});


describe("RDP profile import and proxy route validation", () => {
  it("normalizes manual proxy endpoints and keeps authentication secrets connect-only", () => {
    const networking = { kind: "socks5-manual", host: " PROXY.Example.test ", port: 1080, username: "proxy-user" };
    const input = { ...options, networking, proxyPassword: "proxy-secret" };
    expect(parseRdpConnect(input)).toMatchObject({ networking: { ...networking, host: "proxy.example.test" }, proxyPassword: "proxy-secret" });
    const saved = parseRdpProfile(input);
    expect(saved).not.toHaveProperty("proxyPassword");
    expect(Object.isFrozen(saved.networking)).toBe(true);
    expect(() => parseRdpConnect({ ...options, networking })).toThrow(/proxy password/);
    expect(parseRdpConnect({ ...options, networking: { kind: "socks5-manual", host: "::1", port: 1080 } })).not.toHaveProperty("proxyPassword");
    expect(parseRdpConnect({ ...remote, networking, proxyPassword: "separate-proxy-secret" }).signInMode).toBe("remote-screen");
  });
  it("requires an exact bounded manual authentication mode", () => {
    const networking = { kind: "socks5-manual", host: "127.0.0.1", port: 1080, username: "proxy-user" };
    expect(rdpProxyPassword("é".repeat(127) + "a")).toHaveLength(128);
    for (const value of [undefined, null, "", "a\0b", "a".repeat(256), "é".repeat(128)]) {
      expect(() => parseRdpConnect({ ...options, networking, proxyPassword: value })).toThrow();
    }
    for (const route of [undefined, { kind: "socks5-manual", host: "127.0.0.1", port: 1080 },
      { kind: "socks5", proxyId: "socks5-11111111-1111-4111-8111-111111111111" }]) {
      expect(() => parseRdpConnect({ ...options, networking: route, proxyPassword: "unused-secret" })).toThrow();
    }
    for (const patch of [{ host: "proxy.test:1080" }, { host: "http://proxy.test" }, { host: "[::1]" }, { host: "bad::address" },
      { host: " fe80::1%lo " }, { host: "host name" }, { port: 0 }, { port: 65536 }, { username: "" },
      { username: "é".repeat(128) }, { password: "do-not-save" }, { proxyId: "managed" }]) {
      expect(() => parseRdpProfile({ ...options, networking: { ...networking, ...patch } })).toThrow();
    }
  });
  it("keeps direct, managed and manual route identities distinct", () => {
    const manual = { kind: "socks5-manual" as const, host: "Proxy.test", port: 1080, username: "alice" };
    const key = rdpNetworkingKey(manual);
    expect(key).toBe(rdpNetworkingKey({ ...manual, host: "proxy.test" }));
    for (const route of [undefined, { ...manual, host: "other.test" }, { ...manual, port: 1081 }, { ...manual, username: "bob" },
      { kind: "socks5" as const, proxyId: "socks5-11111111-1111-4111-8111-111111111111" }]) expect(rdpNetworkingKey(route)).not.toBe(key);
  });
  it("permits an incomplete imported username only when saving", () => {
    expect(parseRdpProfile({ ...options, username: "" }).username).toBe("");
    expect(() => parseRdpConnect({ ...options, username: "" })).toThrow();
  });
  it("accepts only a managed SOCKS5 identity", () => {
    const networking = { kind: "socks5", proxyId: "socks5-11111111-1111-4111-8111-111111111111" };
    expect(parseRdpProfile({ ...options, networking }).networking).toEqual(networking);
    for (const invalid of [null, {}, { ...networking, host: "other" }, { ...networking, password: "secret" }, { ...networking, proxyId: "http://proxy" }, { kind: "direct" }]) {
      expect(() => parseRdpConnect({ ...options, networking: invalid })).toThrow();
    }
  });
});
