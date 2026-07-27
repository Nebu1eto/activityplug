배포
====

[English](../en/deployment.md) | 한국어 | [日本語](../ja/deployment.md)

ActivityPlug는 두 가지 Docker Compose 참조 스택을 제공합니다.

 -  `docker-compose.yml`은 웹 클라이언트, ActivityPlug 서버,
    PostgreSQL, Redis를 실행합니다. 인증 및 브라우저 수명주기 상태는
    컨테이너가 재시작되어도 유지됩니다.
 -  `docker-compose.memory.yml`은 웹 클라이언트와 ActivityPlug 서버만
    실행합니다. 애플리케이션 상태를 서버 프로세스에 보관하므로 평가 및
    일회성 환경에 적합합니다.

두 스택 모두 Caddy에서 TLS를 종료하며 브라우저 애플리케이션과
`/health`만 공개합니다. 루프백 인터페이스에 바인딩하고 Caddy의 로컬
인증 기관을 사용합니다. 인터넷에 그대로 공개하는 배포 구성이 아니라,
프로덕션 형태를 갖춘 참조 구성으로 사용해야 합니다.


사전 요구 사항
--------------

저장소 스크립트를 실행하려면 다음이 필요합니다.

 -  Docker Compose v2 명령을 지원하는 Docker Engine
 -  루트 패키지에 명시된 Node.js 26 및 pnpm 11
 -  선택한 컨테이너 이미지가 있는 레지스트리에 대한 접근 권한
 -  원격 ActivityPub 서버를 위한 명시적인 HTTPS origin 허용 목록

패키지 스크립트는 저장소 루트에서 실행합니다. 프로덕션 Compose
파일을 직접 실행하지 마십시오. 실행기는 Docker를 시작하기 전에
이미지 고정값과 필수 비밀을 검증합니다. 다른 Compose 구성 명령은
보간된 비밀을 출력할 수 있으므로 `config --quiet`만 허용합니다.


저장소 모드 선택
----------------

서버가 재시작되어도 세션을 유지하거나, 여러 서버 프로세스가 상태를
공유해야 한다면 durable 스택을 사용합니다. PostgreSQL은 인증 세션,
OAuth 클라이언트 비밀, 브라우저 세션, OAuth 상태를 저장합니다.
Redis는 스트림 티켓, OAuth 시작 제한, 수명이 짧은 인증 challenge를
저장합니다. Redis의 append-only 영속성과 named volume은 참조 스택이
소유한 상태를 보존합니다.

프로세스가 종료될 때 모든 세션과 일시적인 보안 레코드를 잃어도
되는 경우에만 memory 스택을 사용합니다. PostgreSQL이나 Redis에
의존하지 않으며 `/health`는 서버 프로세스만 확인합니다.

두 스택 모두 익명 브라우저 세션을 `stateless`로 설정합니다. 따라서
익명 세션은 영속 레코드 대신 서명된 쿠키를 사용합니다. 인증된
브라우저 세션은 구성된 저장소에 계속 의존합니다.

웹 클라이언트 예제는 `ACTIVITYPLUG_STORAGE` 환경 변수(`durable` 또는
`memory`)로 스택을 선택합니다. `ACTIVITYPLUG_ANONYMOUS_SESSION_MODE`
(`stored` 또는 `stateless`)는 기본 익명 세션 전략을 재정의합니다. 이
변수들은 예제 애플리케이션에 속하며, ActivityPlug 서버 패키지의
변수가 아닙니다.


필수 환경 변수
--------------

두 모드 모두 다음 값을 설정해야 합니다.

| 변수                                  | 요구 사항                                                |
| ------------------------------------- | -------------------------------------------------------- |
| `ACTIVITYPLUG_NODE_IMAGE`             | 소문자 64자리 SHA-256 digest가 있는 Node 이미지 참조     |
| `ACTIVITYPLUG_CADDY_IMAGE`            | 소문자 64자리 SHA-256 digest가 있는 Caddy 이미지 참조    |
| `ACTIVITYPLUG_PNPM_VERSION`           | 정확히 `11.12.0`                                         |
| `ACTIVITYPLUG_COOKIE_SIGNING_KEY`     | 디코딩한 값이 32바이트 이상인 padding 없는 base64url     |
| `ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS` | wildcard 없이 명시적인 HTTPS origin을 쉼표로 구분한 목록 |

durable 스택에는 다음 값도 필요합니다.

| 변수                             | 요구 사항                                                        |
| -------------------------------- | ---------------------------------------------------------------- |
| `ACTIVITYPLUG_POSTGRES_IMAGE`    | 소문자 64자리 SHA-256 digest가 있는 PostgreSQL 이미지 참조       |
| `ACTIVITYPLUG_REDIS_IMAGE`       | 소문자 64자리 SHA-256 digest가 있는 Redis 이미지 참조            |
| `ACTIVITYPLUG_POSTGRES_PASSWORD` | URL-safe base64 문자 32자 이상                                   |
| `ACTIVITYPLUG_REDIS_PASSWORD`    | URL-safe base64 문자 32자 이상이며 PostgreSQL 비밀번호와 다른 값 |

허용되는 이미지 참조 형식은 `name@sha256:digest` 또는
`name:tag@sha256:digest`입니다. 실행기는 변경 가능한 참조,
`latest` 태그, 누락된 digest, 대문자 digest, 길이가 잘못된 digest를
거부합니다.

배포용 secret manager에서 각각 독립적인 비밀을 생성하십시오. 로컬
평가 환경에서는 Node로 필요한 인코딩의 값을 만들 수 있습니다.

~~~~ sh
node --input-type=module -e \
  "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('base64url'))"
~~~~

각 비밀마다 이 명령을 별도로 실행합니다. 결과를 추적되는 파일이나
셸 기록에 저장하지 마십시오.


검증 및 시작
------------

durable 스택은 다음 명령으로 실행합니다.

~~~~ sh
pnpm compose:config
pnpm compose:up
pnpm compose:health
~~~~

`compose:up`은 네 서비스가 준비될 때까지 기다린 뒤 Caddy의 로컬
루트 인증서를 `.dev/caddy-root.crt`로 내보냅니다. health 명령은 이
인증서로 `https://localhost:8443/health`를 검증합니다.

memory 스택은 다음 명령으로 실행합니다.

~~~~ sh
pnpm compose:memory:config
pnpm compose:memory:up
pnpm compose:memory:health
~~~~

memory 스택은 `https://localhost:8444`를 사용하고 인증서를
`.dev/caddy-memory-root.crt`로 내보냅니다. 고정된 프로젝트 이름,
네트워크, volume, 포트를 사용하므로 durable 스택과 동시에 실행할 수
있습니다.

named volume을 삭제하지 않고 스택을 중지하려면 다음 명령을
실행합니다.

~~~~ sh
pnpm compose:down
pnpm compose:memory:down
~~~~


TLS 및 공개 라우팅
------------------

저장소의 Compose 파일은 HTTPS를 `127.0.0.1`에 바인딩합니다.
`Caddyfile.local`은 Caddy 내부 인증 기관의 인증서를 발급하고
`/health`와 `/v1/browser/*`만 서버로 프록시합니다. 나머지 경로에서는
웹 클라이언트를 제공합니다. 따라서 이 Caddy 구성은 GraphQL 및 일반
HTTP API를 공개하지 않습니다.

배포를 공개하기 전에 다음을 완료하십시오.

1.  로컬 Caddy 구성을 검토된 공개 hostname용 ingress 구성으로
    교체합니다.
2.  `ACTIVITYPLUG_PUBLIC_ORIGIN`을 정규화된 외부 HTTPS origin으로
    설정합니다.
3.  대상 클라이언트가 신뢰하는 인증서로 TLS를 종료합니다.
4.  `ACTIVITYPLUG_TRUSTED_PROXY_ADDRESSES`를 ActivityPlug에 직접
    연결되는 프록시의 정확한 IP 주소로 설정합니다.
5.  프록시가 공개할 서버 경로를 명시적으로 결정합니다.

공개 origin은 자격 증명, 경로, query, fragment가 없는 순수 HTTPS
origin이어야 합니다. 이 값이 브라우저에 표시되는 origin과 다르면
same-origin 검사와 OAuth callback binding이 실패합니다.


네트워크 및 컨테이너 경계
-------------------------

durable 스택에서 `product-edge`는 Caddy와 서버를 연결합니다.
서버는 이 네트워크를 프록시 트래픽과 외부 요청에 사용합니다.
`product-data`는 서버, PostgreSQL, Redis만 공유하는 내부
네트워크입니다. 데이터베이스 서비스는 호스트 포트를 공개하지 않으며,
웹 컨테이너는 해당 서비스 이름을 확인할 수 없습니다.

웹 및 서버 컨테이너는 읽기 전용 루트 파일 시스템을 사용하고 모든
Linux capability를 제거하며 권한 상승을 금지합니다. 쓰기 가능한
임시 파일 시스템의 크기도 제한합니다. Caddy는
`NET_BIND_SERVICE`만 유지합니다. 모든 서비스에는 CPU, 메모리, PID,
health, 재시작 제한이 있습니다. PostgreSQL과 Redis는 영속 데이터를
소유하므로 쓰기 가능한 파일 시스템을 유지합니다.

루트 `.dockerignore`는 프로덕션 Dockerfile용 allowlist입니다.
의존성, 빌드 출력, coverage, worktree, 로컬 상태, 환경 파일,
인증서, 비밀 키를 제외합니다. 자격 증명 제외 규칙을 완화하지 말고
검토된 빌드 입력만 allowlist에 추가하십시오.


준비 상태 및 장애 동작
----------------------

durable 서버는 수신을 시작하기 전에 PostgreSQL 수명주기 테이블을
초기화하고 Redis 연결을 검증합니다. readiness callback은 2초의
연결, query, 명령 제한으로 두 데이터 저장소를 확인합니다. 어느 한
저장소라도 사용할 수 없으면 `/health`는 `503`을, 두 저장소가
복구되면 `200`을 반환합니다. Caddy는 서버 health check가 성공한
뒤에만 서비스를 시작합니다.

일반 durable 저장소의 연결 제한 시간은 10초이고, 요청 처리 중
데이터 저장소 작업의 제한 시간은 15초입니다. 스키마 초기화는 별도의
pool과 10분 제한 시간을 사용하므로, lock 대기와 데이터 migration에도
유한한 제한이 적용됩니다.

health endpoint의 성공은 프로세스와 구성된 저장소가 준비되었다는
사실만 증명합니다. 허용된 모든 원격 ActivityPub origin에 연결할 수
있거나 모든 adapter 작업이 성공한다는 것을 의미하지는 않습니다.


업그레이드 및 비밀 교체
-----------------------

업그레이드 전에 PostgreSQL과 Redis volume을 백업합니다. 새
컨테이너 태그마다 변경 불가능한 digest를 확인하고 배포 값을 갱신한
뒤 quiet 구성 검사를 실행하고 스택을 시작합니다. 서버는 수신을
시작하기 전에 PostgreSQL 수명주기 migration을 실행합니다.

여러 인스턴스를 사용하는 배포에서 익명 세션을 `stored`에서
`stateless`로 전환하려면, 먼저 두 쿠키 형식을 모두 디코딩할 수
있는 릴리스를 모든 인스턴스에 배포하되 모드는 `stored`로
유지합니다. 배포가 완료된 뒤 전체 fleet을 동시에 `stateless`로
전환합니다. 이전 decoder가 남아 있는 혼합 fleet은 새 쿠키 형식을
안정적으로 처리할 수 없습니다. 나중에 fleet을 `stored`로 되돌리면,
업그레이드된 인스턴스는 유효한 stateless 익명 쿠키를 구성된 세션
저장소에 등록한 뒤 stored-session 쿠키를 발급합니다.

`ACTIVITYPLUG_COOKIE_SIGNING_KEY`를 교체하면 기존 브라우저 쿠키와
여기서 파생된 CSRF 토큰이 무효화됩니다. 사용자가 새 브라우저
세션을 만들어야 한다는 점을 고려하고, 전체 fleet에서 한 번에
교체합니다.

Compose의 `POSTGRES_PASSWORD`만 변경해도 기존 PostgreSQL volume의
비밀번호는 바뀌지 않습니다. 먼저 데이터베이스 role의 자격 증명을
바꾼 뒤 배포 비밀과 연결 URL을 갱신합니다. Redis 비밀번호는
`requirepass` 구성과 서버 연결 URL을 함께 교체해야 합니다. 한쪽만
바꾸면 readiness가 실패합니다.

`down` 스크립트는 `--volumes`를 전달하지 않으므로 named data와
Caddy 인증 기관 상태가 유지됩니다. 이러한 volume의 삭제는 별도의
파괴적 작업이며, 문서화된 종료 절차에 포함되지 않습니다.


운영상 제한
-----------

참조 스택은 고정된 로컬 subnet, 서비스 주소, 포트, 리소스 제한을
사용합니다. 배포 환경과 충돌하지 않는지 확인하고, 실제 부하를
관찰한 결과에 따라 크기를 조정합니다. Compose 파일은 외부 load
balancer, 공개 hostname용 인증서 자동화, 원격 백업, monitoring,
여러 호스트의 orchestration을 제공하지 않습니다.

예제 서버는 raw token import를 비활성화하고 명시적인 원격 origin
allowlist를 요구합니다. 검토된 애플리케이션 요구 사항이 더 좁은
인증 및 운영 정책을 정의하지 않는 한, 이 기본값을 유지합니다.


관련 문서
---------

 -  [서버 사용법](server-usage.md)
 -  [세션 저장소](session-storage.md)
 -  [보안 모델](security-model.md)
