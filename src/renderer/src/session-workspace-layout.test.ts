/// <reference types="node" />
// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const workspace = readFileSync(new URL("./pages/SessionWorkspacePage.tsx", import.meta.url), "utf8");
const execution = readFileSync(new URL("./pages/TargetExecutionWorkbench.tsx", import.meta.url), "utf8");
const workbenchPanels = readFileSync(new URL("./pages/session-workbench-panels.tsx", import.meta.url), "utf8");
const sessionTableSources = [workspace, execution, workbenchPanels].join("\n");
const registryPanelStart = workbenchPanels.indexOf("export function SessionRegistryPanel");
const registryPanelEnd = workbenchPanels.indexOf("function RegistryMutationSheet", registryPanelStart);
const registryPanel = workbenchPanels.slice(registryPanelStart, registryPanelEnd);
const nonRegistryWorkbenchPanels = workbenchPanels.slice(0, registryPanelStart) + workbenchPanels.slice(registryPanelEnd);
const pageFlowSessionTableSources = [workspace, execution, nonRegistryWorkbenchPanels].join("\n");

describe("Session workspace sticky summary layout", () => {
  it("lets the embedded workspace fill its scroll pane", () => {
    expect(styles).toMatch(
      /\.app-content:has\(>\s*\.session-workspace\[data-presentation="embedded"\]\)\s*\{[^}]*padding:\s*0\s+0\s+10px;/s,
    );
    expect(styles).toMatch(
      /\.app-content:has\(>\s*\.session-workspace\[data-presentation="embedded"\]\)\s*>\s*\.session-workspace\[data-presentation="embedded"\]\s*\{[^}]*max-width:\s*none;/s,
    );
  });

  it("keeps exactly ten pixels below dedicated session panels", () => {
    expect(workspace).toContain('className="session-workspace__viewport-content flow-root pb-[10px]"');
    expect(workspace).not.toMatch(/className="[^"]*flow-root\s+pb-(?:12|20)(?:\s|")/u);
  });

  it("renders the eleven non-registry session tables in page flow", () => {
    expect(sessionTableSources.match(/^\s*<DataGrid(?:\s|$)/gmu)).toHaveLength(12);
    expect(pageFlowSessionTableSources.match(/^\s*<DataGrid(?:\s|$)/gmu)).toHaveLength(11);
    expect(pageFlowSessionTableSources).not.toMatch(/scrollContainerClassName="[^"]*max-h-/u);
    expect(sessionTableSources).not.toMatch(/\svirtualized(?:\s|\n|\/?>)/u);
    expect(workbenchPanels).not.toContain('className="max-h-28 overflow-auto');
  });

  it("bounds Registry while eagerly rendering each explicit one-hundred-row page", () => {
    expect(workbenchPanels).not.toContain("limit: 500");
    expect(registryPanel.match(/^\s*<DataGrid(?:\s|$)/gmu)).toHaveLength(1);
    expect(registryPanel).toContain("session-registry-editor flex h-full max-h-full min-h-0");
    expect(registryPanel).toContain('data-registry-scroll-region="keys"');
    expect(registryPanel).toContain('data-registry-scroll-region="values"');
    expect(registryPanel).toContain('scrollContainerClassName="h-full max-h-full overflow-auto overscroll-contain rounded-none"');
    expect(registryPanel).not.toContain('style={{ height: "auto", overflow: "visible" }}');
    expect(registryPanel).not.toMatch(/\svirtualized(?:\s|\n|\/?>)/u);
    expect(registryPanel).toContain(">Load more values</Button>");
  });

  it("constrains the selected Registry panel to the remaining session viewport", () => {
    expect(workspace).toContain("data-selected-panel={selectedPanel}");
    expect(workspace).toContain('className="session-workspace__registry-panel pt-6"');
    expect(styles).toMatch(
      /\.session-workspace\[data-selected-panel="registry"\]\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s,
    );
    expect(styles).toContain(".session-workspace__viewport-content, .session-workspace__registry-panel");
  });

  it("pins the session chrome above scrolling panel content", () => {
    expect(styles).toMatch(
      /\.session-workspace\[data-presentation="embedded"\]\s+\.session-workspace__sticky\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*[1-9]\d*;/s,
    );
  });

  it("expands and squares the summary only while stuck", () => {
    expect(styles).toMatch(
      /\[data-stuck="true"\]\s+\.session-workspace__summary-frame\s*\{[^}]*max-width:\s*none;[^}]*padding-inline:\s*0;/s,
    );
    expect(styles).toMatch(
      /\[data-stuck="true"\]\s+\.session-workspace__summary\s*\{[^}]*border-radius:\s*0;/s,
    );
  });

  it("reveals the scroll shadow when the chrome sticks", () => {
    expect(styles).toMatch(
      /\.session-workspace__sticky\[data-stuck="true"\]::after\s*\{[^}]*opacity:\s*1;/s,
    );
  });
});
