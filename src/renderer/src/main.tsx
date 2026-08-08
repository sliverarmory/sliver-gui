import React from "react";
import ReactDOM from "react-dom/client";
import { Toast } from "@heroui/react";
import { config } from "@fortawesome/fontawesome-svg-core";
import "@fortawesome/fontawesome-svg-core/styles.css";
import "./styles.css";
import { App } from "./App";

config.autoAddCss = false;

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root element was not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
    <Toast.Provider placement="bottom end" maxVisibleToasts={4} />
  </React.StrictMode>,
);
