import type { CloudDeploymentAPI } from "../../shared/cloud-deployment-ipc";
import type { SliverDesktopAPI } from "../../shared/contracts";
import type { SshWindowAPI } from "../../shared/ssh-contracts";

declare global {
  interface Window {
    cloudDeployment?: CloudDeploymentAPI;
    sliver: SliverDesktopAPI;
    ssh?: SshWindowAPI;
  }
}

export {};
