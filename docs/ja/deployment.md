デプロイ
========

[English](/en/deployment.md) | [한국어](/ko/deployment.md) | 日本語

ActivityPlug は 2 種類の Docker Compose リファレンススタックを提供します。

 -  `docker-compose.yml` は Web クライアント、ActivityPlug サーバー、
    PostgreSQL、Redis を実行します。認証状態とブラウザーライフサイクル
    状態はコンテナーを再起動しても維持されます。
 -  `docker-compose.memory.yml` は Web クライアントと ActivityPlug
    サーバーだけを実行します。アプリケーション状態をサーバープロセスに
    保持するため、評価環境や破棄可能な環境に適しています。

どちらのスタックも Caddy で TLS を終端し、ブラウザーアプリケーションと
`/health` だけを公開します。ループバックインターフェースにバインドし
Caddy
のローカル認証局を使います。インターネットにそのまま公開する構成ではなく、本番構成に近い
リファレンスとして扱ってください。


前提条件
--------

リポジトリのスクリプトには次の環境が必要です。

 -  Docker Compose v2 コマンドを使える Docker Engine
 -  ルートパッケージで指定している Node.js 26 と pnpm 11
 -  選択したコンテナーイメージを保持するレジストリへのアクセス
 -  接続先 ActivityPub サーバーを列挙した HTTPS origin の allowlist

パッケージスクリプトはリポジトリのルートで実行します。本番用 Compose
ファイルを直接実行しないでください。ランチャーは Docker を起動する前に
イメージの固定値と必須秘密情報を検証します。他の Compose
設定コマンドは展開後の秘密情報を出力する可能性がある ため `config --quiet`
だけを許可します。


ストレージモードの選択
----------------------

サーバー再起動後もセッションを維持する場合や、複数のサーバープロセスで
状態を共有する場合は durable スタックを使います。PostgreSQL は認証
セッション、OAuth クライアントシークレット、ブラウザーセッション、
OAuth state を保存します。Redis はストリームチケット、OAuth 開始制限、
有効期間の短い認証チャレンジを保存します。Redis の append-only 永続化と
named volume により、リファレンススタックが所有する状態を維持します。

プロセス終了時にすべてのセッションと一時的なセキュリティレコードが
失われても構わない場合に限り memory スタックを使います。PostgreSQL と Redis
には依存せず、`/health` はサーバープロセスだけを確認します。

どちらのスタックも匿名ブラウザーセッションを `stateless` に設定します。
匿名セッションは永続レコードではなく署名付き cookie を使います。認証済み
ブラウザーセッションは引き続き設定済みストアに依存します。

web-client サンプルは環境変数 `ACTIVITYPLUG_STORAGE`（`durable` または
`memory`）でスタックを切り替えます。
`ACTIVITYPLUG_ANONYMOUS_SESSION_MODE`（`stored` または `stateless`）は
デフォルトの匿名セッション方式を上書きします。これらの変数はサンプル
アプリケーション固有のものであり、ActivityPlug サーバパッケージのものでは
ありません。


必須環境変数
------------

どちらのモードでも次の値を設定します。

| 変数                                  | 要件                                                          |
| ------------------------------------- | ------------------------------------------------------------- |
| `ACTIVITYPLUG_NODE_IMAGE`             | 小文字 64 桁の SHA-256 digest を含む Node イメージ参照        |
| `ACTIVITYPLUG_CADDY_IMAGE`            | 小文字 64 桁の SHA-256 digest を含む Caddy イメージ参照       |
| `ACTIVITYPLUG_PNPM_VERSION`           | `11.12.0` と完全に一致する値                                  |
| `ACTIVITYPLUG_COOKIE_SIGNING_KEY`     | デコード後に 32 バイト以上となる padding なしの base64url     |
| `ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS` | wildcard を含まない明示的な HTTPS origin のカンマ区切りリスト |

durable スタックでは次の値も必要です。

| 変数                             | 要件                                                                       |
| -------------------------------- | -------------------------------------------------------------------------- |
| `ACTIVITYPLUG_POSTGRES_IMAGE`    | 小文字 64 桁の SHA-256 digest を含む PostgreSQL イメージ参照               |
| `ACTIVITYPLUG_REDIS_IMAGE`       | 小文字 64 桁の SHA-256 digest を含む Redis イメージ参照                    |
| `ACTIVITYPLUG_POSTGRES_PASSWORD` | URL-safe base64 文字で 32 文字以上                                         |
| `ACTIVITYPLUG_REDIS_PASSWORD`    | URL-safe base64 文字で 32 文字以上、かつ PostgreSQL のパスワードと異なる値 |

受理されるイメージ参照の形式は `name@sha256:digest` または
`name:tag@sha256:digest` です。ランチャーは変更可能な参照、`latest`
タグ、digest の欠落、大文字の digest、不正な長さの digest を拒否します。

デプロイ用の秘密情報マネージャーでそれぞれ独立した秘密情報を生成します。
ローカル評価では Node で必要なエンコーディングの値を生成できます。

~~~~ sh
node --input-type=module -e \
  "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('base64url'))"
~~~~

秘密情報ごとにこのコマンドを別々に実行します。生成した値を追跡対象の
ファイルや shell 履歴に保存しないでください。


検証と起動
----------

durable スタックでは次のコマンドを実行します。

~~~~ sh
pnpm compose:config
pnpm compose:up
pnpm compose:health
~~~~

`compose:up` は 4 つのサービスを待機し、Caddy のローカルルート証明書を
`.dev/caddy-root.crt` に出力します。health コマンドはその証明書で
`https://localhost:8443/health` を検証します。

memory スタックでは次のコマンドを実行します。

~~~~ sh
pnpm compose:memory:config
pnpm compose:memory:up
pnpm compose:memory:health
~~~~

memory スタックは `https://localhost:8444` を使い、証明書を
`.dev/caddy-memory-root.crt` に出力します。固定されたプロジェクト名、
ネットワーク、volume、port を使うため durable スタックと同時に実行
できます。

named volume を削除せずにスタックを停止するには次のコマンドを実行します。

~~~~ sh
pnpm compose:down
pnpm compose:memory:down
~~~~


TLS と公開ルーティング
----------------------

リポジトリの Compose ファイルは HTTPS を `127.0.0.1` にバインドします。
`Caddyfile.local` は Caddy の内部認証局から証明書を発行し、`/health` と
`/v1/browser/*` だけをサーバーへ proxy します。それ以外のパスでは Web
クライアントを配信します。したがってこの Caddy 構成は GraphQL API と
一般 HTTP API を公開しません。

デプロイを公開する前に次の作業を完了します。

1.  ローカル Caddy 構成を、レビュー済みの公開 hostname 用 ingress
    構成に置き換えます。
2.  `ACTIVITYPLUG_PUBLIC_ORIGIN` を正規化された外部 HTTPS origin に
    設定します。
3.  対象クライアントが信頼する証明書で TLS を終端します。
4.  `ACTIVITYPLUG_TRUSTED_PROXY_ADDRESSES` を ActivityPlug に直接
    接続する proxy の正確な IP アドレスに設定します。
5.  proxy が公開するサーバーパスを明示的に決定します。

公開 origin は資格情報、パス、クエリ、フラグメントを含まない HTTPS
origin でなければなりません。この値がブラウザーから見える origin と
異なる場合、same-origin 検査と OAuth callback binding が失敗します。


ネットワークとコンテナーの境界
------------------------------

durable スタックでは `product-edge` が Caddy とサーバーを接続します。
サーバーはこのネットワークを proxy トラフィックと外部リクエストに使い
ます。`product-data` はサーバー、PostgreSQL、Redis だけが共有する内部
ネットワークです。データベースサービスはホスト port を公開せず、Web
コンテナーはそのサービス名を解決できません。

Web コンテナーとサーバーコンテナーは read-only ルートファイルシステムを
使い、すべての Linux capability を削除して権限昇格を禁止します。
書き込み可能な一時ファイルシステムにも上限を設定します。Caddy は
`NET_BIND_SERVICE` だけを保持します。すべてのサービスに CPU、memory、
PID、health、restart の制限があります。PostgreSQL と Redis は永続
データを所有するため書き込み可能なファイルシステムを維持します。

ルートの `.dockerignore` は本番 Dockerfile 用の allowlist です。
依存関係、ビルド出力、カバレッジ、worktree、ローカル状態、環境ファイル、
証明書、秘密鍵を除外します。資格情報の除外規則を弱めず、レビュー済みの
ビルド入力だけを allowlist に追加してください。


Readiness と障害時の動作
------------------------

durable サーバーは listen を開始する前に PostgreSQL ライフサイクル
テーブルを初期化し、Redis への接続を検証します。readiness コールバックは
2 秒の接続・クエリ・コマンド制限で両方のデータストアを確認します。
どちらか一方が利用できない間 `/health` は `503` を返し、両方が復旧すると
`200` を返します。Caddy はサーバーの health check が成功してからサービス
を開始します。

通常の durable ストア接続 timeout は 10 秒、リクエスト処理中の
データストア操作 timeout は 15 秒です。スキーマ初期化は専用プールと
10 分の timeout を使うため、ロック待機とデータマイグレーションにも
有限の制限が適用されます。

health endpoint の成功はプロセスと設定済みストアの準備完了だけを示し
ます。allowlist 内のすべての ActivityPub origin へ接続できることや、
すべてのアダプター操作が成功することまでは保証しません。


アップグレードと秘密情報のローテーション
----------------------------------------

アップグレード前に PostgreSQL と Redis の volume をバックアップします。
新しいコンテナータグごとに不変の digest を確認し、デプロイ値を更新して
quiet 構成チェックを実行してからスタックを起動します。サーバーは listen
を開始する前に PostgreSQL ライフサイクルマイグレーションを実行します。

複数インスタンスのデプロイで匿名セッションを `stored` から `stateless`
へ変更する場合は、まず両方の cookie 形式をデコードできるリリースを全
インスタンスにデプロイし、モードは `stored` のままにします。その
デプロイが完了してからフリート全体を同時に `stateless` へ変更します。
古いデコーダが残る混在フリートでは新しい cookie 形式を安定して処理
できません。その後フリートを `stored` に戻す場合、更新済みインスタンス
は有効な stateless 匿名 cookie を設定済みセッションストアに登録してから
stored-session cookie を発行します。

`ACTIVITYPLUG_COOKIE_SIGNING_KEY` をローテーションすると、既存の
ブラウザー cookie とそこから導出した CSRF token が無効になります。
ユーザーは新しいブラウザーセッションを作成し直す必要があります。フリート
全体で一度にローテーションしてください。

Compose の `POSTGRES_PASSWORD` だけを変更しても、既存の PostgreSQL
volume 内のパスワードは変わりません。データベースロールの資格情報を
先に変更してからデプロイの秘密情報と接続 URL を更新します。Redis の
パスワードは `requirepass` 設定とサーバー接続 URL を同時に変更します。
片方だけを変更すると readiness チェックが失敗します。

`down` スクリプトは `--volumes` を渡さないため、named データと Caddy
認証局の状態が残ります。これらの volume 削除は別の破壊的操作であり、
記載した停止手順には含まれません。


運用上の制限
------------

リファレンススタックは固定されたローカルサブネット、サービスアドレス、
port、リソース制限を使います。デプロイ環境と競合しないことを確認し、
実測した負荷に基づいて値を調整してください。Compose ファイルは外部
ロードバランサ、公開 hostname 用の証明書自動化、リモートバックアップ、
モニタリング、マルチホストオーケストレーションを提供しません。

サンプルサーバーは生のトークン import を無効にし、明示的なリモート
origin allowlist を要求します。レビュー済みのアプリケーション要件が
より限定的な認可ポリシーと運用ポリシーを定めない限り、この既定値を
維持してください。


関連ドキュメント
----------------

 -  [サーバーの使用方法](server-usage.md)
 -  [セッションストレージ](session-storage.md)
 -  [セキュリティモデル](security-model.md)
