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
HTTP API と異なるホストを使用する場合があります。匿名の公開ストリームでは、
ファクトリーが許可すればこの通知されたエンドポイントを使用できます。

認証済みストリームは bearer トークンを URL に含めません。アダプターは
Akkoma および Pleroma 2.7.1 以降で WebSocket サブプロトコルを使用します。
それより古い、またはバージョンを確認できない Pleroma は、ソケットを開く前に
型付き `UNSUPPORTED_OPERATION` で失敗します。認証済みストリームには暗号化
された `wss:` も必要です。通知されたエンドポイントが別オリジンの場合、権限
にはインスタンスオリジンからストリーミングオリジンへの正確な方向付き grant
が必要です。この grant は認証情報クラス `oauth-access-token`、表現
`websocket-subprotocol`、実際の公開操作 `stream.timeline` または
`stream.notifications` を使用します。同一オリジンの認証済みストリームに
別オリジンの grant は不要です。匿名ストリームはサブプロトコル認証情報を運ば
ないため認証情報 grant も不要ですが、ファクトリーの送信ポリシーは引き続き
適用されます。


ライセンス
----------

Apache-2.0 OR MIT の条件でライセンスされます。`LICENSE-APACHE` と
`LICENSE-MIT` を参照してください。
