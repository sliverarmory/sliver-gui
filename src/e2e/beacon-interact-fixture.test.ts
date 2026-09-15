import { describe, expect, it } from "vitest";
import { sliverpb } from "sliver-script";

import {
  FAKE_BEACON_TASK_DESCRIPTIONS,
  FAKE_BEACON_WORKSPACE_PATH,
  fakeBeaconIfconfigTaskResult,
  fakeBeaconLsTaskResult,
  fakeBeaconPsTaskResult,
  fakeBeaconPwdTaskResult,
} from "./beacon-interact-fixture.js";

describe("Beacon Interact deterministic task fixtures", () => {
  it("encodes a completed pwd result", () => {
    const fixture = fakeBeaconPwdTaskResult();
    const result = sliverpb.Pwd.decode(fixture.result);

    expect(fixture.description).toBe(FAKE_BEACON_TASK_DESCRIPTIONS.pwd);
    expect(result.Path).toBe(FAKE_BEACON_WORKSPACE_PATH);
    expect(result.Response).toBeUndefined();
  });

  it("encodes a requested ls path with file, directory, and link metadata", () => {
    const fixture = fakeBeaconLsTaskResult(FAKE_BEACON_WORKSPACE_PATH);
    const result = sliverpb.Ls.decode(fixture.result);

    expect(fixture.description).toBe(FAKE_BEACON_TASK_DESCRIPTIONS.ls);
    expect(result).toMatchObject({
      Path: FAKE_BEACON_WORKSPACE_PATH,
      Exists: true,
      timezone: "America/Los_Angeles",
      timezoneOffset: -420,
    });
    expect(result.Files).toEqual(expect.arrayContaining([
      expect.objectContaining({ Name: "notes.txt", IsDir: false, Mode: "-rw-r--r--" }),
      expect.objectContaining({ Name: "projects", IsDir: true, Mode: "drwxr-xr-x" }),
      expect.objectContaining({ Name: "latest-notes", Link: "notes.txt" }),
    ]));
  });

  it("resolves the UI's default dot path against the fake working directory", () => {
    const result = sliverpb.Ls.decode(fakeBeaconLsTaskResult(".").result);

    expect(result.Path).toBe(FAKE_BEACON_WORKSPACE_PATH);
    expect(result.Exists).toBe(true);
    expect(result.Files.map((file) => file.Name)).toEqual(["notes.txt", "projects", "latest-notes"]);
  });

  it("encodes process rows with parentage, owners, architectures, and arguments", () => {
    const fixture = fakeBeaconPsTaskResult(true);
    const result = sliverpb.Ps.decode(fixture.result);

    expect(fixture.description).toBe(FAKE_BEACON_TASK_DESCRIPTIONS.ps);
    expect(result.Processes).toEqual(expect.arrayContaining([
      expect.objectContaining({ Pid: 1, Ppid: 0, Executable: "launchd", Owner: "root" }),
      expect.objectContaining({
        Pid: 41002,
        Executable: "m1-beacon",
        Architecture: "arm64",
        CmdLine: ["/private/tmp/m1-beacon", "--transport", "https"],
      }),
      expect.objectContaining({ Executable: "python3", Owner: "analyst", Architecture: "x86_64" }),
    ]));
  });

  it("honors the process full-info option", () => {
    const result = sliverpb.Ps.decode(fakeBeaconPsTaskResult(false).result);

    expect(result.Processes).toHaveLength(4);
    expect(result.Processes[1]).toMatchObject({
      Pid: 41002,
      Ppid: 1,
      Executable: "m1-beacon",
      Owner: "",
      Architecture: "",
      CmdLine: [],
    });
  });

  it("encodes loopback, physical, and tunnel interfaces with IPv4 and IPv6", () => {
    const fixture = fakeBeaconIfconfigTaskResult();
    const result = sliverpb.Ifconfig.decode(fixture.result);

    expect(fixture.description).toBe(FAKE_BEACON_TASK_DESCRIPTIONS.ifconfig);
    expect(result.NetInterfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ Name: "lo0", IPAddresses: ["127.0.0.1/8", "::1/128"] }),
      expect.objectContaining({
        Name: "en0",
        MAC: "02:00:00:00:00:07",
        IPAddresses: ["192.0.2.25/24", "2001:db8:7::25/64"],
      }),
      expect.objectContaining({ Name: "utun3", IPAddresses: ["10.13.37.25/32", "fd00:1337::25/128"] }),
    ]));
  });
});
