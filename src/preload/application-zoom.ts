import type { ApplicationZoomAPI } from "../shared/application-zoom-contracts.js";

interface ApplicationZoomFrame {
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
}

export interface ApplicationZoomResizeTarget {
  addEventListener(type: "resize", listener: () => void): void;
  removeEventListener(type: "resize", listener: () => void): void;
}

export function createApplicationZoomAPI(
  frame: ApplicationZoomFrame,
  resizeTarget: ApplicationZoomResizeTarget,
): ApplicationZoomAPI {
  return Object.freeze({
    getFactor: () => frame.getZoomFactor(),
    reset: () => frame.setZoomFactor(1),
    onChanged: (listener: (factor: number) => void) => {
      if (typeof listener !== "function") throw new TypeError("zoom listener must be a function");
      let previousFactor = frame.getZoomFactor();
      // Native page zoom resizes the CSS viewport, including menu and keyboard zoom changes.
      const onResize = (): void => {
        const factor = frame.getZoomFactor();
        if (factor === previousFactor) return;
        previousFactor = factor;
        listener(factor);
      };
      resizeTarget.addEventListener("resize", onResize);
      return () => resizeTarget.removeEventListener("resize", onResize);
    },
  });
}
