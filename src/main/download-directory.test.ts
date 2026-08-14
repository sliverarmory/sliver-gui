// @vitest-environment node

import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveDownloadsDirectory } from "./download-directory.js";

describe("download directory resolution", () => {
  it("preserves the OS-configured Downloads folder", () => {
    const getPath = vi.fn((name: "downloads" | "home") => {
      if (name === "downloads") return "D:\\Redirected Downloads";
      return "C:\\Users\\operator";
    });

    expect(resolveDownloadsDirectory(getPath)).toBe("D:\\Redirected Downloads");
    expect(getPath).toHaveBeenCalledOnce();
    expect(getPath).toHaveBeenCalledWith("downloads");
  });

  it("falls back to the conventional home Downloads folder", () => {
    const getPath = vi.fn((name: "downloads" | "home") => {
      if (name === "downloads") throw new Error("Known folder is unavailable");
      return "/isolated/home";
    });

    expect(resolveDownloadsDirectory(getPath)).toBe(join("/isolated/home", "Downloads"));
    expect(getPath.mock.calls).toEqual([["downloads"], ["home"]]);
  });
});
