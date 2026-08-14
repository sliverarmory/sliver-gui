import React from "react";
import ReactDOM from "react-dom/client";
import { Toast } from "@heroui/react";
import { config } from "@fortawesome/fontawesome-svg-core";
import "@fortawesome/fontawesome-svg-core/styles.css";
import "./styles.css";
import { App } from "./App";
import { SessionShellWindowApp } from "./SessionShellWindowApp";
import { ReleaseDownloadToasts } from "./components/ReleaseDownloadToasts";

config.autoAddCss = false;

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root element was not found");

const isManagedShellWindow = new URLSearchParams(window.location.search).get("surface") === "managed-shells";

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {isManagedShellWindow ? <SessionShellWindowApp /> : <App />}
    <ReleaseDownloadToasts />
    <Toast.Provider placement="bottom" maxVisibleToasts={4} />
  </React.StrictMode>,
);
