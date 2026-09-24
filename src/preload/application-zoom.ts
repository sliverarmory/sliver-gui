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
  notifyNativeZoomChanged?: () => void,
): ApplicationZoomAPI {
  let previousNativeFactor = frame.getZoomFactor();
  if (notifyNativeZoomChanged) {
    resizeTarget.addEventListener("resize", () => {
      const factor = frame.getZoomFactor();
      if (factor === previousNativeFactor) return;
      previousNativeFactor = factor;
      notifyNativeZoomChanged();
    });
  }
  return Object.freeze({
    getFactor: () => frame.getZoomFactor(),
    reset: () => {
      const previousFactor = frame.getZoomFactor();
      frame.setZoomFactor(1);
      previousNativeFactor = 1;
      if (previousFactor !== 1) notifyNativeZoomChanged?.();
    },
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
