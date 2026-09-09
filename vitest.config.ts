import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

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
    testTimeout: 15_000,
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
