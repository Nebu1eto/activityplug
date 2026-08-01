import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type DefaultTheme, defineConfig } from "vitepress";

export const shared = defineConfig({
  title: "ActivityPlug",
  description: "Unified APIs and TypeScript adapters for ActivityPub software.",
  cleanUrls: true,
  lastUpdated: true,
  sitemap: {
    hostname: "https://activityplug.dev/",
  },
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/activityplug.svg" }],
    ["link", { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon-32x32.png" }],
    ["link", { rel: "icon", type: "image/png", sizes: "16x16", href: "/favicon-16x16.png" }],
    ["link", { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" }],
    ["meta", { property: "og:image", content: "https://activityplug.dev/activityplug.png" }],
  ],
  themeConfig: {
    logo: "/activityplug.svg",
    nav: [
      { text: "Documentation", link: "/en/README" },
      { text: "Getting started", link: "/en/getting-started" },
      { text: "API", link: "/api/" },
    ],
    sidebar: {
      "/api/": sidebarApi(),
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/Nebu1eto/activityplug" },
      { icon: "npm", link: "https://www.npmjs.com/search?q=%40activityplug" },
    ],
    search: {
      provider: "local",
    },
  },
});

export function fixTypedocSidebarLinks(
  items: DefaultTheme.SidebarItem[],
): DefaultTheme.SidebarItem[] {
  return items.map((item) => ({
    ...item,
    link: item.link?.replace(/\.md$/u, ""),
    items: item.items === undefined ? undefined : fixTypedocSidebarLinks(item.items),
  }));
}

function sidebarApi(): DefaultTheme.SidebarItem[] {
  try {
    const path = resolve(import.meta.dirname, "../../api/typedoc-sidebar.json");
    return fixTypedocSidebarLinks(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return [{ text: "API", items: [{ text: "Overview", link: "/api/" }] }];
  }
}
