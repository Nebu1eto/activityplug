セッションストレージ
====================

[English](session-storage.md) | [한국어](session-storage.ko.md) | 日本語

ActivityPlug は、認証資格情報とブラウザーのセキュリティ状態を明示的な
インターフェースを介して保存します。デプロイではインメモリ実装、
PostgreSQL、Redis、またはそれらを意図的に組み合わせた構成を選べます。


ストアの役割
------------

| ストア                   | 保存内容                                                                         | インメモリ | PostgreSQL | Redis |
| ------------------------ | -------------------------------------------------------------------------------- | ---------- | ---------- | ----- |
| `AuthSessionStore`       | リモートトークン、セッション revision、公開 API の OAuth コールバック状態        | 対応       | 対応       | 対応  |
| `BrowserSessionStore`    | ブラウザー cookie binding、CSRF hash、認証セッションへの関連付け、受付メタデータ | 対応       | 対応       | 対応  |
| `OAuthStateStore`        | ブラウザー OAuth コールバック状態、PKCE と redirect の binding、claim lease      | 対応       | 対応       | 対応  |
| `OAuthClientSecretStore` | 公開コールバック用クライアントシークレットと認証セッションの credential lease    | 対応       | 対応       | 対応  |
| `StreamTicketStore`      | 1 回限りのブラウザー WebSocket チケット                                          | 対応       | 非対応     | 対応  |
| `OAuthStartLimiter`      | OAuth 開始の rate と capacity の状態                                             | 対応       | 非対応     | 対応  |
| `ShortCacheStore`        | メールまたは passkey のチャレンジと OAuth コールバックメタデータ                 | 対応       | 非対応     | 対応  |

PostgreSQL パッケージは耐久性が必要なライフサイクルレコードを扱います。
PostgreSQL を使うブラウザーデプロイでも、ストリームチケット、limiter、
short cache には別途実装が必要です。単一プロセスならインメモリ実装、
複数プロセスで共有するなら Redis を使います。

公開 HTTP・GraphQL の OAuth フローはコールバック状態を
`AuthSessionStore` に有効期間 10 分の特別なレコードとして保存します。
`OAuthStateStore` は使いません。ブラウザー OAuth フローはコールバックを
原子的に claim し、再試行のために release してから consume できるよう
`OAuthStateStore` を使います。

`OAuthClientSecretStore` には 2 つの役割があります。公開 OAuth 登録
シークレットを同じ 10 分間のコールバック期間に保持する役割と、認証済み
OAuth セッションが参照する credential lease の backing store として
動作する役割です。lease は認証セッションの `storageExpiresAt` に従い、
この値がなければ既定の有効期間は 30 日です。


Backend の選択
--------------

再起動時にすべてのセッションが失われてもよいテスト・サンプル・単一
プロセスの開発環境ではインメモリストアを使います。各プロセスが独立した
コピーを持つため、プロセス間でリクエストを受け渡す構成には対応できません。

既存のリレーショナルデータベースで認証状態とブラウザーのライフサイクル
状態を管理する場合は PostgreSQL を使います。このパッケージは繰り返し
実行できるテーブル初期化関数と、同時実行に対応したストア操作を提供
します。期限切れ処理では、処理範囲を制限した定期 sweep を実行します。

native TTL、1 回限りの値、rate limit、共有ブラウザーストリームチケット
が必要な場合は Redis を使います。Redis ストアはスキーマの初期化が
不要です。原子的な操作には Redis スクリプトとパッケージが管理する key
prefix を使います。

混合デプロイでは、認証セッションとブラウザーセッションを PostgreSQL に
置き、有効期間の短いブラウザー状態を Redis に置けます。1 つの論理
ストアを複数の backend に分割したり、プロセスごとに異なる prefix を
使ったりしないでください。


サーバー設定
------------

サーバーは次の位置でストアを受け取ります。

~~~~ ts
const server = createActivityPlugServer({
  adapters,
  sessions: authSessions,
  oauthClientSecrets,
  authStartLimiter,
  browser: {
    publicOrigin,
    cookieSigningKey,
    browserSessions,
    oauthStates,
    authChallenges,
    streamTickets,
  },
});
~~~~

`sessions`、`oauthClientSecrets`、`authStartLimiter`、
`browser.oauthStates`、`browser.authChallenges` を省略するとインメモリの
既定値を使います。ブラウザー境界を有効にする場合は
`browser.browserSessions` と `browser.streamTickets` が必須です。


準備状態とライフサイクル
------------------------

`createActivityPlugServer()` はセキュリティ状態のライフサイクルを開始し、
`server.ready` として公開します。リクエストはこの promise を待機します。
sweep を使うストアは準備完了前に一度クリーンアップし、その後は 60 秒
ごとに最大 500 件を処理します。Redis ストアは native expiry を宣言する
ため、有効なレコードへの定期 sweep は実行しません。

トップレベルの `readiness` コールバックは任意で指定でき、公開 health
check に使います。ストアが使うものと同じ PostgreSQL プールや Redis
クライアントを確認します。

~~~~ ts
const server = createActivityPlugServer({
  adapters,
  sessions,
  readiness: async () => {
    await pool.query("select 1");
    return true;
  },
});

await server.ready;
~~~~

各ストアは PostgreSQL プールや Redis クライアントを所有しません。
クリーンアップ worker とブラウザー admission の完了を待つため、
ActivityPlug サーバーを先に閉じてから backing client を閉じます。

~~~~ ts
await server.close();
await pool.end(); // or: await redis.quit()
~~~~

アプリケーションが独自の `SecurityStateLifecycle` を注入した場合、
そのライフサイクルの所有は呼び出し側にあります。backing store を閉じる
前にライフサイクルを停止してください。


匿名ブラウザーセッション
------------------------

ブラウザー境界の既定値は `anonymousSessionMode: "stateless"` です。
認証を開始するまでは、未認証セッションのメタデータを署名済み cookie に
保持します。認証を開始するとレコードを `BrowserSessionStore` へ昇格し、
認証済みブラウザーセッションは常に保存します。

`anonymousSessionMode: "stored"` では匿名セッションも
`BrowserSessionStore` に保存します。最初のセッションリクエストから
全体・クライアント単位・作成 rate の admission limit を適用できます。
ただし、transport peer または設定済み client-IP resolver からクライアント
識別情報を取得する必要があり、ストレージトラフィックも増加します。

ブラウザーセッションの既定の有効期間は 7 日です。capacity と作成制限は
保存済みセッションに適用され、`BrowserBoundaryOptions` で設定します。
1 つのブラウザー origin を処理するすべてのプロセスで、同じ署名キーと
共有ストアを使ってください。


期限切れと同時実行
------------------

ActivityPlug は資格情報の期限と保存期限を区別します。更新できるよう、
期限切れの access token も認証セッションに残ることがあります。
`storageExpiresAt` は保存したセッション全体を削除する時点を決めます。

認証セッションとブラウザーセッションの変更には、単調に増加する revision
を使います。ブラウザー OAuth コールバック状態は claim、release、consume
操作を使います。公開 API の OAuth コールバック状態とストリームチケットは
1 回限りの consume を使います。一部のキャッシュ値も 1 回限りの読み取りを
使います。契約に準拠するストアはこれらの原子性規則を維持する必要があり、
単純な key-value 読み書きだけでは不十分です。

不正、不一致、期限切れのレコードは失敗として扱います。ストア実装は、
操作で読み取った値または revision が現在も有効な場合に限って不正な
レコードを削除します。この条件により、同時に置換された値をクリーンアップ
が削除することを防ぎます。


ファイルストアを提供しない理由
------------------------------

ActivityPlug はファイルベースのセッションストアを提供しません。認証
レコードにはリモート access token、refresh token、origin binding、
アカウント識別子が含まれます。ストア契約では原子的な create、consume、
compare-and-set、compare-and-delete、期限切れのクリーンアップ、同時
リクエストでの安全な動作も要求されます。

通常の JSON ファイルでは複数プロセスにまたがってこれらを保証できません。
ファイルロックと crash-safe な置換を追加しても、権限、バックアップ、
rotation、復旧の処理はデプロイごとに設計が必要です。ローカルの
persistence が必要なテストでは、弱いプロダクション契約に依存せず
PostgreSQL または Redis の統合環境を使います。


ローカル統合サービス
--------------------

リポジトリの Redis サービスと PostgreSQL サービスを起動してから、
コンテナを使う統合テストを実行します。

~~~~ sh
pnpm compose:dev
pnpm test:integration
~~~~

既定の endpoint は次のとおりです。

 -  Redis: `redis://127.0.0.1:56379`
 -  PostgreSQL:
    `postgres://activityplug:activityplug@127.0.0.1:55432/activityplug`

ローカル環境がこれらの port を使っている場合は
`ACTIVITYPLUG_REDIS_URL` または `ACTIVITYPLUG_POSTGRES_URL` を設定
してください。


関連ドキュメント
----------------

 -  [認証とセッション](authentication-and-sessions.ja.md)
 -  [PostgreSQL セッションパッケージ](../packages/session-postgres/README.md)
 -  [Redis セッションパッケージ](../packages/session-redis/README.md)
 -  [デプロイ](deployment.ja.md)
 -  [セキュリティモデル](security-model.ja.md)
