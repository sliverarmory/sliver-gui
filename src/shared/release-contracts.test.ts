import { describe, expect, it } from "vitest";

import { parseSliverReleaseDownloadEvent } from "./release-contracts.js";

const downloadId = "8e577480-5dc2-4dde-aa58-23c8f1770627";

describe("Sliver release download events", () => {
  it("accepts exact lifecycle events", () => {
    expect(parseSliverReleaseDownloadEvent({
      status: "started",
      downloadId,
      artifact: "server",
      os: "linux",
      arch: "amd64",
    })).toEqual({
      status: "started",
      downloadId,
      artifact: "server",
      os: "linux",
      arch: "amd64",
    });
    expect(parseSliverReleaseDownloadEvent({
      status: "completed",
      downloadId,
      artifact: "client",
      os: "macos",
      arch: "arm64",
      version: "v1.7.3",
      fileName: "sliver-client_macos-arm64",
      receivedBytes: 128,
      totalBytes: 128,
    })).toEqual(expect.objectContaining({ status: "completed", receivedBytes: 128 }));
  });

  it("accepts exact Crackstation download events", () => {
    expect(parseSliverReleaseDownloadEvent({
      status: "started",
      downloadId,
      artifact: "crackstation",
      os: "darwin",
      arch: "arm64",
    })).toEqual({
      status: "started",
      downloadId,
      artifact: "crackstation",
      os: "darwin",
      arch: "arm64",
    });
    expect(parseSliverReleaseDownloadEvent({
      status: "completed",
      downloadId,
      artifact: "crackstation",
      os: "windows",
      arch: "amd64",
      version: "v0.0.4",
      fileName: "sliver-crackstation_windows-amd64.exe",
      receivedBytes: 256,
      totalBytes: 256,
    })).toEqual(expect.objectContaining({
      status: "completed",
      artifact: "crackstation",
      fileName: "sliver-crackstation_windows-amd64.exe",
      receivedBytes: 256,
    }));
  });

  it.each([
    { status: "started", downloadId: "not-a-uuid", artifact: "server", os: "linux", arch: "amd64" },
    { status: "started", downloadId, artifact: "implant", os: "linux", arch: "amd64" },
    { status: "started", downloadId, artifact: "server", os: "../linux", arch: "amd64" },
    { status: "failed", downloadId, artifact: "server", os: "linux", arch: "amd64", error: "" },
    {
      status: "progress",
      downloadId,
      artifact: "server",
      os: "linux",
      arch: "amd64",
      version: "v1.7.3",
      fileName: "../server",
      receivedBytes: 2,
      totalBytes: 1,
    },
    {
      status: "completed",
      downloadId,
      artifact: "server",
      os: "linux",
      arch: "amd64",
      version: "v1.7.3",
      fileName: "sliver-server_linux-amd64",
      receivedBytes: 1,
      totalBytes: 2,
    },
  ])("rejects malformed or over-broad events", (event) => {
    expect(() => parseSliverReleaseDownloadEvent(event)).toThrow(/Invalid Sliver release/);
  });
});
