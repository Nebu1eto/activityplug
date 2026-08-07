<h1>
  <img src="https://raw.githubusercontent.com/Nebu1eto/activityplug/main/docs/public/activityplug.svg" alt="ActivityPlug logo" width="40" height="40" align="absmiddle" />
  ActivityPlug
</h1>

[![npm](https://img.shields.io/npm/v/%40activityplug%2Fcore?logo=npm)](https://www.npmjs.com/package/@activityplug/core)
[![Docs](https://img.shields.io/badge/docs-vitepress-059669)](https://activityplug.dev/)
[![CI](https://github.com/Nebu1eto/activityplug/actions/workflows/ci.yml/badge.svg)](https://github.com/Nebu1eto/activityplug/actions/workflows/ci.yml)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](#license)

[English](README.md) | [한국어](README.ko.md) | 日本語

ActivityPlug は、クライアント API が異なる ActivityPub サーバーを単一の
TypeScript 契約で扱えるようにします。アプリケーションにライブラリとして
組み込む方法と、同梱の GraphQL・HTTP・ブラウザ向けサーバを介して実行する
方法があります。

現在のアダプタは Mastodon、Pleroma と Akkoma、Misskey、Hollo、HackersPub
に対応しています。各アダプタは capability を報告するため、アプリケーション
は機能を提示する前に対応状況を確認できます。未対応の操作は型付きの
`UNSUPPORTED_OPERATION` エラーで失敗します。


統合方法の選択
--------------

信頼できるアプリケーションコードから Fediverse サーバを直接呼び出す場合は
**ライブラリモード**を使います。`@activityplug/core` と対象サーバ用の
アダプタをインストールし、実行環境に適した remote authority を指定します。

複数のクライアントが単一の制御された API 境界を共有する場合は**サーバ
モード**を使います。`@activityplug/server` は GraphQL・HTTP API、
リモート origin ポリシの適用、オプションのブラウザ route を提供します。
同じサーバをコマンドラインから実行する場合は `@activityplug/cli` を
使います。

Web アプリケーションが ActivityPlug の session identifier やリモートの
credential をブラウザストレージに保存すべきでない場合は**ブラウザ API**
を使います。ブラウザ route は不透明な署名付き BFF cookie と CSRF 保護を
使用します。

まず[スタートガイド](docs/ja/getting-started.md)を読み、続けて以下の
文書を参照してください。

 -  [ライブラリの使い方](docs/ja/library-usage.md)
 -  [サーバの使い方](docs/ja/server-usage.md)
 -  [ブラウザ統合](docs/ja/browser-integration.md)
 -  [API サーフェス](docs/ja/api-surfaces.md)


公開パッケージ
--------------

| パッケージ                                                              | 役割                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`@activityplug/core`](packages/core/README.md)                         | ポータブルな型、クライアントサービス、capability、identifier、エラー、transport 境界 |
| [`@activityplug/mastodon`](packages/mastodon/README.md)                 | Mastodon アダプタ                                                                    |
| [`@activityplug/pleroma`](packages/pleroma/README.md)                   | Pleroma と Akkoma のアダプタ                                                         |
| [`@activityplug/misskey`](packages/misskey/README.md)                   | Misskey アダプタ                                                                     |
| [`@activityplug/hollo`](packages/hollo/README.md)                       | Hollo アダプタ                                                                       |
| [`@activityplug/hackerspub`](packages/hackerspub/README.md)             | HackersPub アダプタ                                                                  |
| [`@activityplug/mastodon-base`](packages/mastodon-base/README.md)       | Mastodon 互換アダプタの共通基盤                                                      |
| [`@activityplug/server`](packages/server/README.md)                     | GraphQL・HTTP・ブラウザのサーバサーフェス                                            |
| [`@activityplug/cli`](packages/cli/README.md)                           | コマンドラインサーバ                                                                 |
| [`@activityplug/session-postgres`](packages/session-postgres/README.md) | サーバ配備用の PostgreSQL lifecycle store                                            |
| [`@activityplug/session-redis`](packages/session-redis/README.md)       | サーバ配備用の Redis 短期 store と limit                                             |


サンプル
--------

 -  [`examples/bot`](examples/bot/README.md) は、メンションに返信する bot で
    ライブラリモードを示します。
 -  [`examples/proxy-client`](examples/proxy-client/README.md) は、サーバ
    モードの HTTP・GraphQL クライアントを示します。
 -  [`examples/web-client`](examples/web-client/README.md) は、ブラウザ API
    と配備可能なサーバ構成を示します。


要件
----

ActivityPlug パッケージは Node.js 26 以降を必要とし、ECMAScript module を
使用します。リポジトリでは pnpm 11 を使います。


ドキュメント
------------

[ドキュメント索引](docs/ja/README.md)では、目的と読者に応じてガイドを
分類しています。Capability の動作、認証、streaming、storage、配備、
セキュリティ、アーキテクチャ、アダプタ開発、テスト、migration の各文書を
参照できます。


ライセンス
----------

Apache-2.0 OR MIT ライセンスで提供します。`LICENSE-APACHE` と
`LICENSE-MIT` を参照してください。
