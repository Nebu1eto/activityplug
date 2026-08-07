import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import { productServerPlugin } from "./vite-product-server.js";

export default defineConfig({
  // The product server runs inside the dev server so the frontend and the
  // browser API share one origin.
  plugins: [react(), productServerPlugin()],
  build: {
    rollupOptions: {
      input: "index.html",
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
