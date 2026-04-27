import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@activityplug/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@activityplug/e2e-fixtures": new URL("./packages/e2e-fixtures/src/index.ts", import.meta.url)
        .pathname,
      "@activityplug/hackerspub": new URL("./packages/hackerspub/src/index.ts", import.meta.url)
        .pathname,
      "@activityplug/hollo": new URL("./packages/hollo/src/index.ts", import.meta.url).pathname,
      "@activityplug/mastodon": new URL("./packages/mastodon/src/index.ts", import.meta.url)
        .pathname,
      "@activityplug/mastodon-base": new URL(
        "./packages/mastodon-base/src/index.ts",
        import.meta.url,
      ).pathname,
      "@activityplug/misskey": new URL("./packages/misskey/src/index.ts", import.meta.url).pathname,
      "@activityplug/pleroma": new URL("./packages/pleroma/src/index.ts", import.meta.url).pathname,
      "@activityplug/server": new URL("./packages/server/src/index.ts", import.meta.url).pathname,
      "@activityplug/session-postgres": new URL(
        "./packages/session-postgres/src/index.ts",
        import.meta.url,
      ).pathname,
      "@activityplug/session-redis": new URL(
        "./packages/session-redis/src/index.ts",
        import.meta.url,
      ).pathname,
      "@activityplug/test-fixtures": new URL(
        "./packages/test-fixtures/src/index.ts",
        import.meta.url,
      ).pathname,
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
