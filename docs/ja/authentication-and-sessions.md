認証とセッション
================

[English](../en/authentication-and-sessions.md) |
[한국어](../ko/authentication-and-sessions.md) | 日本語

ActivityPlug は、ActivityPub サーバーごとに異なる資格情報を不透明な
`AuthSession` へ変換します。アプリケーションが扱うのは ActivityPlug の
セッション識別子だけです。リモートの access token、refresh token、
アダプター固有の認証データはサーバー側のセッションストアだけが保持します。


認証ストラテジー
----------------

アダプターは、対象のリモートサーバーが受け付けるストラテジーを公開します。
`auth.availableStrategies` でその一覧を確認できます。

| ストラテジー     | アプリケーションのフロー                                                          |
| ---------------- | --------------------------------------------------------------------------------- |
| `oauth`          | OAuth クライアントを登録または指定し、認証 URL を生成してコールバックコードを交換 |
| `token`          | リモートサーバーが発行済みのトークンを取り込む                                    |
| `emailChallenge` | メールチャレンジを開始し、コードを検証する                                        |
| `passkey`        | WebAuthn の認証手順を開始して完了する                                             |

ストラテジー間の fallback はありません。選択したアダプターが実装していない
フローを呼び出すと unsupported-operation エラーになります。OAuth の更新と
失効もアダプターが宣言した capability に依存します。


ライブラリでの認証
------------------

ライブラリ API は各ストラテジーを `client.auth` 配下に提供します。

~~~~ ts
const strategies = client.auth.availableStrategies;

const session = await client.auth.token.importToken({
  accessToken: process.env.REMOTE_ACCESS_TOKEN!,
  tokenType: "Bearer",
});

const verified = await client.auth.verifySession(session);
~~~~

`importToken()` は資格情報をアダプターへ渡して正規化し、ActivityPlug
セッションとして保存します。返される公開セッションには、不透明な識別子、
アダプター、origin、ストラテジー、scope、capability、任意のアカウント
参照が含まれます。リモートトークンは含まれません。

OAuth では `auth.oauth.registerClient()`、`auth.oauth.start()`、
`auth.oauth.exchange()` の順に呼び出します。redirect の前後で state と
PKCE binding を保持し検証してください。サーバー API とブラウザー API は
この状態管理を行う上位レベルの handler を提供します。


公開 HTTP と GraphQL の認証
---------------------------

公開サーバーは、トークン取り込み、OAuth、メールチャレンジ、passkey、
更新、失効の各操作を提供します。`tokenImport.enabled` が `true` で
なければトークン取り込みは無効です。公開デプロイでは、リモートトークンを
受け付ける前に独自の認可ポリシーを適用する `tokenImport.guard` も
指定します。

認証後は ActivityPlug セッション識別子を HTTP の `Authorization`
ヘッダーで送信します。

~~~~ http
GET /api/v1/timelines/home HTTP/1.1
Host: proxy.example
Authorization: Bearer $ACTIVITYPLUG_SESSION
~~~~

GraphQL の HTTP リクエストと WebSocket upgrade も同じ Bearer ヘッダーを
使います。ActivityPlug は公開 API の query parameter や request body に
含まれる `sessionId` を拒否します。削除された入力の詳細は
[0.1.0 の認証マイグレーション](migrations/0.1.0-authentication.md)を
参照してください。


ブラウザーでの認証
------------------

ブラウザーアプリケーションは ActivityPlug セッション識別子を受け取らず、
`/v1/browser/**` 境界を使います。ブラウザー認証は次の順序で進みます。

1.  `GET /v1/browser/session` が `__Host-activityplug` cookie と CSRF
    トークンを発行します。
2.  `POST /v1/browser/auth/start` が OAuth、メールチャレンジ、passkey の
    フローを開始します。same-origin リクエストで CSRF ヘッダーが必要です。
3.  OAuth は `/v1/browser/auth/callback` に戻ります。メールと passkey の
    フローは `POST /v1/browser/auth/complete` で完了します。
4.  ブラウザーセッションレコードをサーバー側の ActivityPlug 認証セッション
    に関連付けます。
5.  `POST /v1/browser/logout` は、upstream token の失効に失敗しても
    ローカル状態を削除します。

ブラウザールートは `Authorization` 資格情報と `sessionId` query parameter
を拒否します。cookie には Secure、HttpOnly、SameSite=Lax が設定され、
パスは `/` に限定されます。署名には `cookieSigningKey` を使います。
状態を変更するリクエストには CSRF ヘッダーが必要です。既定のヘッダーは
`X-ActivityPlug-CSRF` です。

OAuth state はアダプター、リモート origin、クライアント、redirect URI、
PKCE verifier、ブラウザーセッションに binding されます。コールバックを
交換する前に短期 lease で state を claim し、成功時に consume します。
この仕組みにより、同時実行や再送されたコールバックが同じ state を再利用
できなくなります。


資格情報のライフサイクル
------------------------

`StoredAuthSession` には token set、タイムスタンプ、保存期間、revision、
任意のブラウザーセッション owner が含まれます。ストア実装は、単一作成、
1 回限りの consume、正確な revision での置換、正確な revision での削除を
保証します。これにより、遅れて到着した更新や失効が新しい資格情報を
上書きすることを防ぎます。

`verifySession()` はリモート資格情報を検証し、保存済みのアカウント参照を
更新します。`refreshSession()` は次の revision で token set を置き換え
ます。`revokeSession()` はまずセッション revision を claim し、
アダプターが対応していればリモート資格情報の失効を依頼してから、ローカル
認証状態を削除します。

一部の OAuth サーバーは、redirect 後も必要になるクライアントシークレットを
返します。ActivityPlug はこの値を `OAuthClientSecretStore` に分けて保存
し、認証セッションには不透明な資格情報参照だけを保持します。既定の
サーバーは、設定された client-secret ストアから credential-lease ストアを
作成します。

access-token の期限と保存期限は意味が異なります。refresh token があれば、
期限切れの access token も保存されたまま残る場合があります。
`storageExpiresAt` は認証セッション全体を削除する時点を決定します。


セッションストアの選択
----------------------

core クライアントとサーバーは、既定でインメモリ認証セッションを使います。
テストと単一プロセスのローカル開発に適した構成です。再起動後もセッションを
維持する場合や複数プロセスで共有する場合は PostgreSQL または Redis を使い
ます。ブラウザーデプロイでは、ブラウザーセッション、OAuth state、
チャレンジ、ストリームチケット、rate limit 用のストアも必要です。

ストア全体の対応表とライフサイクル要件は
[セッションストレージ](session-storage.md)を参照してください。


運用上の注意
------------

 -  ActivityPlug セッション識別子とブラウザー cookie を URL に含めないで
    ください。
 -  認証セッションや OAuth クライアントシークレットを格納する
    データベースへのアクセスを制限してください。
 -  準備完了を通知する前に `server.ready` を待機してください。
 -  PostgreSQL や Redis クライアントを閉じる前に `server.close()` を
    呼び出してください。
 -  複数プロセスで共有が必要なセキュリティ状態には共有ストアを使って
    ください。
 -  リモートリクエスト、データベース、キャッシュの timeout は
    それぞれの transport 側で設定してください。ストレージパッケージは
    汎用のコマンド timeout を追加しません。


関連ドキュメント
----------------

 -  [セッションストレージ](session-storage.md)
 -  [ブラウザー統合](browser-integration.md)
 -  [セキュリティモデル](security-model.md)
 -  [0.1.0 の認証マイグレーション](migrations/0.1.0-authentication.md)
