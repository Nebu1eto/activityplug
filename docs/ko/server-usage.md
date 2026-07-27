서버 사용법
===========

[English](../en/server-usage.md) | 한국어 | [日本語](../ja/server-usage.md)

`@activityplug/server`는 명령줄 프로세스 또는 Node.js 애플리케이션의
일부로 실행할 수 있습니다. 두 형태 모두 공개 HTTP API, GraphQL,
WebSocket 스트림을 제공합니다. 프로그래밍 방식으로 구성하면 영속 저장소,
의존성 준비 상태 검사, 사용자 정의 제한, 브라우저 BFF도 사용할 수
있습니다.


서버 설치
---------

Node.js 26 이상이 필요합니다.

~~~~ sh
pnpm add @activityplug/server @activityplug/core @hono/node-server @logtape/logtape graphql hono
~~~~

사용할 어댑터를 추가합니다.

~~~~ sh
pnpm add @activityplug/mastodon
~~~~


CLI 실행
--------

CLI에는 패키지로 제공되는 모든 어댑터가 포함되어 있으며 루프백 포트
4000에서 수신합니다.

~~~~ sh
pnpm exec activityplug-server \
  --allow-origin https://social.example
~~~~

`--allow-origin`을 지정하지 않으면 원격 origin 허용 목록이 비어
있습니다. 이 프로세스가 접속할 수 있는 모든 HTTPS ActivityPub 서버에
대해 옵션을 반복 지정하십시오.

~~~~ sh
pnpm exec activityplug-server \
  --host 0.0.0.0 \
  --port 8080 \
  --allow-origin https://social.example \
  --allow-origin https://community.example
~~~~

`--allow-private-networks`는 origin 정책이 origin을 허용한 뒤
비공개·루프백 주소로의 네트워크 연결을 허용합니다. origin 허용 목록
자체를 완화하지는 않습니다.

브라우저 애플리케이션을 서비스하려면 `--browser-origin`에 공개 HTTPS
origin을 지정하고 `ACTIVITYPLUG_BROWSER_COOKIE_SIGNING_KEY`를 설정하십시오.
인메모리 브라우저 저장소가 의도적임을 확인하기 위해 CLI는
`--browser-memory-stores`를 필요로 합니다.

~~~~ sh
pnpm exec activityplug-server \
  --allow-origin https://social.example \
  --browser-origin https://localhost:8443 \
  --browser-memory-stores
~~~~

서버가 reverse proxy 뒤에서 실행된다면 `--trusted-proxy`로 신뢰하는
프록시 주소를 지정하십시오. `X-Forwarded-For` 헤더는 이 주소에서 온
경우에만 신뢰됩니다. 프록시가 여러 대이면 옵션을 반복합니다.

~~~~ sh
pnpm exec activityplug-server \
  --allow-origin https://social.example \
  --browser-origin https://app.example \
  --trusted-proxy 10.0.0.2 \
  --trusted-proxy 10.0.0.3
~~~~

CLI는 시작 전에 호스트, 포트, origin, 브라우저 설정, 서명 키, 신뢰하는
프록시 주소를 검증합니다. 전체 옵션은 `--help`로 확인하십시오.


서버 구성
---------

프로그래밍 방식 설정은 어댑터 구성, 원격 권한, 리스너를 분리합니다.

~~~~ ts
import { createMastodonAdapter } from "@activityplug/mastodon";
import {
  createActivityPlugServer,
  createNodePinnedWebSocketFactory,
  createOriginPolicy,
  nodeLookupAddresses,
} from "@activityplug/server";

const originPolicy = createOriginPolicy(["https://social.example"]);
const webSocket = createNodePinnedWebSocketFactory({
  originPolicy,
  lookup: nodeLookupAddresses,
});

const activityPlug = createActivityPlugServer({
  adapters: [createMastodonAdapter({ webSocket })],
  originPolicy,
  tokenImport: { enabled: false },
});

await activityPlug.ready;
const listener = activityPlug.start({
  hostname: "127.0.0.1",
  port: 4000,
});
~~~~

스트리밍을 구현하는 어댑터에는 WebSocket 팩터리를 주입해야 합니다.
Node 고정 팩터리는 구성된 origin 정책과 DNS 주소 검사를 WebSocket
연결에 적용합니다.

`originPolicy`를 생략하면 서버는 모든 원격 origin을 거부합니다. 정확한
허용 목록에는 `createOriginPolicy()`를 사용하거나, 애플리케이션에 맞는
동등한 검사를 수행하는 `OriginPolicy`를 제공하십시오.

`allowPrivateNetworks: true`는 배포가 비공개·루프백 주소에 의도적으로
접근해야 할 때만 설정하십시오. origin 허용 목록을 완화하지는 않습니다.


수명 주기와 소유권
------------------

`createActivityPlugServer()`는 보안 상태 수명 주기를 즉시 시작하고,
시작 상태를 `ready`로 노출합니다. 결합된 Hono 애플리케이션은 요청을
처리하기 전에 `ready`를 기다립니다. 애플리케이션도 준비 상태를 알리기
전에 이를 기다려야 합니다.

`start()`는 Node 리스너를 생성하고 서버 객체, 호스트 이름, 포트를
반환합니다. 프로그래밍 방식 시작에는 포트 `0`도 유효하며, 운영 체제가
사용 가능한 포트를 선택합니다. 반환된 `StartedServer.port`는 구성값
`0`으로 유지됩니다. 실제 할당된 포트는 `listening` 이벤트 후
`StartedServer.server.address()`에서 확인하십시오.

~~~~ ts
try {
  await activityPlug.ready;
  activityPlug.start({ hostname: "0.0.0.0", port: 4000 });
  await runApplication();
} finally {
  await activityPlug.close();
  await databasePool.end();
}
~~~~

`close()`는 멱등입니다. 이 `ActivityPlugServer`를 통해 생성된 모든
리스너, 브라우저 경계, 그리고 서버가 수명 주기를 직접 생성한 경우 보안
상태 수명 주기를 닫습니다. 주입된 저장소, 데이터베이스 풀, Redis
클라이언트 등 호출자 소유 리소스는 닫지 않습니다. 백그라운드 정리가 이미
닫힌 클라이언트를 사용하지 않도록, 서버를 먼저 닫은 뒤 이런 리소스를
닫으십시오.

`await activityPlug[Symbol.asyncDispose]()`는
`await activityPlug.close()`와 같습니다.

`startActivityPlugServer()`는 기존 `ActivityPlugApiService`나 Hono
애플리케이션을 위한 저수준 도우미입니다. `createActivityPlugServer()`가
제공하는 소유권·수명 주기 통합은 포함되지 않습니다.


상태와 준비 상태
----------------

`GET /health`는 API 버전과 준비 상태를 반환합니다.

~~~~ json
{
  "data": {
    "ok": true,
    "version": "v1"
  }
}
~~~~

`ok`가 참이면 응답 상태는 `200`, 아니면 `503`입니다. `readiness`
콜백이 없으면 서버가 시작된 뒤 프로세스를 준비됨으로 보고합니다. 영속
의존성을 포함하려면 콜백을 제공하십시오.

~~~~ ts
const activityPlug = createActivityPlugServer({
  adapters,
  originPolicy,
  sessions,
  oauthClientSecrets,
  readiness: async () => {
    const [database, redisStatus] = await Promise.all([
      databasePool.query("select 1"),
      redis.ping(),
    ]);
    return database.rowCount === 1 && redisStatus === "PONG";
  },
});
~~~~

거부된 준비 상태 콜백은 비정상으로 처리됩니다. 상태 요청이 무한히
대기하지 않도록 의존성별 timeout으로 콜백을 제한하십시오.


공개 API 표면
-------------

공개 라우트는 ActivityPlug 세션 ID를 Bearer credential로 사용합니다.
URL과 요청 본문의 세션 ID는 거부됩니다.

| 진입점                                 | 계약                              |
| -------------------------------------- | --------------------------------- |
| `GET /api/v1`                          | API 버전 및 검색 링크             |
| `/api/v1/*`                            | 버전 지정 JSON·multipart HTTP API |
| `GET /api/v1/openapi.json`             | 생성된 OpenAPI 문서               |
| `POST /graphql`                        | GraphQL 쿼리 및 mutation          |
| `GET /api/v1/streams`                  | 스트림 프로토콜 및 이벤트 이름    |
| `GET /api/v1/streams/timelines/home`   | 인증된 홈 WebSocket               |
| `GET /api/v1/streams/timelines/public` | 공개 또는 로컬 WebSocket          |
| `GET /api/v1/streams/notifications`    | 인증된 알림 WebSocket             |

HTTP·GraphQL 표면은 동일한 `ActivityPlugApiService`를 호출합니다. 같은
도메인 작업을 전송 방식별 봉투로 직렬화합니다. 개별 필드와 입력은
OpenAPI 문서·GraphQL 스키마를 참고하십시오.

호출자가 같은 프로세스에서 실행된다면 `server.service`를 사용하십시오.
HTTP 단계를 생략하면서 어댑터 선택, 세션 검증, origin 정책, 요청 취소,
capability 처리를 그대로 유지합니다.


인증 및 토큰 가져오기
---------------------

선택한 어댑터가 지원하면 OAuth, 이메일 챌린지, 패스키 라우트를 사용할
수 있습니다. 공개 HTTP·GraphQL 세션은 호출자에게 반환되며, 호출자는
이를 Bearer credential로 제공합니다.

원시 토큰 가져오기는 `tokenImport.enabled`가 참일 때만 활성화됩니다.
`guard` 없이 활성화하면 라우트에 접근할 수 있는 누구에게나 열립니다.
프로덕션 애플리케이션은 가져오기를 비활성화하거나 권한 부여 가드를
제공해야 합니다.

인증 응답에는 `Cache-Control: no-store`가 설정됩니다. GraphQL 응답도
`no-store`로 설정됩니다.

브라우저 애플리케이션은 ActivityPlug 세션 ID를 브라우저 JavaScript에
저장하지 말고 쿠키 BFF를 활성화하십시오.
[브라우저 통합](browser-integration.md)을 참고하십시오.


저장소 선택
-----------

서버에는 개발·테스트용 인메모리 구현이 포함됩니다.

 -  인증 세션과 OAuth 클라이언트 비밀
 -  브라우저 세션과 OAuth 상태
 -  스트림 티켓
 -  인증 시작 제한
 -  수명이 짧은 인증 챌린지

이 저장소는 프로세스에 한정되며 재시작 시 레코드를 잃습니다. 여러 서버
복제본을 조정할 수도 없습니다.

세션이나 브라우저 흐름이 재시작 후에도 유지되거나 여러 복제본에서
실행되어야 한다면 영속 저장소를 주입하십시오.
`@activityplug/session-postgres`는 영속 인증·브라우저 세션, OAuth
상태, OAuth 클라이언트 비밀 저장소를 제공합니다.
`@activityplug/session-redis`는 스트림 티켓, 속도 제한기, 단기 캐시
저장소를 제공합니다.

영속 인증 세션 저장소는 영속 `oauthClientSecrets` 저장소와 함께
사용해야 합니다. OAuth 콜백이 완료에 필요한 비밀 없이 남을 수 있으므로,
서버는 영속 세션 저장소와 기본 인메모리 비밀 저장소의 조합을 거부합니다.

`credentialLeases` 옵션은 OAuth 클라이언트 비밀 해석을 위한 사용자 정의
`CredentialLeaseStore`를 제공합니다. 기본값은 `oauthClientSecrets`에서
파생됩니다. credential 임대와 클라이언트 비밀 저장소를 분리해야 하는
애플리케이션에서 재정의하십시오.

애플리케이션이 저장소 초기화와 스키마 마이그레이션을 관리합니다.
`examples/web-client` 서버는 영속 세션 레코드에 PostgreSQL을, 일회성
또는 단기 조정에 Redis를 사용하는 분할 예제를 보여줍니다.


브라우저 경계
-------------

동일한 Hono 애플리케이션에 `/v1/browser/*` 라우트를 추가하려면
`browser` 구성을 전달하십시오.

~~~~ ts
const activityPlug = createActivityPlugServer({
  adapters,
  originPolicy,
  sessions,
  oauthClientSecrets,
  browser: {
    publicOrigin: "https://app.example",
    cookieSigningKey,
    browserSessions,
    oauthStates,
    streamTickets,
    authStartLimiter,
    authChallenges,
    clientIp,
  },
});
~~~~

`publicOrigin`은 credential·경로·쿼리·프래그먼트가 없는 HTTPS
origin이어야 합니다. 서명 키에는 최소 32바이트가 필요합니다. 서버가
reverse proxy 뒤에서 실행된다면 신뢰할 수 있는 클라이언트 IP 확인자를
사용하십시오. 임의 피어의 전달 헤더를 절대 신뢰하지 마십시오.


제한과 원격 credential
----------------------

`requestLimits`는 전송 단계의 작업을 제한합니다. JSON·GraphQL 요청
바이트, multipart 전체 크기·파일 수, 원격 구조화 응답 바이트, WebSocket
버퍼·대기 이벤트가 포함됩니다. `graphqlLimits`는 이와 별도로 GraphQL
별칭, 깊이, 복잡도, 서비스에 대한 동시 resolver 호출을 제한합니다.

`createBudgetScope`는 작업별 아웃바운드 작업 경계입니다. 반환된
`BudgetScope`는 하나의 공개 작업에 대해 어댑터가 수행하는 원격 요청,
읽기, 바이트, 노드, 동시성, 경과 시간을 제한할 수 있습니다. 이는
GraphQL resolver 동시성·전송 바이트 제한과 별개입니다. 전송·GraphQL
제한에는 기본값이 있지만, 작업 예산이 필요한 애플리케이션은 팩터리를
직접 제공해야 합니다.

원격 전송과 예산 경계는 [보안 모델](security-model.md)을
참고하십시오.

원격 credential은 기본적으로 발급 origin에 묶여 유지됩니다. 작업이 다른
origin에 credential을 전송해야 한다면 발급자, 수신자, 공개 작업,
credential 클래스, 표현에 대해 정확한 `remoteCredentialGrants` 항목을
구성하십시오. 익명·동일 origin 작업에는 이런 허용이 필요 없습니다.


CORS
----

`cors` 옵션은 `@hono/cors`에 전달됩니다. 공개 HTTP·GraphQL API에
크로스 origin 접근이 필요한 신뢰하는 비 브라우저 BFF 클라이언트에만
구성하십시오. credential이 포함된 CORS는 와일드카드 origin을 사용할
수 없습니다.

브라우저 BFF는 동일 origin 요청을 전제로 하며, 공개 API CORS와 별도로
쿠키·CSRF 검사를 사용합니다. 브라우저 클라이언트에는 CORS 구성이
필요하지 않습니다.


로깅
----

`configureServerLogging()`은 `activityplug` 카테고리에 대한 LogTape
콘솔 로거를 설정합니다. CLI는 이를 자동 호출합니다. 프로그래밍 방식으로
서버를 구성하는 애플리케이션은 시작 전에 이를 호출하거나 LogTape를
직접 구성할 수 있습니다.

~~~~ ts
import { configureServerLogging } from "@activityplug/server";

await configureServerLogging({ level: "debug" });
~~~~

허용 옵션은 `level`(LogTape 로그 수준, 기본값 `"info"`),
`sink`(사용자 정의 LogTape `Sink`), `force`(LogTape가 이미 구성된
경우에도 재구성)입니다. 애플리케이션이 자체 LogTape 설정을 갖고 있다면
`force`가 참이 아닌 한 `configureServerLogging()`은 아무 작업도 하지
않습니다.


Openapi 문서
------------

`/api/v1/openapi.json`은 생성된 OpenAPI 3.1 문서를 제공합니다.
애플리케이션에서 프로그래밍 방식으로 생성할 수도 있습니다.

~~~~ ts
import { createOpenApiDocument } from "@activityplug/server";

const doc = createOpenApiDocument({ tokenImport: "guarded" });
~~~~

`tokenImport` 옵션은 토큰 가져오기 라우트의 표시 방식을 제어합니다.
`"open"`, `"guarded"`, `"disabled"`(기본값) 중 하나를 지정하십시오.
생성된 문서는 서버가 노출하는 라우트와 동일한 내용을 반영합니다.


다음 단계
---------

 -  [브라우저 통합](browser-integration.md)
 -  [인증과 세션](authentication-and-sessions.md)
 -  [세션 저장소](session-storage.md)
 -  [보안 모델](security-model.md)
 -  [오류와 문제 해결](errors-and-troubleshooting.md)
 -  [`@activityplug/server` 패키지 README](../../packages/server/README.md)
