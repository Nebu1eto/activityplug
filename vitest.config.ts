import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@activityplug/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@activityplug/server": new URL("./packages/server/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: [
      "packages/**/*.test.ts",
      "packages/**/*.integration.test.ts",
      "examples/**/*.test.ts",
    ],
  },
});
