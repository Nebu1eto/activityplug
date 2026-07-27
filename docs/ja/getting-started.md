スタートガイド
==============

[English](../en/getting-started.md) | [한국어](../ko/getting-started.md) |
日本語

このガイドはサーバモードから始めます。コマンドラインサーバがリモート
transport と origin ポリシを備えているためです。ライブラリモードでも同じ
ポータブルなクライアント契約を直接利用できますが、Node.js アプリケーション
側で審査済みの remote authority を用意する必要があります。


要件
----

公開パッケージは Node.js 26 以降を必要とし、ECMAScript module を使います。
リポジトリでは pnpm 11 を使います。


サーバを実行する
----------------

サーバと peer dependency をインストールします。

~~~~ sh
pnpm add @activityplug/server @activityplug/core @hono/node-server @logtape/logtape graphql hono
~~~~

以下の `https://social.example` を、ActivityPlug プロセスから到達できる
実際の Fediverse サーバの正規 HTTPS origin に置き換えてください。
コマンドラインサーバは `127.0.0.1:4000` で起動し、明示的に渡された
origin のみ許可します。

~~~~ sh
pnpm exec activityplug-server \
  --allow-origin https://social.example
~~~~

サーバはフォアグラウンドで動き続けます。別のターミナルから readiness を
確認してください。

~~~~ sh
curl http://127.0.0.1:4000/health
~~~~

HTTP API で設定済みの instance を検出します。

~~~~ sh
curl \
  -H 'Content-Type: application/json' \
  -d '{"origin":"https://social.example"}' \
  http://127.0.0.1:4000/api/v1/instances/detect
~~~~

CLI には現在のアダプタがすべて含まれます。認証とセキュリティの状態は
メモリ上にあり、access-token import はデフォルトで無効です。ブラウザ
モードを有効にした場合、`--browser-memory-stores` を指定したときだけ
ブラウザ用のインメモリ store が追加されます。永続 store やカスタム
ポリシが必要なアプリケーションでは、プログラムからサーバを構成して
ください。[サーバの使い方](server-usage.md)を参照してください。


リポジトリのサンプルを実行する
------------------------------

リポジトリのサンプルは統合経路全体を実行します。

 -  [Bot](../../examples/bot/README.md) は Mastodon または Misskey で
    ライブラリモードを使います。
 -  [Proxy client](../../examples/proxy-client/README.md) は HTTP と
    GraphQL のサーバ API を呼び出します。
 -  [Web client](../../examples/web-client/README.md) はメモリまたは永続
    ストレージと組み合わせてブラウザ API を使います。


次に読むガイド
--------------

 -  TypeScript から直接統合し、実行環境ごとの remote authority を設定
    する場合は[ライブラリの使い方](library-usage.md)を参照して
    ください。
 -  GraphQL または HTTP クライアントを開発する場合は
    [サーバの使い方](server-usage.md)を参照してください。
 -  Web アプリケーションを開発する場合は
    [ブラウザ統合](browser-integration.md)を参照してください。
 -  サーバ固有の機能に依存する前に
    [アダプタと capability](adapters-and-capabilities.md)を参照して
    ください。
