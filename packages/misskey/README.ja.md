@activityplug/misskey
=====================

[English](README.md) | [한국어](README.ko.md) | 日本語

ActivityPlug 用の Misskey アダプターです。


インストール
------------

~~~~ sh
pnpm add @activityplug/misskey
~~~~

Node.js 26 以降が必要です。このパッケージは ECMAScript モジュールを使用します。


使用方法
--------

~~~~ ts
import * as activityplug from "@activityplug/misskey";
~~~~

パッケージルートは、サポートされる公開 API を公開します。このリリースで
利用可能な正確な契約については、エクスポートされた型を参照してください。


ストリーミング
--------------

ストリーミングと URL メディア取り込みには注入された `webSocket` ファクトリーが
必要です。サーバーアプリケーションはトークンを含む URL へ接続する前に独自の
送信ポリシーと DNS 固定を適用する必要があるため、アダプターはグローバル
WebSocket 実装を使用しません。


ライセンス
----------

Apache-2.0 OR MIT の条件でライセンスされます。`LICENSE-APACHE` と
`LICENSE-MIT` を参照してください。
