// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseRdpFile, RDP_IMPORT_MAX_BYTES } from "./rdp-file-import.js";

const base = "full address:s:DESKTOP.example.test\r\nusername:s:alice\r\n";
const parse = (extra = "") => parseRdpFile(base + extra, "Office.rdp");

describe(".rdp profile import", () => {
  it("imports defaults without credentials, connections, or inferred NLA downgrades", () => {
    expect(parse()).toEqual({ profile: { label: "Office", host: "desktop.example.test", port: 3389, username: "alice", domain: "",
      width: 1280, height: 800, clipboard: false, scaleMode: "fit" }, warnings: [] });
    expect(parseRdpFile("full address:s:host", "Blank.rdp").profile.username).toBe("");
    expect(parse("prompt for credentials:i:0\nauthentication level:i:0").profile).not.toHaveProperty("signInMode");
  });
  it.each(["utf8", "utf8-bom", "utf16le-bom"])("decodes %s without losing Unicode identities", (encoding) => {
    const text = "full address:s:host\r\nusername:s:équipe日本語\r\ndomain:s:LAB";
    const bytes = encoding === "utf16le-bom" ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])
      : Buffer.from((encoding === "utf8-bom" ? "\uFEFF" : "") + text);
    expect(parseRdpFile(bytes, "C:\\Profiles\\Café.RDP").profile).toMatchObject({ label: "Café", username: "équipe日本語", domain: "LAB" });
  });
  it.each([
    ["host.test:3390", "host.test", 3390], ["127.0.0.1:3391", "127.0.0.1", 3391],
    ["[2001:DB8::1]:3392", "2001:db8::1", 3392], ["2001:db8::1234", "2001:db8::1234", 3389],
    ["[::1]", "::1", 3389], ["[::ffff:192.0.2.1]:3393", "::ffff:192.0.2.1", 3393],
  ])("parses endpoint %s", (address, host, port) => {
    expect(parseRdpFile(`full address:s:${address}`, "Desktop.rdp").profile).toMatchObject({ host, port });
  });
  it("handles separate ports without silently resolving conflicts", () => {
    expect(parse("server port:i:3390").profile.port).toBe(3390);
    expect(parseRdpFile("full address:s:[::1]:3390\nserver port:i:3390", "a.rdp").profile.port).toBe(3390);
    expect(() => parseRdpFile("full address:s:host:3390\nserver port:i:3391", "a.rdp")).toThrow(/conflicting server ports/u);
  });
  it.each(["https://host", "host/path", "host:0", "host:65536", "host:abc", "[host]:3389", "[::1]:0", "[::1", "fe80::1%en0", "-host", "user@host"])("rejects malformed endpoint %s", (address) => {
    expect(() => parseRdpFile(`full address:s:${address}`, "a.rdp")).toThrow();
  });
  it("splits qualified usernames, preserves UPNs, and rejects domain conflicts", () => {
    expect(parseRdpFile("full address:s:host\nusername:s:LAB\\alice", "a.rdp").profile).toMatchObject({ username: "alice", domain: "LAB" });
    expect(parseRdpFile("full address:s:host\nusername:s:LAB\\alice\ndomain:s:lab", "a.rdp").profile).toMatchObject({ username: "alice", domain: "lab" });
    expect(parseRdpFile("full address:s:host\nusername:s:alice@example.test", "a.rdp").profile).toMatchObject({ username: "alice@example.test", domain: "" });
    expect(() => parseRdpFile("full address:s:host\nusername:s:LAB\\alice\ndomain:s:OTHER", "a.rdp")).toThrow(/conflicting/u);
  });
  it("imports bounded display and clipboard settings", () => {
    expect(parse("desktopwidth:i:1920\ndesktopheight:i:1080\nredirectclipboard:i:1\nsmart sizing:i:0").profile)
      .toMatchObject({ width: 1920, height: 1080, clipboard: true, scaleMode: "actual" });
    expect(parse("desktop size id:i:2").profile).toMatchObject({ width: 1024, height: 768 });
    expect(parse("desktop size id:i:2\ndesktopwidth:i:1600").profile).toMatchObject({ width: 1600, height: 768 });
    expect(() => parse("desktopwidth:i:199")).toThrow(/out of range/u);
    expect(() => parse("desktopwidth:i:8192\ndesktopheight:i:8192")).toThrow(/pixel limit/u);
    expect(() => parse("redirectclipboard:i:2")).toThrow(/out of range/u);
  });
  it("maps only explicit CredSSP off to remote-screen sign-in and drops the identity", () => {
    const imported = parse("domain:s:LAB\nenablecredsspsupport:i:0");
    expect(imported.profile).toMatchObject({ signInMode: "remote-screen", username: "", domain: "" });
    expect(imported.warnings.join(" ")).toContain("disables NLA");
    expect(parse("enablecredsspsupport:i:1").profile).not.toHaveProperty("signInMode");
    expect(() => parse("enablecredsspsupport:s:0")).toThrow(/must be an integer/u);
  });
  it.each([
    ["gatewayhostname:s:gateway\ngatewayusagemethod:i:1", "Gateway"], ["gatewayusagemethod:i:2", "Gateway"],
    ["gatewayusagemethod:i:3", "Gateway"], ["gatewayhostname:s:gateway", "Gateway"],
    ["remoteapplicationmode:i:1", "RemoteApp"], ["remoteapplicationprogram:s:||app", "RemoteApp"],
    ["alternate shell:s:C:\\app.exe", "alternate remote shell"], ["loadbalanceinfo:s:tsv://broker", "routing"],
    ["pcb:s:virtual-machine-id", "routing"], ["use redirection server name:i:1", "redirection"],
    ["alternate full address:s:other-host", "alternate endpoint"], ["authentication level:i:1", "strict certificate"],
    ["negotiate security layer:i:0", "TLS"], ["enablerdsaadauth:i:1", "authentication"],
    ["restricted admin mode:i:1", "authentication"], ["disablecredentialsdelegation:i:1", "authentication"],
  ])("rejects unsupported required setting %s", (extra, message) => { expect(() => parse(extra)).toThrow(message); });
  it.each([0, 4])("permits explicitly disabled gateway mode %i without changing the endpoint", (mode) => {
    const imported = parse(`gatewayhostname:s:unused\ngatewayusagemethod:i:${mode}`);
    expect(imported.profile.host).toBe("desktop.example.test");
    expect(imported.warnings.join(" ")).toContain("connects directly");
  });
  it("never imports secrets, trusts, signatures, or unsupported redirection settings", () => {
    const secret = "SECRET_SENTINEL";
    const imported = parse(`password 51:b:${secret}\npassword:s:${secret}\nsignature:s:${secret}\nauthentication level:i:0\nredirectdrives:i:1`);
    expect(JSON.stringify(imported)).not.toContain(secret);
    expect(imported.profile).not.toHaveProperty("password");
    expect(imported.profile).not.toHaveProperty("persistence");
    expect(imported.warnings).toHaveLength(4);
    expect(imported.warnings.join(" ")).toContain("certificates will still be checked");
  });
  it("accepts case-insensitive names, whitespace, harmless duplicate settings and comments", () => {
    expect(parseRdpFile("# comment\n FULL ADDRESS:S: host \nfull address:s:host\n; comment", " a.rdp").profile.host).toBe("host");
    expect(() => parse("FULL ADDRESS:s:other")).toThrow(/conflicting duplicate/u);
  });
  it("rejects malformed or oversized input without reflecting values in errors", () => {
    for (const contents of ["full address:s:host\0", "not a property SECRET_SENTINEL", "full address:i:123", "", "\n".repeat(1025), "x".repeat(8193)]) {
      expect(() => parseRdpFile(contents, "a.rdp")).toThrow();
      try { parseRdpFile(contents, "a.rdp"); } catch (error) { expect(String(error)).not.toContain("SECRET_SENTINEL"); }
    }
    expect(() => parseRdpFile(Buffer.alloc(RDP_IMPORT_MAX_BYTES + 1), "a.rdp")).toThrow(/256 KiB/u);
    expect(() => parseRdpFile("x".repeat(RDP_IMPORT_MAX_BYTES + 1), "a.rdp")).toThrow(/256 KiB/u);
    for (const bytes of [Buffer.from([0xc0, 0xaf]), Buffer.from([0xff, 0xfe, 0x41]), Buffer.from([0xfe, 0xff, 0, 0x41]), Buffer.from(base, "utf16le")]) {
      expect(() => parseRdpFile(bytes, "a.rdp")).toThrow();
    }
    expect(() => parseRdpFile("\ud800", "a.rdp")).toThrow(/Unicode/u);
  });
  it("uses only a bounded file basename for labels", () => {
    expect(parseRdpFile(base, "/private/secrets/Office.rdp").profile.label).toBe("Office");
    expect(parseRdpFile(base, ".rdp").profile.label).toBe("Imported Remote Desktop");
    expect(parseRdpFile(base, `${"😀".repeat(100)}.rdp`).profile.label.length).toBe(120);
    expect(() => parseRdpFile(base, "profile.txt")).toThrow(/extension/u);
  });
});

it("preserves an explicit pre-authentication requirement by rejecting unsupported imports", () => {
  expect(() => parseRdpFile("full address:s:desktop.test\nrequire pre-authentication:i:1", "desktop.rdp")).toThrow(/unsupported authentication/);
  expect(parseRdpFile("full address:s:desktop.test\nrequire pre-authentication:i:0", "desktop.rdp").profile.host).toBe("desktop.test");
});
