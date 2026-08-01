サーバの使い方
==============

[English](/en/server-usage.md) | [한국어](/ko/server-usage.md) | 日本語

`@activityplug/server` はコマンドラインプロセスとして、または Node.js
アプリケーションの一部として実行できます。どちらの形式でも公開 HTTP
API、GraphQL、WebSocket
ストリームを提供します。プログラムから構築する場合は永続ストア、依存関係の
readiness チェック、 カスタム制限、ブラウザ BFF もサポートします。


サーバをインストールする
------------------------

Node.js 26 以降が必要です。

~~~~ sh
pnpm add @activityplug/server @activityplug/core @hono/node-server @logtape/logtape graphql hono
~~~~

アプリケーションがインポートするアダプタを追加します。

~~~~ sh
pnpm add @activityplug/mastodon
~~~~


CLI を実行する
--------------

CLI にはパッケージ化されたすべてのアダプタが含まれ、ループバックの
ポート 4000 で待ち受けます。

~~~~ sh
pnpm exec activityplug-server \
  --allow-origin https://social.example
~~~~

`--allow-origin` を省略するとリモート origin 許可リストは空になります。
接続する HTTPS ActivityPub サーバごとにこのオプションを繰り返し指定して
ください。

~~~~ sh
pnpm exec activityplug-server \
  --host 0.0.0.0 \
  --port 8080 \
  --allow-origin https://social.example \
  --allow-origin https://community.example
~~~~

`--allow-private-networks` は origin ポリシが origin を許可した後で
プライベートアドレスやループバックアドレスへのネットワーク接続を許可
します。origin 許可リスト自体を緩和するものではありません。

ブラウザアプリケーションを配信する場合は `--browser-origin` に公開 HTTPS
origin を指定し、`ACTIVITYPLUG_BROWSER_COOKIE_SIGNING_KEY` を設定します。
CLI ではインメモリのブラウザストアを意図的に使うことを確認するため
`--browser-memory-stores` が必須です。

~~~~ sh
pnpm exec activityplug-server \
  --allow-origin https://social.example \
  --browser-origin https://localhost:8443 \
  --browser-memory-stores
~~~~

リバースプロキシの背後でサーバを実行する場合は `--trusted-proxy` で
`X-Forwarded-For` ヘッダを信頼するプロキシアドレスを指定します。プロキシ
ごとにオプションを繰り返してください。

~~~~ sh
pnpm exec activityplug-server \
  --allow-origin https://social.example \
  --browser-origin https://app.example \
  --trusted-proxy 10.0.0.2 \
  --trusted-proxy 10.0.0.3
~~~~

CLI は起動前にホスト、ポート、origin、ブラウザ設定、署名キー、信頼済み
プロキシアドレスを検証します。生成されたリファレンスは `--help` で確認
してください。


サーバを構築する
----------------

プログラムから設定する場合はアダプタの構築、リモート権限、リスナを
分離します。

~~~~ ts
import { createMastodonAdapter } from "@activityplug/mastodon";
import {
  createActivityPlugServer,
  createNodePinnedWebSocketFactory,
  createOriginPolicy,
  nodeLookupAddresses,
} from "@activityplug/server";

const originPolicy = createOriginPolicy(["https://social.example"]);
const webSocket = createNodePinnedWebSocketFactory({
  originPolicy,
  lookup: nodeLookupAddresses,
});

const activityPlug = createActivityPlugServer({
  adapters: [createMastodonAdapter({ webSocket })],
  originPolicy,
  tokenImport: { enabled: false },
});

await activityPlug.ready;
const listener = activityPlug.start({
  hostname: "127.0.0.1",
  port: 4000,
});
~~~~

ストリーミングを実装するアダプタには WebSocket ファクトリの注入が必要
です。Node 固定ファクトリは設定済み origin ポリシと DNS アドレス検査を
WebSocket 接続に適用します。

`originPolicy` を省略するとサーバはすべてのリモート origin を拒否します。
厳密な許可リストには `createOriginPolicy()` を使うか、アプリケーション
固有の同等チェックを行う `OriginPolicy` を指定してください。

`allowPrivateNetworks: true` はプライベートアドレスやループバックアドレス
への接続を意図的に許可する場合にのみ設定してください。origin 許可リスト
自体を緩和するものではありません。


ライフサイクルと所有権
----------------------

`createActivityPlugServer()` はセキュリティ状態のライフサイクルを直ちに
開始し、起動状態を `ready` として公開します。統合された Hono
アプリケーションはリクエスト処理前に `ready` を待機します。
アプリケーション側でも準備完了を通知する前に待機する必要があります。

`start()` は Node リスナを作成し、サーバオブジェクト、ホスト名、ポートを
返します。プログラムからの起動ではポート `0` も有効で、OS が利用可能なポートを
選択します。返される `StartedServer.port` は設定値 `0` のままです。
割り当てられたポートは `listening` イベント後に
`StartedServer.server.address()` で取得してください。

~~~~ ts
try {
  await activityPlug.ready;
  activityPlug.start({ hostname: "0.0.0.0", port: 4000 });
  await runApplication();
} finally {
  await activityPlug.close();
  await databasePool.end();
}
~~~~

`close()` は冪等です。この `ActivityPlugServer` を通じて作成されたすべて
のリスナ、ブラウザ境界、サーバが作成したセキュリティ状態ライフサイクルを
閉じます。注入されたストア、データベースプール、Redis クライアントなど
呼び出し元が所有するリソースは閉じません。バックグラウンドクリーンアップ
が閉じたクライアントを参照しないよう、サーバの後で閉じてください。

`await activityPlug[Symbol.asyncDispose]()` は
`await activityPlug.close()` と同等です。

`startActivityPlugServer()` は既存の `ActivityPlugApiService` や Hono
アプリケーション向けの低レベルヘルパです。`createActivityPlugServer()` の
所有権・ライフサイクル集約は提供しません。


ヘルスチェックと readiness
--------------------------

`GET /health` は API バージョンと readiness を返します。

~~~~ json
{
  "data": {
    "ok": true,
    "version": "v1"
  }
}
~~~~

`ok` が true ならレスポンスステータスは `200`、それ以外は `503` です。
`readiness` コールバックがなければサーバ起動後にプロセスを準備完了として
報告します。永続的な依存関係を含める場合はコールバックを指定してください。

~~~~ ts
const activityPlug = createActivityPlugServer({
  adapters,
  originPolicy,
  sessions,
  oauthClientSecrets,
  readiness: async () => {
    const [database, redisStatus] = await Promise.all([
      databasePool.query("select 1"),
      redis.ping(),
    ]);
    return database.rowCount === 1 && redisStatus === "PONG";
  },
});
~~~~

reject された readiness コールバックは異常として扱われます。依存関係固有
のタイムアウトでコールバックを制限し、ヘルスリクエストが無期限に待機
しないようにしてください。


公開 API サーフェス
-------------------

公開ルートは ActivityPlug セッション ID を Bearer credential として使い
ます。URL やリクエストボディ内のセッション ID は拒否されます。

| エントリポイント                       | 契約                                    |
| -------------------------------------- | --------------------------------------- |
| `GET /api/v1`                          | API バージョンとディスカバリリンク      |
| `/api/v1/*`                            | バージョン付き JSON・multipart HTTP API |
| `GET /api/v1/openapi.json`             | 生成された OpenAPI ドキュメント         |
| `POST /graphql`                        | GraphQL クエリとミューテーション        |
| `GET /api/v1/streams`                  | ストリームプロトコルとイベント名        |
| `GET /api/v1/streams/timelines/home`   | 認証済みホーム WebSocket                |
| `GET /api/v1/streams/timelines/public` | 公開またはローカル WebSocket            |
| `GET /api/v1/streams/notifications`    | 認証済み通知 WebSocket                  |

HTTP と GraphQL のサーフェスは同じ `ActivityPlugApiService` を呼び出し、
同じドメイン操作をトランスポート固有のエンベロープでシリアライズします。
個々のフィールドと入力は OpenAPI ドキュメントおよび GraphQL スキーマを
参照してください。

呼び出し元が同じプロセス内で実行される場合は `server.service` を使います。
HTTP ホップを省略しつつ、アダプタ選択、セッション検証、origin ポリシ、
リクエストキャンセル、capability 処理を維持します。


認証とトークンインポート
------------------------

選択したアダプタがサポートしていれば OAuth、メールチャレンジ、パスキー
ルートを利用できます。公開 HTTP・GraphQL セッションは呼び出し元に返され、
Bearer credential として指定します。

raw トークンインポートは `tokenImport.enabled` が true の場合にのみ有効
です。`guard` なしで有効にすると、ルートに到達できるすべての呼び出し元に
開放されます。本番アプリケーションではインポートを無効にするか、認可ガードを指定
してください。

認証レスポンスには `Cache-Control: no-store` が付与されます。GraphQL
レスポンスにも `no-store` が付与されます。

ブラウザアプリケーションでは ActivityPlug セッション ID をブラウザの
JavaScript に保存せず、cookie BFF を有効にしてください。
[ブラウザ統合](browser-integration.md)を参照してください。


ストアの選択
------------

サーバには開発・テスト用のインメモリ実装が含まれています。

 -  認証セッションと OAuth クライアントシークレット
 -  ブラウザセッションと OAuth state
 -  ストリームチケット
 -  認証開始レート制限
 -  短期認証チャレンジ

これらのストアはプロセスローカルであり、再起動するとレコードが失われ
ます。複数のサーバレプリカ間で連携させることもできません。

セッションやブラウザフローを再起動後も維持する場合、または複数レプリカで
実行する場合は永続ストアを注入してください。
`@activityplug/session-postgres` は永続的な認証セッション、ブラウザ
セッション、OAuth state、OAuth クライアントシークレットのストアを提供
します。`@activityplug/session-redis` はストリームチケット、レートリミッ
タ、短期キャッシュのストアを提供します。

永続認証セッションストアは永続 `oauthClientSecrets` ストアと組み合わせる
必要があります。OAuth コールバック完了に必要なシークレットが失われたまま
コールバックだけが残る可能性があるため、サーバは永続セッションストアと
デフォルトのインメモリシークレットストアの組み合わせを拒否します。

`credentialLeases` オプションを指定すると、OAuth クライアントシークレットの
解決に使うカスタム `CredentialLeaseStore` を提供できます。デフォルトでは
`oauthClientSecrets` から導出されます。credential リースとクライアント
シークレットのストレージを分離するアプリケーションで使用してください。

アプリケーション側でストアの初期化とスキーマ migration を管理します。
`examples/web-client` サーバは永続セッションレコードに PostgreSQL、
使い捨てまたは短期の調整に Redis を使う分割例を示します。


ブラウザ境界
------------

同じ Hono アプリケーションに `/v1/browser/*` ルートを追加するには
`browser` 設定を渡します。

~~~~ ts
const activityPlug = createActivityPlugServer({
  adapters,
  originPolicy,
  sessions,
  oauthClientSecrets,
  browser: {
    publicOrigin: "https://app.example",
    cookieSigningKey,
    browserSessions,
    oauthStates,
    streamTickets,
    authStartLimiter,
    authChallenges,
    clientIp,
  },
});
~~~~

`publicOrigin` は credential、パス、クエリ、フラグメントを含まない HTTPS
origin でなければなりません。署名キーには 32 バイト以上が必要です。
サーバをリバースプロキシの背後で実行する場合は信頼できるクライアント IP
リゾルバを使ってください。任意のピアからの forwarding ヘッダを信頼しては
いけません。


制限とリモート credential
-------------------------

`requestLimits` はトランスポート処理を制限します。対象は JSON・GraphQL
リクエストのバイト数、multipart の合計とファイル、リモート構造化レスポンス
のバイト数、WebSocket バッファとキュー内イベントです。`graphqlLimits` は
別途 GraphQL のエイリアス、深さ、複雑度、サービスへの同時リゾルバ呼び出し
を制限します。

`createBudgetScope` は操作単位の外向き処理境界です。返される
`BudgetScope` は 1 つの公開操作でアダプタが実行するリモートリクエスト、
読み取り、バイト、ノード、同時実行数、経過時間を制限できます。GraphQL
リゾルバの同時実行数やトランスポートのバイト制限とは独立です。
トランスポート制限と GraphQL 制限にはデフォルトがありますが、操作バジェット
が必要なアプリケーションはファクトリを指定する必要があります。

リモートトランスポートとバジェットの境界は
[セキュリティモデル](security-model.md)を参照してください。

リモート credential はデフォルトで発行元 origin にバインドされます。
操作で別の origin に credential を送信する必要がある場合は、発行元、
受信先、公開操作、credential クラス、表現について厳密な
`remoteCredentialGrants` エントリを設定してください。匿名操作と同一
origin 操作にはこの許可は不要です。


CORS
----

`cors` オプションは `@hono/cors` にそのまま渡されます。公開 HTTP API や
GraphQL API へクロスオリジンアクセスが必要な、信頼できる非ブラウザ BFF
クライアントに限り設定してください。credential 付き CORS ではワイルド
カード origin を使えません。

ブラウザ BFF は同一 origin リクエストを前提とし、公開 API の CORS とは
独立して cookie と CSRF のチェックを行います。ブラウザクライアントでは
CORS 設定は通常不要です。


ロギング
--------

`configureServerLogging()` は `activityplug` カテゴリの LogTape コンソール
ロガーを設定します。CLI は自動的に呼び出します。プログラムでサーバを構築
するアプリケーションは起動前に呼び出すか、LogTape を直接設定できます。

~~~~ ts
import { configureServerLogging } from "@activityplug/server";

await configureServerLogging({ level: "debug" });
~~~~

指定できるオプションは `level`（LogTape のログレベル、デフォルト
`"info"`）、`sink`（カスタム LogTape `Sink`）、`force`（LogTape が設定済み
でも再設定する）です。アプリケーション独自の LogTape 設定がある場合、
`force` が true でなければ `configureServerLogging()` は何もしません。


Openapi ドキュメント
--------------------

`/api/v1/openapi.json` は生成された OpenAPI 3.1 ドキュメントを配信します。
プログラムで生成することもできます。

~~~~ ts
import { createOpenApiDocument } from "@activityplug/server";

const doc = createOpenApiDocument({ tokenImport: "guarded" });
~~~~

`tokenImport` オプションはトークンインポートルートの表示方法を制御します。
`"open"`、`"guarded"`、`"disabled"`（デフォルト）のいずれかを指定します。
生成されるドキュメントはサーバが公開するルートと同じ内容を反映します。


次のステップ
------------

 -  [ブラウザ統合](browser-integration.md)
 -  [認証とセッション](authentication-and-sessions.md)
 -  [セッションストレージ](session-storage.md)
 -  [セキュリティモデル](security-model.md)
 -  [エラーとトラブルシューティング](errors-and-troubleshooting.md)
 -  [`@activityplug/server` パッケージ README]

[`@activityplug/server` パッケージ README]: https://github.com/Nebu1eto/activityplug/blob/main/packages/server/README.md
