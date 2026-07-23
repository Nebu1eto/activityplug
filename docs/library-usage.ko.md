Activityplug를 라이브러리로 사용하기
====================================

[English](library-usage.md) | 한국어 | [日本語](library-usage.ja.md)

라이브러리 모드에서는 TypeScript 애플리케이션이 typed service를 직접
호출하고 transport, 세션 저장소, 어댑터 선택, 재시도 정책을 직접
관리합니다. 여러 프로세스나 신뢰할 수 없는 클라이언트가 하나의 경계를
공유해야 한다면 [API 표면](api-surfaces.ko.md)의 서버 방식을
사용하십시오.


Core와 어댑터 설치
------------------

~~~~ sh
pnpm add @activityplug/core @activityplug/mastodon
~~~~

패키지는 Node.js 26 이상과 ECMAScript 모듈을 사용합니다. 어댑터가
`@activityplug/core`를 peer dependency로 선언하므로, 애플리케이션은
모든 어댑터에 적용할 호환 core 버전을 하나 선택할 수 있습니다.


클라이언트 생성
---------------

클라이언트에는 서버 제품군을 매핑하는 어댑터, 원격 인스턴스의 origin,
런타임에서 검증한 transport를 사용하는 `RemoteAuthority`가 필요합니다.
서버용 transport는 목적지, DNS, 사설 네트워크, redirect, timeout, 응답
크기 제한을 적용해야 합니다.

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

`origin`은 origin 부분으로 정규화됩니다. 사용자 정보, path, query,
fragment, 지원하지 않는 scheme은 거부합니다. remote authority가 없으면
첫 원격 작업은 `ORIGIN_NOT_ALLOWED`로 실패합니다. 브라우저에서는
`createBrowserRemoteAuthority()`로 브라우저 `fetch`를 명시적으로 선택할
수 있지만, 서버 경계를 약화하는 데 사용해서는 안 됩니다.


일반 작업 전 서버 탐지
----------------------

직접 클라이언트는 어댑터를 자동 선택하지 않습니다. 예상하는 서버
제품군의 어댑터로 `instances.detect()`를 호출하고, 보고된 software를
확인한 다음, 탐지된 capability·software profile로 실제 클라이언트를
만듭니다.

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

두 클라이언트에는 같은 adapter, origin, authority를 사용해야 합니다.
신뢰할 수 없는 입력으로 `detectedSoftware`나 `capabilities`를 채우지
마십시오. ActivityPlug 서버는 등록된 어댑터를 해석할 때 이 과정을
수행합니다.


Capability 확인
---------------

각 capability 판정에는 `supported`, `unsupported`, `unknown` 상태와
source, 선택적 reason·constraint가 있습니다.

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

`supported`만 사용 가능한 상태로 취급하십시오. `unknown`은 지원을
확인하지 못했다는 뜻입니다. 입력을 받기 전에 허용 게시물 필드, 공개
범위, 미디어 크기·개수·MIME type 등의 constraint도 확인해야 합니다.


인증
----

어댑터가 구현한 전략은 `client.auth.availableStrategies`에서
확인합니다. 이미 발급된 토큰은 다음과 같이 가져옵니다.

~~~~ ts
const session = await client.auth.token.importToken({
  accessToken: process.env.ACTIVITYPLUG_ACCESS_TOKEN!,
  scopes: ["read", "write"],
});

const verified = await client.auth.verifySession(session);
console.log(verified.account.acct);
~~~~

반환되는 `AuthSession`에는 불투명 session ID와 공개 메타데이터만
포함되며, access token과 refresh token은 저장소에 남습니다. 기본 저장소는
프로세스 메모리 안에 있습니다.

OAuth authorization code 절차는 다음과 같습니다.

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

애플리케이션 경계에서 `state`를 생성·검증하며, 배포 조건에 따라 PKCE를
사용합니다. refresh와 revoke는 탐지된 OAuth capability를 확인해야
합니다.


서비스 호출과 엔티티 참조 보존
------------------------------

서비스는 `instances`, `accounts`, `posts`, `timelines`, `search`,
`media`, `polls`, `notifications`, `streams`, `social`, `lists`,
`followRequests`, `filters`, `scheduledPosts`, `bookmarkFolders`,
`auth`로 나뉩니다. 엔티티의 `ref.id`는 불투명 ID입니다. 다른
adapter·origin·엔티티 유형·작업의 원시 ID와 섞지 마십시오.

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

`raw`와 `extensions`는 어댑터별 진단 정보이며 이식 가능한 계약이
아닙니다.


반환된 커서로 페이지 이동
-------------------------

collection은 `{ nodes, pageInfo }`를 반환하며 이식 가능 limit는
100입니다. 커서는 adapter, origin, 작업에 묶여 있습니다.

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

adapter, origin, 작업이 바뀌면 저장한 커서를 폐기해야 합니다.


Code 기반 오류 처리
-------------------

이식 가능한 실패는 `ActivityPlugError`로 표현됩니다.

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

메시지가 아니라 code와 context를 사용하십시오. capability, 인증, 검증,
원격·네트워크, origin, 요청 제한 오류가 구분됩니다. 재시도는 해당 작업이
애플리케이션과 원격 서버의 idempotency 조건에서 안전한 경우에만
수행하십시오.


스트림의 명시적 사용
--------------------

스트리밍 어댑터에는 `WebSocketFactory`가 필요합니다. 스트림은
`AsyncIterable<StreamEvent>`입니다.

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

factory는 HTTP와 같은 목적지·credential 정책을 적용해야 합니다.
Mastodon은 Authorization header를, Pleroma·Akkoma는 token-only
WebSocket subprotocol을 사용합니다. ActivityPlug는 느린 소비자의 대기
이벤트·바이트를 제한하지만, 재연결 정책은 결정하지 않습니다.


다음 문서
---------

 -  [어댑터와 capability](adapters-and-capabilities.ko.md)
 -  [인증과 세션](authentication-and-sessions.ko.md)
 -  [스트리밍과 미디어](streaming-and-media.ko.md)
 -  [보안 모델](security-model.ko.md)
 -  [API 표면](api-surfaces.ko.md)
