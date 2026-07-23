ActivityPlug をライブラリとして使う
===================================

[English](library-usage.md) | [한국어](library-usage.ko.md) | 日本語

ライブラリモードでは TypeScript アプリケーションが typed service を直接
呼び出し、transport、セッションストア、アダプタ選択、リトライポリシを
自ら管理します。複数プロセスや信頼できないクライアントが単一の境界を
共有する場合は、[API サーフェス](api-surfaces.ja.md)のサーバ方式を使い
ます。


コアとアダプタをインストールする
--------------------------------

~~~~ sh
pnpm add @activityplug/core @activityplug/mastodon
~~~~

パッケージは Node.js 26 以降と ECMAScript module を使います。アダプタは
`@activityplug/core` を peer dependency として宣言するため、
アプリケーション側で共通の互換バージョンを選べます。


クライアントを作成する
----------------------

クライアントにはアダプタ、リモートインスタンスの origin、実行環境で審査
した transport を使う `RemoteAuthority` が必要です。

~~~~ ts
import {
  createActivityPlugClient,
  createRemoteAuthority,
} from "@activityplug/core";
import { createMastodonAdapter } from "@activityplug/mastodon";

export function createClient(
  origin: string,
  vettedTransport: typeof fetch,
) {
  return createActivityPlugClient({
    adapter: createMastodonAdapter(),
    origin,
    remoteAuthority: createRemoteAuthority({
      transport: vettedTransport,
    }),
  });
}
~~~~

サーバ transport は宛先、DNS、プライベートネットワーク、リダイレクト、
タイムアウト、レスポンスサイズの制限を適用する必要があります。remote
authority がなければ最初のリモート操作は `ORIGIN_NOT_ALLOWED` で失敗
します。ブラウザでは `createBrowserRemoteAuthority()` でブラウザの
fetch を明示的に選べます。


通常操作の前にサーバを検出する
------------------------------

直接クライアントはアダプタを自動選択しません。想定するサーバファミリの
アダプタで検出し、software を確認してから、検出済み capability と
software profile を渡してクライアントを作り直します。

~~~~ ts
import {
  createActivityPlugClient,
  createRemoteAuthority,
  type ActivityPlugAdapter,
} from "@activityplug/core";

export async function connect(
  adapter: ActivityPlugAdapter,
  origin: string,
  vettedTransport: typeof fetch,
) {
  const remoteAuthority = createRemoteAuthority({
    transport: vettedTransport,
  });
  const bootstrap = createActivityPlugClient({
    adapter,
    origin,
    remoteAuthority,
  });
  const profile = await bootstrap.instances.detect();

  if (
    !adapter.metadata.supportedSoftware.some(
      (name) => name.toLowerCase() === profile.software.name.toLowerCase(),
    )
  ) {
    throw new TypeError(
      `${adapter.metadata.id} does not support ${profile.software.name}`,
    );
  }

  return createActivityPlugClient({
    adapter,
    origin,
    remoteAuthority,
    capabilities: profile.capabilities,
    detectedSoftware: profile.software,
  });
}
~~~~

2 つのクライアントでは同じ adapter、origin、authority を使います。
信頼できない入力から `detectedSoftware` や `capabilities` を設定しないで
ください。ActivityPlug サーバは登録済みアダプタの解決時にこの処理を行い
ます。


Capability を確認する
---------------------

各 capability 判定は `supported`、`unsupported`、`unknown` の status と
source、オプションの reason・constraint を持ちます。

~~~~ ts
import { hasCapability } from "@activityplug/core";

if (hasCapability(client.capabilities, "posts.update")) {
  await client.posts.update({
    session,
    id: postId,
    content: "Corrected text",
  });
}
~~~~

利用可能と判断できるのは `supported` だけです。入力を受け取る前に、投稿
フィールド、公開範囲、メディアサイズ、件数、MIME type の constraint も
確認してください。


認証する
--------

実装済みの方式は `client.auth.availableStrategies` で確認します。

~~~~ ts
const session = await client.auth.token.importToken({
  accessToken: process.env.ACTIVITYPLUG_ACCESS_TOKEN!,
  scopes: ["read", "write"],
});

const verified = await client.auth.verifySession(session);
console.log(verified.account.acct);
~~~~

`AuthSession` は opaque session ID と公開メタデータだけを返し、トークンは
ストアに保持します。デフォルトストアはプロセスメモリ内にあります。

OAuth authorization code の手順は以下のとおりです。

~~~~ ts
const oauthClient = await client.auth.oauth.registerClient({
  clientName: "Example application",
  redirectUris: ["https://app.example/oauth/callback"],
  scopes: ["read", "write"],
});

const authorization = await client.auth.oauth.start({
  client: oauthClient,
  redirectUri: "https://app.example/oauth/callback",
  scopes: ["read", "write"],
  state,
});

// Redirect the resource owner to authorization.url.

const session = await client.auth.oauth.exchange({
  client: oauthClient,
  code,
  redirectUri: "https://app.example/oauth/callback",
  state,
});
~~~~

アプリケーション境界で `state` を生成・検証し、必要に応じて PKCE を
使います。refresh と revoke は検出済み OAuth capability を確認してから
呼び出してください。


サービスとエンティティ参照を扱う
--------------------------------

サービスは `instances`、`accounts`、`posts`、`timelines`、`search`、
`media`、`polls`、`notifications`、`streams`、`social`、`lists`、
`followRequests`、`filters`、`scheduledPosts`、`bookmarkFolders`、
`auth` に分かれます。エンティティの `ref.id` は opaque ID です。

~~~~ ts
const account = await client.accounts.getByHandle({
  handle: "@alice@example.social",
});

if (account !== null) {
  const posts = await client.accounts.listPosts({
    accountId: account.ref.id,
    page: { limit: 20 },
  });
  console.log(posts.nodes);
}
~~~~

`raw` と `extensions` はアダプタ固有の診断情報であり、ポータブル契約では
ありません。


返されたカーソルでページを移動する
----------------------------------

コレクションは `{ nodes, pageInfo }` を返し、ポータブル limit は 100 です。
カーソルは adapter、origin、operation にバインドされています。

~~~~ ts
let after: string | undefined;

do {
  const page = await client.timelines.public({
    page: { limit: 50, ...(after === undefined ? {} : { after }) },
  });

  for (const post of page.nodes) {
    consume(post);
  }

  after = page.pageInfo.hasNextPage
    ? page.pageInfo.endCursor
    : undefined;
} while (after !== undefined);
~~~~

adapter、origin、operation が変わった場合は保存済みカーソルを破棄して
ください。


Code でエラーを処理する
-----------------------

ポータブルな失敗は `ActivityPlugError` で表されます。

~~~~ ts
import {
  isActivityPlugError,
} from "@activityplug/core";

try {
  await client.posts.delete({ session, id: postId });
} catch (error) {
  if (isActivityPlugError(error) && error.code === "RATE_LIMITED") {
    scheduleRetry(error);
  } else {
    throw error;
  }
}
~~~~

メッセージではなく code と context を使います。リトライはアプリケーション
とリモートサーバの idempotency 条件で安全な場合に限ります。


ストリームを明示的に扱う
------------------------

ストリーミングアダプタには `WebSocketFactory` が必要です。

~~~~ ts
const controller = new AbortController();
const events = await client.streams.timeline({
  type: "public",
  signal: controller.signal,
});

try {
  for await (const event of events) {
    if (event.type === "timeline.update") {
      consume(event.post);
    }
  }
} finally {
  controller.abort();
}
~~~~

ファクトリは HTTP と同じ宛先・credential ポリシを適用します。Mastodon は
Authorization ヘッダ、Pleroma と Akkoma は token-only WebSocket
subprotocol を使います。リコネクションポリシはアプリケーション側で決めて
ください。


次のドキュメント
----------------

 -  [アダプタと capability](adapters-and-capabilities.ja.md)
 -  [認証とセッション](authentication-and-sessions.ja.md)
 -  [ストリーミングとメディア](streaming-and-media.ja.md)
 -  [セキュリティモデル](security-model.ja.md)
 -  [API サーフェス](api-surfaces.ja.md)
