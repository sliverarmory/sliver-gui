import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ApplicationIconController } from "./application-icon.js";

const assetsDirectory = "/app-icons";
const icon = (name: string): string => join(assetsDirectory, name);
const windowIcon = () => ({ isDestroyed: vi.fn(() => false), setIcon: vi.fn() });

describe("application icon selection", () => {
  it("follows system appearance in Auto and keeps explicit icons through system changes", () => {
    const setDockIcon = vi.fn();
    const controller = new ApplicationIconController({ platform: "darwin", assetsDirectory, setDockIcon });
    controller.update("auto", true);
    expect(setDockIcon).toHaveBeenLastCalledWith(icon("icon1a-dark.png"));
    controller.update("auto", false);
    expect(setDockIcon).toHaveBeenLastCalledWith(icon("icon1a-light.png"));
    controller.update("passion", false);
    controller.update("passion", true);
    expect(setDockIcon).toHaveBeenCalledTimes(3);
    expect(setDockIcon).toHaveBeenLastCalledWith(icon("passion.png"));
    controller.update("light", true);
    expect(controller.getIconPath()).toBe(icon("icon1a-light.png"));
    controller.update("dark", false);
    expect(controller.getIconPath()).toBe(icon("icon1a-dark.png"));
    controller.update("auto", false);
    expect(controller.getIconPath()).toBe(icon("icon1a-light.png"));
  });

  it.each(["win32", "linux"] as const)("updates existing and newly opened %s windows", (platform) => {
    const controller = new ApplicationIconController({ platform, assetsDirectory });
    const first = windowIcon();
    const second = windowIcon();
    controller.update("auto", false);
    controller.applyToWindow(first);
    controller.applyToWindow(first);
    expect(first.setIcon).toHaveBeenCalledExactlyOnceWith(icon("icon1a-light.png"));
    controller.update("passion", true);
    controller.applyToWindow(first);
    controller.applyToWindow(second);
    expect(first.setIcon).toHaveBeenLastCalledWith(icon("passion.png"));
    expect(second.setIcon).toHaveBeenCalledExactlyOnceWith(icon("passion.png"));
    second.isDestroyed.mockReturnValue(true);
    controller.update("dark", false);
    controller.applyToWindow(second);
    expect(second.setIcon).toHaveBeenCalledTimes(1);
  });

  it("retains dark branding on unsupported platforms", () => {
    const controller = new ApplicationIconController({ platform: "freebsd", assetsDirectory });
    const window = windowIcon();
    for (const preference of ["auto", "light", "dark", "passion"] as const) {
      controller.update(preference, false);
      expect(controller.getIconPath()).toBe(icon("icon1a-dark.png"));
      controller.applyToWindow(window);
    }
    expect(window.setIcon).not.toHaveBeenCalled();
  });

  it("restores the dark fallback if a native icon swap fails", () => {
    const controller = new ApplicationIconController({ platform: "win32", assetsDirectory });
    const window = windowIcon();
    window.setIcon.mockImplementation((path: string) => {
      if (path.endsWith("passion.png")) throw new Error("Icon rejected");
    });
    controller.update("passion", false);
    controller.applyToWindow(window);
    expect(window.setIcon.mock.calls.map(([path]) => path)).toEqual([
      icon("passion.png"), icon("icon1a-dark.png"),
    ]);
    window.setIcon.mockImplementation(() => { throw new Error("Surface unavailable"); });
    expect(() => controller.applyToWindow(window)).not.toThrow();
  });

  it("restores the Dock fallback if a native icon swap fails", () => {
    const setDockIcon = vi.fn((path: string) => {
      if (path.endsWith("passion.png")) throw new Error("Icon rejected");
    });
    const controller = new ApplicationIconController({ platform: "darwin", assetsDirectory, setDockIcon });
    controller.update("passion", true);
    expect(setDockIcon).toHaveBeenLastCalledWith(icon("icon1a-dark.png"));
  });
});
