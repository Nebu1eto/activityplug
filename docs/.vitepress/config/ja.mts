import { type DefaultTheme, defineConfig } from "vitepress";

export const ja = defineConfig({
  lang: "ja",
  description: "ActivityPub ソフトウェア向けの統合 API と TypeScript アダプタ。",
  themeConfig: {
    nav: nav(),
    sidebar: {
      "/ja/": sidebarGuide(),
    },
    editLink: {
      pattern: "https://github.com/Nebu1eto/activityplug/edit/main/docs/:path",
      text: "GitHub でこのページを編集",
    },
    footer: {
      message: "Apache-2.0 OR MIT ライセンスで配布します。",
    },
    outlineTitle: "このページの内容",
    darkModeSwitchLabel: "表示モード",
    sidebarMenuLabel: "メニュー",
    returnToTopLabel: "ページの先頭へ戻る",
  },
});

function nav(): DefaultTheme.NavItem[] {
  return [
    { text: "ドキュメント", link: "/ja/README" },
    { text: "スタートガイド", link: "/ja/getting-started" },
    { text: "API", link: "/api/" },
  ];
}

function sidebarGuide(): DefaultTheme.SidebarItem[] {
  return [
    {
      text: "最初に読む文書",
      items: [
        { text: "ドキュメント", link: "/ja/README" },
        { text: "スタートガイド", link: "/ja/getting-started" },
        { text: "コア概念", link: "/ja/concepts" },
        { text: "API サーフェス", link: "/ja/api-surfaces" },
      ],
    },
    {
      text: "ActivityPlug を使う",
      items: [
        { text: "ライブラリの使い方", link: "/ja/library-usage" },
        { text: "サーバの使い方", link: "/ja/server-usage" },
        { text: "ブラウザ統合", link: "/ja/browser-integration" },
        { text: "アダプタと capability", link: "/ja/adapters-and-capabilities" },
        { text: "認証とセッション", link: "/ja/authentication-and-sessions" },
        { text: "ストリーミングとメディア", link: "/ja/streaming-and-media" },
        { text: "エラーとトラブルシューティング", link: "/ja/errors-and-troubleshooting" },
      ],
    },
    {
      text: "ActivityPlug を運用する",
      items: [
        { text: "セッションストレージ", link: "/ja/session-storage" },
        { text: "配備", link: "/ja/deployment" },
        { text: "セキュリティモデル", link: "/ja/security-model" },
      ],
    },
    {
      text: "内部構造と拡張",
      items: [
        { text: "アーキテクチャ", link: "/ja/architecture" },
        { text: "アダプタ開発", link: "/ja/adapter-development" },
        { text: "テスト", link: "/ja/testing" },
      ],
    },
    {
      text: "アップグレード",
      items: [{ text: "0.1.0 認証 migration", link: "/ja/migrations/0.1.0-authentication" }],
    },
  ];
}
