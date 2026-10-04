import { app, BrowserWindow } from "electron";

// Record actual native calls before the application restores its saved icon.
// This fixture is excluded from production bundles and does not replace the APIs.
const state = globalThis as unknown as { iconPaths: string[] };
state.iconPaths = [];
app.once("ready", () => {
  if (process.platform === "darwin" && app.dock) {
    const original = app.dock.setIcon.bind(app.dock);
    app.dock.setIcon = (path) => {
      original(path);
      if (typeof path === "string") state.iconPaths.push(path);
    };
  } else {
    const original = BrowserWindow.prototype.setIcon;
    BrowserWindow.prototype.setIcon = function (path) {
      original.call(this, path);
      if (typeof path === "string") state.iconPaths.push(path);
    };
  }
});

await import("./fake-main.js");
