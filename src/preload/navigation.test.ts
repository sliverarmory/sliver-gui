// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("session navigation preload", () => {
  it("cancels foreign destinations before native navigation while preserving app routes", async () => {
    vi.resetModules();
    const addEventListener = vi.fn();
    vi.stubGlobal("location", { protocol: "sliver:" });
    vi.stubGlobal("navigation", { addEventListener });
    await import("./navigation.js");
    expect(addEventListener).toHaveBeenCalledOnce();
    expect(addEventListener.mock.calls[0]?.[0]).toBe("navigate");
    const navigate = addEventListener.mock.calls[0]?.[1];
    for (const url of [
      "about:blank", "about:blank#fragment", "about:srcdoc",
      "data:text/html,benign", "blob:sliver://app/fixture",
      "https://example.test/", "http://127.0.0.1:5173/", "file:///tmp/index.html",
      "sliver://other/index.html", "sliver://app.example.test/index.html",
      "sliver://app:123/index.html", "sliver://user@app/index.html",
      "sliver://:password@app/index.html", "sliver://app/other.html",
      "devtools://devtools/bundled/inspector.html", "not a URL",
    ]) {
      const event = { destination: { url }, preventDefault: vi.fn() };
      navigate(event);
      expect(event.preventDefault, url).toHaveBeenCalledOnce();
    }
    for (const url of [
      "sliver://app/index.html",
      "sliver://app/index.html?surface=network",
      "sliver://app/index.html?surface=cloud-deployment#settings",
    ]) {
      const event = { destination: { url }, preventDefault: vi.fn() };
      navigate(event);
      expect(event.preventDefault, url).not.toHaveBeenCalled();
    }
  });

  it("leaves Electron's native DevTools frontend to the main-process policy", async () => {
    vi.resetModules();
    const addEventListener = vi.fn();
    vi.stubGlobal("location", { protocol: "devtools:" });
    vi.stubGlobal("navigation", { addEventListener });
    await import("./navigation.js");
    expect(addEventListener).not.toHaveBeenCalled();
  });
});
