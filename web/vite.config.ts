import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // v0.1: minimal SW — tile + map caching is a v1.0 task
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg}"],
        // Do NOT cache PMTiles basemap or API responses here;
        // offline map caching requires a custom tile-cache strategy (v1.0)
        runtimeCaching: [],
      },
      manifest: {
        name: "BikeRouteNicePDX",
        short_name: "PDX Greenways",
        description: "Portland greenway-aware bike routing",
        start_url: "/",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#16a34a",
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      // Dev proxy: /api/* → backend at localhost:3000 (avoids CORS)
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
