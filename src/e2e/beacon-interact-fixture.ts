import { gzipSync } from "node:zlib";

import { sliverpb } from "sliver-script";

export const FAKE_BEACON_WORKSPACE_PATH = "/Users/e2e/workspace";

export const FAKE_BEACON_TASK_DESCRIPTIONS = {
  download: "DownloadReq",
  env: "EnvReq",
  grep: "GrepReq",
  ifconfig: "IfconfigReq",
  ls: "LsReq",
  memfiles: "MemfilesListReq",
  mount: "MountReq",
  netstat: "NetstatReq",
  ps: "PsReq",
  pwd: "PwdReq",
  whoami: "CurrentTokenOwnerReq",
} as const;

export interface FakeBeaconTaskResult {
  description: string;
  result: Buffer;
}

export function fakeBeaconPwdTaskResult(): FakeBeaconTaskResult {
  return {
    description: FAKE_BEACON_TASK_DESCRIPTIONS.pwd,
    result: encode(sliverpb.Pwd, sliverpb.Pwd.create({
      Path: FAKE_BEACON_WORKSPACE_PATH,
    })),
  };
}

export function fakeBeaconLsTaskResult(requestedPath: string): FakeBeaconTaskResult {
  const normalizedPath = requestedPath.trim();
  const path = normalizedPath === "" || normalizedPath === "."
    ? FAKE_BEACON_WORKSPACE_PATH
    : normalizedPath;
  const files = path === FAKE_BEACON_WORKSPACE_PATH
    ? [
        file("notes.txt", false, "72", "-rw-r--r--"),
        file("projects", true, "0", "drwxr-xr-x"),
        file("latest-notes", false, "9", "Lrwxr-xr-x", "notes.txt"),
      ]
    : path === `${FAKE_BEACON_WORKSPACE_PATH}/projects`
      ? [
          file("readme.md", false, "29", "-rw-r--r--"),
          file("src", true, "0", "drwxr-x---"),
        ]
      : [];

  return {
    description: FAKE_BEACON_TASK_DESCRIPTIONS.ls,
    result: encode(sliverpb.Ls, sliverpb.Ls.create({
      Path: path,
      Exists: files.length > 0,
      Files: files,
      timezone: "America/Los_Angeles",
      timezoneOffset: -420,
    })),
  };
}

export function fakeBeaconPsTaskResult(fullInfo: boolean): FakeBeaconTaskResult {
  const processes = [
    process(1, 0, "launchd", "root", "arm64", ["/sbin/launchd"]),
    process(41002, 1, "m1-beacon", "e2e-user", "arm64", [
      "/private/tmp/m1-beacon",
      "--transport",
      "https",
    ]),
    process(41012, 41002, "zsh", "e2e-user", "arm64", ["/bin/zsh", "-l"]),
    process(41031, 41002, "python3", "analyst", "x86_64", [
      "/usr/bin/python3",
      "worker.py",
      "--queue",
      "triage",
    ]),
  ];
  return {
    description: FAKE_BEACON_TASK_DESCRIPTIONS.ps,
    result: encode(sliverpb.Ps, sliverpb.Ps.create({
      Processes: fullInfo
        ? processes
        : processes.map(({ Pid, Ppid, Executable }) => ({ Pid, Ppid, Executable })),
    })),
  };
}

export function fakeBeaconIfconfigTaskResult(): FakeBeaconTaskResult {
  return {
    description: FAKE_BEACON_TASK_DESCRIPTIONS.ifconfig,
    result: encode(sliverpb.Ifconfig, sliverpb.Ifconfig.create({
      NetInterfaces: [{
        Index: 1,
        Name: "lo0",
        MAC: "00:00:00:00:00:00",
        IPAddresses: ["127.0.0.1/8", "::1/128"],
      }, {
        Index: 7,
        Name: "en0",
        MAC: "02:00:00:00:00:07",
        IPAddresses: ["192.0.2.25/24", "2001:db8:7::25/64"],
      }, {
        Index: 12,
        Name: "utun3",
        MAC: "",
        IPAddresses: ["10.13.37.25/32", "fd00:1337::25/128"],
      }],
    })),
  };
}

export function fakeBeaconEnvTaskResult(name = ""): FakeBeaconTaskResult {
  return {
    description: FAKE_BEACON_TASK_DESCRIPTIONS.env,
    result: encode(sliverpb.EnvInfo, sliverpb.EnvInfo.create({
      Variables: name === "" || name === "BC05_VISIBLE"
        ? [{ Key: "BC05_VISIBLE", Value: "fixture-value" }]
        : [],
    })),
  };
}

export function fakeBeaconWhoamiTaskResult(): FakeBeaconTaskResult {
  return {
    description: FAKE_BEACON_TASK_DESCRIPTIONS.whoami,
    result: encode(sliverpb.CurrentTokenOwner, sliverpb.CurrentTokenOwner.create({
      Output: "fixture-token-owner",
    })),
  };
}

export function fakeBeaconNetstatTaskResult(): FakeBeaconTaskResult {
  return {
    description: FAKE_BEACON_TASK_DESCRIPTIONS.netstat,
    result: encode(sliverpb.Netstat, sliverpb.Netstat.create({
      Entries: [{
        LocalAddr: { Ip: "192.0.2.25", Port: 41001 },
        RemoteAddr: { Ip: "198.51.100.8", Port: 31337 },
        SkState: "ESTABLISHED",
        UID: 501,
        Protocol: "tcp4",
      }],
    })),
  };
}

export function fakeBeaconMountTaskResult(): FakeBeaconTaskResult {
  return {
    description: FAKE_BEACON_TASK_DESCRIPTIONS.mount,
    result: encode(sliverpb.Mount, sliverpb.Mount.create({
      Info: [{
        VolumeName: "disk3s1",
        VolumeType: "apfs",
        MountPoint: "/",
        Label: "Fixture volume",
        FileSystem: "apfs",
        UsedSpace: "1048576",
        FreeSpace: "2097152",
        TotalSpace: "3145728",
        MountOptions: "rw",
      }],
    })),
  };
}

export function fakeBeaconMemfilesTaskResult(): FakeBeaconTaskResult {
  return {
    description: FAKE_BEACON_TASK_DESCRIPTIONS.memfiles,
    result: encode(sliverpb.Ls, sliverpb.Ls.create({
      Path: "/proc/self/fd",
      Exists: true,
      Files: [file("73", false, "4096", "-rw-------", "m2-memory-cache.bin")],
    })),
  };
}

export function fakeBeaconTextTaskResult(path: string, text: string): FakeBeaconTaskResult {
  const content = Buffer.from(text, "utf8");
  return {
    description: FAKE_BEACON_TASK_DESCRIPTIONS.download,
    result: encode(sliverpb.Download, sliverpb.Download.create({
      Path: path,
      Exists: true,
      IsDir: false,
      Encoder: "gzip",
      Data: gzipSync(content),
      ReadFiles: 1,
    })),
  };
}

export function fakeBeaconGrepTaskResult(path: string, pattern: string): FakeBeaconTaskResult {
  return {
    description: FAKE_BEACON_TASK_DESCRIPTIONS.grep,
    result: encode(sliverpb.Grep, sliverpb.Grep.create({
      SearchPathAbsolute: path,
      Results: {
        [`${path}/notes.txt`]: {
          IsBinary: false,
          FileResults: [{
            LineNumber: "2",
            Positions: [{ Start: 0, End: pattern.length }],
            Line: `${pattern} appears in fixture text`,
            LinesBefore: ["context before"],
            LinesAfter: ["context after"],
          }],
        },
      },
    })),
  };
}

function file(name: string, isDirectory: boolean, size: string, mode: string, link = "") {
  return {
    Name: name,
    IsDir: isDirectory,
    Size: size,
    ModTime: "1786305600",
    Mode: mode,
    Link: link,
    Uid: "501",
    Gid: "20",
  };
}

function process(
  pid: number,
  parentPid: number,
  executable: string,
  owner: string,
  architecture: string,
  commandLine: string[],
) {
  return {
    Pid: pid,
    Ppid: parentPid,
    Executable: executable,
    Owner: owner,
    Architecture: architecture,
    SessionID: 1,
    CmdLine: commandLine,
  };
}

function encode<T>(codec: { encode(message: T): { finish(): Uint8Array } }, message: T): Buffer {
  return Buffer.from(codec.encode(message).finish());
}
