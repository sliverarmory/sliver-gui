import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { BrowserWindow } from "electron";

export interface ReportScreenshotResult {
  directory: string;
  windowCount: number;
  savedPaths: string[];
  failures: Array<{ windowId: number; message: string }>;
}

/** Captures each live application window and saves one private PNG per window. */
export async function captureReportScreenshots(directory: string): Promise<ReportScreenshotResult> {
  if (!isAbsolute(directory)) throw new Error("Screenshot destination must be an absolute directory");

  // Resolve the configured directory once. No screenshot may replace an existing
  // file, and writing must not change the chosen directory's permissions.
  const destination = await realpath(directory);
  const destinationStats = await lstat(destination);
  if (!destinationStats.isDirectory()) throw new Error("Screenshot destination must be a directory");

  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
  if (windows.length === 0) throw new Error("No open application windows are available to capture");

  const prefix = `sliver-report-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const savedPaths: string[] = [];
  const failures: ReportScreenshotResult["failures"] = [];

  for (const [index, window] of windows.entries()) {
    let png: Buffer | undefined;
    try {
      if (window.isDestroyed() || window.webContents.isDestroyed()) {
        throw new Error("Window closed before capture");
      }
      const image = await window.webContents.capturePage();
      if (image.isEmpty()) throw new Error("Window capture was empty");
      png = image.toPNG();
      if (png.length === 0) throw new Error("Window PNG was empty");

      const path = join(destination, `${prefix}-window-${index + 1}.png`);
      await writePrivateScreenshotExclusive(path, png);
      savedPaths.push(path);
    } catch (error) {
      failures.push({
        windowId: window.id,
        message: error instanceof Error ? error.message : "Window capture failed",
      });
    } finally {
      png?.fill(0);
    }
  }

  return { directory: destination, windowCount: windows.length, savedPaths, failures };
}

/** Creates the final file exclusively without depending on hard-link support. */
async function writePrivateScreenshotExclusive(path: string, data: Buffer): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    created = true;
    await handle.writeFile(data);
    await handle.sync();
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await unlink(path).catch(() => undefined);
    throw error;
  }
}
