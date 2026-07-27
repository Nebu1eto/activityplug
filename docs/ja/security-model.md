セキュリティモデル
==================

[English](../en/security-model.md) | [한국어](../ko/security-model.md) | 日本語

ActivityPlug はクライアントが選択したリモート ActivityPub origin を
受け取り、ユーザーの資格情報を外部リクエストに付加できます。安全な
デプロイでは、接続先と、資格情報が発行元 origin を離れられる条件の
両方を制御する必要があります。

このドキュメントは `@activityplug/core`、`@activityplug/server`、
サンプル product server が実装する境界を説明します。有効にする
アダプター、origin、資格情報、ルート、ストア実装はアプリケーション
コードが決定します。


信頼境界
--------

主な境界は次のとおりです。

1.  公開クライアントが GraphQL、HTTP、ブラウザーリクエストを
    ActivityPlug へ送信します。
2.  信頼済み reverse proxy が公開 TLS を終端し、選択したルートを
    サーバーへ転送します。
3.  アダプターがリモートサーバーへ接続する前に、サーバーがリクエスト
    制限、セッション、origin、資格情報の使用を検証します。
4.  検証済み HTTP または WebSocket transport が、許可されたリモート
    接続先を解決して固定してから socket を開きます。
5.  セッションストアとライフサイクルストアが認証状態とブラウザー
    セキュリティ状態を保持します。

外部 ActivityPub トラフィック用に許可した origin が、自動的に
ブラウザー origin、OAuth redirect URI、CORS origin、信頼済み proxy、
資格情報の受信者になることはありません。境界ごとに個別の設定が必要です。


リモート origin ポリシー
------------------------

origin ポリシーを指定しない場合、サーバー側のリモートアクセスは既定で
拒否されます。`createOriginPolicy()` は各 origin を正規化した後、
完全一致の allowlist を作成します。サンプル product server は
`ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS` を必須とし、wildcard を拒否して
HTTPS origin だけを受理します。

ポリシーはすべての外部操作について、正規化された origin と操作名を
受け取ります。redirect 先も DNS 解決の前に再検査します。したがって
origin を追加して許可されるのは、そのポリシーを使う操作の接続だけで
あり、cross-origin の資格情報転送までは許可されません。

allowlist にはデプロイが実際に提供する origin だけを含めます。信頼
できないリクエストから直接生成したり、suffix 一致を許可したり、
wildcard リストに変換したりしないでください。


検証済み HTTP transport
-----------------------

サーバーは検証済み HTTP 境界を 1 つ作成し、検出、認証、viewer、
すべてのアダプター操作で共有します。既定の制御は次のとおりです。

 -  URL に資格情報を含まない絶対 HTTP または HTTPS URL だけを許可
 -  すべての接続と redirect の前に origin ポリシーを評価
 -  DNS を 1 回引き、返されたアドレス全体がアドレス検査を通過する
    ことを要求
 -  選択した数値アドレスへ接続し、元の hostname を Host ヘッダーと
    TLS server name に使用
 -  private、loopback、link-local、multicast、unspecified、
    documentation、transition など無効なアドレス範囲を既定で拒否
 -  redirect loop を検査し、通常の HTTP redirect メソッド規則を適用
    して redirect を最大 5 回まで許可
 -  ポリシー、DNS、dispatch、redirect、最終レスポンス消費の全体に
    10 秒の deadline を適用
 -  構造化リモートレスポンスを最大 16 MiB に制限
 -  リクエスト転送とレスポンス消費が共有する non-EOF body read を
    最大 4,096 回に制限
 -  body を保持する redirect で replay 用に保管するリクエスト body を
    最大 1 MiB に制限

Node dispatcher は identity response encoding を要求し、予期しない
content encoding と transfer encoding を拒否して、agent connection を
再利用しません。呼び出し元が指定した framing ヘッダーを削除し、検証済み
body から framing を決定します。

`allowPrivateNetworks` は明示的なサーバーオプションです。サンプル
product server は有効にしていません。アプリケーションが private
接続先を有効にする場合は、origin allowlist とネットワーク構成により
無関係な内部サービスへの接続を防いでください。


Redirect、dns 変更、レスポンス budget
-------------------------------------

各 redirect で origin 認可、DNS 解決、アドレス分類、数値アドレス固定を
繰り返します。origin を越える redirect では Authorization、Cookie、
Cookie2、Proxy-Authorization ヘッダーを削除します。別の origin へ意図的
に資格情報を送る操作は、その受信者に対する別の認可済みリクエストを
作成する必要があります。資格情報を含む redirect URL は拒否されます。

レスポンスのバイト制限と read-count 制限はレスポンスヘッダーの受信時
までではなく、consumer が body を読む間も適用されます。全体の deadline
も最終 body が完了するか cancel されるまで維持されます。リクエストが
operation budget を保持する場合、リクエストストリームとレスポンス
ストリームは redirect 後もその budget を保持するため、accounting
境界は初期化されません。

これらの制御は、server-side request forgery、DNS rebinding、redirect
pivot、過大な構造化レスポンス、過剰に小さな chunk で構成されたストリーム
を制限します。許可済みリモートサーバーが正直であることや、返された
ActivityPub コンテンツをアプリケーションレベルの escaping なしで安全に
表示できることまでは保証しません。


資格情報 authority
------------------

remote authority は外部へ送る資格情報のスコープを次の値で制限します。

 -  発行元 origin
 -  受信先 origin
 -  操作
 -  資格情報クラス
 -  Authorization ヘッダー、Cookie ヘッダー、form body、JSON body、
    WebSocket subprotocol などの表現方式

same-origin では、設定済みの same-origin 表現方式を許可します。
cross-origin の資格情報には tuple 全体と一致する明示的な grant が必要
です。authority は、実際の接続先がスコープに指定された接続先と一致
しないリクエストを拒否します。

JSON body や form body の検査が必要な場合、authority は最大 64 KiB を
読み取ります。cross-origin リクエストで不明な body 表現方式を受け取ると
既定で拒否します。URL 内の資格情報は受理しません。ambient cookie が
受信者に許可されていない場合、ブラウザー authority は
`credentials: "omit"` も強制します。

生の Node global `fetch` を `createRemoteAuthority()` に渡さないで
ください。サーバーコードは DNS、redirect、timeout、レスポンスの制御を
すでに適用した transport を wrap する必要があります。
`createBrowserRemoteAuthority()` はブラウザー fetch ランタイム用の
別のエントリポイントです。


WebSocket 外部接続
------------------

Node WebSocket factory は接続の前に、同じ origin ポリシー、DNS アドレス
検査、数値アドレス固定、Host ヘッダー、TLS server-name 規則を適用
します。サンプルサーバーはストリーミング対応アダプターにこの factory を
渡します。

既定の制限は次のとおりです。

 -  handshake timeout 10 秒
 -  close timeout 1 秒
 -  最大 payload 1 MiB
 -  buffered chunk と fragment 各最大 256
 -  per-message compression 無効

Authorization 値は空にできず、改行文字を含められません。呼び出し元が
リクエストを abort すると、保留中の handshake リクエストを破棄して
socket を終了します。

ブラウザークライアントは upstream のストリーミング資格情報を受け取り
ません。まず認証済みブラウザー境界から stream ticket を取得します。
ticket は 32 バイトの entropy を使い、hash だけを保存して 60 秒後に
期限切れとなります。1 つのブラウザーセッションと操作に binding され、
1 回の atomic take で consume されます。


ブラウザー境界
--------------

ブラウザールートは `__Host-activityplug` cookie を使います。サーバーは
Domain 属性を指定せず `Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/`
を設定します。cookie は 32 バイト以上の鍵で署名されます。stateless な
匿名 cookie には署名済みの有効期限が含まれ、認証済みセッションは
引き続き設定済み認証ストアから解決されます。

セッションエンドポイントはブラウザーに CSRF token を返します。
Browser API の `POST` と `DELETE` の mutation、認証開始と完了、logout は
既定で `X-ActivityPlug-CSRF` に token を要求し、hash を constant time
で比較します。Origin ヘッダーが一致しないリクエストや
`Sec-Fetch-Site: cross-site` のリクエストも拒否します。

OAuth callback は redirect `GET` であるため CSRF ヘッダーを使いません。
代わりに ActivityPlug は一回限りの state をアダプター、リモート origin、
OAuth クライアント、redirect URI、PKCE verifier、ブラウザーセッションに
binding します。callback は exchange の前に state を claim し、正常に
完了した後で consume します。

ブラウザールートは Authorization ヘッダーと `sessionId` query parameter
を拒否します。cookie に帰属し `Cache-Control: no-store` と
`X-Content-Type-Options: nosniff` を返します。

`ACTIVITYPLUG_PUBLIC_ORIGIN` は正確な公開 HTTPS origin でなければ
なりません。same-origin 検査、OAuth callback URL、安全な return URL は
この値から決まります。資格情報、パス、クエリ、フラグメントは含め
られません。


Reverse proxy とクライアント識別
--------------------------------

アプリケーションが明示的な client-IP resolver を設定しない限り、
forwarding ヘッダーは信頼されません。サンプルデプロイは固定された
Caddy サービスアドレスだけを信頼します。Caddy は `X-Forwarded-For` を
直接接続されたクライアントアドレスで置き換え、`X-Real-IP` を削除します。

サンプル resolver は transport peer が
`ACTIVITYPLUG_TRUSTED_PROXY_ADDRESSES` に含まれる場合に限り、単一の
`X-Forwarded-For` 値を受理します。値がない場合や複数 hop が連結された
値の場合は、検証済み proxy peer を使います。空、長すぎる、制御文字を
含む識別子は拒否します。

信頼済み proxy アドレスにはクライアントのネットワークではなく、サーバー
に直接接続する proxy の実際のアドレスを設定します。サーバーが内部
ロードバランサの後ろにあるという理由だけで、すべての private 範囲を
信頼しないでください。


受信制限
--------

サーバーの既定の制限は次のとおりです。

| 入力                      | 既定値 |
| ------------------------- | -----: |
| JSON リクエスト           |  1 MiB |
| GraphQL リクエスト        |  1 MiB |
| multipart リクエスト      | 64 MiB |
| multipart ファイル数      |      4 |
| 個別の multipart ファイル | 16 MiB |
| リモート構造化レスポンス  | 16 MiB |
| WebSocket バッファデータ  |  1 MiB |
| WebSocket キューイベント  |    256 |

アダプターが公開する制限は multipart 制限を狭められますが、サーバー
設定を拡張できません。リクエストリーダーは過剰な chunk 数も拒否し、
制限超過または呼び出し元の abort 後に body を cancel します。

サイズ制限は個別の入力だけを制限します。デプロイには ingress と
ランタイムで接続数、リクエスト速度、同時実行数、リソースを制御する
仕組みも必要です。リファレンス Compose スタックは process、memory、
CPU、PID の制限を設定しますが、実際のワークロードに応じた確認が必要
です。


秘密情報、ストレージ、ログ
--------------------------

次の値を秘密情報として扱います。

 -  リモート access token と refresh token
 -  import した資格情報
 -  OAuth クライアントシークレット、state、challenge
 -  認証セッションレコードとブラウザーセッションレコード
 -  stream ticket
 -  cookie 署名鍵
 -  PostgreSQL と Redis の資格情報

セキュリティ状態を再起動後も維持する場合やインスタンス間で共有する場合は
durable ストアを使います。サンプルの durable サーバーは有効期間の長い
ライフサイクルデータを PostgreSQL に保存し、有効期間の短いチケット、
制限、チャレンジを Redis に保存します。メモリストアはプロセス終了時に
すべてのレコードを失います。

秘密情報を URL、Compose コマンド出力、追跡対象の環境ファイル、image
レイヤー、ログに含めないでください。プロダクション用ランチャーは
Compose 設定を `config --quiet` に制限し、`.dockerignore` は一般的な
環境ファイル、証明書ファイル、鍵ファイルを除外します。サーバーの起動
ログに含まれるのは受信 hostname と port だけであり、token や秘密情報を
含みうるランタイムオプションは含まれません。

ActivityPlug 周辺のアプリケーションログにも同じ規則を適用します。
必要に応じて操作名、アダプター ID、正規化された origin、ステータス、
型付きエラーコードを記録し、Authorization ヘッダー、Cookie ヘッダー、
リクエスト body、OAuth callback パラメータ、セッション識別子、チケット、
ストア接続 URL は除外してください。


デプロイチェックリスト
----------------------

ActivityPlug を公開する前に次の項目を確認します。

 -  完全一致の HTTPS リモート origin allowlist を設定する
 -  デプロイが private ネットワークの外部接続を必要としかつ分離
    できている場合を除き、その機能を無効にする
 -  不変の container image digest を使う
 -  公開 TLS を終端し、正確な公開 origin を設定する
 -  必要な HTTP パスだけを公開する
 -  サーバーに直接接続する reverse proxy だけを信頼する
 -  相互に独立した高エントロピーの秘密情報と必要な durable ストアを
    使う
 -  レビュー済み guard が許可する場合を除き、生のトークン import を
    無効にする
 -  PostgreSQL または Redis が利用不能なときに readiness が失敗する
    ことを確認する
 -  アプリケーションログと proxy ログから資格情報とセッション資材が
    除外されていることを確認する


関連ドキュメント
----------------

 -  [デプロイ](deployment.md)
 -  [認証とセッション](authentication-and-sessions.md)
 -  [ブラウザー統合](browser-integration.md)
 -  [セッションストレージ](session-storage.md)
