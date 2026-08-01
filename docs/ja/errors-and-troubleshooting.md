エラーとトラブルシューティング
==============================

[English](/en/errors-and-troubleshooting.md) |
[한국어](/ko/errors-and-troubleshooting.md) | 日本語

ActivityPlug は型付きエラー契約として `ActivityPlugError` を使います。
同じコードがプロセス内サービス、公開 HTTP API、GraphQL API で共通です。
ブラウザー境界はそれらをより小さなプロダクト向けコードセットに
マッピングします。


TypeScript でのエラー処理
-------------------------

コードやコンテキストを読み取る前に `isActivityPlugError()` を使って
ください。

~~~~ ts
import { isActivityPlugError } from "@activityplug/core";

try {
  await client.posts.get({ id });
} catch (error) {
  if (!isActivityPlugError(error)) throw error;

  if (error.code === "UNSUPPORTED_OPERATION") {
    disableUnsupportedAction(error.context.capability);
    return;
  }

  reportActivityPlugFailure(error.code, error.context);
}
~~~~

`context` には `adapter`、`origin`、`operation`、`capability`、内部の
`raw` 値が含まれる場合があります。公開 transport では `raw` を省略
します。


エラーコード
------------

| コード                   | 意味                                                     | 一般的な対応                                     |
| ------------------------ | -------------------------------------------------------- | ------------------------------------------------ |
| `ADAPTER_NOT_FOUND`      | 設定済みアダプターがリクエストに一致しない               | アダプター ID とサーバーのアダプター一覧を確認   |
| `AUTH_REQUIRED`          | 操作に認証が必要                                         | 認証するかブラウザーセッションを更新             |
| `AUTH_EXPIRED`           | 保存済みまたはリモートの資格情報が失効                   | 再認証する（同じ資格情報での再試行は不可）       |
| `AUTH_UNSUPPORTED`       | アダプターが要求された認証方式に未対応                   | capability が対応する方式を選択                  |
| `CAPABILITY_UNKNOWN`     | 対応を安全に判断できない                                 | 操作を避けるか試行前にユーザーへ確認             |
| `UNSUPPORTED_OPERATION`  | アダプターがその操作を実装しないと明示                   | アクションを無効にし capability の理由を活用     |
| `VALIDATION_FAILED`      | 入力、ID、origin、設定値が無効                           | リクエストを修正する（同一入力の再試行は不可）   |
| `NOT_FOUND`              | リモートまたはローカルのエンティティが見つからない       | 古い参照を削除するか包含リソースを更新           |
| `CONFLICT`               | 現在のリモートまたはローカル状態が変更を妨げる           | 再試行を判断する前に状態を更新                   |
| `RATE_LIMITED`           | ローカルまたはリモートのレート制限が拒否                 | `Retry-After` があればそれに従う                 |
| `REMOTE_PROTOCOL_ERROR`  | upstream レスポンスが期待プロトコルに違反                | アダプター、origin、操作を記録し互換性を確認     |
| `REMOTE_ERROR`           | upstream サーバーが別の障害を返した                      | 状態とログを確認し安全な操作だけ再試行           |
| `NETWORK_ERROR`          | リモート接続に失敗                                       | DNS、TLS、ルーティング、origin ポリシーを確認    |
| `TIMEOUT`                | 設定済みリクエスト期限が切れた                           | upstream 遅延とリクエスト budget を確認          |
| `ORIGIN_NOT_ALLOWED`     | origin ポリシーがリモート origin を拒否                  | 意図した厳密な origin を追加するかリクエスト修正 |
| `REQUEST_LIMIT_EXCEEDED` | リクエスト、レスポンス、アップロード、ストリームが上限超 | ペイロードを減らすかデプロイ制限を調整           |
| `INTERNAL_ERROR`         | より安全で具体的なエラーを公開できない                   | サーバーログを照合し失敗した操作を保持           |

`CAPABILITY_UNKNOWN` と `UNSUPPORTED_OPERATION` は異なります。前者は
アダプターが対応を確定できないことを意味し、後者は操作が利用できないと
確定したことを意味します。


公開 HTTP のマッピング
----------------------

公開 HTTP エラーは次の形式を使います。

~~~~ json
{
  "error": {
    "code": "ORIGIN_NOT_ALLOWED",
    "message": "Remote origin is not allowed by this server.",
    "origin": "https://social.example",
    "operation": "instance.detect"
  }
}
~~~~

任意の公開コンテキストフィールドは `adapter`、`origin`、`operation`、
`capability` です。

| HTTP ステータス | ActivityPlug コード                                                                    |
| --------------- | -------------------------------------------------------------------------------------- |
| `400`           | `AUTH_UNSUPPORTED`, `CAPABILITY_UNKNOWN`, `UNSUPPORTED_OPERATION`, `VALIDATION_FAILED` |
| `401`           | `AUTH_REQUIRED`, `AUTH_EXPIRED`                                                        |
| `403`           | `ORIGIN_NOT_ALLOWED`                                                                   |
| `404`           | `ADAPTER_NOT_FOUND`, `NOT_FOUND`                                                       |
| `409`           | `CONFLICT`                                                                             |
| `413`           | `REQUEST_LIMIT_EXCEEDED`                                                               |
| `429`           | `RATE_LIMITED`                                                                         |
| `502`           | `REMOTE_PROTOCOL_ERROR`, `REMOTE_ERROR`, `NETWORK_ERROR`                               |
| `504`           | `TIMEOUT`                                                                              |
| `500`           | `INTERNAL_ERROR` および分類されていないサーバー障害                                    |

レート制限エラーに正の `retryAfterSeconds` 値がある場合、レスポンスには
`Retry-After` が含まれます。


GraphQL のマッピング
--------------------

GraphQL の構文、body 形状、バリデーション失敗は通常の GraphQL エラー
とともに HTTP 400 を返します。リクエストの読み取りまたは解析中に
`ActivityPlugError` が発生すると、HTTP ステータスは上の表に従い、
詳細は `extensions.activityplug` に含まれます。

~~~~ json
{
  "errors": [
    {
      "message": "Remote origin is not allowed by this server.",
      "extensions": {
        "activityplug": {
          "code": "ORIGIN_NOT_ALLOWED",
          "origin": "https://social.example",
          "operation": "instance.detect"
        }
      }
    }
  ]
}
~~~~

GraphQL 実行中のエラーは、成功した GraphQL HTTP レスポンス内の実行
エラーとして残ります。HTTP ステータスが 200 でもクライアントは
`errors` 配列を確認する必要があります。ActivityPlug 固有の制御フローに
は `extensions.activityplug.code` を使ってください。

サーバーはクエリ変数やリクエスト body 内の GraphQL セッション ID を拒否
します。セッションは `Authorization: Bearer <session-id>` で送信して
ください。


ブラウザーのマッピング
----------------------

ブラウザー境界は内部コードセット全体を公開しません。

| ブラウザーコード   | HTTP ステータス | 発生元                                                                   |
| ------------------ | --------------- | ------------------------------------------------------------------------ |
| `BAD_REQUEST`      | `400`           | 無効なブラウザー入力、リクエスト制限、不正な境界リクエスト               |
| `UNAUTHENTICATED`  | `401`           | 欠落、失効、無効なブラウザーセッションまたは認証セッション               |
| `FORBIDDEN`        | `403`           | CSRF、クロスオリジン、リモート origin の拒否                             |
| `NOT_FOUND`        | `404`           | 存在しないルート、アダプター、エンティティ                               |
| `CONFLICT`         | `409`           | セッションまたはリモート状態の競合                                       |
| `UNSUPPORTED`      | `422`           | 未対応の認証方式、不明な capability、未対応の操作                        |
| `RATE_LIMITED`     | `429`           | 認証開始または upstream のレート制限                                     |
| `UPSTREAM_FAILURE` | `502`           | リモートプロトコル、リモート、ネットワーク、タイムアウト、予期しない障害 |

すべてのブラウザーエラーには `code`、`message`、生成された `requestId`
があります。レート制限エラーには `retryAfterSeconds` と `Retry-After`
ヘッダーが含まれる場合もあります。ユーザーに表示した障害とログを
照合するには `requestId` を使ってください。

中断されたブラウザーリクエストは空の body とステータス 499 を返します。
upstream エラーではなくクライアントによるキャンセルとして扱ってください。


サーバーがインスタンスに接続できない
------------------------------------

### `ORIGIN_NOT_ALLOWED`

`createActivityPlugServer()` は `originPolicy` が指定されていない場合、
すべてのリモート origin を拒否します。完全一致の allowlist を設定して
ください。

~~~~ ts
import {
  createActivityPlugServer,
  createOriginPolicy,
} from "@activityplug/server";

const activityPlug = createActivityPlugServer({
  adapters,
  originPolicy: createOriginPolicy([
    "https://social.example",
    "https://community.example",
  ]),
});
~~~~

CLI では `--allow-origin` を繰り返し指定します。allowlist に含める
origin は HTTPS を使い、パスや資格情報を含められません。

### Private アドレスまたはループバックアドレスが拒否される

許可済み origin であってもブロック対象アドレスに解決される場合があり
ます。デプロイが private ネットワークへの接続を意図している場合に限り
`allowPrivateNetworks: true` または `--allow-private-networks` を使って
ください。明示的な origin ポリシーは維持してください。アドレスの許可は
その代わりにはなりません。

### HTTP は動作するがストリーミングが失敗する

Mastodon 互換アダプターと Misskey アダプターのストリーミングには
WebSocket ファクトリーの注入が必要です。HTTP と同じ origin ポリシーと
ルックアップ規則で `createNodePinnedWebSocketFactory()` を使ってくだ
さい。選択したアダプターが要求されたストリーミング capability を対応と報告
していることも確認してください。


認証の失敗
----------

### Bearer 資格情報が拒否される

公開 HTTP と GraphQL は `Authorization` ヘッダー内の ActivityPlug
セッション ID だけを受け付けます。URL やリクエスト body から `sessionId`
を削除してください。

ブラウザールートは逆に `Authorization` を拒否し、
`__Host-activityplug` cookie を使います。
`GET /v1/browser/session` で初期化してください。

### トークンの import でエラーが返る

トークンインポートは既定で無効です。アプリケーションに明示的な
インポートフローがある場合に限り `tokenImport.enabled: true` を設定して
ください。
`guard` が設定されていれば、リクエストはその guard も満たす必要が
あります。

### 永続 OAuth コールバックを完了できない

永続的な認証セッションストアには互換性のある永続的な
`oauthClientSecrets` ストアが必要です。両方を
`@activityplug/session-postgres` で設定してください。永続セッションと
既定のインメモリシークレットストアを組み合わせないでください。

### ブラウザーの CSRF 障害

`GET /v1/browser/session` を取得し、返された CSRF トークンをメモリに
保持して、状態変更リクエストでは設定済みの CSRF ヘッダーで送信して
ください。cookie とトークンが同じブラウザーセッションを表すよう
`credentials: "same-origin"` を含めます。

401 の後はプライベート状態を破棄する前にセッションを再取得してください。
更新中のネットワーク障害はログアウトの証拠にはなりません。架空の匿名
セッションをキャッシュせず、プライベートキャッシュ状態を消去し、更新
失敗を表示してください。
[ブラウザー統合](browser-integration.md#認証の回復)を参照して
ください。

### OAuth コールバックが認証なしでアプリに戻る

ブラウザーコールバックはコールバックの詳細をブラウザーに公開せず、
失効済み、使用済み、不一致、無効な OAuth 状態を意図的に `returnTo` へ
リダイレクトします。次の点を確認してください。

 -  外部リダイレクト後もブラウザー cookie が維持されたか
 -  コールバック URL が設定済みの公開 origin を使っているか
 -  OAuth 状態ストアとチャレンジストアが処理レプリカ間で共有されて
    いるか
 -  サーバークロックとストアの失効動作が正しいか
 -  リモート origin とアダプターが元の開始リクエストと一致するか

次に `GET /v1/browser/session` を取得し、信頼できる状態を判断します。


ブラウザーストリームの失敗
--------------------------

ブラウザーストリームチケットは使い捨てで、1 つのブラウザーセッションと
1 つの操作に結び付けられ 60 秒後に失効します。
`/v1/browser/stream` を開く直前にチケットを要求してください。

使用済みチケットを再試行しないでください。現在の cookie と CSRF トークン
で新しいチケットを要求してください。チケットの作成とストリームの消費が
異なるレプリカに到達する場合は共有 `StreamTicketStore` を使います。

ブラウザーストリームはサーバー送信イベントを使います。reverse proxy の
バッファリングを無効にし、想定されるハートビート間隔より長いアイドル
タイムアウトを設定してください。


ヘルスチェックが 503 を返す
---------------------------

`GET /health` は設定済みの `readiness` コールバックが false を返すか
拒否された場合に限り 503 を返します。そのコールバックがテストする各
依存関係を確認してください。既定のヘルス実装はデータベースや Redis を
検査しません。

可能であれば依存関係チェックを短く保ち、通常のリクエストプールから
分離してください。本番 Web クライアントのサンプルでは、個別に制限された
PostgreSQL と Redis の readiness クライアントを使います。


制限によるリクエストの失敗
--------------------------

`REQUEST_LIMIT_EXCEEDED` は JSON、GraphQL ドキュメント、multipart
アップロード、リモート構造化レスポンス、ストリームバッファに適用される
場合があります。操作を特定し、ペイロードを `requestLimits` および
`graphqlLimits` と比較してください。

これらの設定は異なるレイヤーを対象とします。`requestLimits` は
transport サイズとストリームバッファリングを対象とし `graphqlLimits` は
GraphQL ドキュメント形状とリゾルバ同時実行数を対象とします。
`createBudgetScope` が返す `BudgetScope` は、これとは別に操作単位の
リモートリクエスト数、読み取り数、バイト数、ノード数、同時実行数、
期限を制限します。適用中の操作 budget を使い切った場合も
`REQUEST_LIMIT_EXCEEDED` が発生することがあります。

リクエストが想定どおりか確認する前に制限を引き上げないでください。
どのレイヤーが拒否しているか把握できるよう、proxy 制限を ActivityPlug
の制限と整合させてください。


シャットダウンが停止する、またはリソースが開いたままになる
----------------------------------------------------------

注入したデータベースクライアントや Redis クライアントを閉じる前に
`await activityPlug.close()` を呼び出してください。サーバーは自身の
リスナーと所有するクリーンアップライフサイクルを閉じますが、注入された
クライアントは所有しません。

アプリケーションが `startActivityPlugServer()` を直接使う場合は返された
Node サーバーを所有するため、自身で閉じる必要があります。1 つの
オブジェクトでリスナーと ActivityPlug セキュリティ状態のライフサイクルを
連携させるには `createActivityPlugServer()` を使ってください。


関連ドキュメント
----------------

 -  [サーバーの使用方法](server-usage.md)
 -  [ブラウザー統合](browser-integration.md)
 -  [認証とセッション](authentication-and-sessions.md)
 -  [セッションストレージ](session-storage.md)
 -  [セキュリティモデル](security-model.md)
