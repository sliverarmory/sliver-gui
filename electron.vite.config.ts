import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        // Bundle sliver-script into Electron main's runtime graph so packaged
        // applications do not load it as a separate installed npm module.
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
      sourcemap: false,
      commonjsOptions: {
        include: [/node_modules/],
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
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
          navigation: resolve("src/preload/navigation.ts"),
          "cloud-deployment": resolve("src/preload/cloud-deployment.ts"),
          network: resolve("src/preload/network.ts"),
          armory: resolve("src/preload/armory.ts"),
          ssh: resolve("src/preload/ssh.ts"),
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react(), tailwindcss()],
    build: {
      outDir: resolve("dist/renderer"),
      sourcemap: false,
      rollupOptions: {
        input: resolve("src/renderer/index.html"),
      },
    },
  },
});
