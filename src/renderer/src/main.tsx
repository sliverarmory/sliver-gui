import React from "react";
import ReactDOM from "react-dom/client";
import { Toast } from "@heroui/react";
import { config } from "@fortawesome/fontawesome-svg-core";
import "@fortawesome/fontawesome-svg-core/styles.css";
import "./styles.css";
import { App } from "./App";
import { InteractionWindowApp } from "./InteractionWindowApp";
import { SessionShellWindowApp } from "./SessionShellWindowApp";
import { ConsoleWindowApp } from "./ConsoleWindowApp";
import { CloudDeploymentWindowApp } from "./CloudDeploymentWindowApp";
import { SshWindowApp } from "./SshWindowApp";
import { ReleaseDownloadToasts } from "./components/ReleaseDownloadToasts";
import { ApplicationUpdateStatus } from "./components/ApplicationUpdateStatus";
import {
  ApplicationSettingsProvider,
  initializeRendererTheme,
} from "./components/ApplicationSettingsProvider";

config.autoAddCss = false;
initializeRendererTheme();

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root element was not found");

const surface = new URLSearchParams(window.location.search).get("surface");

function RendererSurface(): React.JSX.Element {
  if (surface === "console") return <ConsoleWindowApp />;
  if (surface === "managed-shells") return <SessionShellWindowApp />;
  if (surface === "interaction") return <InteractionWindowApp />;
  if (surface === "ssh") return <SshWindowApp />;
  return <App />;
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {surface === "cloud-deployment" ? (
      <CloudDeploymentWindowApp />
    ) : surface === "ssh" ? (
      window.ssh ? (
        <ApplicationSettingsProvider api={window.ssh}>
          <RendererSurface />
        </ApplicationSettingsProvider>
      ) : <RendererSurface />
    ) : (
      <ApplicationSettingsProvider>
        <RendererSurface />
        <ApplicationUpdateStatus showIdleControl={surface === null} />
        <ReleaseDownloadToasts />
      </ApplicationSettingsProvider>
    )}
    <Toast.Provider placement="bottom" maxVisibleToasts={4} />
  </React.StrictMode>,
);
