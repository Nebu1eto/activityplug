@activityplug/core
==================

[English](README.md) | [한국어](README.ko.md) | 日本語

ActivityPlug
の中核となる契約、型、識別子、機能、およびサービスインターフェースを提供します。


インストール
------------

~~~~ sh
pnpm add @activityplug/core
~~~~

Node.js 26 以降が必要です。このパッケージは ECMAScript モジュールを使用します。


使用方法
--------

~~~~ ts
import * as activityplug from "@activityplug/core";
~~~~

パッケージルートは、サポートされる公開 API を公開します。このリリースで
利用可能な正確な契約については、エクスポートされた型を参照してください。


リモートトランスポートの移行
----------------------------

`createActivityPlugClient()` は raw `fetch` オプションを受け付けず、
`globalThis.fetch` にフォールバックしなくなりました。リモート操作には明示的な
`RemoteAuthority` が必要です。指定しない場合、最初のリモート操作はネット
ワーク I/O より前に `ORIGIN_NOT_ALLOWED` で失敗します。

~~~~ ts
import { createActivityPlugClient, createRemoteAuthority } from "@activityplug/core";

const client = createActivityPlugClient({
  adapter,
  origin: "https://social.example",
  remoteAuthority: createRemoteAuthority({ transport: vettedTransport }),
});
~~~~

`vettedTransport` は、ランタイムの宛先、DNS、プライベートネットワーク、応答
上限を事前に適用する必要があります。raw グローバル fetch の直接指定は拒否
されます。ブラウザーランタイムに限り、`createBrowserRemoteAuthority()` で
ブラウザーの fetch 境界を明示的に選択できます。ActivityPlug サーバーは独自の
検証済み権限を構築するため、このクライアント設定は不要です。

権限は同一オリジンの認証情報を既定で許可します。オリジンをまたぐ認証情報
には、発行元、受信先、公開操作、認証情報クラス、表現がすべて正確に一致する
方向付き `credentialGrants` エントリーが必要です。対応する表現は
`authorization-header`、`cookie-header`、`form-body`、`json-body`、
`websocket-subprotocol` です。匿名操作は認証情報を運ばないため、認証情報の
grant は不要です。

一致する本文 grant がない別オリジンのフォームまたは JSON 本文は、リクエスト
の複製から最大 64 KiB だけ検査され、元の本文はトランスポートで引き続き利用
できます。未知の本文形式やこの上限を超える本文は、ネットワーク I/O より前に
拒否されます。URL のユーザー情報や既知のクエリパラメーターに含まれる認証情報
は常に拒否され、URL へのフォールバックはありません。


WebSocket アダプター用ユーティリティ
------------------------------------

パッケージルートには、`WebSocketFactory` を注入するアダプター作成者向けの
サポート対象ユーティリティが含まれます。ファクトリー呼び出しには信頼済みの
操作名が渡され、`WebSocketFactoryCallOptions` を通じて `Authorization`
ヘッダー値を受け取れます。`resolveWebSocketFactoryResult()`
は同期ファクトリーを維持し、非同期ファクトリーの待機を `AbortSignal` で
制限し、キャンセル後に到着したソケットを閉じます。
`streamWebSocketMessages()` は JSON メッセージを解析し、停止した
コンシューマーのキューを 256 イベントおよび 1 MiB のデータに制限します。
上限超過は `REQUEST_LIMIT_EXCEEDED` として報告されます。

`closeWebSocketSafely()` は、終了中にエラーイベントを発生させる可能性が
ある Node 互換ソケットを処理し、`webSocketFrameByteLength()` は対応する
フレームデータのサイズを測定します。関連する
`MAX_STREAMING_QUEUED_EVENTS` および `MAX_STREAMING_QUEUED_BYTES` 定数も
公開契約に含まれます。


ライセンス
----------

Apache-2.0 OR MIT の条件でライセンスされます。`LICENSE-APACHE` と
`LICENSE-MIT` を参照してください。
