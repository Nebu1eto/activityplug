ブラウザ統合
============

[English](/en/browser-integration.md) |
[한국어](/ko/browser-integration.md) | 日本語

ActivityPlug のブラウザ境界はブラウザ向けバックエンド (BFF) です。
ActivityPlug の認証セッションを HttpOnly cookie の背後に保持し、同一
origin の Web アプリケーション向けに `/v1/browser/*` API を公開します。
ブラウザコードは ActivityPlug セッション ID を受信することも送信する
こともありません。


ブラウザ境界を使う場面
----------------------

以下の要件がある Web アプリケーションではブラウザモードを使ってください。

 -  ブラウザの JavaScript にアクセス credential を保存せず ActivityPub
    サーバ経由で認証する
 -  同一 origin の cookie 認証 API を使う
 -  安全でない mutation リクエストに CSRF チェックを適用する
 -  WebSocket URL にセッション ID を含めず認証済みストリームを開く

credential を自前で保護できるネイティブアプリケーション、信頼済み
サーバ、その他のクライアントは公開 HTTP API や GraphQL API を使えます。


サーバ設定
----------

ブラウザモードには HTTPS 公開 origin、32 バイト以上の署名キー、ブラウザ
セッションストア、ストリームチケットストアが必要です。

~~~~ ts
import {
  createActivityPlugServer,
  InMemoryBrowserSessionStore,
  InMemoryStreamTicketStore,
} from "@activityplug/server";

const activityPlug = createActivityPlugServer({
  adapters,
  originPolicy,
  sessions,
  oauthClientSecrets,
  browser: {
    publicOrigin: "https://app.example",
    cookieSigningKey,
    browserSessions: new InMemoryBrowserSessionStore(),
    streamTickets: new InMemoryStreamTicketStore(),
  },
});
~~~~

省略した OAuth state、認証開始リミッタ、チャレンジの各ストアにはインメモリ
実装がデフォルトで使われます。すべてのインメモリストアは再起動すると状態を
失い、レプリカ間で連携できません。本番環境では永続ストアを指定してください。
[セッションストレージ](session-storage.md)を参照してください。

ローカル開発では公開 origin に `http://localhost`、`http://127.0.0.1`、
`http://[::1]` を使えます。`NODE_ENV` が `production` でなければブラウザ
境界はこれらの HTTP ループバック origin を受け入れ、
`allowInsecureLoopback` でこの既定を双方向に上書きできます。それ以外の
origin は HTTPS を使う必要があります。

このモードでもセッション Cookie は `__Host-` 接頭辞と `Secure` 属性を保ち
ます。Chromium と Firefox はループバックアドレスを信頼できる対象として扱い、
平文 HTTP でもこの Cookie を保存するため、TLS なしでブラウザセッションが
動作します。Safari などの WebKit ブラウザはこの Cookie を破棄するため、
ループバックの HTTP origin では WebKit のセッションを認証できません。
WebKit を試す場合はローカルの HTTPS Compose スタックを使ってください。

ブラウザセッションのデフォルト有効期間は 7 日です。匿名セッションは
デフォルトでステートレスです。匿名の `stored` モードではアトミックな
グローバル制限、クライアント単位制限、レート制限が割り当てに適用されます。
カスタム `clientIp` リゾルバがなければ、サーバは検証済みトランスポート
ピアアドレスを使い、ランタイムがそれを公開しない場合は `unknown` を使い
ます。直接接続された Node リスナは通常ピアアドレスを提供します。ランタイム
が安定したクライアント単位識別子を提供できない場合はリゾルバを指定して
ください。リバースプロキシの背後では既知のプロキシピアからの forwarding
ヘッダだけを受け入れるリゾルバを指定してください。


ブラウザセッションの初期化
--------------------------

mutation の前にセッションを取得します。

~~~~ ts
const response = await fetch("/v1/browser/session", {
  credentials: "same-origin",
});

const session = await response.json();
const csrfToken = session.csrfToken;
~~~~

レスポンスは `BrowserSessionPayload` です。

 -  匿名セッションは `authenticated: false` と `csrfToken` を含みます。
 -  認証済みセッションにはアダプタ、origin、ストラテジ、閲覧者プロフィール、
    capability セットも含まれます。

レスポンスは `Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/` を指定した
`__Host-activityplug` cookie を設定します。`Domain` 属性はありません。
JavaScript は cookie を読み取れず、ブラウザが同一 origin ルートに送信
します。

すべてのブラウザレスポンスは `Cache-Control: no-store` と
`X-Content-Type-Options: nosniff` を使います。


CSRF と同一 origin 規則
-----------------------

認証の開始と完了、投稿とメディアの変更、ストリームチケットの発行、
ログアウトを含む安全でないブラウザ mutation では、現在の CSRF トークン
を `X-ActivityPlug-CSRF` で送信してください。

~~~~ ts
await fetch("/v1/browser/api/posts", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "content-type": "application/json",
    "X-ActivityPlug-CSRF": csrfToken,
  },
  body: JSON.stringify({
    content: "Hello from ActivityPlug",
    visibility: "public",
  }),
});
~~~~

ヘッダ名は `browser.csrf.headerName` で変更できます。サーバはトークンの
ハッシュを constant time で比較します。

安全でないルートは `Origin` ヘッダが一致しないリクエストや
`Sec-Fetch-Site: cross-site` のリクエストも拒否します。この境界に
クロス origin のフロントエンドを設定しないでください。フロントエンドと
`/v1/browser/*` は同じ公開 origin の背後に配置します。

ブラウザルートは以下を拒否します。

 -  すべての `Authorization` ヘッダ
 -  `sessionId` クエリパラメータ
 -  プロダクト API リクエストボディ内の credential フィールドや権限
    フィールド

cookie がブラウザセッションの権限です。アダプタ、origin、ActivityPlug
セッションの選択は認証済みのサーバ側セッションから取得されます。


認証
----

### OAuth

匿名ブラウザセッションから開始します。

~~~~ ts
const response = await fetch("/v1/browser/auth/start", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "content-type": "application/json",
    "X-ActivityPlug-CSRF": csrfToken,
  },
  body: JSON.stringify({
    kind: "oauth",
    origin: "https://social.example",
    adapter: "mastodon",
    returnTo: "/",
  }),
});

const { redirectUrl } = await response.json();
window.location.assign(redirectUrl);
~~~~

サーバは OAuth state をブラウザセッションにバインドし、
`/v1/browser/auth/callback` をコールバックエンドポイントとして使います。
リモートサーバからリダイレクトされた後、コールバックが認証を完了し、
検証済み `returnTo` パスへの `303` リダイレクトを返します。

コールバックは CSRF ヘッダの意図的な例外です。外部 OAuth リダイレクトは
カスタムヘッダを指定できません。代わりにサーバは使い捨て OAuth state
レコードを取得し、ActivityPlug セッションを関連付ける前にブラウザ
セッション ID とコールバックのバインディングが署名済みブラウザ cookie と
一致することを検証します。

`returnTo` は設定済み公開 origin 内に収める必要があります。任意の
リダイレクト URL ではなくローカルナビゲーション先として扱ってください。

### メールチャレンジとパスキー

HackersPub では `POST /v1/browser/auth/start` に送る `kind` として
`emailChallenge` または `passkey` を使えます。開始レスポンスはチャレンジ
ID を提供し、パスキーの場合は公開キーリクエストオプションも提供します。

どちらのフローも `POST /v1/browser/auth/complete`、同じ cookie、現在の
CSRF トークンで完了します。

~~~~ ts
await fetch("/v1/browser/auth/complete", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "content-type": "application/json",
    "X-ActivityPlug-CSRF": csrfToken,
  },
  body: JSON.stringify({
    kind: "emailChallenge",
    challengeId,
    code,
  }),
});
~~~~

認証開始はクライアント IP とリモート origin に基づいてレート制限されます。
`429` レスポンスには `Retry-After` と `retryAfterSeconds` が含まれます。


認証の回復
----------

コールバックまたは完了後に `GET /v1/browser/session` を再取得します。
認証済みペイロードが信頼できる閲覧者と capability のスナップショットです。

API 呼び出しが `UNAUTHENTICATED` または HTTP 401 を返した場合は以下の
手順を実行します。

1.  保留中の状態変更リクエストを停止または中断します。
2.  メモリ内の CSRF トークンを破棄します。
3.  `GET /v1/browser/session` を取得します。
4.  更新後のペイロードが認証済みのままである場合に限り、非公開の
    クライアント状態を維持します。
5.  それ以外の場合はキャッシュ済みの非公開データと下書きを消去し、匿名
    状態をレンダリングします。

更新自体が失敗した場合は非公開のキャッシュ状態を消去し、架空の匿名
セッションをキャッシュせずに更新エラーを表示します。トランスポート障害
だけではサーバ側の認証状態は確定しません。
`examples/web-client/src/state/auth-recovery.ts` の実装は重複する回復
試行を統合し、成功した更新を認証済み状態と匿名状態の間の信頼できる境界
として扱います。

OAuth 交換で ActivityPlug セッションを作成できてもブラウザセッションへの
関連付けが一時的に失敗した場合、サーバは短期の保留中認証レコードを保持し、
同じコールバック state での回復を許可します。回復できない障害では関連付け
られていないセッションを削除します。


プロダクト API
--------------

すべてのプロダクト API ルートには認証済みブラウザセッションが必要です。

| ルートグループ                               | 操作                                                             |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `GET /v1/browser/api/capabilities`           | 現在のインスタンスの capability                                  |
| `GET /v1/browser/api/timelines/:kind`        | `home`、`local`、`federated` タイムライン                        |
| `GET /v1/browser/api/search`                 | アカウント、投稿、ハッシュタグの検索                             |
| `GET /v1/browser/api/profiles/:id`           | プロフィール、投稿、関係                                         |
| `POST /v1/browser/api/profiles/:id/follow`   | フォロー                                                         |
| `POST /v1/browser/api/profiles/:id/unfollow` | フォロー解除                                                     |
| `/v1/browser/api/posts/*`                    | 読み取り、作成、リアクション、お気に入り、ブースト、ブックマーク |
| `/v1/browser/api/media/*`                    | メディアのアップロードと削除                                     |

成功したプロダクトルートは値を `{ "data": ... }` で包みます。セッション
初期化ルートと認証ルートはペイロードを直接返します。

ブラウザサーフェスは公開 HTTP API や GraphQL API より意図的に小さく
設計されています。選択したアダプタがサポートしない操作は capability を使って
非表示または無効にしてください。


ログアウト
----------

ログアウトは CSRF 保護された空の `POST` です。

~~~~ ts
await fetch("/v1/browser/logout", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "X-ActivityPlug-CSRF": csrfToken,
  },
});
~~~~

アップストリームのトークン失効に失敗した場合でもローカルログアウトが
優先されます。サーバは関連付けられた認証セッションとブラウザセッションを
削除し、その後 cookie を消去します。


ブラウザストリーム
------------------

ブラウザコードはまず使い捨てのストリームチケットを要求します。

~~~~ ts
const response = await fetch("/v1/browser/stream-tickets", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "content-type": "application/json",
    "X-ActivityPlug-CSRF": csrfToken,
  },
  body: JSON.stringify({ operation: "stream.timeline" }),
});

const { data } = await response.json();
const stream = new EventSource(
  `/v1/browser/stream?ticket=${encodeURIComponent(data.ticket)}`,
);
~~~~

サポートされるチケット操作は `stream.timeline`、
`stream.notifications`、`stream.conversations` です。ブラウザ境界は
`stream.timeline` を認証済みホームタイムラインにマッピングします。
チケットリクエストでは公開、ローカル、ハッシュタグ、リストの各タイムライン
を選択できません。チケットの特性は以下のとおりです。

 -  base64url エンコードされた 32 バイトのランダムエントロピーを含みます。
 -  SHA-256 ハッシュとしてのみ保存されます。
 -  現在のブラウザセッションと 1 つの操作にバインドされます。
 -  1 回だけ使用できます。
 -  60 秒後に失効します。

ストリームエンドポイントはサーバ送信イベントを送出します。チケットは URL
に含まれるため、ストリームを開く直前に要求し、クエリ文字列をログに記録
しないでください。チケットは ActivityPlug セッション credential ではなく、
別の操作には使えません。

ストリーミングはアダプタのサポートにも依存します。選択したアダプタが
要求されたストリームをサポートしない場合、有効なチケットでも
`UNSUPPORTED` レスポンスが返ることがあります。


リバースプロキシ
----------------

プロキシで TLS を終端し、公開 origin を維持してください。直前のピアが
既知のプロキシ IP である場合にのみ forwarding ヘッダを信頼するよう
`browser.clientIp` を設定してください。`createTrustedProxyClientIp()` は
信頼済みアドレスの厳密なリストを受け取り、信頼済み側から
`X-Forwarded-For` をたどります。

公開 `/api/v1/streams/*` ルートには WebSocket サポートが必要です。ブラウザ
の `/v1/browser/stream` はサーバ送信イベントを使うため、プロキシの
バッファリングを無効にする必要があります。


エラー
------

ブラウザの障害には安定したエンベロープが使われます。

~~~~ json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Browser session is unavailable.",
    "requestId": "80e56e6a-1a61-4b17-84fe-1d2f5ce5c251"
  }
}
~~~~

制御フローには code を使い、クライアントとサーバのログに `requestId` を
保持してください。ステータスマッピングと回復手順は
[エラーとトラブルシューティング](errors-and-troubleshooting.md)を
参照してください。
