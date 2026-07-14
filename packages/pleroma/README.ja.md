@activityplug/pleroma
=====================

[English](README.md) | [한국어](README.ko.md) | 日本語

ActivityPlug 用の Pleroma アダプターです。


インストール
------------

~~~~ sh
pnpm add @activityplug/pleroma
~~~~

Node.js 26 以降が必要です。このパッケージは ECMAScript モジュールを使用します。


使用方法
--------

~~~~ ts
import * as activityplug from "@activityplug/pleroma";
~~~~

パッケージルートは、サポートされる公開 API を公開します。このリリースで
利用可能な正確な契約については、エクスポートされた型を参照してください。


ストリーミング
--------------

ストリーミングには、アダプターの作成時に `webSocket` ファクトリーが必要です。
デプロイメントのリモートオリジンポリシーを適用するファクトリーを渡してください。
アダプター自体は WebSocket を作成しません。

インスタンスは `configuration.urls.streaming` または従来の
`urls.streaming_api` を通知できます。このエンドポイントはインスタンスの
HTTP API と異なるホストを使用する場合があります。アダプターは通知された
エンドポイントを使用して `/api/v1/streaming/` を追加するため、インスタンスの
HTTPS オリジンと通知されたストリーミング HTTPS
オリジンの両方を許可してください。 たとえば、サーバーが `wss://stream.example`
を通知する場合は、 `https://stream.example` を許可します。

Pleroma ラッパーは明示的に `legacy-query` を既定とします。したがって認証済み
ストリームは、`options.authorization` ではなく URL クエリーでアクセストークンを
渡します。この URL は資格情報を含むため、暗号化された `wss:`
ターゲットを使用して ください。対象が WebSocket の `Authorization`
ヘッダー認証をサポートする場合にのみ、
`streamingAuthentication: "authorization-header"` を設定してください。


ライセンス
----------

Apache-2.0 OR MIT の条件でライセンスされます。`LICENSE-APACHE` と
`LICENSE-MIT` を参照してください。
