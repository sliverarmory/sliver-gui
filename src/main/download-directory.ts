import { join } from "node:path";

export type ApplicationPathResolver = (name: "downloads" | "home") => string;

/**
 * Prefer the OS-configured Downloads folder, including redirected or localized
 * locations. Some Windows profiles do not expose that known folder; falling
 * back to the conventional home directory keeps startup and downloads usable.
 */
export function resolveDownloadsDirectory(getPath: ApplicationPathResolver): string {
  try {
    return getPath("downloads");
  } catch {
    return join(getPath("home"), "Downloads");
  }
}
