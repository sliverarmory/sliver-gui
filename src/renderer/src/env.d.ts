import type { CloudDeploymentAPI } from "../../shared/cloud-deployment-ipc";
import type { ApplicationContextMenuAPI } from "../../shared/application-context-menu-contracts";
import type { SliverDesktopAPI } from "../../shared/contracts";
import type { SshWindowAPI } from "../../shared/ssh-contracts";

declare global {
  interface Window {
    applicationContextMenu: ApplicationContextMenuAPI;
    cloudDeployment?: CloudDeploymentAPI;
    sliver: SliverDesktopAPI;
    ssh?: SshWindowAPI;
  }
}

export {};
