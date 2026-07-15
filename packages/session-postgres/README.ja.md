@activityplug/session-Postgres
==============================

[English](README.md) | [한국어](README.ko.md) | 日本語

ActivityPlug サーバーモード向けの PostgreSQL ライフサイクルストレージです。


インストール
------------

~~~~ sh
pnpm add @activityplug/session-postgres
~~~~

Node.js 26 以降が必要です。このパッケージは ECMAScript モジュールを使用します。


使用方法
--------

~~~~ ts
import * as activityplug from "@activityplug/session-postgres";
~~~~

パッケージルートは、サポートされる公開 API を公開します。このリリースで
利用可能な正確な契約については、エクスポートされた型を参照してください。


サーバーへの接続
----------------

リクエスト処理用の `pg` プールを 1 つ作成し、トラフィックを受け付ける前に
ライフサイクルテーブルを初期化して、そのプールから PostgreSQL ベースの全
ストアを作成します。初期化関数はデプロイ開始時に毎回安全に呼び出せます。
認証セッション、OAuth 状態、OAuth クライアントシークレット、ブラウザー
セッションの各テーブルが作成されます。

~~~~ ts
import { createActivityPlugServer, InMemoryStreamTicketStore } from "@activityplug/server";
import {
  createPostgresAuthSessionStore,
  createPostgresBrowserSessionStore,
  createPostgresOAuthClientSecretStore,
  createPostgresOAuthStateStore,
  initializePostgresLifecycleStores,
} from "@activityplug/session-postgres";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

await initializePostgresLifecycleStores(pool);

const activityPlug = createActivityPlugServer({
  adapters,
  sessions: createPostgresAuthSessionStore(pool),
  oauthClientSecrets: createPostgresOAuthClientSecretStore(pool),
  browser: {
    publicOrigin: "https://client.example",
    cookieSigningKey,
    browserSessions: createPostgresBrowserSessionStore(pool),
    oauthStates: createPostgresOAuthStateStore(pool),
    streamTickets: new InMemoryStreamTicketStore(),
  },
});

await activityPlug.ready;
activityPlug.start({ hostname: "127.0.0.1", port: 4000 });

try {
  // アプリケーションを実行します。
} finally {
  await activityPlug.close();
  await pool.end();
}
~~~~

例の `adapters` はアプリケーションで設定したアダプター一覧です。
`cookieSigningKey` は 32 バイト以上のランダム値を持つ `Uint8Array` です。
インメモリのストリームチケットストアは、この例を本パッケージに集中させる
ためのものです。マルチプロセスまたは本番のブラウザー配備では永続実装を使用
してください。

必ず `pool.end()` より先に ActivityPlug サーバーを閉じてください。サーバーが
所有するセキュリティ状態ライフサイクルは、`close()` が完了するまで PostgreSQL
のクリーンアップを実行する可能性があります。別途注入した
`SecurityStateLifecycle` も呼び出し側の所有物であるため、プール終了前に停止
してください。


ライセンス
----------

Apache-2.0 OR MIT の条件でライセンスされます。`LICENSE-APACHE` と
`LICENSE-MIT` を参照してください。
