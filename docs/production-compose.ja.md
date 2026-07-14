本番 compose
============

[English](production-compose.md) | [한국어](production-compose.ko.md)

本番用の例ではパッケージスクリプトを使用します。ランチャーは Docker に値を
渡す前にイメージ参照と永続データ用パスワードを検証し、永続化スタックと
メモリスタックには別々の固定プロジェクト名を使用します。

~~~~ sh
pnpm compose:config
pnpm compose:up
pnpm compose:health
pnpm compose:down
~~~~

メモリスタックはポート `8444` と別のローカル CA ファイルを使用するため、
ポート `8443` の永続化スタックと同時に実行できます。

~~~~ sh
pnpm compose:memory:config
pnpm compose:memory:up
pnpm compose:memory:health
pnpm compose:memory:down
~~~~


永続化デプロイに必要な値
------------------------

`ACTIVITYPLUG_NODE_IMAGE`、`ACTIVITYPLUG_CADDY_IMAGE`、
`ACTIVITYPLUG_POSTGRES_IMAGE`、`ACTIVITYPLUG_REDIS_IMAGE` には不変の
`name:tag@sha256:digest` 参照を指定します。`ACTIVITYPLUG_PNPM_VERSION` は
`11.12.0` に設定します。Compose には `ACTIVITYPLUG_COOKIE_SIGNING_KEY` と
`ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS` も必要です。認証済み API
とストリーミングの
資格情報を平文で送信しないよう、許可するすべてのリモートオリジンには HTTPS
が必要です。

`ACTIVITYPLUG_POSTGRES_PASSWORD` と `ACTIVITYPLUG_REDIS_PASSWORD` はデプロイ
シークレットマネージャーから指定します。各値には 32 文字以上の URL 安全な
base64 文字（`A-Z`、`a-z`、`0-9`、`_`、`-`）を含め、異なる値にします。
ランチャーは Docker の開始前にこれを確認し、変数名だけを報告してシークレット
値を報告しません。ランチャーは正確に `config --quiet` のみを許可するため、
`pnpm compose:config` は資格情報を標準出力に書かずにレンダリング済み設定を
検証します。


匿名セッションのロールアウト
----------------------------

Compose の例では `ACTIVITYPLUG_ANONYMOUS_SESSION_MODE` を `stateless` に
明示的に設定します。これにより、未認証の訪問者やヘルスプローブごとに永続化
ストアの行を作成しません。すべてのサーバーが新しい Cookie 形式を解釈できる
ようになる前に新形式を発行しないよう、サーバー API と製品設定の既定値は
`stored` です。

既存の複数インスタンスサービスでステートレスセッションを有効にする場合は、
2 回に分けてデプロイします。最初に、モードを `stored` のまま、このリリースを
すべてのインスタンスへデプロイします。この段階では従来の不透明な Cookie を
引き続き発行し、新しいデコーダーは両方の形式を受け入れます。すべての
インスタンスが新しいデコーダーを実行した後、全インスタンスを同時に
`stateless` へ切り替えます。旧リリースが残るフリートの一部だけで
ステートレスモードを有効にしないでください。

新しいデコーダーは、従来の不透明な Cookie から認証済みセッションを復元します。
アップグレード済みインスタンスを `stored` モードへ戻す場合、有効な
ステートレス匿名 Cookie を設定済みセッションストアへ取り込んでから、再び
不透明な Cookie を発行します。


ネットワーク境界
----------------

`product-edge` は internal ではないネットワークです。Caddy と Web サービスが
これを使用し、Web サービスは `172.30.0.2` を維持します。サーバーも Caddy
トラフィックと外部インターネット接続のためにこのネットワークに参加します。
サーバーはプロキシアドレスとして引き続き正確に `172.30.0.2` だけを信頼します。

`product-data` は internal ネットワークです。サーバー、PostgreSQL、Redis
だけが参加します。したがって Web サービスはデータベースまたは Redis の
サービス名を名前解決または到達できません。PostgreSQL と Redis はホストポートを
公開しません。PostgreSQL は指定されたパスワードを使用し、Redis は指定された
パスワードを要求し、両方のヘルスチェックは認証します。名前付きボリュームは
PostgreSQL データと Redis の append-only 永続化を保持します。

PostgreSQL イメージは空のボリュームを初期化するときだけ
`POSTGRES_PASSWORD` を適用します。既存ボリュームのパスワードは、デプロイ
シークレットを変更する前にデータベースロールの変更でローテーションします。


ビルドコンテキストとランタイム制限
----------------------------------

ルートの `.dockerignore` は、両方の本番 Dockerfile のための許可リストです。
ワークスペースマニフェスト、必要なコンパイラ設定、`packages`、
`examples/web-client` だけを含めます。ローカル依存関係、生成済み出力、
カバレッジ、入れ子の worktree、アーティファクト、ローカル開発状態、一般的な
証明書または鍵ファイルは除外します。イメージビルドをデバッグするためにこれらの
除外を弱めないでください。代わりに、レビュー済みの入力を明示的にコピーします。

すべてのサービスは `restart: unless-stopped` と、上限を設定した CPU、メモリ、
PID 制限を使用します。Web とサーバーのコンテナは読み取り専用のルート
ファイルシステムで実行し、すべての Linux capability を削除し、権限昇格を
禁止し、小さな書き込み可能な `/tmp` だけを受け取ります。Caddy は、非特権
プロセスが HTTPS にバインドできるように `NET_BIND_SERVICE` だけを保持します。
PostgreSQL と Redis は通常の書き込み可能なファイルシステムとエントリポイントの
権限を維持しますが、再起動とリソースにも上限を設定します。

Web サービスは正常なサーバーを待機し、永続化サーバーは認証済みで正常な
PostgreSQL と Redis サービスを待機します。公開 `/health` エンドポイントは
readiness チェックです。永続データストアのいずれかが利用できない間は `503` を
返し、回復後は `200` を返します。CI の smoke test は外部 TLS エンドポイントを
通じて、各データストアの障害と回復を個別に検証します。

本番用ファイルに対して `docker compose` を直接実行しないでください。Compose
の変数展開では不変イメージ参照や強力なパスワードを強制できないため、ランチャー
がサポートされるセキュリティ境界です。
