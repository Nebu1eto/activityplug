Fediverse E2E テスト
====================

ActivityPlug は、実際の Fediverse サーバーに対するローカル E2E テストに
Docker Compose を使います。マトリクスは Mastodon の stable と minimum の
profile に加え、Misskey、Pleroma、Hollo、HackersPub を含みます。

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

matrix runner は各上流の正確な ref を
`${XDG_CACHE_HOME:-$HOME/.cache}/activityplug/fediverse-sources/<software>/<commit>`
へ取得します。この cache は repository の外部にあります。acquisition script は
取得した ref を resolve し、`test/e2e/versions.env` の commit と比較してから
detached checkout を行い、build 前に `git rev-parse HEAD` を検証します。
Pleroma は、現在の CA certificate と固定された Hex および Rebar version
を使い、 この検証済み checkout から build されます。build が Pleroma
application source を変更した場合は失敗します。acquisition は ignored file も
削除するため、古い build product が検証済みの build context に入ることは
ありません。2 つの Mastodon profile は、それぞれ異なる ref と commit を
検証します。

Pleroma source provenance を直接確認するには、次のコマンドを実行します。

~~~~ sh
. test/e2e/versions.env
source_dir="$(node --experimental-strip-types scripts/acquire-fediverse-sources.ts \
  --software pleroma \
  --repository https://git.pleroma.social/pleroma/pleroma.git \
  --ref "v$PLEROMA_STABLE_VERSION" \
  --commit "$PLEROMA_STABLE_COMMIT")"
git -C "$source_dir" rev-parse HEAD
git -C "$source_dir" status --porcelain
~~~~

Docker Desktop のメモリ割り当てが小さい場合は、対象を 1 つずつ実行します。
4 GB のメモリ制限は順次実行には十分であり、マトリクス全体を同時に起動する
必要はありません。5 つの対象すべてを証明する実行では、matrix runner を使い
ます。matrix runner は、各対象が healthy になるまで最大 900 秒待ちます。
`ACTIVITYPLUG_FEDIVERSE_WAIT_TIMEOUT` でこの値を変更できます。

~~~~ sh
bash test/e2e/run-fediverse-matrix.sh
~~~~

runner は各 profile の開始前と終了時に、container と named data volume を削除
します。同じ再現可能な reset を手動で行うには、次のコマンドを実行します。

~~~~ sh
docker compose -f test/e2e/docker-compose.yml --profile '*' \
  down --volumes --remove-orphans
~~~~

各 stage は、`target`、`stage`、`status`、`external`、`message` を持つ JSON
object を standard output に NDJSON として 1 件出力します。command、Compose、
test の log は standard error に送られるため、standard output はそのまま parse
できます。stage は `checkout`、`build`、`provision`、
`server-test`、`adapter-test` です。Checkout、上流 build または startup、
provisioning の失敗は `external: true` です。ActivityPlug server と adapter test
の失敗は `external: false` です。特に Pleroma Hex または Rebar bootstrap
の失敗は、 `adapter-test` ではなく失敗した `build` stage です。

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

matrix runner は volume を reset した後、各 target を provision し、server
suite が破壊的な fixture を使うため adapter suite の前に再度 provision します。
`pnpm test:e2e` を直接実行する場合も、既定で adapter suite の前に再度
provision します。渡した payload がすでに
provision 済みの場合にのみ、
`ACTIVITYPLUG_FEDIVERSE_REPROVISION_PACKAGE_TARGETS=0` を設定します。要求した
test file が存在しないか空の場合は Vitest の開始前に失敗し、named suite では
`--passWithNoTests` を使いません。

skip を許可しない場合は strict mode を使います。

~~~~ sh
ACTIVITYPLUG_FEDIVERSE_E2E_REQUIRED=1 \
ACTIVITYPLUG_FEDIVERSE_REQUIRED_ADAPTERS=mastodon \
ACTIVITYPLUG_FEDIVERSE_TARGETS="[$target]" \
pnpm test:e2e
~~~~

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
