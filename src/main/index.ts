import { app } from "electron";

import { startApplication, type ApplicationHandle } from "./application.js";

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  let application: ApplicationHandle | undefined;
  app.on("second-instance", () => application?.createWindow());
  void startApplication().then((startedApplication) => {
    application = startedApplication;
  });
}
