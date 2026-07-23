API 표면
========

[English](api-surfaces.md) | 한국어 | [日本語](api-surfaces.ja.md)

ActivityPlug는 동일한 이식 가능 작업 모델을 TypeScript 라이브러리,
HTTP API, GraphQL API, 브라우저 경계로 제공합니다. 각 표면은 서로 다른
신뢰 경계와 배포 조건을 위한 것입니다.


표면 선택
---------

| 표면                  | 적합한 경우                                      | 인증 경계                                        | 계약의 기준                                   |
| --------------------- | ------------------------------------------------ | ------------------------------------------------ | --------------------------------------------- |
| TypeScript 라이브러리 | 신뢰하는 코드가 adapter, transport, store를 소유 | 애플리케이션 store가 보관하는 `AuthSession`      | `@activityplug/core`와 어댑터의 export type   |
| HTTP API              | 서비스나 비 GraphQL client가 중앙 서버를 호출    | 인증 작업의 `Authorization: Bearer <session-id>` | `/api/v1/openapi.json`의 OpenAPI 3.1 문서     |
| GraphQL API           | field 선택과 단일 schema가 필요                  | 인증 작업의 `Authorization: Bearer <session-id>` | `/graphql`의 schema와 `createGraphQLSchema()` |
| Browser API           | 웹 애플리케이션에 BFF 경계가 필요                | 서명된 HttpOnly cookie, origin 검사, CSRF        | `@activityplug/server`의 browser type과 route |

HTTP와 GraphQL은 폭넓은 공개 서버 표면입니다. 브라우저 API는 UI에
필요한 일부 작업과 브라우저용 DTO만 제공합니다.


공통 작업 모델
--------------

모든 표면은 코어의 공개 작업 이름을 기준으로 합니다. schema나 route가
존재하더라도 선택한 어댑터가 `UNSUPPORTED_OPERATION`을 반환할 수
있으므로, 대상 인스턴스의 capability를 확인해야 합니다. 엔티티 ID와
페이지 커서는 불투명하며 adapter, origin, type, 작업 바인딩을
보존합니다.


TypeScript 라이브러리
---------------------

~~~~ ts
const page = await client.timelines.public({
  page: { limit: 20 },
});
~~~~

라이브러리는 같은 프로세스에서 어댑터 기반 서비스를 호출합니다.
애플리케이션이 검증된 `RemoteAuthority`, 필요한 영속 저장소, 어댑터
선택, WebSocket 생성을 제공해야 합니다. bot, worker, 백엔드 통합에는
[라이브러리 사용법](library-usage.ko.md)을 따르십시오.


HTTP API
--------

HTTP API의 루트는 `/api/v1`이고, `GET /health`는 readiness를
반환합니다. 현재 HTTP 계약의 기준은 다음 OpenAPI 문서입니다.

~~~~ text
GET /api/v1/openapi.json
~~~~

route, method, parameter, body, response, error schema는 이 문서를
따라야 합니다. 성공 JSON은 `{ "data": ... }`, 실패는
`{ "error": ... }` 봉투입니다. 인증 작업은 ActivityPlug session ID를
헤더로 보냅니다.

~~~~ http
Authorization: Bearer <activityplug-session-id>
~~~~

원격 Fediverse access token은 공개 API의 bearer credential이 아닙니다.
토큰 가져오기는 서버가 명시적으로 활성화해야 하며, admission guard를
두는 것이 좋습니다. HTTP API의 WebSocket route도 실행 중인 OpenAPI와
스트림 디스커버리 응답을 기준으로 사용하십시오.


GraphQL API
-----------

~~~~ text
POST /graphql
~~~~

GraphQL 계약은 `createGraphQLSchema()`가 생성하고 실행 중인 엔드포인트가
제공하는 schema입니다. 배포가 허용한다면 introspection으로 field,
argument, input, nullability, enum을 확인할 수 있습니다. 요청 body에는
`query`와 선택적 `operationName`, `variables`를 넣습니다. 인증에는
HTTP API와 같은 session bearer 헤더를 사용하며, body나 URL의 레거시
`sessionId`는 거부됩니다.

서버는 요청 바이트, depth, alias, selection, 아웃바운드 동시성 제한을
적용합니다. 이식 가능 실패는 GraphQL error의
`extensions.activityplug`에 포함됩니다. `examples/proxy-client`는
HTTP와 GraphQL을 함께 사용하는 typed client 예제입니다.


Browser API
-----------

브라우저 경계의 루트는 `/v1/browser`이며, 브라우저 옵션을 구성해야
활성화됩니다. 공개 API와 달리 서명된 브라우저 쿠키를 사용하고
Authorization 헤더를 거부합니다. mutation은 origin과 CSRF 토큰을
검증하며, 응답은 어댑터 내부 `raw`를 제외한 브라우저 DTO입니다.
스트리밍은 브라우저 세션에 묶인 짧은 수명의 일회용 티켓을 사용합니다.

브라우저 코드는 먼저 `/v1/browser/session`에서 쿠키와 CSRF 토큰을 받고,
안전하지 않은 요청에 설정된 헤더(기본값 `X-ActivityPlug-CSRF`)를
보냅니다. ActivityPlug session ID나 원격 access token을 JavaScript
저장소에 저장해서는 안 됩니다. 별도 OpenAPI는 현재 제공하지 않으며,
브라우저 route 문서와 exported type이 계약입니다.


표면별 capability
-----------------

모든 표면에서 `supported`, `unsupported`, `unknown`의 뜻은 같습니다.
라이브러리는 `client.capabilities`, 공개 서버는 HTTP·GraphQL 쿼리,
브라우저 경계는 인증된 인스턴스의 브라우저용 projection을 제공합니다.
인스턴스, 어댑터, 브라우저 세션이 바뀌면 capability를 다시 조회합니다.


인증과 비밀 처리
----------------

라이브러리는 토큰을 저장소에 남기고 `AuthSession`을 반환합니다.
HTTP·GraphQL 클라이언트는 직렬화된 ActivityPlug session ID를 bearer
credential로 사용합니다. 브라우저 경계는 이 연결을 서버에 보관하고
서명된 쿠키만 노출합니다. OAuth secret, 토큰, 콜백 상태, PKCE
verifier, 쿠키, CSRF 토큰, 스트림 티켓을 서로 바꾸거나 URL에 넣어서는
안 됩니다. [인증과 세션](authentication-and-sessions.ko.md)과
[보안 모델](security-model.ko.md)을 참고하십시오.


오류, 페이지 이동, 호환성
-------------------------

라이브러리는 `ActivityPlugError`를 throw하고, HTTP는 status와 error
봉투, GraphQL은 `extensions.activityplug`, 브라우저는 브라우저 error
봉투를 사용합니다. HTTP·GraphQL은 start/end cursor를, 브라우저는
UI에 필요한 forward cursor를 제공합니다. 어댑터별 `raw`·`extensions`
필드는 이식 가능 계약이 아닙니다.


계약 유지
---------

1.  라이브러리는 패키지 export를 기준으로 사용합니다.
2.  HTTP는 배포된 `/api/v1/openapi.json`을 가져옵니다.
3.  GraphQL은 배포된 schema를 사용합니다.
4.  BFF는 브라우저 route 문서와 exported type을 사용합니다.
5.  대상 인스턴스의 capability를 런타임에 확인합니다.

저장소 소스와 예제는 동작을 설명하지만, 원격 클라이언트가 보낼 수 있는
값은 배포된 버전의 생성 계약이 결정합니다.
