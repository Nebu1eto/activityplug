import { defineConfig } from "vitepress";
import llmstxt from "vitepress-plugin-llms";

import { en } from "./config/en.mts";
import { ja } from "./config/ja.mts";
import { ko } from "./config/ko.mts";
import { shared } from "./config/shared.mts";

export default defineConfig({
  ...shared,
  locales: {
    en: { label: "English", link: "/en/", ...en },
    ko: { label: "한국어", link: "/ko/", ...ko },
    ja: { label: "日本語", link: "/ja/", ...ja },
  },
  vite: {
    plugins: [
      llmstxt({
        domain: "https://activityplug.dev",
        ignoreFiles: [],
        excludeIndexPage: false,
      }),
    ],
  },
});
