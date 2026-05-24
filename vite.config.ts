
import { defineConfig } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Photophone",
        short_name: "Photophone",
        description:
          "Browser-to-browser data transfer using only a screen and a camera.",
        theme_color: "#0a0a0a",
        background_color: "#0a0a0a",
        display: "standalone",
        start_url: "/",
        icons: [],
      },
    }),
  ],
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        send: resolve(__dirname, "send.html"),
        receive: resolve(__dirname, "receive.html"),
        "broadcast-send": resolve(__dirname, "broadcast-send.html"),
        "broadcast-receive": resolve(__dirname, "broadcast-receive.html"),
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
