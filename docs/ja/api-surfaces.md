API サーフェス
==============

[English](../en/api-surfaces.md) | [한국어](../ko/api-surfaces.md) | 日本語

ActivityPlug は同じポータブル操作モデルを TypeScript ライブラリ、HTTP
API、GraphQL API、ブラウザ境界で提供します。各サーフェスは異なる信頼
境界と配備条件に対応します。


サーフェスを選ぶ
----------------

| サーフェス            | 適する用途                                          | 認証境界                                        | 契約の基準                                      |
| --------------------- | --------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| TypeScript ライブラリ | 信頼するコードが adapter、transport、store を所有   | アプリケーション store が保持する `AuthSession` | `@activityplug/core` とアダプタの export 型     |
| HTTP API              | サービスや非 GraphQL クライアントが中央サーバを呼ぶ | 認証操作の `Authorization: Bearer <session-id>` | `/api/v1/openapi.json` の OpenAPI 3.1 文書      |
| GraphQL API           | フィールド選択と単一スキーマが必要                  | 認証操作の `Authorization: Bearer <session-id>` | `/graphql` のスキーマと `createGraphQLSchema()` |
| ブラウザ API          | Web アプリケーションに BFF 境界が必要               | 署名済み HttpOnly cookie、origin 検査、CSRF     | `@activityplug/server` のブラウザ型と route     |

HTTP と GraphQL は広い公開サーバサーフェスです。ブラウザ API は UI に
必要な一部の操作とブラウザ向け DTO を提供します。


共通の操作モデル
----------------

全サーフェスはコアの公開操作名を基準にします。スキーマや route が存在
しても、選択したアダプタが `UNSUPPORTED_OPERATION` を返す場合があります。
対象インスタンスの capability を確認してください。エンティティ ID と
ページカーソルは opaque であり、adapter、origin、type、operation の
バインディングを保持します。


TypeScript ライブラリ
---------------------

~~~~ ts
const page = await client.timelines.public({
  page: { limit: 20 },
});
~~~~

ライブラリは同じプロセスでアダプタを通じたサービスを呼び出します。
アプリケーション側で審査済み `RemoteAuthority`、必要な永続ストア、
アダプタ選択、WebSocket 作成を提供します。
[ライブラリの使い方](library-usage.md)を参照してください。


HTTP API
--------

HTTP API のルートは `/api/v1` で、`GET /health` は readiness を返します。
現在の HTTP 契約は以下の OpenAPI 文書です。

~~~~ text
GET /api/v1/openapi.json
~~~~

route、メソッド、パラメータ、ボディ、レスポンス、エラースキーマはこの
文書を参照してください。成功 JSON は `{ "data": ... }`、失敗は
`{ "error": ... }` エンベロープです。認証操作は ActivityPlug セッション
ID をヘッダで送ります。

~~~~ http
Authorization: Bearer <activityplug-session-id>
~~~~

リモート Fediverse のアクセストークンは公開 API の bearer credential では
ありません。トークンインポートはサーバが明示的に有効化する必要があります。
HTTP API のバインド済み WebSocket route も、実行中の OpenAPI とストリーム
ディスカバリレスポンスを基準にします。


GraphQL API
-----------

~~~~ text
POST /graphql
~~~~

GraphQL 契約は `createGraphQLSchema()` が生成し、実行中のエンドポイント
が提供するスキーマです。配備が許可する場合は introspection でフィールド、
引数、入力、nullability、enum を確認できます。認証には HTTP API と同じ
セッション bearer ヘッダを使い、ボディや URL の `sessionId` は拒否
されます。

サーバはリクエストバイト、depth、alias、selection、外向き同時実行の制限
を適用します。ポータブルな失敗は GraphQL エラーの
`extensions.activityplug` に入ります。`examples/proxy-client` は HTTP と
GraphQL を併用する型付きクライアントの例です。


ブラウザ API
------------

ブラウザ境界のルートは `/v1/browser` です。ブラウザオプションを設定した
場合にのみ有効になります。公開 API とは異なり署名済みブラウザ cookie を
使い、Authorization ヘッダを拒否します。mutation は origin と CSRF
トークンを検証し、アダプタ固有の `raw` を除いたブラウザ DTO を返します。
ストリーミングはブラウザセッションにバインドされた短期の使い捨てチケット
を使います。

ブラウザコードはまず `/v1/browser/session` から cookie と CSRF トークン
を受け取り、安全でないリクエストに設定済みヘッダ（デフォルトは
`X-ActivityPlug-CSRF`）を送ります。ActivityPlug セッション ID やリモート
アクセストークンを JavaScript ストレージに保存しないでください。ブラウザ
route のドキュメントと export 型が契約です。


サーフェス間の capability
-------------------------

すべてのサーフェスで `supported`、`unsupported`、`unknown` の意味は
同じです。ライブラリは `client.capabilities`、公開サーバは HTTP と
GraphQL クエリ、ブラウザ境界は認証済みインスタンスのブラウザ向け
projection を提供します。インスタンス、アダプタ、ブラウザセッションが
変わった場合は capability を再取得してください。


認証とシークレットの扱い
------------------------

ライブラリはトークンをストアに残して `AuthSession` を返します。HTTP と
GraphQL クライアントは ActivityPlug セッション ID を bearer credential
として使います。ブラウザ境界は関連付けをサーバに保持し、署名済み cookie
だけを公開します。OAuth シークレット、トークン、コールバック state、PKCE
verifier、cookie、CSRF トークン、ストリームチケットを相互変換したり URL
に入れたりしないでください。
[認証とセッション](authentication-and-sessions.md)と
[セキュリティモデル](security-model.md)を参照してください。


エラー、ページ移動、互換性
--------------------------

ライブラリは `ActivityPlugError` を throw し、HTTP はステータスとエラー
エンベロープ、GraphQL は `extensions.activityplug`、ブラウザはブラウザ
エラーエンベロープを使います。HTTP と GraphQL は start/end カーソルを、
ブラウザは UI に必要な forward カーソルを返します。アダプタ固有の `raw`
や `extensions` はポータブル契約ではありません。


契約を維持する
--------------

1.  ライブラリはパッケージの export を基準にします。
2.  HTTP は配備済み `/api/v1/openapi.json` を取得します。
3.  GraphQL は配備済みスキーマを使います。
4.  BFF はブラウザ route のドキュメントと export 型を使います。
5.  対象インスタンスの capability を実行時に確認します。

リポジトリのソースとサンプルは動作を説明しますが、リモートクライアントが
送信できる値は配備済みバージョンの生成契約で決まります。
