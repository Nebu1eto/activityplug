ローカルセッションストアテスト
==============================

ActivityPlug には、Redis と PostgreSQL の認証セッションストア用 Docker
Compose 環境が含まれます。

統合テストを実行する前にローカルサービスを起動してください。

~~~~ sh
pnpm compose:dev
~~~~

コンテナベースの統合テストを実行します。

~~~~ sh
pnpm test:integration
~~~~

既定のエンドポイントは次のとおりです。

 -  Redis: `redis://127.0.0.1:56379`
 -  PostgreSQL:
    `postgres://activityplug:activityplug@127.0.0.1:55432/activityplug`

別のローカル環境がこれらのポートを使用している場合は、
`ACTIVITYPLUG_REDIS_URL` と `ACTIVITYPLUG_POSTGRES_URL` で値を上書きして
ください。
