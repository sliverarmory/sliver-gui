import type { SliverDesktopAPI } from "../../shared/contracts";

declare global {
  interface Window {
    sliver: SliverDesktopAPI;
  }
}

export {};
