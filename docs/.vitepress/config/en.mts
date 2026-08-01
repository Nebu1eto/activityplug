import { type DefaultTheme, defineConfig } from "vitepress";

export const en = defineConfig({
  lang: "en",
  description: "Unified APIs and TypeScript adapters for ActivityPub software.",
  themeConfig: {
    nav: nav(),
    sidebar: {
      "/en/": sidebarGuide(),
    },
    editLink: {
      pattern: "https://github.com/Nebu1eto/activityplug/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "Released under the Apache-2.0 OR MIT license.",
    },
  },
});

function nav(): DefaultTheme.NavItem[] {
  return [
    { text: "Documentation", link: "/en/README" },
    { text: "Getting started", link: "/en/getting-started" },
    { text: "API", link: "/api/" },
  ];
}

function sidebarGuide(): DefaultTheme.SidebarItem[] {
  return [
    {
      text: "Start here",
      items: [
        { text: "Documentation", link: "/en/README" },
        { text: "Getting started", link: "/en/getting-started" },
        { text: "Core concepts", link: "/en/concepts" },
        { text: "API surfaces", link: "/en/api-surfaces" },
      ],
    },
    {
      text: "Use ActivityPlug",
      items: [
        { text: "Library usage", link: "/en/library-usage" },
        { text: "Server usage", link: "/en/server-usage" },
        { text: "Browser integration", link: "/en/browser-integration" },
        { text: "Adapters and capabilities", link: "/en/adapters-and-capabilities" },
        { text: "Authentication and sessions", link: "/en/authentication-and-sessions" },
        { text: "Streaming and media", link: "/en/streaming-and-media" },
        { text: "Errors and troubleshooting", link: "/en/errors-and-troubleshooting" },
      ],
    },
    {
      text: "Operate ActivityPlug",
      items: [
        { text: "Session storage", link: "/en/session-storage" },
        { text: "Deployment", link: "/en/deployment" },
        { text: "Security model", link: "/en/security-model" },
      ],
    },
    {
      text: "Understand and extend",
      items: [
        { text: "Architecture", link: "/en/architecture" },
        { text: "Adapter development", link: "/en/adapter-development" },
        { text: "Testing", link: "/en/testing" },
      ],
    },
    {
      text: "Upgrade",
      items: [
        {
          text: "Authentication migration for 0.1.0",
          link: "/en/migrations/0.1.0-authentication",
        },
      ],
    },
  ];
}
