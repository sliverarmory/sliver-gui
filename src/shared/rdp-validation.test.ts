import { describe, expect, it } from "vitest";
import { parseRdpConnect, parseRdpOptions, parseRdpProfile } from "./rdp-validation.js";

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
