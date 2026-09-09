import type { CloudDeploymentAPI } from "../../shared/cloud-deployment-ipc";
import type { ApplicationContextMenuAPI } from "../../shared/application-context-menu-contracts";
import type { SliverDesktopAPI } from "../../shared/contracts";
import type { SshWindowAPI } from "../../shared/ssh-contracts";
import type { NetworkForwardingAPI } from "../../shared/network-forwarding-contracts";

declare global {
  interface Window {
    applicationContextMenu: ApplicationContextMenuAPI;
    cloudDeployment?: CloudDeploymentAPI;
    network?: NetworkForwardingAPI;
    sliver: SliverDesktopAPI;
    ssh?: SshWindowAPI;
  }
}

export {};
