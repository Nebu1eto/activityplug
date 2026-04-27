Fediverse E2E テスト
====================

ActivityPlug は、実際の Fediverse サーバーに対するローカル E2E テストに
Docker Compose を使います。対象のマトリクスは Mastodon、Misskey、Pleroma、
Hollo、HackersPub です。

各対象サーバーは隔離された Docker Compose profile で動き、assertion は各
アダプターパッケージ内に置きます。

 -  各サーバーは隔離されたデータベースとキャッシュを使います。
 -  上流サーバーが必要とする場合は、Docker サービス名と公開インスタンス
    ホストを分離します。
 -  公開ホストには `mastodon.127.0.0.1.nip.io` のように loopback へ解決
    されるドメインを使います。
 -  provision スクリプトは、アダプターテストに必要なローカルアカウント、
    アクセストークン、seed content を作ります。
 -  E2E assertion は各アダプターパッケージに置きます。共通の parsing と
    baseline assertion は `packages/e2e-fixtures` に置きます。
 -  Compose ファイル、サーバー設定、provision スクリプトは `test/e2e/` の下に
    置きます。

Compose ファイルは、Misskey、Pleroma、HackersPub を隣接するソフトウェア
checkout から build します。既定の場所は
`/Users/Nebuleto/Workspace/activityplug-docs` です。checkout が別の場所に
ある場合は、`ACTIVITYPLUG_SOFTWARE_ROOT` を設定します。検証した source
revision は次のとおりです。

 -  Misskey: `0f5da633284ffe20c3ed59bb0a5c5866071baac3`.
 -  Pleroma: `683ab39160a2ff95d151887a89217bd1d4a6dcf5`.
 -  HackersPub: `ee596993c26ead89c70f6b8b601a8e8f8d829cb7`.

Docker Desktop のメモリ割り当てが小さい場合は、対象を 1 つずつ実行します。
4 GB のメモリ制限は順次実行には十分であり、マトリクス全体を同時に起動する
必要はありません。5 つの対象すべてを証明する実行では、matrix runner を使い
ます。

~~~~ sh
bash test/e2e/run-fediverse-matrix.sh
~~~~

対象を 1 つ起動して provision します。

~~~~ sh
docker compose -f test/e2e/docker-compose.yml --profile mastodon up -d --wait
target="$(bash test/e2e/provision.mastodon.sh)"
printf '%s\n' "$target"
~~~~

provision 済みの target を JSON で渡して、アダプター E2E テストを実行します。

~~~~ sh
NODE_TLS_REJECT_UNAUTHORIZED=0 \
ACTIVITYPLUG_FEDIVERSE_E2E=1 \
ACTIVITYPLUG_FEDIVERSE_TARGETS="[$target]" \
pnpm test:e2e
~~~~

`ACTIVITYPLUG_FEDIVERSE_TARGETS` が設定されていない場合、`pnpm test:e2e` は
Fediverse E2E suite を skip します。provision 済みの target がない場合に失敗
させる CI job では `ACTIVITYPLUG_FEDIVERSE_E2E_REQUIRED=1` を設定します。既定
の strict mode は、1 つの target array に 5 つの adapter がすべて含まれること
を要求します。matrix runner は、順次 target ごとに
`ACTIVITYPLUG_FEDIVERSE_REQUIRED_ADAPTERS` を設定するため、すべてのサーバーを
同時に起動しなくても同じ strict check を使えます。

初期 baseline は、インスタンスプロファイルの読み取り、トークンがある場合の
viewer 検証、アカウント検索、アカウント投稿一覧、ActivityPlug page limit
clamp を検証します。テストは公開インスタンスへ fallback してはいけません。

対象ごとの注意点:

 -  Mastodon はこの profile で公開 HTTPS origin を要求するため、ローカルの
    Caddy サービスの背後で動かします。
    `https://mastodon.127.0.0.1.nip.io:41080` を使い、このローカルテストで
    のみ `NODE_TLS_REJECT_UNAUTHORIZED=0` を設定します。
 -  Misskey の provision は、データベースで federation を有効にし、admin
    session を作成してから seed note と token target を作ります。
 -  Pleroma の provision は、`pleroma_ctl` でローカルユーザーを作成し、
    Mastodon-compatible OAuth application を登録し、password-grant token と
    public seed status を作ります。
 -  Hollo の provision は、account、token、public post に必要な PostgreSQL
    row を直接 seed します。固定された Hollo image が、この fixture に必要な
    Mastodon-compatible bootstrap surface をすべて提供していないためです。
 -  HackersPub の provision は、local instance、account、actor、note
    source、post に必要な PostgreSQL row を seed します。Docker build は固定の
    `GIT_COMMIT` 値を渡し、container command は起動時に `INSTANCE_ACTOR_KEY`
    を生成します。

アダプターパッケージのテストは、`@activityplug/e2e-fixtures` を通じて同じ
target JSON を使います。アダプターレベルの E2E テストを追加する場合は、
`targetsForAdapter()` で adapter 名を filter し、実際の adapter instance と
ともに `expectReadBaseline()` を呼び出します。サーバー固有の setup は package
test 内ではなく `test/e2e/` に置きます。

次の対象を起動する前に、実行中の profile を停止します。

~~~~ sh
docker compose -f test/e2e/docker-compose.yml --profile mastodon stop
~~~~
