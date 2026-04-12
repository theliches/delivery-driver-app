import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/nominatim": {
        target: "https://nominatim.openstreetmap.org",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/nominatim/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader(
              "User-Agent",
              "DeliveryDriverApp/1.0 (lokal udvikling)",
            );
          });
        },
      },
      "/api/osrm": {
        target: "https://router.project-osrm.org",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/osrm/, ""),
      },
    },
  },
});
