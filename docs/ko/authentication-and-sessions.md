인증과 세션
===========

[English](/en/authentication-and-sessions.md) | 한국어 |
[日本語](/ja/authentication-and-sessions.md)

ActivityPlug는 ActivityPub 서버마다 다른 자격 증명 방식을 불투명한
`AuthSession`으로 통합합니다. 애플리케이션은 ActivityPlug 세션 식별자만
사용하고, 원격 access token과 refresh token, 어댑터 전용 인증 데이터는
서버 측 세션 저장소에서만 관리합니다.


인증 전략
---------

어댑터는 원격 서버가 지원하는 전략을 노출하며,
`auth.availableStrategies`로 확인할 수 있습니다.

| 전략             | 애플리케이션 흐름                                                                     |
| ---------------- | ------------------------------------------------------------------------------------- |
| `oauth`          | OAuth 클라이언트를 등록하거나 제공하고, 인증 URL을 만든 다음, 콜백 코드를 교환합니다. |
| `token`          | 원격 서버가 이미 발급한 토큰을 가져옵니다.                                            |
| `emailChallenge` | 이메일 챌린지를 시작하고 코드를 검증합니다.                                           |
| `passkey`        | WebAuthn 인증 절차를 시작하고 완료합니다.                                             |

전략 사이에 fallback은 없습니다. 어댑터가 구현하지 않은 흐름을 호출하면
`UNSUPPORTED_OPERATION` 오류가 발생합니다. OAuth 갱신과 폐기도 어댑터가
선언한 capability에 따라 지원 여부가 결정됩니다.


라이브러리 인증
---------------

라이브러리 API는 각 전략을 `client.auth` 아래에 노출합니다.

~~~~ ts
const strategies = client.auth.availableStrategies;

const session = await client.auth.token.importToken({
  accessToken: process.env.REMOTE_ACCESS_TOKEN!,
  tokenType: "Bearer",
});

const verified = await client.auth.verifySession(session);
~~~~

`importToken()`은 자격 증명을 어댑터로 전달해 정규화한 뒤 ActivityPlug
세션으로 저장합니다. 반환되는 공개 세션에는 불투명 식별자, 어댑터,
origin, 전략, scope, capability, 선택적 계정 참조가 포함되며, 원격
토큰은 포함되지 않습니다.

OAuth를 사용할 때는 `auth.oauth.registerClient()`,
`auth.oauth.start()`, `auth.oauth.exchange()`를 순서대로 호출합니다.
redirect 전후로 state와 PKCE binding을 보존하고 검증해야 합니다. 서버
및 브라우저 API는 이 상태 관리를 위한 상위 수준 handler를 제공합니다.


공개 HTTP와 GraphQL 인증
------------------------

공개 서버는 토큰 가져오기, OAuth, 이메일 챌린지, passkey, 갱신, 폐기
연산을 제공합니다. `tokenImport.enabled`가 `true`가 아니면 토큰
가져오기가 비활성화됩니다. 공개 배포에서는 원격 토큰을 수락하기 전에
자체 인증 정책을 적용하는 `tokenImport.guard`도 함께 제공해야 합니다.

인증을 마친 뒤에는 ActivityPlug 세션 식별자를 HTTP `Authorization`
헤더로 전송합니다.

~~~~ http
GET /api/v1/timelines/home HTTP/1.1
Host: proxy.example
Authorization: Bearer $ACTIVITYPLUG_SESSION
~~~~

GraphQL HTTP 요청과 WebSocket upgrade도 같은 Bearer 헤더를 사용합니다.
ActivityPlug는 공개 API의 query parameter나 request body에 포함된
`sessionId`를 거부합니다. 제거된 입력에 관해서는
[0.1.0 인증 마이그레이션](migrations/0.1.0-authentication.md)을
참고하십시오.


브라우저 인증
-------------

브라우저 애플리케이션은 ActivityPlug 세션 식별자를 직접 받지 않고
`/v1/browser/**` 경계를 사용해야 합니다. 브라우저 인증 흐름은 다음과
같습니다.

1.  `GET /v1/browser/session`이 `__Host-activityplug` 쿠키와 CSRF 토큰을
    발급합니다.
2.  `POST /v1/browser/auth/start`가 OAuth, 이메일 챌린지 또는 passkey
    흐름을 시작합니다. 요청은 same-origin이어야 하며 CSRF 헤더를
    포함해야 합니다.
3.  OAuth는 `/v1/browser/auth/callback`으로 돌아옵니다. 이메일과 passkey
    흐름은 `POST /v1/browser/auth/complete`로 완료합니다.
4.  브라우저 세션 레코드가 서버 측 ActivityPlug 인증 세션에 연결됩니다.
5.  `POST /v1/browser/logout`은 upstream token 폐기에 실패하더라도 로컬
    상태를 제거합니다.

브라우저 경로는 `Authorization` 자격 증명과 `sessionId` query
parameter를 거부합니다. 쿠키는 Secure, HttpOnly, SameSite=Lax이며
`/`에 한정되고 `cookieSigningKey`로 서명됩니다. 상태를 변경하는
요청에는 설정된 CSRF 헤더가 필요하며, 기본값은
`X-ActivityPlug-CSRF`입니다.

OAuth state는 어댑터, 원격 origin, 클라이언트, redirect URI, PKCE
verifier, 브라우저 세션에 binding됩니다. 콜백 상태는 짧은 lease로
claim한 뒤 교환에 성공하면 consume됩니다. 따라서 동시에 처리되거나
재생된 콜백이 같은 상태를 사용하는 것은 불가능합니다.


자격 증명 수명주기
------------------

`StoredAuthSession`에는 token set, timestamp, 저장 수명, revision,
선택적 브라우저 세션 owner가 포함됩니다. 저장소 구현은 단일 생성,
일회용 consume, 정확한 revision 교체, 정확한 revision 삭제를
보장합니다. 이를 통해 늦게 도착한 갱신이나 폐기가 최신 자격 증명을
덮어쓰는 일을 방지합니다.

`verifySession()`은 원격 자격 증명을 검증하고 저장된 계정 참조를
갱신합니다. `refreshSession()`은 다음 revision으로 token set을
교체합니다. `revokeSession()`은 먼저 세션 revision을 claim하고,
어댑터가 지원하면 원격 자격 증명 폐기를 요청한 뒤, 로컬 인증 상태를
제거합니다.

일부 OAuth 서버는 redirect 이후에 사용할 클라이언트 시크릿을
반환합니다. ActivityPlug는 이 값을 `OAuthClientSecretStore`에 따로
저장하고, 인증 세션에는 불투명 자격 증명 참조만 보관합니다. 기본
서버는 구성된 client-secret 저장소에서 credential-lease 저장소를
생성합니다.

access-token 만료와 저장 만료는 의미가 다릅니다. refresh token이
있으면 만료된 access token도 저장 상태로 유지될 수 있습니다.
`storageExpiresAt`은 인증 세션 전체를 제거할 시점을 결정합니다.


세션 저장소 선택
----------------

core 클라이언트와 서버는 기본적으로 인메모리 인증 세션을 사용합니다.
테스트와 단일 프로세스 로컬 개발에 적합합니다. 재시작 이후에도 세션을
유지하거나 여러 프로세스에서 공유해야 한다면 PostgreSQL 또는 Redis를
사용하십시오. 브라우저 배포에는 브라우저 세션, OAuth state, 챌린지,
스트림 티켓, rate limit을 위한 저장소도 필요합니다.

전체 저장소 표와 수명주기 요건은 [세션 저장소](session-storage.md)를
참고하십시오.


운영 요건
---------

 -  ActivityPlug 세션 식별자와 브라우저 쿠키를 URL에 넣지 마십시오.
 -  인증 세션 또는 OAuth 클라이언트 시크릿이 포함된 데이터베이스에 대한
    접근을 제한하십시오.
 -  `server.ready`가 완료된 뒤에 준비 상태를 알리십시오.
 -  PostgreSQL 또는 Redis 클라이언트를 닫기 전에 `server.close()`를
    호출하십시오.
 -  여러 프로세스에서 사용해야 하는 보안 상태에는 모두 공유 저장소를
    적용하십시오.
 -  원격 요청, 데이터베이스, 캐시 timeout은 해당 transport 설정에서
    지정하십시오. 저장소 패키지는 자체 명령 timeout을 추가하지
    않습니다.


관련 문서
---------

 -  [세션 저장소](session-storage.md)
 -  [브라우저 통합](browser-integration.md)
 -  [보안 모델](security-model.md)
 -  [0.1.0 인증 마이그레이션](migrations/0.1.0-authentication.md)
