보안 모델
=========

[English](/en/security-model.md) | 한국어 | [日本語](/ja/security-model.md)

ActivityPlug는 클라이언트가 선택한 원격 ActivityPub origin에 사용자의
자격 증명을 첨부하여 외부 요청을 보냅니다. 따라서 안전한 배포를
위해서는 대상 선정과 자격 증명이 발급 origin을 벗어나는 모든 조건을
통제해야 합니다.

이 문서는 `@activityplug/core`, `@activityplug/server`, 예제 product
server가 구현한 경계를 설명합니다. 어떤 adapter, origin, 자격 증명,
route, 저장소 구현을 활성화할지는 애플리케이션 코드에서 결정합니다.


신뢰 경계
---------

주요 경계는 다음과 같습니다.

1.  공개 클라이언트가 GraphQL, HTTP 또는 브라우저 요청을 ActivityPlug에
    보냅니다.
2.  신뢰하는 reverse proxy가 공개 TLS를 종료하고 선택된 route를 서버로
    전달합니다.
3.  서버가 요청 제한, 세션, origin, 자격 증명 사용을 검증한 뒤
    adapter가 원격 서버에 연결합니다.
4.  검증된 HTTP 또는 WebSocket transport가 허용된 원격 대상을 확인하고
    고정한 뒤 socket을 엽니다.
5.  세션 및 수명주기 저장소가 인증 상태와 브라우저 보안 상태를
    보관합니다.

외부 ActivityPub 트래픽에 허용된 origin이 브라우저 origin,
OAuth redirect URI, CORS origin, trusted proxy, 자격 증명 수신자로
자동 승격되지는 않습니다. 각 경계는 별도로 구성해야 합니다.


원격 origin 정책
----------------

origin 정책을 제공하지 않으면 서버 측 원격 접근은 기본적으로
거부됩니다. `createOriginPolicy()`는 각 origin을 정규화한 뒤 정확히
일치하는 allowlist를 만듭니다. 예제 product server는
`ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS`를 필수로 요구하고, wildcard를
거부하며 HTTPS origin만 허용합니다.

정책은 모든 외부 작업에서 정규화된 origin과 작업 이름을 전달받습니다.
redirect 대상도 DNS 확인 전에 다시 검사합니다. 따라서 origin을 추가하면 해당
정책을 사용하는 작업의 연결만 허용될 뿐, origin을 넘는 자격 증명 전달까지
허용되지는 않습니다.

allowlist에는 배포가 실제로 제공할 origin만 포함하십시오. 신뢰할 수
없는 요청에서 직접 목록을 생성하거나, suffix 일치를 허용하거나,
wildcard 목록으로 대체하지 마십시오.


검증된 HTTP transport
---------------------

서버는 하나의 검증된 HTTP 경계를 만들고 detection, 인증, viewer, 모든
adapter 작업에서 공유합니다. 기본 통제 항목은 다음과 같습니다.

 -  자격 증명이 없는 절대 HTTP 또는 HTTPS URL만 허용
 -  모든 연결 및 redirect 전에 origin 정책 평가
 -  DNS를 한 번 조회하고 반환된 전체 주소가 주소 검사를 통과하도록 요구
 -  선택된 숫자 주소로 연결하되 원래 hostname을 Host header와 TLS
    server name으로 유지
 -  private, loopback, link-local, multicast, unspecified, documentation,
    transition 및 기타 유효하지 않은 주소 범위를 기본적으로 거부
 -  redirect loop를 검사하고 일반 HTTP redirect method 규칙을 적용하며
    최대 5회까지 redirect 허용
 -  정책, DNS, dispatch, redirect, 최종 response 소비 전체에 10초
    deadline 적용
 -  구조화된 원격 response를 최대 16 MiB로 제한
 -  요청 전달과 response 소비가 공유하는 non-EOF body read를
    최대 4,096회로 제한
 -  body를 유지하는 redirect에서 재생을 위해 보관하는 request body를
    최대 1 MiB로 제한

Node dispatcher는 identity response encoding을 요청하고, 예상하지
못한 content encoding과 transfer encoding을 거부하며, agent connection을
재사용하지 않습니다. 호출자가 제공한 framing header를 제거하고 검증된
body를 기준으로 framing을 결정합니다.

`allowPrivateNetworks`는 명시적인 서버 option입니다. 예제 product
server는 이를 활성화하지 않습니다. 애플리케이션에서 private
destination을 활성화한다면, origin allowlist와 네트워크 구조로
관계없는 내부 서비스에 접근하지 못하도록 해야 합니다.


Redirect, DNS 변경 및 response budget
-------------------------------------

모든 redirect에서 origin 인증, DNS 조회, 주소 분류, 숫자 주소 고정을
다시 수행합니다. origin을 넘는 redirect는 Authorization, Cookie,
Cookie2, Proxy-Authorization header를 제거합니다. 다른 origin에
의도적으로 자격 증명을 보내는 작업은, 해당 수신자에 대해 별도로 인증된
요청을 생성해야 합니다. 자격 증명이 포함된 redirect URL은 거부됩니다.

response byte 및 read count 제한은 response header를 받은 시점뿐
아니라 consumer가 body를 읽는 동안에도 적용됩니다. 전체 deadline도
최종 body가 완료되거나 취소될 때까지 유지됩니다. 요청에 operation
budget이 있으면 request와 response stream이 redirect 이후에도 이를
유지하므로, accounting 경계가 초기화되지 않습니다.

이러한 통제는 server-side request forgery, DNS rebinding, redirect
pivot, 과도하게 큰 구조화 response, 지나치게 작은 chunk로 이루어진
stream을 방어합니다. 다만 허용된 원격 서버가 정직하다거나, 반환된
ActivityPub content를 애플리케이션 수준의 escaping 없이 안전하게
표시할 수 있다고 보장하지는 않습니다.


자격 증명 authority
-------------------

remote authority는 외부 자격 증명의 범위를 다음 값으로 제한합니다.

 -  발급 origin
 -  수신 origin
 -  작업
 -  자격 증명 class
 -  Authorization header, Cookie header, form body, JSON body 또는
    WebSocket subprotocol 같은 표현 방식

same-origin 사용은 구성된 same-origin 표현 방식을 허용합니다.
origin을 넘는 자격 증명에는 전체 tuple과 일치하는 명시적인 grant가
필요합니다. authority는 실제 대상이 범위에 지정된 destination과
일치하지 않는 요청을 거부합니다.

JSON 및 form body를 검사해야 할 때 authority는 최대 64 KiB를
읽습니다. origin을 넘는 요청에서 알 수 없는 body 표현 방식은
기본적으로 거부합니다. URL에 포함된 자격 증명은 허용하지 않습니다.
ambient cookie가 수신자에게 허용되지 않으면 browser authority는
`credentials: "omit"`도 강제합니다.

raw Node global `fetch`를 `createRemoteAuthority()`에 전달하지
마십시오. 서버 코드는 DNS, redirect, timeout, response 통제를 이미
적용한 transport를 감싸야 합니다. `createBrowserRemoteAuthority()`는
브라우저 fetch runtime을 위한 별도 진입점입니다.


WebSocket 외부 연결
-------------------

Node WebSocket factory는 연결 전에 같은 origin 정책, DNS 주소 검사,
숫자 주소 고정, Host header, TLS server-name 규칙을 적용합니다. 예제
서버는 streaming을 지원하는 adapter에 이 factory를 제공합니다.

기본 제한은 다음과 같습니다.

 -  handshake timeout 10초
 -  close timeout 1초
 -  최대 payload 1 MiB
 -  buffered chunk 및 fragment 각각 최대 256개
 -  per-message compression 비활성화

Authorization 값은 비어 있으면 안 되며 줄바꿈 문자를 포함할 수
없습니다. 호출자가 요청을 중단하면 대기 중인 handshake request를
파기하고 socket을 종료합니다.

브라우저 클라이언트는 upstream streaming 자격 증명을 직접 받지
않습니다. 먼저 인증된 browser boundary에서 stream ticket을
요청합니다. ticket은 32바이트 entropy를 사용하고, hash만 저장되며,
60초 뒤 만료됩니다. 하나의 브라우저 세션 및 작업에 묶이며, 단일
atomic take로 소비됩니다.


브라우저 경계
-------------

브라우저 route는 `__Host-activityplug` 쿠키를 사용합니다. 서버는
Domain attribute 없이 `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`를
설정합니다. 쿠키는 32바이트 이상의 key로 서명됩니다. stateless 익명
쿠키에는 서명된 만료 시점이 포함되며, 인증된 세션은 구성된 인증
저장소에서 검증합니다.

세션 endpoint는 브라우저에 CSRF token을 반환합니다. Browser API의
`POST` 및 `DELETE` mutation, 인증 시작과 완료, logout은 기본적으로
`X-ActivityPlug-CSRF`에 token을 요구하고, hash를 constant time으로
비교합니다. Origin header가 일치하지 않거나
`Sec-Fetch-Site: cross-site`인 요청도 거부합니다.

OAuth callback은 redirect `GET`이므로 CSRF header를 사용하지
않습니다. 대신 ActivityPlug는 일회용 state를 adapter, 원격 origin,
OAuth client, redirect URI, PKCE verifier, 브라우저 세션에 묶습니다.
callback은 exchange 전에 state를 claim하고, 성공 시 이를 consume
합니다.

브라우저 route는 Authorization header와 `sessionId` query parameter를
거부합니다. 쿠키에 귀속되며 `Cache-Control: no-store`와
`X-Content-Type-Options: nosniff`를 반환합니다.

`ACTIVITYPLUG_PUBLIC_ORIGIN`은 정확한 공개 HTTPS origin이어야 합니다.
이 값이 same-origin 검사, OAuth callback URL, 안전한 return URL을
결정합니다. 자격 증명, path, query, fragment를 포함할 수 없습니다.


Reverse proxy 및 클라이언트 식별
--------------------------------

애플리케이션이 명시적인 client-IP resolver를 설치하지 않으면
forwarding header를 신뢰하지 않습니다. 예제 배포는 고정된 Caddy
서비스 주소만 신뢰합니다. Caddy는 `X-Forwarded-For`를 직접 연결된
클라이언트 주소로 교체하고 `X-Real-IP`를 제거합니다.

예제 resolver는 transport peer가
`ACTIVITYPLUG_TRUSTED_PROXY_ADDRESSES`에 포함된 경우에만 단일
`X-Forwarded-For` 값을 허용합니다. 값이 없거나 여러 hop이 연결된
값이면 검증된 proxy peer를 사용합니다. 비어 있거나 너무 길거나 제어
문자가 포함된 식별자는 거부합니다.

trusted proxy 주소에는 클라이언트 네트워크가 아니라 서버에 직접
연결되는 proxy의 실제 주소를 설정하십시오. 서버가 내부 load
balancer 뒤에 있다는 이유만으로 모든 private range를 신뢰하지
마십시오.


Inbound 제한
------------

서버의 기본 제한은 다음과 같습니다.

| 입력                     | 기본값 |
| ------------------------ | -----: |
| JSON request             |  1 MiB |
| GraphQL request          |  1 MiB |
| Multipart request        | 64 MiB |
| Multipart file 수        |      4 |
| 개별 multipart file      | 16 MiB |
| 원격 structured response | 16 MiB |
| Buffered WebSocket data  |  1 MiB |
| Queued WebSocket event   |    256 |

adapter가 알리는 제한은 multipart 제한을 줄일 수 있지만 서버 구성을
확장할 수는 없습니다. request reader는 chunk 수가 과도한 body도
거부하며, 제한을 초과하거나 호출자가 중단하면 body를 취소합니다.

크기 제한은 개별 입력에만 적용됩니다. 배포에서는 ingress와 runtime에
연결, 요청 속도, 동시성, 리소스 통제를 별도로 구성해야 합니다.
참조 Compose 스택은 process, memory, CPU, PID 제한을 설정하지만,
실제 workload에 맞게 검토해야 합니다.


비밀, 저장소 및 로그
--------------------

다음 값을 비밀로 취급하십시오.

 -  원격 access token 및 refresh token
 -  import된 자격 증명
 -  OAuth client secret, state, challenge
 -  인증 및 브라우저 세션 record
 -  stream ticket
 -  cookie-signing key
 -  PostgreSQL 및 Redis 자격 증명

보안 상태를 재시작 이후에도 유지하거나 여러 인스턴스에서 공유해야
한다면 durable 저장소를 사용합니다. 예제 durable 서버는 수명이 긴
lifecycle data를 PostgreSQL에, 수명이 짧은 ticket, limit, challenge를
Redis에 저장합니다. memory 저장소는 프로세스가 종료되면 모든 레코드를
잃습니다.

비밀을 URL, Compose 명령 출력, 추적되는 환경 파일, image layer,
log에 넣지 마십시오. 프로덕션 실행기는 Compose 구성을
`config --quiet`로 제한하며, `.dockerignore`는 일반적인 environment,
certificate, key file을 제외합니다. 서버 startup log에는 수신
hostname과 port만 포함되고, token이나 secret이 포함될 수 있는
runtime option은 포함되지 않습니다.

ActivityPlug 주변의 애플리케이션 logging에도 같은 규칙을 적용해야
합니다. 필요한 경우 operation name, adapter ID, canonical origin,
status, typed error code를 기록하되, Authorization 및 Cookie header,
request body, OAuth callback parameter, session identifier, ticket,
store connection URL은 제외하십시오.


배포 점검 목록
--------------

ActivityPlug를 공개하기 전에 다음 항목을 확인하십시오.

 -  정확히 일치하는 HTTPS remote-origin allowlist 구성
 -  배포가 private-network 외부 연결을 요구하고 이를 격리한 경우가
    아니라면 해당 기능 비활성화
 -  변경 불가능한 container image digest 사용
 -  공개 TLS 종료 및 정확한 public origin 설정
 -  필요한 HTTP path만 공개
 -  서버에 직접 연결되는 reverse proxy만 신뢰
 -  서로 독립적인 high-entropy secret과 필요한 durable 저장소 사용
 -  검토된 guard가 허용하지 않는 한 raw token import 비활성화
 -  PostgreSQL 또는 Redis를 사용할 수 없을 때 readiness 실패 확인
 -  애플리케이션 및 proxy log에서 자격 증명과 session material 제외
    확인


관련 문서
---------

 -  [배포](deployment.md)
 -  [인증 및 세션](authentication-and-sessions.md)
 -  [브라우저 통합](browser-integration.md)
 -  [세션 저장소](session-storage.md)
