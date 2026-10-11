import { Tabs } from "@heroui/react";
import type { SliverSnapshot } from "../../../shared/contracts";
import { OperationsPage } from "./OperationsPage";
import { WebsitesPage } from "./WebsitesPage";

interface OperationsWorkspacePageProps {
  snapshot: SliverSnapshot;
  selectedTab: "operations" | "websites";
  onTabChange: (tab: "operations" | "websites") => void;
}

export function OperationsWorkspacePage({
  snapshot,
  selectedTab,
  onTabChange,
}: OperationsWorkspacePageProps): React.JSX.Element {
  return (
    <Tabs
      className="operations-workspace"
      selectedKey={selectedTab}
      variant="secondary"
      onSelectionChange={(key) => {
        if (key === "operations" || key === "websites") onTabChange(key);
      }}
    >
      <Tabs.ListContainer className="w-fit max-w-full shrink-0">
        <Tabs.List aria-label="Jobs and website management">
          <Tabs.Tab className="w-auto shrink-0 whitespace-nowrap" id="operations">
            Jobs &amp; listeners
            <Tabs.Indicator />
          </Tabs.Tab>
          <Tabs.Tab className="w-auto shrink-0 whitespace-nowrap" id="websites">
            Websites
            <Tabs.Indicator />
          </Tabs.Tab>
        </Tabs.List>
      </Tabs.ListContainer>
      <Tabs.Panel className="operations-workspace__panel operations-workspace__jobs" id="operations">
        <OperationsPage snapshot={snapshot} />
      </Tabs.Panel>
      <Tabs.Panel className="operations-workspace__panel" id="websites">
        <WebsitesPage snapshot={snapshot} />
      </Tabs.Panel>
    </Tabs>
  );
}
