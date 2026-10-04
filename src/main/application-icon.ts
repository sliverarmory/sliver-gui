import { join } from "node:path";

import type { ApplicationIcon, ResolvedApplicationIcon } from "../shared/application-settings-contracts.js";

export const APPLICATION_ICON_FILES = Object.freeze({
  light: "icon1a-light.png",
  dark: "icon1a-dark.png",
  passion: "passion.png",
});

interface IconWindow {
  isDestroyed(): boolean;
  setIcon(path: string): void;
}

/** Runtime icons never mutate the installed bundle or its signed fallback icon. */
export class ApplicationIconController {
  readonly #platform: NodeJS.Platform;
  readonly #assetsDirectory: string;
  readonly #setDockIcon: ((path: string) => void) | undefined;
  readonly #windowIcons = new WeakMap<IconWindow, string>();
  #iconPath: string;
  #resolvedIcon: ResolvedApplicationIcon = "dark";
  #dockIconPath: string | undefined;

  constructor(options: {
    platform: NodeJS.Platform;
    assetsDirectory: string;
    setDockIcon?: (path: string) => void;
  }) {
    this.#platform = options.platform;
    this.#assetsDirectory = options.assetsDirectory;
    this.#setDockIcon = options.setDockIcon;
    this.#iconPath = this.#darkIconPath();
  }

  getIconPath(): string {
    return this.#iconPath;
  }

  getResolvedIcon(): ResolvedApplicationIcon {
    return this.#resolvedIcon;
  }

  update(preference: ApplicationIcon, systemDark: boolean): void {
    const supportsIcons = ["darwin", "win32", "linux"].includes(this.#platform);
    const variant = supportsIcons
      ? preference === "auto" ? systemDark ? "dark" : "light" : preference
      : "dark";
    this.#resolvedIcon = variant;
    this.#iconPath = join(this.#assetsDirectory, APPLICATION_ICON_FILES[variant]);
    if (this.#platform === "darwin" && this.#setDockIcon && this.#dockIconPath !== this.#iconPath) {
      this.#dockIconPath = this.#apply(this.#setDockIcon);
    }
  }

  applyToWindow(window: IconWindow): void {
    if (
      !["win32", "linux"].includes(this.#platform) ||
      window.isDestroyed() ||
      this.#windowIcons.get(window) === this.#iconPath
    ) return;
    const applied = this.#apply((path) => window.setIcon(path));
    if (applied) this.#windowIcons.set(window, applied);
  }

  #darkIconPath(): string {
    return join(this.#assetsDirectory, APPLICATION_ICON_FILES.dark);
  }

  #apply(setIcon: (path: string) => void): string | undefined {
    try {
      setIcon(this.#iconPath);
      return this.#iconPath;
    } catch {
      // Unsupported native surfaces retain the packaged dark icon. If a
      // previously swapped surface rejects an asset, also try restoring dark.
      try {
        const fallback = this.#darkIconPath();
        setIcon(fallback);
        return fallback;
      } catch {
        return undefined;
      }
    }
  }
}
