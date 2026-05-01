import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

function workspacePath(path: string): string {
  return fileURLToPath(new URL(`../../${path}`, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      "@activityplug/core": workspacePath("packages/core/src/index.ts"),
      "@activityplug/mastodon-base": workspacePath("packages/mastodon-base/src/index.ts"),
      "@activityplug/mastodon": workspacePath("packages/mastodon/src/index.ts"),
      "@activityplug/misskey": workspacePath("packages/misskey/src/index.ts"),
    },
  },
});
