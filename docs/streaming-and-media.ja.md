ストリーミングとメディア
========================

[English](streaming-and-media.md) |
[한국어](streaming-and-media.ko.md) | 日本語

ActivityPlug はタイムラインと通知の WebSocket を非同期イベントストリーム
として正規化します。ローカルファイルのアップロードとサーバー側 URL
取り込みは、対応範囲とセキュリティ特性が異なるため別の操作として提供
します。


ストリーミング対応
------------------

| アダプター     | タイムライン                                        | 通知                                       | Conversation |
| -------------- | --------------------------------------------------- | ------------------------------------------ | ------------ |
| Mastodon       | 検出した対応状況                                    | 検出した対応状況                           | 未対応       |
| Pleroma/Akkoma | 検出した対応状況                                    | 検出した対応状況                           | 未対応       |
| Misskey        | 注入したファクトリー、認証時は Misskey 13.14.0 以降 | 注入したファクトリー、Misskey 13.14.0 以降 | 未対応       |
| HackersPub     | 未対応                                              | 未対応                                     | 未対応       |
| Hollo          | 未対応                                              | 未対応                                     | 未対応       |

Mastodon 互換の検出では、注入したファクトリー、通知されたストリーミング
endpoint、ソフトウェアファミリー、バージョン、endpoint の暗号化を確認
します。Misskey はファクトリーがある場合にタイムラインと通知の
ストリーミングを対応と報告し、credential を使う場合は信頼できるバージョン
検査も適用します。


WebSocket ファクトリー
----------------------

アダプターはグローバル WebSocket を作成しません。ホストが
`WebSocketFactory` を注入します。

~~~~ ts
type WebSocketFactory = (
  url: string,
  protocols?: string | string[],
  signal?: AbortSignal,
  options?: {
    readonly operation: string;
    readonly authorization?: string;
  },
) => WebSocket | Promise<WebSocket>;
~~~~

ファクトリーはセキュリティ境界であり、次の処理が求められます。

 -  デプロイ先の origin allowlist を適用する
 -  接続前に許可された公開アドレスを resolve して pin する
 -  渡された abort signal を保持する
 -  ランタイムに適した接続上限とフレーム上限を適用する
 -  値がある場合は `options.authorization` を WebSocket HTTP の
    `Authorization` ヘッダーへ設定する
 -  資格情報を漏らす可能性がある URL、protocol、authorization 値、
    エラーをログに出力しない

ブラウザー標準の `WebSocket` コンストラクタは任意の `Authorization`
ヘッダーを設定できません。トークンを URL に入れてヘッダーの代用としない
でください。handshake ヘッダーに対応するサーバー側 WebSocket 実装を
使うか、認証済みストリーミングを提供しない構成にします。

`options.operation` には公開操作の `stream.timeline`、
`stream.notifications`、または Misskey URL 取り込みの
`media.ingestUrl` が入ります。検証済みファクトリーはポリシーの適用に
この値を使えます。


資格情報の表現
--------------

ActivityPlug はストリーミング資格情報を query parameter と URL userinfo
に入れません。資格情報に似た parameter を含む通知済みストリーミング URL
は拒否します。

対応する表現はアダプターごとに異なります。

| アダプター           | 資格情報の表現          |
| -------------------- | ----------------------- |
| Mastodon             | `authorization-header`  |
| Pleroma 2.7.1 以降   | `websocket-subprotocol` |
| Akkoma               | `websocket-subprotocol` |
| Misskey 13.14.0 以降 | `authorization-header`  |

authorization-header モードではアダプターが完全な `Bearer ...` 値を
`options.authorization` として渡します。subprotocol モードではトークンを
WebSocket protocol 値として渡します。ファクトリーは指定された表現を保持
する必要があります。

認証済み socket には `wss:` が必要です。匿名タイムラインストリームでは
許可された plaintext endpoint を使えますが、ホストの外部接続ポリシーは
引き続き適用されます。通知ストリームには常にセッションが必要です。


通知された endpoint と origin grant
-----------------------------------

Mastodon 互換インスタンスは `configuration.urls.streaming` または旧式の
`urls.streaming_api` でストリーミング endpoint を通知できます。
アダプターはその endpoint を使い、パスを `/api/v1/streaming/` へ正規化
します。通知された endpoint がない場合はインスタンス origin を fallback
として使えます。

ストリーミング endpoint の origin は HTTP API と異なる場合があります。
その origin へ資格情報を送るには、方向を正確に指定した
`RemoteCredentialGrant` が必要です。

~~~~ ts
const credentialGrants = [
  {
    issuer: "https://social.example",
    recipient: "https://stream.example",
    operation: "stream.timeline",
    credentialClass: "oauth-access-token",
    representations: ["authorization-header"],
  },
] as const;
~~~~

grant には方向と操作が指定されています。タイムライン用 grant は通知、
逆方向の origin の組、別の資格情報クラス、別の表現を許可しません。
Pleroma と Akkoma では `authorization-header` の代わりに
`websocket-subprotocol` を使います。

同一 origin の認証済み socket は remote authority が許可した同一 origin
表現を使うため、cross-origin grant は不要です。Misskey は検出した
インスタンス origin を socket に使うため、現在の認証済みストリームと
URL 取り込みは同一 origin です。


ストリームの利用
----------------

ストリームは `AsyncIterable<StreamEvent>` を返します。

~~~~ ts
const stream = await client.streams.timeline({
  type: "home",
  session,
  signal: abortController.signal,
});

for await (const event of stream) {
  if (event.type === "timeline.update") {
    console.log(event.post);
  }
  if (event.type === "delete") {
    console.log(event.deleted.ref);
  }
}
~~~~

タイムライン種別は `home`、`public`、`local`、`hashtag`、`list` です。
認証要件はサーバーとバージョンにより異なります。選択したタイムラインまた
はインスタンスが要求する場合はセッションを渡します。キャンセルすると
iteration が終了し socket を安全に閉じます。

アダプターは認識したリモートイベントを次の値へ正規化します。

 -  `timeline.update`
 -  `notification`
 -  `delete`
 -  `edit`
 -  `filters.changed`
 -  `heartbeat`

すべてのアダプターがすべてのイベント型を出力するわけではありません。
認識したイベントの形式が不正な場合は型付き protocol error で失敗し、
未知のリモートイベント型は無視できます。


ローカルファイルのメディアアップロード
--------------------------------------

`client.media.upload` は呼び出し元が指定した `Blob` を送信します。

~~~~ ts
const attachment = await client.media.upload({
  session,
  file,
  filename: "photo.jpg",
  description: "A view across the harbor",
});
~~~~

対応範囲はアダプターごとに異なります。

 -  Mastodon のアップロードはバージョンに依存します。ActivityPlug は
    可能であれば非同期メディア endpoint を使います。
 -  Pleroma と Akkoma はメディアアップロードに対応します。
 -  Misskey はアップロード、metadata 更新、削除に対応します。
 -  Hollo はアップロードと metadata 更新に対応しますが、削除には
    対応しません。
 -  HackersPub の移植可能な `media.upload` capability は未対応です。
    マッピングした投稿作成 mutation では、アップロード画像を添付
    できません。

Mastodon 互換のアップロード処理は `sensitive: true` を拒否します。
metadata 更新処理は `false` を含め `sensitive` フィールドが存在すると
拒否します。Misskey はアップロードと metadata 更新の両方で sensitivity
に対応します。

アップロードした attachment は自動的には投稿されません。対応する投稿
作成操作へ opaque media ID を渡します。入力を組み合わせる前に投稿と
メディアの capability 制約を確認してください。


URL メディア取り込み
--------------------

`client.media.ingestUrl` はリモートサーバーへ URL の取得を依頼します。

~~~~ ts
const attachment = await client.media.ingestUrl({
  session,
  url: "https://media.example/photo.jpg",
  signal: abortController.signal,
});
~~~~

この操作を実装するのは Misskey と HackersPub だけです。

Misskey は `drive/files/upload-from-url` を開始し、認証済みの同一
origin WebSocket で完了イベントを待ちます。注入したファクトリー、
信頼できる方法で検出した Misskey 13.14.0 以降、`wss:`、
authorization-header 対応が必要です。description と sensitivity の値は
転送されます。

HackersPub は GraphQL URL-upload mutation を呼び出します。WebSocket は
使いませんが、マッピングした mutation では値を保存できないため
description と sensitivity を拒否します。

Mastodon、Pleroma/Akkoma、Hollo はマッピング済みの URL 取り込み
endpoint を公開しません。ActivityPlug はリソースをアプリケーション側へ
ダウンロードして暗黙に再アップロードする fallback を実装しません。
その処理はネットワーク信頼、リソース制限、失敗のセマンティクスを変更
します。


失敗の処理
----------

ストリーミングとメディアの操作は型付きの `ActivityPlugError` コードを
使います。主な例は次のとおりです。

 -  ファクトリー、バージョン、endpoint、リモート機能が利用できない
    場合の `UNSUPPORTED_OPERATION`
 -  セッションがない、または期限切れの場合の `AUTH_REQUIRED` と
    `AUTH_EXPIRED`
 -  許可されていない資格情報の送信先や表現、暗号化されていない認証済み
    socket に対する `ORIGIN_NOT_ALLOWED`
 -  検証済みの接続が失敗した場合の `NETWORK_ERROR`
 -  認識したイベントの形式が不正な場合の `REMOTE_PROTOCOL_ERROR`
 -  上限付きストリームやフレームが上限を超えた場合の
    `REQUEST_LIMIT_EXCEEDED`

アダプター、インスタンス、設定を変更せずに `UNSUPPORTED_OPERATION` を
再試行しないでください。再接続ポリシーはアプリケーションが管理します。
アダプターはストリームと abort の動作を公開しますが、接続の反復失敗を
隠しません。

capability の選択については
[アダプターと capability](adapters-and-capabilities.ja.md) を、HTTP と
WebSocket の外部接続ポリシーについては
[セキュリティモデル](security-model.ja.md)を参照してください。
