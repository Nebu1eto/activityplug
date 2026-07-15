@activityplug/server
====================

[English](README.md) | [한국어](README.ko.md) | 日本語

ActivityPlug の GraphQL および HTTP サーバーインターフェースを提供します。


インストール
------------

~~~~ sh
pnpm add @activityplug/server
~~~~

Node.js 26 以降が必要です。このパッケージは ECMAScript モジュールを使用します。


使用方法
--------

~~~~ ts
import * as activityplug from "@activityplug/server";
~~~~

パッケージルートは、サポートされる公開 API を公開します。このリリースで
利用可能な正確な契約については、エクスポートされた型を参照してください。


コマンドラインサーバー
----------------------

このパッケージは `activityplug-server` バイナリをインストールします。最小構成
のサーバーはループバックのポート 4000 にバインドします。

~~~~ sh
pnpm exec activityplug-server
~~~~

リスナーを変更するには `--host` と `--port` を使用します。ランタイムから接続
できる各 HTTPS リモート ActivityPub サーバーについて `--allow-origin` を繰り
返し指定します。プライベートネットワークまたはループバック宛ての場合は、
`--allow-private-networks` も必要です。

~~~~ sh
pnpm exec activityplug-server \
  --host 0.0.0.0 \
  --port 8080 \
  --allow-origin https://social.example
~~~~

`--browser-origin` がなければブラウザールートは無効です。CLI のブラウザー
モードは開発専用であり、32 バイト以上のパディングなし base64url 署名キーと、
明示的なインメモリストレージが必要です。

~~~~ sh
export ACTIVITYPLUG_BROWSER_COOKIE_SIGNING_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
pnpm exec activityplug-server \
  --browser-origin https://client.example \
  --browser-memory-stores \
  --trusted-proxy 10.0.0.10
~~~~

`--trusted-proxy` には正確な IP アドレスを指定し、複数回使用できます。直近の
ピアがこの一覧に含まれる場合に限り、転送されたクライアントアドレスヘッダーを
信頼します。CLI のブラウザーモードを本番環境で使用しないでください。セッ
ション、OAuth 状態、ストリームチケット、レート制限、チャレンジはプロセス内
だけに存在し、再起動時に失われます。本番環境では
`createActivityPlugServer()` を通じて永続ストアを設定してください。

匿名ブラウザーセッションは既定で stateless です。embedding が
`anonymousSessionMode: "stored"` を選択すると、すべての割り当てはストアの
アトミックな admission 操作を使用します。`storedSessionCapacity` の既定値は
live セッション 10,000 件、`storedSessionCapacityPerClient` は 16 件、
`storedSessionCreationLimit` は 60 秒の
`storedSessionCreationWindowMilliseconds` ごとに 32 回です。信頼された
client-IP resolver がクライアント単位の識別子を提供し、ストアにはその HMAC
だけを保存します。

認証済みリモート操作が認証情報の発行元とは異なるオリジンへ認証情報を送る
場合は、`createActivityPlugServer()` の `remoteCredentialGrants` を使用して
ください。各 grant では、発行元、受信先、公開操作、認証情報クラス、表現が
すべて正確に一致する必要があります。サーバーは、認証済み WebSocket の検査を
含め、これらの grant を検証済み `RemoteAuthority` に渡します。同一オリジンの
操作と匿名操作に別オリジンの認証情報 grant は不要です。

生成された全オプションの説明は `pnpm exec activityplug-server --help` で確認
できます。


ライフサイクル
--------------

`createActivityPlugServer()` は自身が所有するセキュリティ状態ライフサイクルを
開始し、その開始処理を `ready` として公開します。リクエストは `ready` を待機
します。アプリケーションも準備完了を通知する前に待機してください。`start()`
は Node リスナーを返します。

~~~~ ts
const activityPlug = createActivityPlugServer({ adapters });

await activityPlug.ready;
activityPlug.start({ hostname: "127.0.0.1", port: 4000 });

try {
  // アプリケーションを実行します。
} finally {
  await activityPlug.close();
}
~~~~

`close()` は冪等です。このサーバーから作成したリスナーと、サーバーが所有する
セキュリティ状態ライフサイクルだけを閉じます。
`await activityPlug[Symbol.asyncDispose]()` も同じ動作です。ストアクライアント
などの注入されたリソースは呼び出し側が所有します。クリーンアップワーカーが
閉じた依存先を使わないよう、サーバーの後で閉じてください。


ライセンス
----------

Apache-2.0 OR MIT の条件でライセンスされます。`LICENSE-APACHE` と
`LICENSE-MIT` を参照してください。
