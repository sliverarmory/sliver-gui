import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const isWindowsActionsRun = process.env["CI"] === "true" && process.env["RUNNER_OS"] === "Windows";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@renderer": resolve(__dirname, "src/renderer/src"),
      "@shared": resolve(__dirname, "src/shared"),
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "src/**/*.spec.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["src/tests/setup.ts"],
    testTimeout: isWindowsActionsRun ? 30_000 : 15_000,
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
