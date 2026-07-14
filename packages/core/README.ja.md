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
