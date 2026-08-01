---
layout: home

title: ActivityPlug
description: ActivityPub ソフトウェア向けの統合 API と TypeScript アダプタ。

hero:
  name: ActivityPlug
  text: Fediverse のための統合 API
  tagline: 異なる ActivityPub サーバ API を、アプリケーションに合う runtime と配備境界から利用できます。
  image:
    src: /activityplug.svg
    alt: ActivityPlug
  actions:
    - theme: brand
      text: スタートガイド
      link: /ja/getting-started
    - theme: alt
      text: API リファレンス
      link: /api/
    - theme: alt
      text: GitHub
      link: https://github.com/Nebu1eto/activityplug

features:
  - icon:
      src: /icons/lucide/package.svg
      alt: パッケージ
    title: TypeScript ライブラリとして利用
    details: 必要な package だけを追加します。ActivityPlug は Node.js、Bun、Deno、browser、React Native、Expo で動作します。
    link: /ja/library-usage
  - icon:
      src: /icons/lucide/network.svg
      alt: ネットワーク
    title: Gateway server として実行
    details: JavaScript 以外の client からも、一つの gateway を GraphQL、HTTP、WebSocket API で利用できます。
    link: /ja/server-usage
  - icon:
      src: /icons/lucide/blocks.svg
      alt: 拡張ブロック
    title: Adapter を追加
    details: 新しいサーバ API を共通インターフェースと capability model にマッピングするだけで、アプリケーションコードを変えずに対応先を追加できます。
    link: /ja/adapter-development
---

