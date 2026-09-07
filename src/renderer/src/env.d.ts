import type { CloudDeploymentAPI } from "../../shared/cloud-deployment-ipc";
import type { SliverDesktopAPI } from "../../shared/contracts";

declare global {
  interface Window {
    cloudDeployment?: CloudDeploymentAPI;
    sliver: SliverDesktopAPI;
  }
}

export {};
