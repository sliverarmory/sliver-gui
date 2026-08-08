import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        // The local sliver-script checkout is intentionally linked during
        // development. Bundle its runtime graph so packaged applications do
        // not traverse that link and accidentally ship the upstream Sliver
        // checkout, tests, docs, or development dependencies.
        exclude: [
          "sliver-script",
          "@bufbuild/protobuf",
          "@grpc/grpc-js",
          "nice-grpc",
          "nice-grpc-common",
          "rxjs",
        ],
      }),
    ],
    build: {
      outDir: resolve("dist/main"),
      sourcemap: true,
      commonjsOptions: {
        include: [/node_modules/, /sliver-script\/lib/],
      },
      rollupOptions: {
        input: resolve("src/main/index.ts"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve("dist/preload"),
      sourcemap: true,
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "index.cjs",
        },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react(), tailwindcss()],
    build: {
      outDir: resolve("dist/renderer"),
      sourcemap: true,
      rollupOptions: {
        input: resolve("src/renderer/index.html"),
      },
    },
  },
});
