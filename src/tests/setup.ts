import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/dom";

if (process.env["CI"] === "true" && process.env["RUNNER_OS"] === "Windows") {
  configure({ asyncUtilTimeout: 5_000 });
}

Object.defineProperty(globalThis, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    // DOM tests have no animation clock; dismiss overlays without exit delays.
    matches: query === "(prefers-reduced-motion: reduce)",
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  }),
});
