import { app, dialog } from "electron";

import { startApplication, type ApplicationHandle } from "./application.js";
import { scavengeStaleSliverConsoleRoots } from "./console-runtime.js";
import { rdpFilesFromArguments } from "./rdp-open-files.js";

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  let application: ApplicationHandle | undefined;
  const pending = new Set(rdpFilesFromArguments(process.argv.slice(1), process.cwd()));
  let importing = false;
  const flush = async (): Promise<void> => {
    if (!application || importing || !pending.size) return;
    importing = true;
    try {
      while (pending.size) {
        const files = [...pending].slice(0, 32);
        for (const file of files) pending.delete(file);
        try { await application.openRdpFiles(files); }
        catch { dialog.showErrorBox("RDP import failed", "The RDP files could not be imported. Open Remote Desktop and try Import .rdp again."); }
      }
    } finally { importing = false; }
  };
  const queue = (files: readonly string[]): void => {
    for (const file of files) { if (pending.size >= 32) break; pending.add(file); }
    void flush();
  };
  app.on("open-file", (event, path) => { event.preventDefault(); queue(rdpFilesFromArguments([path], process.cwd())); });
  app.on("second-instance", (_event, argv, cwd) => {
    const files = rdpFilesFromArguments(argv.slice(1), cwd);
    if (files.length) queue(files);
    else application?.createWindow();
  });
  void scavengeStaleSliverConsoleRoots()
    .then(() => startApplication())
    .then((startedApplication) => { application = startedApplication; void flush(); })
    .catch((error: unknown) => {
      console.error("Sliver GUI failed to start", error);
      app.exit(1);
    });
}
