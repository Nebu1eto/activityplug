Fediverse E2E テスト
====================

ActivityPlug は、実際の Fediverse サーバーに対するローカル E2E テストに
Docker Compose を使います。対象のマトリクスは Mastodon、Misskey、Pleroma、
Hollo、HackersPub です。

各対象サーバーは隔離された Docker Compose profile で動きます。

 -  各サーバーは隔離されたデータベースとキャッシュを使います。
 -  上流サーバーが必要とする場合は、Docker サービス名と公開インスタンス
    ホストを分離します。
 -  公開ホストには `mastodon.127.0.0.1.nip.io` のように loopback へ解決
    されるドメインを使います。
 -  provision スクリプトは、アダプターテストに必要なローカルアカウント、
    アクセストークン、seed content を作るか、必要な手順を説明します。
 -  E2E assertion は各アダプターパッケージに置きます。共通の parsing と
    baseline assertion は `packages/e2e-fixtures` に置きます。
 -  Compose ファイル、サーバー設定、provision スクリプトは `test/e2e/` の下に
    置きます。

対象を 1 つ起動します。

~~~~ sh
docker compose -f test/e2e/docker-compose.yml --profile mastodon up -d --wait
bash test/e2e/provision.mastodon.sh
~~~~

provision 済みの target を JSON で渡して、アダプター E2E テストを実行します。

~~~~ sh
ACTIVITYPLUG_FEDIVERSE_TARGETS='[
  {
    "adapter": "mastodon",
    "origin": "http://mastodon.127.0.0.1.nip.io:41080",
    "token": "replace-with-provisioned-token"
  }
]' pnpm test:e2e
~~~~

`ACTIVITYPLUG_FEDIVERSE_TARGETS` が設定されていない場合、`pnpm test:e2e` は
Fediverse E2E suite を skip します。provision 済みの target がない場合に失敗
させる CI job では `ACTIVITYPLUG_FEDIVERSE_E2E_REQUIRED=1` を設定します。

初期 baseline は、インスタンスプロファイルの読み取り、トークンがある場合の
viewer 検証、アカウント検索、アカウント投稿一覧、ActivityPlug page limit
clamp を検証します。テストは公開インスタンスへ fallback してはいけません。
