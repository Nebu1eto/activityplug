@activityplug/mastodon
======================

[English](README.md) | [한국어](README.ko.md) | 日本語

ActivityPlug 用の Mastodon アダプターです。


インストール
------------

~~~~ sh
pnpm add @activityplug/mastodon
~~~~

Node.js 26 以降が必要です。このパッケージは ECMAScript モジュールを使用します。


使用方法
--------

~~~~ ts
import * as activityplug from "@activityplug/mastodon";
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

Mastodon は既定で `authorization-header` ストリーミングモードを使用します。
認証済みストリームでは、アダプターはトークンをファクトリーの
`options.authorization` として渡し、ストリーミング URL はトークンを含みません。
ファクトリーはこの値を WebSocket の `Authorization` ヘッダーとして転送する必要が
あります。通知されたエンドポイントが別オリジンの場合、権限にはインスタンス
オリジンからストリーミングオリジンへの正確な方向付き grant も必要です。この
grant は認証情報クラス `oauth-access-token`、表現 `authorization-header`、
実際の公開操作 `stream.timeline` または `stream.notifications` を使用します。
同一オリジンの認証済みストリームに別オリジンの grant は不要です。匿名
ストリームには認証値が渡されないため認証情報 grant も不要ですが、ファクトリー
の送信ポリシーは引き続き適用されます。認証済みストリームには暗号化された
`wss:` ターゲットが必要です。


ライセンス
----------

Apache-2.0 OR MIT の条件でライセンスされます。`LICENSE-APACHE` と
`LICENSE-MIT` を参照してください。
