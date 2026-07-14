@activityplug/mastodon-base
===========================

[English](README.md) | [한국어](README.ko.md) | 日本語

Mastodon 互換の ActivityPlug アダプター向け共通機能を提供します。


インストール
------------

~~~~ sh
pnpm add @activityplug/mastodon-base
~~~~

Node.js 26 以降が必要です。このパッケージは ECMAScript モジュールを使用します。


使用方法
--------

~~~~ ts
import * as activityplug from "@activityplug/mastodon-base";
~~~~

パッケージルートは、サポートされる公開 API を公開します。このリリースで
利用可能な正確な契約については、エクスポートされた型を参照してください。


ストリーミング
--------------

ストリーミングには注入された `webSocket` ファクトリーが必要です。サーバー
アプリケーションはトークンを含む URL へ接続する前に独自の送信ポリシーと
DNS 固定を適用する必要があるため、アダプターはグローバル WebSocket 実装を
使用しません。


ライセンス
----------

Apache-2.0 OR MIT の条件でライセンスされます。`LICENSE-APACHE` と
`LICENSE-MIT` を参照してください。
