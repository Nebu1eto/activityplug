Fediverse E2E テスト
====================

ActivityPlug は、実際の Fediverse サーバーに対するローカル E2E テストに
Docker Compose を使います。対象のマトリクスは Mastodon、Misskey、Pleroma、
Hollo、HackersPub です。

各対象サーバーは隔離された Docker Compose profile で動きます。Assertion は
サーバーパッケージとアダプターパッケージに分けて置きます。

 -  各サーバーは隔離されたデータベースとキャッシュを使います。
 -  上流サーバーが必要とする場合は、Docker サービス名と公開インスタンス
    ホストを分離します。
 -  公開ホストには `mastodon.127.0.0.1.nip.io` のように loopback へ解決
    されるドメインを使います。
 -  provision スクリプトは、アダプターテストに必要なローカルアカウント、
    アクセストークン、seed content を作ります。
 -  サーバーパッケージが HTTP と GraphQL API を先に検証します。その後、対象の
    アダプターパッケージが実際のアダプターでライブラリ API を検証します。
 -  共通の parsing と baseline assertion は `packages/e2e-fixtures` に置きます。
 -  Compose ファイル、サーバー設定、provision スクリプトは `test/e2e/` の下に
    置きます。

Compose ファイルは、Misskey、Pleroma、HackersPub を隣接するソフトウェア
checkout から build します。既定の場所は `../activityplug-docs` です。
checkout が別の場所にある場合は、`ACTIVITYPLUG_SOFTWARE_ROOT` を設定します。
検証した source revision は次のとおりです。

 -  Misskey: `0f5da633284ffe20c3ed59bb0a5c5866071baac3`.
 -  Pleroma: `683ab39160a2ff95d151887a89217bd1d4a6dcf5`.
 -  HackersPub: `ee596993c26ead89c70f6b8b601a8e8f8d829cb7`.

Docker Desktop のメモリ割り当てが小さい場合は、対象を 1 つずつ実行します。
4 GB のメモリ制限は順次実行には十分であり、マトリクス全体を同時に起動する
必要はありません。5 つの対象すべてを証明する実行では、matrix runner を使い
ます。matrix runner は、各対象が healthy になるまで最大 900 秒待ちます。
`ACTIVITYPLUG_FEDIVERSE_WAIT_TIMEOUT` でこの値を変更できます。

~~~~ sh
bash test/e2e/run-fediverse-matrix.sh
~~~~

対象を 1 つ起動して provision します。

~~~~ sh
docker compose -f test/e2e/docker-compose.yml --profile mastodon up -d --wait
target="$(bash test/e2e/provision.mastodon.sh)"
printf '%s\n' "$target"
~~~~

provision 済みの target を JSON で渡して、Fediverse E2E suite を実行します。
サーバー HTTP と GraphQL の check が、アダプターパッケージの check より先に
実行されます。

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

matrix runner は、サーバー E2E テストの前に対象を provision します。同じ対象を
アダプターパッケージ E2E テストの前にもう一度 provision する動作は、
`pnpm test:e2e` の既定値です。target payload が各 phase に独立した fixture を
すでに提供する場合にのみ、
`ACTIVITYPLUG_FEDIVERSE_REPROVISION_PACKAGE_TARGETS=0` を設定します。これに
より、サーバーテストの破壊的な通知操作や投稿操作が、パッケージテストに必要な
fixture を削除しません。

baseline は、インスタンスプロファイルの読み取り、トークンがある場合の viewer
検証、アカウント検索、アカウント投稿一覧、公開タイムラインの読み取り、マップ
済みの場合の local タイムラインの読み取り、マップ済みの場合の hashtag
タイムライン、マップ済みの場合のアカウント検索、マップ済みの場合の hashtag
検索、マップ済みの場合の認証付き投稿検索、マップ済みの場合のホームタイムライン
の読み取り、マップ済みの場合のメディアアップロード、マップ済みの場合の投稿の
作成/削除/更新/更新履歴、マップ済みの場合の reply と quote 投稿作成、マップ
済みの場合の投票の作成/読み取り/投票、マップ済みの場合の通知一覧/個別削除/
一括既読と unread count、マップ済みの場合の follow request 一覧、マップ済みの
場合のリストの作成/一覧/読み取り/更新/member/timeline/削除、マップ済みの場合の
filter の作成/一覧/読み取り/更新/削除、マップ済みの場合の予約投稿の
作成/一覧/読み取り/更新/削除、テスト所有の投稿に対する capability ベースの投稿
social action を検証します。target が `socialActionHandle` を提供する場合は、
disposable local account に対する follow/unfollow、block/unblock、mute/unmute も
検証します。テストは公開インスタンスへ fallback してはいけません。

対象ごとの注意点:

 -  Mastodon はこの profile で公開 HTTPS origin を要求するため、ローカルの
    Caddy サービスの背後で動かします。
    `https://mastodon.127.0.0.1.nip.io:41080` を使い、このローカルテストで
    のみ `NODE_TLS_REJECT_UNAUTHORIZED=0` を設定します。Provision は viewer
    account と disposable social-action account の両方を作成します。
 -  Misskey の provision は、データベースで federation を有効にし、既定の
    `canSearchNotes` policy を有効にし、Docker Compose が起動した
    Meilisearch service を note search に使います。その後、admin session と
    disposable social-action account を作成し、seed note が index されるまで
    待ってから token target を作ります。
 -  Pleroma の provision は、`pleroma_ctl` でローカルユーザーを作成し、
    Mastodon-compatible OAuth application を登録し、password-grant token、
    disposable social-action account、public seed status を作ります。
 -  Hollo の provision は、account、token、public post に必要な PostgreSQL
    row を直接 seed します。固定された Hollo image が、この fixture に必要な
    Mastodon-compatible bootstrap API をすべて提供していないためです。
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
