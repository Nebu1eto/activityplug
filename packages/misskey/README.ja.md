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
必要です。サーバーアプリケーションは独自の送信ポリシーと DNS 固定を適用する
必要があるため、アダプターはグローバル WebSocket 実装を使用しません。

認証済みのタイムライン、通知、URL メディア操作では、アダプターは
`WebSocketFactoryCallOptions.authorization` を通じて `Bearer ...` 値を渡し
ます。ファクトリーはその値を WebSocket ハンドシェイクの `Authorization`
ヘッダーに設定する必要があります。アクセストークンが `i` クエリパラメーター
に書き込まれることはなく、従来のクエリへのフォールバックもありません。この
ヘッダーを設定できないファクトリーまたはランタイムでは、該当する認証操作を
安全に提供できません。

認証済みのタイムライン、通知、URL メディア WebSocket は、検出結果が Misskey
13.14.0 以降の場合に限り有効です。未知、より古い、または Misskey ではない
結果では、ソケットを開く前に型付き `UNSUPPORTED_OPERATION` で失敗します。
アダプターは実際の公開操作を `WebSocketFactoryCallOptions.operation` として
渡します。操作名は `stream.timeline`、`stream.notifications`、または
`media.ingestUrl` です。これらのソケットは検出されたインスタンスオリジンと
`authorization-header` 表現を使用するため、別オリジンの認証情報 grant は
不要です。匿名ストリーミングはバージョンと認証情報の検査を省略しますが、注入
されたファクトリーとその送信ポリシーは引き続き使用します。URL メディア取り
込みは認証済み操作であり、匿名のフォールバックはありません。

直接クライアントは、信頼できるインスタンス検出を通じてソフトウェアプロファイル
を取得し、運用クライアントに `detectedSoftware` として渡す必要があります。
クライアントを再構築するときは、同じアダプター、オリジン、検証済み authority
を再利用してください。

~~~~ ts
const detector = createActivityPlugClient({ adapter, origin, remoteAuthority });
const profile = await detector.instances.detect();
const client = createActivityPlugClient({
  adapter,
  origin,
  remoteAuthority,
  detectedSoftware: profile.software,
});
~~~~

信頼できない呼び出し元の入力から `detectedSoftware` を設定しないでください。
サーバーランタイムは信頼できる検出を実行し、このオプションを自動的に渡します。


ライセンス
----------

Apache-2.0 OR MIT の条件でライセンスされます。`LICENSE-APACHE` と
`LICENSE-MIT` を参照してください。
