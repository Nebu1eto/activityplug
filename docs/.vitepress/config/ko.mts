import { type DefaultTheme, defineConfig } from "vitepress";

export const ko = defineConfig({
  lang: "ko",
  description: "ActivityPub 소프트웨어를 위한 통합 API와 TypeScript 어댑터.",
  themeConfig: {
    nav: nav(),
    sidebar: {
      "/ko/": sidebarGuide(),
    },
    editLink: {
      pattern: "https://github.com/Nebu1eto/activityplug/edit/main/docs/:path",
      text: "GitHub에서 이 페이지 편집하기",
    },
    footer: {
      message: "Apache-2.0 OR MIT 라이선스로 배포됩니다.",
    },
    outlineTitle: "이 페이지에서",
    darkModeSwitchLabel: "화면 모드",
    sidebarMenuLabel: "메뉴",
    returnToTopLabel: "맨 위로 돌아가기",
  },
});

function nav(): DefaultTheme.NavItem[] {
  return [
    { text: "문서", link: "/ko/README" },
    { text: "시작 가이드", link: "/ko/getting-started" },
    { text: "API", link: "/api/" },
  ];
}

function sidebarGuide(): DefaultTheme.SidebarItem[] {
  return [
    {
      text: "시작하기",
      items: [
        { text: "문서", link: "/ko/README" },
        { text: "시작 가이드", link: "/ko/getting-started" },
        { text: "핵심 개념", link: "/ko/concepts" },
        { text: "API 표면", link: "/ko/api-surfaces" },
      ],
    },
    {
      text: "ActivityPlug 사용",
      items: [
        { text: "라이브러리 사용법", link: "/ko/library-usage" },
        { text: "서버 사용법", link: "/ko/server-usage" },
        { text: "브라우저 통합", link: "/ko/browser-integration" },
        { text: "어댑터와 capability", link: "/ko/adapters-and-capabilities" },
        { text: "인증과 session", link: "/ko/authentication-and-sessions" },
        { text: "Streaming과 media", link: "/ko/streaming-and-media" },
        { text: "Error와 문제 해결", link: "/ko/errors-and-troubleshooting" },
      ],
    },
    {
      text: "ActivityPlug 운영",
      items: [
        { text: "Session storage", link: "/ko/session-storage" },
        { text: "배포", link: "/ko/deployment" },
        { text: "보안 모델", link: "/ko/security-model" },
      ],
    },
    {
      text: "내부 구조와 확장",
      items: [
        { text: "아키텍처", link: "/ko/architecture" },
        { text: "어댑터 개발", link: "/ko/adapter-development" },
        { text: "테스트", link: "/ko/testing" },
      ],
    },
    {
      text: "업그레이드",
      items: [{ text: "0.1.0 인증 migration", link: "/ko/migrations/0.1.0-authentication" }],
    },
  ];
}
