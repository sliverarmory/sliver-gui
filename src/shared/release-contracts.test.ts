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
