import { describe, expect, it } from "vitest";
import { validateRdpConnectForm, type RdpConnectFormValues } from "./rdp-connect-form";

const valid: RdpConnectFormValues = {
  label: "", host: "desktop.test", port: "3389", username: "operator", domain: "",
  password: "password", width: "1280", height: "800",
};

describe("RDP form field validation", () => {
  it("validates manual proxy endpoints and requires authentication only on Connect", () => {
    const proxy = { ...valid, manualProxy: true, proxyHost: "proxy.test", proxyPort: "1080", proxyUsername: "", proxyPassword: "" };
    expect(validateRdpConnectForm(proxy, true)).toEqual({});
    expect(validateRdpConnectForm({ ...proxy, proxyHost: "socks5://proxy.test", proxyPort: "0" }, true))
      .toMatchObject({ proxyHost: expect.any(String), proxyPort: expect.any(String) });
    expect(validateRdpConnectForm({ ...proxy, proxyUsername: "proxy-user" }, true)).toHaveProperty("proxyPassword");
    expect(validateRdpConnectForm({ ...proxy, proxyUsername: "proxy-user" }, false, false)).toEqual({});
    expect(validateRdpConnectForm({ ...proxy, proxyUsername: "proxy-user", signInMode: "remote-screen" }, true)).toHaveProperty("proxyPassword");
    expect(validateRdpConnectForm({ ...proxy, manualProxy: false, proxyHost: "invalid/path" }, true)).toEqual({});
  });

  it("enforces proxy credential limits in UTF-8 bytes without silently truncating", () => {
    const proxy = { ...valid, manualProxy: true, proxyHost: "::1", proxyPort: "1080", proxyUsername: "é".repeat(127) + "a", proxyPassword: "é".repeat(127) + "a" };
    expect(validateRdpConnectForm(proxy, true)).toEqual({});
    expect(validateRdpConnectForm({ ...proxy, proxyUsername: "é".repeat(128), proxyPassword: "é".repeat(128) }, true))
      .toMatchObject({ proxyUsername: expect.any(String), proxyPassword: expect.any(String) });
    expect(validateRdpConnectForm({ ...proxy, proxyUsername: "user\u0000", proxyPassword: "pass\u0000" }, true))
      .toMatchObject({ proxyUsername: expect.any(String), proxyPassword: expect.any(String) });
  });

  it("requires credentials by default but validates only the endpoint and display for remote-screen sign-in", () => {
    const emptyAccount = { ...valid, username: "", domain: "", password: "" };
    expect(validateRdpConnectForm(emptyAccount, true)).toMatchObject({ username: expect.any(String), password: expect.any(String) });
    expect(validateRdpConnectForm({ ...emptyAccount, signInMode: "nla" }, true)).toHaveProperty("username");
    expect(validateRdpConnectForm({ ...emptyAccount, signInMode: "remote-screen" }, true)).toEqual({});
    expect(validateRdpConnectForm({ ...emptyAccount, signInMode: "remote-screen", host: "https://invalid", height: "0" }, true))
      .toMatchObject({ host: expect.any(String), height: expect.any(String) });
  });

  it.each(["CASTLEBLACK", "desktop.test.", "lab_pc.test", "10.13.37.22", "::1", "2001:db8::2", "::ffff:192.0.2.1"])(
    "accepts a hostname or bare IP address: %s", (host) => {
      expect(validateRdpConnectForm({ ...valid, host }, true)).toEqual({});
    },
  );

  it.each(["desktop.test:3389", "192.0.2.1:3389", "999.1.2.3", "1.2.3", "desktop..test", "-desktop", "desktop-", "[::1]", "fe80::1%en0", "not:ipv6", "https://desktop.test"])(
    "rejects an invalid or decorated address: %s", (host) => {
      expect(validateRdpConnectForm({ ...valid, host }, true)).toHaveProperty("host");
    },
  );

  it.each([
    { label: "x".repeat(121) }, { label: "name\u007f" }, { username: "x".repeat(257) },
    { username: "user\u0000name" }, { domain: "x".repeat(257) }, { domain: "LAB\t" },
    { password: "x".repeat(4097) }, { password: "pass\u0000word" },
    { port: "1e3" }, { port: "0xD3D" }, { port: "3389.0" }, { port: "0" },
    { width: "2e3" }, { height: "" },
  ])("rejects invalid field syntax and text limits %#", (invalid) => {
    expect(Object.keys(validateRdpConnectForm({ ...valid, ...invalid }, true))).toEqual(Object.keys(invalid));
  });

  it("accepts the exact desktop pixel limit and rejects one extra row", () => {
    expect(validateRdpConnectForm({ ...valid, width: "8192", height: "2048" }, true)).toEqual({});
    expect(validateRdpConnectForm({ ...valid, width: "8192", height: "2049" }, true)).toHaveProperty("height");
  });
});
