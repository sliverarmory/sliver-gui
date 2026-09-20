import type { ArmoryAPI } from "../../shared/armory-contracts";
import type { CloudDeploymentAPI } from "../../shared/cloud-deployment-ipc";
import type { ApplicationContextMenuAPI } from "../../shared/application-context-menu-contracts";
import type { SliverDesktopAPI } from "../../shared/contracts";
import type { SshWindowAPI } from "../../shared/ssh-contracts";
import type { NetworkForwardingAPI } from "../../shared/network-forwarding-contracts";
import type { ScriptTaskManagerAPI } from "../../shared/script-task-manager-contracts";

declare global {
  interface Window {
    applicationContextMenu: ApplicationContextMenuAPI;
    cloudDeployment?: CloudDeploymentAPI;
    network?: NetworkForwardingAPI;
    scriptTasks?: ScriptTaskManagerAPI;
    armory?: ArmoryAPI;
    sliver: SliverDesktopAPI;
    ssh?: SshWindowAPI;
  }
}

export {};
