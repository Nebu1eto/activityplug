세션 저장소
===========

[English](session-storage.md) | 한국어 | [日本語](session-storage.ja.md)

ActivityPlug는 인증 자격 증명과 브라우저 보안 상태를 명시적인 인터페이스
뒤에 저장합니다. 배포 환경에 따라 인메모리 구현, PostgreSQL, Redis 또는
이를 의도적으로 조합해 사용할 수 있습니다.


저장소 역할
-----------

| 저장소                   | 저장 내용                                                         | 인메모리 | PostgreSQL | Redis |
| ------------------------ | ----------------------------------------------------------------- | -------- | ---------- | ----- |
| `AuthSessionStore`       | 원격 토큰, 세션 revision, 공개 API OAuth 콜백 상태                | 지원     | 지원       | 지원  |
| `BrowserSessionStore`    | 브라우저 쿠키 binding, CSRF hash, 인증 세션 연결, 허용 메타데이터 | 지원     | 지원       | 지원  |
| `OAuthStateStore`        | 브라우저 OAuth 콜백 상태, PKCE 및 redirect binding, claim lease   | 지원     | 지원       | 지원  |
| `OAuthClientSecretStore` | 공개 콜백의 클라이언트 시크릿과 인증 세션 credential lease        | 지원     | 지원       | 지원  |
| `StreamTicketStore`      | 일회용 브라우저 WebSocket 티켓                                    | 지원     | 미지원     | 지원  |
| `OAuthStartLimiter`      | OAuth 시작 rate 및 capacity 상태                                  | 지원     | 미지원     | 지원  |
| `ShortCacheStore`        | 이메일/passkey 챌린지와 OAuth 콜백 메타데이터                     | 지원     | 미지원     | 지원  |

PostgreSQL 패키지는 내구성이 필요한 수명주기 레코드를 지원합니다.
PostgreSQL 기반 브라우저 배포에서도 스트림 티켓, limiter, short cache
구현은 별도로 필요합니다. 프로세스가 하나라면 인메모리 구현을,
여러 프로세스에서 공유해야 한다면 Redis를 사용할 수 있습니다.

공개 HTTP 및 GraphQL OAuth 흐름은 콜백 상태를 `AuthSessionStore`에 10분
수명의 특수 레코드로 저장하며, `OAuthStateStore`는 사용하지 않습니다.
브라우저 OAuth 흐름은 콜백을 원자적으로 claim, release, consume할 수
있도록 `OAuthStateStore`를 사용합니다.

`OAuthClientSecretStore`에는 두 가지 역할이 있습니다. 공개 OAuth 등록
시크릿을 같은 10분 콜백 구간 동안 보관하며, 인증된 OAuth 세션이
참조하는 credential lease의 backing store 역할도 합니다. lease는
인증 세션의 `storageExpiresAt`을 따르며, 이 값이 없으면 기본 수명은
30일입니다.


Backend 선택
------------

재시작 시 모든 세션을 잃어도 괜찮은 테스트, 예제, 단일 프로세스 개발
환경에는 인메모리 저장소를 사용합니다. 각 프로세스가 독립된 복사본을
가지므로, 인메모리 상태는 프로세스 사이를 이동하는 요청을 처리할 수
없습니다.

기존 관계형 데이터베이스에서 인증 및 브라우저 수명주기 상태를 함께
관리하려면 PostgreSQL을 사용합니다. 이 패키지는 여러 번 실행해도
안전한 테이블 초기화 함수와 동시 실행에 안전한 저장소 연산을
제공합니다. PostgreSQL의 만료 처리는 범위를 제한한 주기적 sweep으로
동작합니다.

native TTL, 일회용 값, rate limit, 공유 브라우저 스트림 티켓이
필요하다면 Redis를 사용합니다. Redis 저장소에는 스키마 초기화가
불필요합니다. 원자적 연산에는 Redis 스크립트와 패키지가 제어하는
key prefix를 사용합니다.

혼합 배포에서는 인증 및 브라우저 세션을 PostgreSQL에, 수명이 짧은
브라우저 상태를 Redis에 둘 수 있습니다. 하나의 논리 저장소를
여러 backend나 서로 다른 prefix를 사용하는 프로세스에 나누지 마십시오.


서버 구성
---------

서버는 다음 위치에서 저장소를 받습니다.

~~~~ ts
const server = createActivityPlugServer({
  adapters,
  sessions: authSessions,
  oauthClientSecrets,
  authStartLimiter,
  browser: {
    publicOrigin,
    cookieSigningKey,
    browserSessions,
    oauthStates,
    authChallenges,
    streamTickets,
  },
});
~~~~

`sessions`, `oauthClientSecrets`, `authStartLimiter`,
`browser.oauthStates`, `browser.authChallenges`를 생략하면 인메모리
기본값을 사용합니다. 브라우저 경계를 활성화하려면
`browser.browserSessions`와 `browser.streamTickets`를 반드시
지정해야 합니다.


준비 상태와 수명주기
--------------------

`createActivityPlugServer()`는 보안 상태 수명주기를 시작하고
`server.ready`로 외부에 알립니다. 요청 처리는 이 promise를
기다립니다. sweep을 사용하는 저장소는 준비 상태를 알리기 전에 한 번
정리하고, 이후에는 60초마다 최대 500개씩 처리합니다. Redis 저장소는
native expiry를 사용하므로 유효 레코드에 주기적 sweep을 실행하지
않습니다.

선택적인 최상위 `readiness` 콜백은 공개 health check에 활용합니다.
저장소가 사용하는 것과 같은 PostgreSQL 풀 또는 Redis 클라이언트를
확인하십시오.

~~~~ ts
const server = createActivityPlugServer({
  adapters,
  sessions,
  readiness: async () => {
    await pool.query("select 1");
    return true;
  },
});

await server.ready;
~~~~

저장소는 PostgreSQL 풀이나 Redis 클라이언트를 소유하지 않습니다.
정리 worker와 브라우저 admission이 종료되도록 ActivityPlug 서버를
먼저 닫은 뒤 backing client를 닫습니다.

~~~~ ts
await server.close();
await pool.end(); // or: await redis.quit()
~~~~

애플리케이션에서 자체 `SecurityStateLifecycle`을 주입했다면 해당
수명주기는 호출자가 소유합니다. backing store를 닫기 전에 수명주기를
중지하십시오.


익명 브라우저 세션
------------------

브라우저 경계의 기본값은 `anonymousSessionMode: "stateless"`입니다.
인증 시작 전까지 미인증 세션 메타데이터를 서명된 쿠키에 담습니다.
인증이 시작되면 레코드를 `BrowserSessionStore`로 승격하며, 인증된
브라우저 세션은 항상 저장됩니다.

`anonymousSessionMode: "stored"`를 사용하면 익명 세션도
`BrowserSessionStore`에 저장됩니다. 첫 세션 요청부터 전역,
클라이언트별, 생성 rate admission limit을 적용할 수 있지만,
transport peer 또는 구성된 client-IP resolver에서 클라이언트 신원을
확보해야 하며 저장소 트래픽이 증가합니다.

브라우저 세션의 기본 수명은 7일입니다. capacity 및 생성 제한은
저장된 세션에 적용되며 `BrowserBoundaryOptions`에서 설정할 수
있습니다. 하나의 브라우저 origin을 처리하는 모든 프로세스에 같은
서명 키와 공유 저장소를 사용하십시오.


만료와 동시성
-------------

ActivityPlug는 자격 증명 만료와 저장 만료를 구분합니다. 갱신할 수
있도록 만료된 access token도 인증 세션에 남을 수 있습니다.
`storageExpiresAt`은 저장된 세션 전체를 제거할 시점을 결정합니다.

인증 및 브라우저 세션 변경은 단조 증가하는 revision을 사용합니다.
브라우저 OAuth 콜백 상태는 claim, release, consume 연산을 사용합니다.
공개 API OAuth 콜백 상태와 스트림 티켓은 일회용 consume을 사용합니다.
특정 캐시 값도 일회용 읽기를 사용합니다. 계약을 준수하는 저장소는 이
원자성 규칙을 반드시 보존해야 하며, 단순한 key-value 읽기/쓰기로는
충분하지 않습니다.

잘못되거나 일치하지 않거나 만료된 레코드는 실패 처리됩니다. 저장소
구현은 연산에서 읽은 값이나 revision이 아직 현재 값인 경우에만 해당
레코드를 제거하므로, 정리 작업이 동시에 교체된 값을 삭제하는 일은
없습니다.


파일 저장소를 제공하지 않는 이유
--------------------------------

ActivityPlug는 파일 기반 세션 저장소를 제공하지 않습니다. 인증
레코드에는 원격 access token, refresh token, origin binding, 계정
식별자가 포함됩니다. 저장소 계약은 원자적 create, consume,
compare-and-set, compare-and-delete, 만료 정리, 동시 요청에서의
안전한 동작을 요구합니다.

일반 JSON 파일은 여러 프로세스에서 이러한 보장을 제공하지 않습니다.
파일 잠금과 crash-safe 교체를 추가해도 권한, 백업, rotation, 복구
동작은 배포마다 따로 다뤄야 합니다. 로컬 persistence가 필요한
테스트에서는 더 약한 프로덕션 계약에 의존하지 말고 PostgreSQL 또는
Redis 통합 환경을 실행하십시오.


로컬 통합 서비스
----------------

저장소의 Redis 및 PostgreSQL 서비스를 시작한 다음 컨테이너 기반 통합
테스트를 실행합니다.

~~~~ sh
pnpm compose:dev
pnpm test:integration
~~~~

기본 endpoint는 다음과 같습니다.

 -  Redis: `redis://127.0.0.1:56379`
 -  PostgreSQL:
    `postgres://activityplug:activityplug@127.0.0.1:55432/activityplug`

다른 로컬 환경이 해당 port를 사용한다면 `ACTIVITYPLUG_REDIS_URL`
또는 `ACTIVITYPLUG_POSTGRES_URL`을 설정하십시오.


관련 문서
---------

 -  [인증과 세션](authentication-and-sessions.ko.md)
 -  [PostgreSQL 세션 패키지](../packages/session-postgres/README.md)
 -  [Redis 세션 패키지](../packages/session-redis/README.md)
 -  [배포](deployment.ko.md)
 -  [보안 모델](security-model.ko.md)
