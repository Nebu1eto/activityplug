アダプタと capability
=====================

[English](/en/adapters-and-capabilities.md) |
[한국어](/ko/adapters-and-capabilities.md) | 日本語

ActivityPlug のアダプタは特定のサーバファミリの API を共通のクライアント
契約へ変換します。ただし、すべてのサーバがすべての操作を実装するという意味ではありません。capability
の判定は、選択したアダプタとインスタンスで
アプリケーションが依存できる動作を示します。


対応するサーバソフトウェア
--------------------------

| アダプタパッケージ         | アダプタ ID  | 検出するソフトウェア | API ファミリ           |
| -------------------------- | ------------ | -------------------- | ---------------------- |
| `@activityplug/mastodon`   | `mastodon`   | Mastodon             | Mastodon               |
| `@activityplug/pleroma`    | `pleroma`    | Pleroma, Akkoma      | 拡張付き Mastodon 互換 |
| `@activityplug/misskey`    | `misskey`    | Misskey              | Misskey                |
| `@activityplug/hackerspub` | `hackerspub` | HackersPub           | GraphQL と HTTP        |
| `@activityplug/hollo`      | `hollo`      | Hollo                | 拡張付き Mastodon 互換 |

`@activityplug/mastodon-base` は Mastodon 互換アダプタの開発者向け実装
パッケージです。呼び出し元がアダプタ
identity、対応ソフトウェア名、ファミリ固有の
動作を指定する必要があるため、汎用的なソフトウェア自動検出には使い ません。

リクエストでアダプタを指定しない場合、ActivityPlug サーバは登録済みアダプタ
を順番に試します。検出したソフトウェア identity がアダプタメタデータの
ID、kind、`supportedSoftware` のいずれかに一致すると、そのプロファイルを
採用します。アダプタ ID を指定した場合はそのアダプタを直接選び、ファミリ名
の一致検査をせずにインスタンス discovery を実行します。discovery は形式が
不正な応答や互換性がない応答を拒否できます。


Capability の判定
-----------------

`CapabilityName` の各名前は `CapabilityDecision` に解決されます。

~~~~ ts
interface CapabilityDecision {
  readonly name: CapabilityName;
  readonly status: "supported" | "unsupported" | "unknown";
  readonly source: "static" | "nodeinfo" | "oauth" | "instance" | "probe";
  readonly reason?: string;
  readonly constraints?: CapabilityConstraints;
  readonly raw?: unknown;
}
~~~~

3 つの status はそれぞれ異なる意味を持ちます。

 -  `supported`: 選択したアダプタと得られた根拠が操作を許可します。
 -  `unsupported`: アダプタが操作を提供しない明示的な理由があります。
 -  `unknown`: ソフトウェア identity や安定したバージョンが不明な場合
    など、アダプタが対応を証明できません。

オプション機能は `supported` の場合だけ公開してください。`unknown` は
楽観的な対応を意味しません。

~~~~ ts
const profile = await client.instances.detect();
const decision = profile.capabilities["posts.update"];

switch (decision.status) {
  case "supported":
    // Offer editing.
    break;
  case "unsupported":
    console.log(decision.reason);
    break;
  case "unknown":
    // Hide or disable editing until support can be established.
    break;
}
~~~~

`constraints` は対応する操作の範囲を狭めます。たとえば投稿作成では
受け付ける入力形式を記録し、メディア capability ではバイト数、項目数、
MIME type
の上限を宣言できます。サーバが受け付けられない入力を組み立てる前に制約を確認してください。


静的レイヤと検出レイヤ
----------------------

アダプタメタデータは完全な静的 capability セットを持ちます。欠けている
項目は `unknown` になります。ActivityPlug は NodeInfo、OAuth メタデータ、
インスタンス文書、明示的なプローブから後で得た根拠を統合できます。

ソースレイヤの順序は以下のとおりです。

~~~~ text
static < nodeinfo < oauth < instance < probe
~~~~

`unknown` でない判定はそれ以前の `unknown` 判定を置き換えます。`unknown`
判定は既存の `supported` や `unsupported` を消しません。確実性が同じ
場合は順位が高いソースを優先します。

検出したファミリやバージョンに依存する Mastodon 互換動作の例を示します。

 -  Mastodon の投稿編集には 3.5.0 以降が必要です。
 -  Mastodon の非同期メディアアップロードには 3.1.3 以降が必要です。
 -  Mastodon のメディア削除には 4.4.0 以降が必要です。
 -  Mastodon の filter v2 エンドポイントには 4.0.0 以降が必要です。
 -  Pleroma と Akkoma にはファミリ固有の判定を適用し、Mastodon の
    バージョン条件は使いません。
 -  Hollo の relationship 参照には検出した 0.1.0 以降のバージョンが必要
    です。
 -  ストリーミングの判定には注入したファクトリ、検出したエンドポイント、
    ファミリ、バージョン、transport の安全性が反映されます。

検出が返すインスタンスプロファイルには統合済みのセットが含まれます。
検出後に 2 つ目の直接クライアントを作る場合は `profile.capabilities` と
`profile.software` の両方を渡してください。ActivityPlug サーバはこの
引き渡しを自動的に行います。


機能の比較
----------

以下の表はアダプタのおおまかな対応状況を示します。「対応」はその機能
グループをマッピングするという意味であり、グループ内のすべての操作に
無条件で対応するという意味ではありません。操作別・バージョン別の判定には有効な
capability セットを使ってください。

| 機能グループ                  | Mastodon       | Pleroma/Akkoma | Misskey            | HackersPub       | Hollo  |
| ----------------------------- | -------------- | -------------- | ------------------ | ---------------- | ------ |
| OAuth authorization code      | 対応           | 対応           | 対応               | 未対応           | 対応   |
| トークンインポート            | 対応           | 対応           | 対応               | 対応             | 対応   |
| メールチャレンジ / パスキー   | 未対応         | 未対応         | 未対応             | 両方             | 未対応 |
| ホームと公開タイムライン      | 対応           | 対応           | 対応               | 対応             | 対応   |
| リストとリストタイムライン    | 対応           | 対応           | 対応               | 未対応           | 対応   |
| フォローリクエスト            | 対応           | 対応           | 対応               | 未対応           | 対応   |
| 投稿編集                      | バージョン依存 | ファミリ依存   | 未対応             | 未対応           | 対応   |
| 引用作成                      | 未対応         | 対応           | 対応               | 対応             | 対応   |
| 絵文字リアクション            | 未対応         | 対応           | 対応               | 対応             | 対応   |
| メディアアップロード          | バージョン依存 | 対応           | 対応               | 部分的な処理のみ | 対応   |
| URL メディアインポート        | 未対応         | 未対応         | WebSocket 使用     | 対応             | 未対応 |
| タイムライン / 通知ストリーム | 検出結果       | 検出結果       | 注入したファクトリ | 未対応           | 未対応 |
| フィルタ                      | バージョン依存 | 対応           | 未対応             | 未対応           | 未対応 |
| 予約投稿                      | 対応           | 対応           | 未対応             | 未対応           | 未対応 |

HackersPub のメディアアップロードは部分的な処理です。GraphQL upload
mutation は画像を保存できますが、マッピングした `createNote` mutation
ではその画像を添付できません。そのためポータブルな `media.upload`
capability は `unsupported` であり、URL インポートは別の操作として利用
できます。


操作の強制
----------

コアクライアントはアダプタを呼び出す前に、公開操作に対応する capability
を検査します。判定が `supported` でなければコード
`UNSUPPORTED_OPERATION` の `ActivityPlugError` をスローします。エラー
context には操作が含まれ、該当する場合は capability 名も含まれます。

アダプタは単一の capability では表現できない入力依存の条件も検証します。

 -  Mastodon 互換 API で poll と media を組み合わせた投稿を拒否する
 -  HackersPub の投稿作成で content warning と media attachment を拒否
    する
 -  認証 WebSocket で信頼できる Misskey バージョン検出を要求する
 -  リモート API に信頼できるカーソルがない場合に検索カーソルを拒否する

これらの失敗は `null` や空のコレクション、暗黙に変更した入力ではなく、
型付きエラーとして返されます。


アダプタの選択
--------------

対応するソフトウェアファミリの具体的なパッケージを使います。複数インスタンスを扱うサービスでは必要なアダプタをすべて登録し、
信頼できる検出結果から選択します。アダプタ自身のインスタンス検出を経ずに、信頼できないソフトウェア名の
文字列からアダプタを選択しないでください。

オプションの UI または API 動作には以下の手順を適用します。

1.  選択した origin の有効な capability セットを取得します。
2.  `status === "supported"` であることを確認します。
3.  宣言された制約を適用します。
4.  discovery 時の根拠と実際のリモートインスタンスが異なる場合に備えて
    `UNSUPPORTED_OPERATION` を処理します。

transport に依存する capability は
[ストリーミングとメディア](streaming-and-media.md)を、エラーモデルは
[エラーとトラブルシューティング](errors-and-troubleshooting.md)を
参照してください。
