브라우저 통합
=============

[English](/en/browser-integration.md) | 한국어 |
[日本語](/ja/browser-integration.md)

ActivityPlug 브라우저 경계는 브라우저용 백엔드(BFF)입니다. ActivityPlug
인증 세션을 HttpOnly 쿠키 뒤에 보관하고, 동일 origin 웹 애플리케이션을
위해 더 작은 `/v1/browser/*` API를 노출합니다. 브라우저 코드는 ActivityPlug
세션 ID를 직접 수신하거나 제출하지 않습니다.


브라우저 경계를 사용할 때
-------------------------

웹 애플리케이션에 다음이 필요하면 브라우저 모드를 사용하십시오.

 -  브라우저 JavaScript에 credential을 저장하지 않고 ActivityPub 서버를
    통해 인증
 -  동일 origin의 쿠키 인증 API 사용
 -  안전하지 않은 mutation 요청에 CSRF 검사 적용
 -  WebSocket URL에 세션 ID를 넣지 않고 인증된 스트림 열기

credential을 안전하게 보관할 수 있는 네이티브 애플리케이션,
신뢰하는 서버, 기타 클라이언트는 공개 HTTP·GraphQL API를 사용할 수
있습니다.


서버 구성
---------

브라우저 모드에는 HTTPS 공개 origin, 32바이트 이상의 서명 키, 브라우저
세션 저장소, 스트림 티켓 저장소가 필요합니다.

~~~~ ts
import {
  createActivityPlugServer,
  InMemoryBrowserSessionStore,
  InMemoryStreamTicketStore,
} from "@activityplug/server";

const activityPlug = createActivityPlugServer({
  adapters,
  originPolicy,
  sessions,
  oauthClientSecrets,
  browser: {
    publicOrigin: "https://app.example",
    cookieSigningKey,
    browserSessions: new InMemoryBrowserSessionStore(),
    streamTickets: new InMemoryStreamTicketStore(),
  },
});
~~~~

생략된 OAuth 상태, 인증 시작 제한기, 챌린지 저장소에는 인메모리 구현이
기본 적용됩니다. 인메모리 저장소는 모두 재시작 시 상태를 잃으며, 복제본
사이에서 조정할 수 없습니다. 프로덕션에서는 영속 저장소를 제공하십시오.
[세션 저장소](session-storage.md)를 참고하십시오.

기본 브라우저 세션 수명은 7일입니다. 익명 세션은 기본적으로 상태
비저장입니다. `stored` 익명 모드에서는 할당에 원자적 전역·클라이언트별
속도 제한이 적용됩니다. 사용자 정의 `clientIp` 확인자가 없으면 서버는
검증된 전송 계층 피어 주소를 사용하고, 런타임이 이를 노출하지 않으면
`unknown`을 사용합니다. 직접 연결된 Node 리스너는 보통 피어 주소를 제공합니다.
런타임이 안정적인 클라이언트 식별자를 제공하지 못한다면 확인자를 제공하십시오.
reverse proxy 뒤에서는 알려진 프록시 피어의 전달 헤더만 허용하는 확인자를
제공하십시오.


브라우저 세션 부트스트랩
------------------------

mutation을 수행하기 전에 세션을 가져옵니다.

~~~~ ts
const response = await fetch("/v1/browser/session", {
  credentials: "same-origin",
});

const session = await response.json();
const csrfToken = session.csrfToken;
~~~~

응답은 `BrowserSessionPayload`입니다.

 -  익명 세션에는 `authenticated: false`와 `csrfToken`이 있습니다.
 -  인증된 세션에는 어댑터, origin, 전략, 뷰어 프로필, capability
    집합도 포함됩니다.

응답은 `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`가 지정된
`__Host-activityplug`를 설정합니다. `Domain` 속성은 없습니다.
JavaScript는 쿠키를 읽을 수 없으며, 브라우저가 동일 origin 라우트에
전송합니다.

모든 브라우저 응답은 `Cache-Control: no-store`와
`X-Content-Type-Options: nosniff`를 사용합니다.


CSRF 및 동일 origin 규칙
------------------------

인증 시작·완료, 게시물·미디어 변경, 스트림 티켓 발급, 로그아웃을
포함해 모든 안전하지 않은 브라우저 mutation에 현재 CSRF 토큰을
`X-ActivityPlug-CSRF`로 전송하십시오.

~~~~ ts
await fetch("/v1/browser/api/posts", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "content-type": "application/json",
    "X-ActivityPlug-CSRF": csrfToken,
  },
  body: JSON.stringify({
    content: "Hello from ActivityPlug",
    visibility: "public",
  }),
});
~~~~

헤더 이름은 `browser.csrf.headerName`으로 변경할 수 있습니다. 서버는
제공된 토큰의 해시를 상수 시간에 비교합니다.

안전하지 않은 라우트는 충돌하는 `Origin` 헤더와
`Sec-Fetch-Site: cross-site`로 표시된 요청도 거부합니다. 이 경계에
교차 origin 프런트엔드를 구성하지 마십시오. 프런트엔드와
`/v1/browser/*`를 같은 공개 origin 뒤에 두십시오.

브라우저 라우트는 다음을 거부합니다.

 -  모든 `Authorization` 헤더
 -  `sessionId` 쿼리 매개변수
 -  제품 API 요청 본문의 credential·권한 필드

쿠키가 브라우저 세션 권한입니다. 어댑터, origin, ActivityPlug 세션
선택은 인증된 서버 측 세션에서 가져옵니다.


인증
----

### OAuth

익명 브라우저 세션에서 시작합니다.

~~~~ ts
const response = await fetch("/v1/browser/auth/start", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "content-type": "application/json",
    "X-ActivityPlug-CSRF": csrfToken,
  },
  body: JSON.stringify({
    kind: "oauth",
    origin: "https://social.example",
    adapter: "mastodon",
    returnTo: "/",
  }),
});

const { redirectUrl } = await response.json();
window.location.assign(redirectUrl);
~~~~

서버는 OAuth 상태를 브라우저 세션에 연결하고
`/v1/browser/auth/callback`을 콜백 엔드포인트로 사용합니다. 원격
서버가 리다이렉트한 뒤 콜백이 인증을 완료하고, 검증된 `returnTo`
경로로 `303` 리다이렉트를 반환합니다.

콜백은 의도적으로 CSRF 헤더를 요구하지 않습니다. 외부 OAuth
리다이렉트에서 사용자 정의 헤더를 포함할 수 없기 때문입니다. 대신
서버는 일회용 OAuth 상태 레코드를 점유하고, ActivityPlug 세션을
연결하기 전에 브라우저 세션 ID와 콜백 바인딩이 서명된 브라우저
쿠키와 일치하는지 검증합니다.

`returnTo`는 구성된 공개 origin 안에 있어야 합니다. 임의의 리다이렉트
URL이 아니라 로컬 탐색 대상으로 취급하십시오.

### 이메일 챌린지 및 패스키

HackersPub은 `POST /v1/browser/auth/start`에 보내는 `kind`로
`emailChallenge` 또는 `passkey`를 사용할 수 있습니다. 시작 응답은
챌린지 ID와, 패스키의 경우 공개 키 요청 옵션을 제공합니다.

두 흐름 모두 `POST /v1/browser/auth/complete`, 같은 쿠키, 현재 CSRF
토큰으로 완료합니다.

~~~~ ts
await fetch("/v1/browser/auth/complete", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "content-type": "application/json",
    "X-ActivityPlug-CSRF": csrfToken,
  },
  body: JSON.stringify({
    kind: "emailChallenge",
    challengeId,
    code,
  }),
});
~~~~

인증 시작은 클라이언트 IP·원격 origin 기준으로 속도 제한됩니다. `429`
응답에는 `Retry-After`와 `retryAfterSeconds`가 포함됩니다.


인증 복구
---------

콜백 또는 완료 후 `GET /v1/browser/session`을 다시 가져옵니다.
인증된 페이로드가 뷰어·capability의 권위 있는 스냅숏입니다.

API 호출이 `UNAUTHENTICATED` 또는 HTTP 401을 반환하면 다음을
수행합니다.

1.  대기 중인 상태 변경 요청을 중지하거나 중단합니다.
2.  메모리의 CSRF 토큰을 폐기합니다.
3.  `GET /v1/browser/session`을 가져옵니다.
4.  갱신된 페이로드가 여전히 인증된 경우에만 비공개 클라이언트 상태를
    유지합니다.
5.  그렇지 않으면 캐시된 비공개 데이터·초안을 지우고 익명 상태를
    렌더링합니다.

갱신 자체가 실패하면 비공개 캐시 상태를 지우고, 가상의 익명 세션을
캐시하지 않고 갱신 오류를 표시합니다. 전송 실패가 서버 측 인증 상태를
확정하지는 않습니다.
`examples/web-client/src/state/auth-recovery.ts` 구현은 겹치는 복구
시도를 하나로 합치고, 성공한 갱신을 인증·익명 클라이언트 상태 사이의
권위 있는 경계로 취급합니다.

OAuth 교환이 ActivityPlug 세션을 생성했지만 브라우저 세션에 연결하는
작업이 일시적으로 실패하면, 서버는 수명이 짧은 대기 인증 레코드를
보존하고 같은 콜백 상태를 통한 복구를 허용합니다. 재시도할 수 없는
실패는 연결되지 않은 세션을 삭제합니다.


제품 API
--------

모든 제품 API 라우트에는 인증된 브라우저 세션이 필요합니다.

| 라우트 그룹                                  | 작업                                       |
| -------------------------------------------- | ------------------------------------------ |
| `GET /v1/browser/api/capabilities`           | 현재 인스턴스 capability                   |
| `GET /v1/browser/api/timelines/:kind`        | `home`, `local`, `federated` 타임라인      |
| `GET /v1/browser/api/search`                 | 계정, 게시물, 해시태그 검색                |
| `GET /v1/browser/api/profiles/:id`           | 프로필, 게시물, 관계                       |
| `POST /v1/browser/api/profiles/:id/follow`   | 팔로우                                     |
| `POST /v1/browser/api/profiles/:id/unfollow` | 언팔로우                                   |
| `/v1/browser/api/posts/*`                    | 읽기, 생성, 반응, 즐겨찾기, 부스트, 북마크 |
| `/v1/browser/api/media/*`                    | 미디어 업로드 및 삭제                      |

성공한 제품 라우트는 값을 `{ "data": ... }`로 감쌉니다. 세션
부트스트랩과 인증 라우트는 페이로드를 직접 반환합니다.

브라우저 표면은 공개 HTTP·GraphQL API보다 의도적으로 작습니다.
선택한 어댑터가 지원하지 않는 작업은 capability 정보에 따라 숨기거나
비활성화하십시오.


로그아웃
--------

로그아웃은 CSRF로 보호되는 본문 없는 `POST`입니다.

~~~~ ts
await fetch("/v1/browser/logout", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "X-ActivityPlug-CSRF": csrfToken,
  },
});
~~~~

upstream 토큰 취소가 실패해도 로컬 로그아웃이 우선합니다. 서버는
연결된 인증 세션과 브라우저 세션을 제거한 뒤 쿠키를 지웁니다.


브라우저 스트림
---------------

브라우저 코드는 먼저 일회용 스트림 티켓을 요청합니다.

~~~~ ts
const response = await fetch("/v1/browser/stream-tickets", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "content-type": "application/json",
    "X-ActivityPlug-CSRF": csrfToken,
  },
  body: JSON.stringify({ operation: "stream.timeline" }),
});

const { data } = await response.json();
const stream = new EventSource(
  `/v1/browser/stream?ticket=${encodeURIComponent(data.ticket)}`,
);
~~~~

지원되는 티켓 작업은 `stream.timeline`, `stream.notifications`,
`stream.conversations`입니다. 브라우저 경계는 `stream.timeline`을
인증된 홈 타임라인에 매핑합니다. 티켓 요청으로 공개·로컬·해시태그·목록
타임라인을 선택할 수 없습니다. 티켓의 특성은 다음과 같습니다.

 -  base64url로 인코딩된 32바이트의 무작위 엔트로피를 포함합니다.
 -  SHA-256 해시로만 저장됩니다.
 -  현재 브라우저 세션 및 하나의 작업에 연결됩니다.
 -  한 번만 사용할 수 있습니다.
 -  60초 후 만료됩니다.

스트림 엔드포인트는 서버 전송 이벤트를 내보냅니다. 티켓이 URL에
나타나므로 스트림을 열기 직전에 요청하고, 쿼리 문자열을 기록하지
마십시오. 티켓은 ActivityPlug 세션 credential이 아니며 다른 작업에
사용할 수 없습니다.

스트리밍은 어댑터 지원에도 의존합니다. 선택한 어댑터가 요청된 스트림을
지원하지 않으면 유효한 티켓도 `UNSUPPORTED` 응답을 받을 수 있습니다.


Reverse proxy
-------------

프록시에서 TLS를 종료하고 공개 origin을 유지하십시오. 직전 피어가
알려진 프록시 IP일 때만 전달 헤더를 신뢰하도록 `browser.clientIp`를
구성하십시오. `createTrustedProxyClientIp()`는 신뢰하는 주소의 정확한
목록을 받고 신뢰하는 쪽부터 `X-Forwarded-For`를 따라갑니다.

공개 `/api/v1/streams/*` 라우트에는 WebSocket 지원이 필요합니다.
브라우저 `/v1/browser/stream`은 서버 전송 이벤트를 사용하며 프록시
버퍼링을 비활성화해야 합니다.


오류
----

브라우저 실패는 안정적인 봉투를 사용합니다.

~~~~ json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Browser session is unavailable.",
    "requestId": "80e56e6a-1a61-4b17-84fe-1d2f5ce5c251"
  }
}
~~~~

제어 흐름에는 code를 사용하고, 클라이언트·서버 로그에 `requestId`를
보관하십시오. 상태 매핑·복구 지침은
[오류와 문제 해결](errors-and-troubleshooting.md)을 참고하십시오.
