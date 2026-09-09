import { ArmoryWindowApp } from "./ArmoryWindowApp";
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
import { NetworkWindowApp } from "./NetworkWindowApp";
import { ReleaseDownloadToasts } from "./components/ReleaseDownloadToasts";
import { ApplicationUpdateStatus } from "./components/ApplicationUpdateStatus";
import { ApplicationContextMenu } from "./components/ApplicationContextMenu";
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

function ApplicationRoot(): React.JSX.Element {
  if (surface === "armory") {
    return window.armory ? (
      <ApplicationSettingsProvider api={window.armory}>
        <ArmoryWindowApp />
      </ApplicationSettingsProvider>
    ) : <ArmoryWindowApp />;
  }
  if (surface === "network") {
    return window.network ? (
      <ApplicationSettingsProvider api={window.network}>
        <NetworkWindowApp />
      </ApplicationSettingsProvider>
    ) : <NetworkWindowApp />;
  }
  return (
    <ApplicationContextMenu>
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
    </ApplicationContextMenu>
  );
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ApplicationRoot />
    <Toast.Provider placement="bottom" maxVisibleToasts={4} />
  </React.StrictMode>,
);
