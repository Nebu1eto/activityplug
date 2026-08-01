ActivityPlug のテスト
=====================

[English](/en/testing.md) | [한국어](/ko/testing.md) | 日本語

ActivityPlug は、互換性のない Fediverse サーバー間でも維持すべき動作を
テストします。対象は公開 API 契約、アダプターマッピング、認証、
capability 検出、opaque な識別子とカーソル、ページネーション、型付き
エラー、セキュリティ境界、相互運用性の前提です。

テストケースはこれらの動作を保護するのに必要な最小限の組み合わせに
します。
ビルドツールの設定、単純な実装詳細、外部ライブラリの動作をテストする
必要はありません。失敗すると ActivityPlug
の契約が変わるか、対応するワークフローが壊れる 場合に回帰テストを追加します。


テストの階層
------------

リポジトリは検証する境界ごとにテストを分けています。

| 階層               | 目的                                               | 外部サービス                   |
| ------------------ | -------------------------------------------------- | ------------------------------ |
| unit と component  | マッピング、検証、エラー、状態、公開契約           | なし                           |
| store integration  | PostgreSQL と Redis の lifecycle store 動作        | ローカルコンテナ               |
| browser E2E        | ユーザージャーニーと browser-only API 境界         | インターセプトした fixture API |
| production Compose | TLS、プロセス強化、readiness、durable 障害復旧     | ローカルコンテナ               |
| Fediverse E2E      | 実サーバーに対するアダプター、HTTP、GraphQL の動作 | 分離した Compose profile       |

開発中はコストが低く対象を絞った階層を実行します。変更が境界を越える
場合はより広い階層を使います。


Unit テストと component テスト
------------------------------

リポジトリの Vitest スイートを実行します。

~~~~ sh
pnpm test
~~~~

ルートの Vitest 設定はワークスペースパッケージ名をソースエントリポイント
へ解決し、`packages/`、`examples/`、`scripts/` 配下のテストを対象に
します。各パッケージの `test` スクリプトは `scripts/run-package-tests.ts`
を呼び出します。このスクリプトは対象パッケージの integration 以外の
テストファイルを選び、1 件もなければ失敗します。

変更が 1 パッケージに限られる場合はそのパッケージだけを実行します。

~~~~ sh
pnpm --filter @activityplug/core test
pnpm --filter @activityplug/server test
~~~~

Web クライアントは別の Vite/Vitest 設定を使います。

~~~~ sh
pnpm --filter @activityplug/example-web-client test
~~~~

このテストは `jsdom` で動作し、ブラウザー契約、状態、レンダリング、
ルーティング、機能間のインタラクションを検証します。

共有する決定的なリモートペイロードは
[`packages/test-fixtures`] にあります。
ActivityPlug の正規化と検出動作の検証に使います。現在の upstream
サーバーが同じ動作をしている証拠にはなりません。その確認には Fediverse E2E
テストを使います。

[`packages/test-fixtures`]: https://github.com/Nebu1eto/activityplug/blob/main/packages/test-fixtures/


PostgreSQL と Redis の integration テスト
-----------------------------------------

ローカルデータサービスを起動します。

~~~~ sh
pnpm compose:dev
~~~~

両方の lifecycle store integration スイートを実行します。

~~~~ sh
pnpm test:integration
~~~~

既定のエンドポイントは次のとおりです。

 -  PostgreSQL:
    `postgres://activityplug:activityplug@127.0.0.1:55432/activityplug`
 -  Redis: `redis://127.0.0.1:56379`

ローカル環境がこれらのポートを使っている場合は
`ACTIVITYPLUG_POSTGRES_URL` または `ACTIVITYPLUG_REDIS_URL` を設定
します。終了後はサービスを停止しコンテナを削除します。

~~~~ sh
docker compose -f docker-compose.dev.yml down
~~~~

保存済みの開発データも削除する場合にのみ `--volumes` を追加します。


Browser E2E テスト
------------------

Chromium ランタイムを一度インストールしてから Playwright スイートを
実行します。

~~~~ sh
pnpm --filter @activityplug/example-web-client exec playwright install chromium
pnpm --filter @activityplug/example-web-client test:e2e
~~~~

Playwright はフロントエンドをビルドし `http://127.0.0.1:4173` で
プレビューします。fixture は browser API 呼び出しをインターセプトし、
アプリケーションがリモート Fediverse origin へ直接接続しないことを
検証します。プロジェクトは英語、韓国語、日本語のデスクトップロケールと
英語のモバイルビューポートを対象にします。ジャーニーは認証の再読み込み、
タイムラインと opaque カーソル、検索、プロフィール、スレッド、投稿操作、
画像の再試行、アクセシビリティランドマーク、レスポンシブレイアウト、
不明なルート、ログアウトを検証します。

これらのテストは実サーバーをプロビジョニングせずにプロダクトのブラウザー
動作を検証します。アダプターの E2E テストの代替にはなりません。


Production compose テスト
-------------------------

production Compose の検査はアダプターの意味ではなくデプロイ可能な
トポロジーを検証します。ローカルでは次のコマンドを使えます。

~~~~ sh
pnpm compose:config
pnpm compose:up
pnpm compose:health
pnpm compose:down
~~~~

memory variant はポート `8444` と別のローカル CA を使います。

~~~~ sh
pnpm compose:memory:config
pnpm compose:memory:up
pnpm compose:memory:health
pnpm compose:memory:down
~~~~

どちらのランチャーにもデプロイガイドに記載した digest-pinned イメージと
セキュリティ変数が必要です。CI smoke test は外部 TLS 境界、cookie と
CSRF の動作、コンテナ制限、PostgreSQL や Redis が利用できない間と復旧後
の readiness も検査します。


Fediverse E2E matrix
--------------------

ActivityPlug は Mastodon stable、Mastodon minimum、Misskey、Pleroma、
Hollo、HackersPub に分離した Compose profile をプロビジョニングします。
各対象は固有のデータサービスと、テストが所有するアカウントまたは
コンテンツを使います。サーバースイートが HTTP と GraphQL を先に検証し、
対応するアダプタースイートがライブラリ API を検証します。

matrix 全体を順番に実行します。

~~~~ sh
bash test/e2e/run-fediverse-matrix.sh
~~~~

runner は各 profile の前と終了時にコンテナと named volume を初期化
します。stage の結果は NDJSON として標準出力へ書き、コマンド、Compose、
テストのログは標準エラーへ書きます。`checkout` と `build` の後、
テスト runner は `server-test` を記録し、消費した fixture を再
プロビジョニングしながら `provision` を記録してから `adapter-test` を
記録します。最初のプロビジョニングは `server-test` より前に行い、
その失敗も `provision` として記録します。upstream の checkout、build、
startup、provisioning の失敗は external として記録しますが、
ActivityPlug のアサーション失敗は external ではありません。

正確な upstream ref と commit は
[`test/e2e/versions.env`] に記録されて
います。取得したソースはリポジトリ外の
`${XDG_CACHE_HOME:-$HOME/.cache}/activityplug/fediverse-sources` に
保存します。acquisition はソースをビルドコンテキストへ入れる前に commit
を検証し、ignored file
を削除します。これらの対象を公開インスタンスで置き換えないでください。

サーバー固有の変更を調査するときは 1 つの profile を実行します。

~~~~ sh
docker compose -f test/e2e/docker-compose.yml --profile mastodon up -d --wait
target="$(bash test/e2e/provision.mastodon.sh)"

NODE_TLS_REJECT_UNAUTHORIZED=0 \
ACTIVITYPLUG_FEDIVERSE_E2E=1 \
ACTIVITYPLUG_FEDIVERSE_TARGETS="[$target]" \
pnpm test:e2e
~~~~

`NODE_TLS_REJECT_UNAUTHORIZED=0` が必要なのはローカル Mastodon
fixture の生成証明書だけです。public や本番の origin には使わないで
ください。

`ACTIVITYPLUG_FEDIVERSE_TARGETS` がなければ `pnpm test:e2e` は
Fediverse スイートをスキップします。スキップを失敗として扱う環境では
strict mode を設定します。

~~~~ sh
ACTIVITYPLUG_FEDIVERSE_E2E_REQUIRED=1 \
ACTIVITYPLUG_FEDIVERSE_REQUIRED_ADAPTERS=mastodon \
ACTIVITYPLUG_FEDIVERSE_TARGETS="[$target]" \
pnpm test:e2e
~~~~

サーバースイートが破壊的 fixture を使うため、直接実行した runner は
アダプターテストの前に再プロビジョニングします。渡した target payload
がアダプタースイート用にプロビジョニング済みの場合に限り
`ACTIVITYPLUG_FEDIVERSE_REPROVISION_PACKAGE_TARGETS=0` を設定します。

[`packages/e2e-fixtures`] の共通
アサーションは capability に従って実行されます。アダプターが対応を宣言
し、プロビジョニング済み対象が必要な使い捨て fixture を提供する場合に
限り、インスタンス・アカウントの読み取り、タイムライン、検索、メディア、
投稿、poll、通知、フォローリクエスト、リスト、フィルター、scheduled
post、social action を検証します。

手動で起動した matrix は profile を切り替える前に停止して削除します。

~~~~ sh
docker compose -f test/e2e/docker-compose.yml --profile '*' \
  down --volumes --remove-orphans
~~~~

pull request の CI workflow は unit、integration、browser、production
Compose の各検査を実行しますが、実際の Fediverse matrix はプロビジョニ
ングしません。別の `Fediverse E2E` workflow が schedule または手動の
workflow dispatch で matrix を実行します。その workflow より前に実
サーバーの証拠が必要な場合はローカルで matrix を実行します。

[`test/e2e/versions.env`]: https://github.com/Nebu1eto/activityplug/blob/main/test/e2e/versions.env
[`packages/e2e-fixtures`]: https://github.com/Nebu1eto/activityplug/blob/main/packages/e2e-fixtures/


テストの選択と追加
------------------

次の条件を 1 つ以上保護する場合に、対象を絞ったテストを追加します。

 -  文書化した公開 API の結果または型付き failure
 -  対応サーバー間で異なるアダプターマッピング
 -  認証、origin、資格情報、ブラウザーのセキュリティ境界
 -  明示的な unsupported result を含む capability 依存動作
 -  opaque な識別子、カーソル、ページネーション、エラーの保持
 -  実サーバーテストで検証できる相互運用性の前提

決定的なマッピングと検証には unit test を優先します。PostgreSQL または
Redis に依存する動作だけに store integration test を使います。
コンポーネントや状態の階層をまたぐユーザージャーニーには browser E2E
test を使います。結果が実際の upstream プロトコル動作に依存する場合は
Fediverse E2E アサーションを使います。

同じ不変条件をすべての階層で重複して検証しないでください。Rolldown、
Vitest、React、データベースクライアント、サーバー実装を代わりにテスト
する必要はありません。破壊的 E2E リソースはテストが所有し、任意機能は
capability に従って検証し、実サーバーの実行後はコンテナとボリュームを
削除してください。
