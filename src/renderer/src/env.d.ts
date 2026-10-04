import type { GhosttySettingsAPI } from "../../shared/ghostty-settings-contracts";
import type { ArmoryAPI } from "../../shared/armory-contracts";
import type { CloudDeploymentAPI } from "../../shared/cloud-deployment-ipc";
import type { ApplicationContextMenuAPI } from "../../shared/application-context-menu-contracts";
import type { ApplicationZoomAPI } from "../../shared/application-zoom-contracts";
import type { SliverDesktopAPI } from "../../shared/contracts";
import type { SshWindowAPI } from "../../shared/ssh-contracts";
import type { NetworkForwardingAPI } from "../../shared/network-forwarding-contracts";
import type { TextEditorAPI } from "../../shared/text-editor-contracts";

declare global {
  interface Window {
    ghosttySettings?: GhosttySettingsAPI;
    applicationContextMenu: ApplicationContextMenuAPI;
    applicationZoom: ApplicationZoomAPI;
    cloudDeployment?: CloudDeploymentAPI;
    network?: NetworkForwardingAPI;
    textEditor?: TextEditorAPI;
    armory?: ArmoryAPI;
    sliver: SliverDesktopAPI;
    ssh?: SshWindowAPI;
  }
}

export {};
