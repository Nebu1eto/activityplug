アダプター開発
==============

[English](../en/adapter-development.md) |
[한국어](../ko/adapter-development.md) | 日本語

ActivityPlug アダプターは、1 つのリモートクライアント API 契約を
`@activityplug/core` の正規化された契約へマッピングします。対象
ソフトウェアが提供し、必要な意味を失わずにマッピングできる動作だけを
実装してください。


安定したメタデータの定義
------------------------

`ActivityPlugAdapter` と完全な capability セットから始めます。

~~~~ ts
import {
  capability,
  createCapabilitySet,
  type ActivityPlugAdapter,
} from "@activityplug/core";

export const exampleAdapter: ActivityPlugAdapter = {
  metadata: {
    id: "example",
    displayName: "Example",
    kind: "activitypub",
    supportedSoftware: ["example"],
    staticCapabilities: createCapabilitySet({
      "instance.nodeInfo": capability("supported"),
      "posts.read": capability("supported"),
      "posts.create": capability(
        "unsupported",
        "The Example API does not expose post creation.",
      ),
    }),
  },
};
~~~~

ID は空にできず、空白文字や制御文字も含められません。opaque ID と
ページカーソルに埋め込まれるため、リリース後も安定させる必要があります。
`supportedSoftware` にはアダプターが実際に検出しマッピングする
ソフトウェア契約だけを指定してください。

`createCapabilitySet()` は省略された capability を `unknown` で
補完します。リモート API が移植可能な動作を提供しないと判明している
場合は、理由を付けて明示的に `unsupported` と判定してください。
ディスカバリー、バージョン、またはプローブによって対応状況が変わる場合
は `unknown` を使います。


操作グループの実装
------------------

アダプターがマッピングする操作グループだけを追加してください。各メソッド
は正規化された入力と `AdapterOperationContext` を受け取ります。次の
項目を使います。

 -  選択された正規インスタンスには `context.origin`
 -  ロギングとリモートアクセスの公開操作には `context.operation`
 -  HTTP には `context.fetch`（グローバル fetch は使わない）
 -  保存された認証情報の解決には `context.sessionStore`
 -  インスタンスの origin 外や WebSocket ファクトリーを通して資格情報
    を転送する前には `context.assertCredentialAllowed`
 -  公開操作の budget を共有するネスト処理には `context.budget`
 -  インスタンス固有の判定には `context.capabilities` と
    `context.detectedSoftware`

`ORIGIN_NOT_ALLOWED` や `REQUEST_LIMIT_EXCEEDED` を捕捉して置き換え
ないでください。これらのエラーは呼び出し元のセキュリティ境界に属します。


エンティティと識別子のマッピング
--------------------------------

`@activityplug/core` がエクスポートする正規化されたエンティティ型を
返します。各参照は `createEntityRef()` で作成します。

~~~~ ts
import { createEntityRef, type Account } from "@activityplug/core";

function accountFromRemote(
  remote: { id: string; username: string },
  adapter: string,
  origin: string,
): Account {
  return {
    ref: createEntityRef({
      adapter,
      origin,
      type: "account",
      id: remote.id,
    }),
    username: remote.username,
    acct: remote.username,
    displayName: remote.username,
    bot: false,
    locked: false,
    raw: remote,
  };
}
~~~~

この例は参照の境界を示しています。本番用マッピングではリモート
レスポンス全体を検証し、必須の正規化フィールドをすべて設定する必要が
あります。エンティティを作成する前にスキーマまたは明示的なバリデータを
使ってください。必須のリモートフィールドが欠けている場合は、空の移植
可能な値ではなく `REMOTE_PROTOCOL_ERROR` または `REMOTE_ERROR` として
扱います。

診断に役立つ場合はリモートペイロードを `raw` に保持します。安定した
アダプター固有の追加情報は `extensions` に格納します。どちらの
フィールドも正規化されたフィールドの意味を変えてはいけません。

クライアントはアダプターを呼び出す前に受信した公開 ID をデコードする
ため、アダプターのメソッドは生の ID を受け取ります。生の ID を公開
`ref.id` として公開しないでください。


ページネーションの実装
----------------------

正確な `PageInfo` を含む `Connection<Node>` を返します。リモートの
継続値を `encodePageCursor()` でエンコードし、入力を
`decodePageCursor()` でデコードします。どちらも次の項目に結び付けます。

 -  アダプター ID
 -  正規 origin
 -  正確な公開操作

カーソルのバイト列を正確に保持してください。リモート API がエンティティ
ID をカーソルとして定義していない限り、最後のエンティティ ID を使わない
でください。リモートエンドポイントに同等の意味がある場合にのみ `after`
と `before` を対応します。移植可能な上限 100 と、それより低いリモート
上限を適用してください。

確実に継続できない検索 API では、誤解を招くページを返すのではなく、
渡されたカーソルを型付きエラーで拒否してください。


認証の実装
----------

対応するストラテジーを `adapter.auth.strategies` で公開します。
ストラテジーは OAuth、トークン import、メールチャレンジ、パスキーの
各メソッドに加え、セッション検証と、対応する更新または失効操作を実装
できます。

ストラテジーが返したトークンセットはコア認証サービスに保存されます。
リモート操作はセッションストアから認証情報を解決する必要があります。
通常のサービス入力で呼び出し元がアクセストークンを渡すことを想定しない
でください。使用前にセッションが選択したアダプターと origin に属する
ことを確認してください。

資格情報を送信するときは次の原則に従います。

 -  操作スコープの `context.fetch` を使う
 -  正しい資格情報クラスと表現を宣言する
 -  受信先 origin が異なる場合は正確な資格情報の許可を要求する
 -  URL やエラーコンテキストに資格情報を含めない
 -  `AUTH_REQUIRED` と `AUTH_EXPIRED` の区別を維持する


ディスカバリー後の capability 具体化
------------------------------------

静的 capability はアダプターの基準を示します。動作がソフトウェアや
バージョンに依存する場合は、検証済みのディスカバリーデータから
`PartialCapabilitySet` を導出し、適切な NodeInfo、OAuth、インスタンス、
またはプローブのレイヤーとしてマージします。

capability 判定は操作と一致させてください。

 -  `supported` には、文書化された意味を持つ実装が必要です。
 -  `unsupported` ではメソッドを用意しないか、capability 情報を
    コンテキストに含む `UNSUPPORTED_OPERATION` を送出します。
 -  クライアントは `unknown` を対応済みとして扱ってはいけません。

許可する入力、メディアの個数とサイズ、MIME タイプ、ソフトウェアの
バージョン範囲には制約情報を使います。文書化されていない一部の入力だけ
を受け付けながら、広い操作全体を対応済みと宣言しないでください。


エラーのマッピング
------------------

最も限定的な移植可能コードを持つ `ActivityPlugError` を送出します。

 -  無効な呼び出し元入力には `VALIDATION_FAILED`
 -  資格情報の状態には `AUTH_REQUIRED` または `AUTH_EXPIRED`
 -  利用できない移植可能な動作には `UNSUPPORTED_OPERATION`
 -  対応するリモートレスポンスには `NOT_FOUND`、`CONFLICT`、
    `RATE_LIMITED`
 -  期待するプロトコルに違反するレスポンスには
    `REMOTE_PROTOCOL_ERROR`
 -  その他の有効なリモート失敗には `REMOTE_ERROR`
 -  ランタイムがまだ分類していない transport 失敗には
    `NETWORK_ERROR` または `TIMEOUT`

判明している場合はアダプター、origin、操作、capability 情報を
コンテキストに含めます。有用な場合は元のエラーを `cause` として保持
しますが、`message`、`context.raw`、ログにトークンやリモートシークレット
を公開しないでください。


検証済みファクトリーがある場合のみストリーミングを追加
------------------------------------------------------

ストリーミング操作のメソッドは `AsyncIterable<StreamEvent>` を返します。
グローバル WebSocket を参照する代わりに、アダプターオプションを通じて
`WebSocketFactory` を受け取ります。信頼済みの操作と任意の認証値を
ファクトリーへ渡してください。

非同期ファクトリーの作成、キュー内のイベント数とバイト数、ソケットの
終了を制限するにはコアヘルパーを使います。すべてのメッセージを
マッピング前に検証してください。リモートストリーミングエンドポイントが
別の origin にある場合は、認証を転送する前に一致する資格情報の許可を
要求してください。


テスト要件
----------

相互運用性を確立するアダプターの動作をテストします。

 -  必須フィールドの検証と代表的なエンティティマッピング
 -  クライアントを通した opaque ID と正確なリモートカーソルの処理
 -  capability に依存する操作と、明示的に未対応の操作
 -  認証ストラテジーの動作と資格情報の配置
 -  リモート HTTP エラーのマッピングとセキュリティ境界エラーの維持
 -  ページネーションの方向と継続セマンティクス
 -  capability を変更するソフトウェアまたはバージョンの判定
 -  ストリーミング実装時の認証、イベントマッピング、キャンセル、制限

対象 API 契約に絞ったフィクスチャを使ってください。`ky`、GraphQL
クライアント、WebSocket 実装、Zod など依存関係自体をテストしないで
ください。代表的なマッピングケース 1 件と不正ケース 1 件で契約を保護
できるなら、任意のレスポンスフィールドごとにテストを作成しないで
ください。

アダプターを公開する前に、パッケージのテストとリポジトリの型、
フォーマット、lint、テストの各チェックを実行してください。


Mastodon 互換アダプター
-----------------------

対象が Mastodon 互換エンドポイントを実装している場合は
`@activityplug/mastodon-base` を使います。リフレッシュトークン、
ローカル公開範囲、引用パラメータ、ストリーミング認証、検出した
capability など、確認済みの相違点だけを設定してください。プロダクトの
レスポンスやセマンティクスが基本マッピングと異なる場合は操作グループを
オーバーライドします。

1 つのアダプターだけに属する動作のために、共有基本実装へプロダクト分岐
を追加しないでください。既存の Mastodon、Pleroma/Akkoma、Hollo
アダプターに基本設定と対象固有のオーバーライド例があります。


関連ドキュメント
----------------

 -  [コア概念](concepts.md)
 -  [アーキテクチャ](architecture.md)
 -  [アダプターと capability](adapters-and-capabilities.md)
 -  [認証とセッション](authentication-and-sessions.md)
 -  [テスト](testing.md)
