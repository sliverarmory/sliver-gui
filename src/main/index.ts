import { app } from "electron";

import { startApplication, type ApplicationHandle } from "./application.js";
import { scavengeStaleSliverConsoleRoots } from "./console-runtime.js";

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  let application: ApplicationHandle | undefined;
  app.on("second-instance", () => application?.createWindow());
  void scavengeStaleSliverConsoleRoots()
    .then(() => startApplication())
    .then((startedApplication) => {
      application = startedApplication;
    })
    .catch((error: unknown) => {
      console.error("Sliver GUI failed to start", error);
      app.exit(1);
    });
}
