import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "packages/**/*.integration.test.ts",
      "examples/**/*.test.ts",
    ],
  },
});
