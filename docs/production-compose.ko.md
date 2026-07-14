프로덕션 compose
================

[English](production-compose.md) | [日本語](production-compose.ja.md)

프로덕션 예제에는 패키지 스크립트를 사용합니다. 런처는 Docker에 값을 전달하기
전에 이미지 참조와 내구성 데이터 비밀번호를 검증하고, 내구성 및 메모리 스택에
서로 다른 고정 프로젝트 이름을 사용합니다.

~~~~ sh
pnpm compose:config
pnpm compose:up
pnpm compose:health
pnpm compose:down
~~~~

메모리 스택은 `8444` 포트와 별도의 로컬 CA 파일을 사용하므로 `8443` 포트의
내구성 스택과 동시에 실행할 수 있습니다.

~~~~ sh
pnpm compose:memory:config
pnpm compose:memory:up
pnpm compose:memory:health
pnpm compose:memory:down
~~~~


필수 내구성 배포 값
-------------------

`ACTIVITYPLUG_NODE_IMAGE`, `ACTIVITYPLUG_CADDY_IMAGE`,
`ACTIVITYPLUG_POSTGRES_IMAGE`, `ACTIVITYPLUG_REDIS_IMAGE`에는 불변의
`name:tag@sha256:digest` 참조를 제공합니다. `ACTIVITYPLUG_PNPM_VERSION`은
`11.12.0`으로 설정합니다. Compose에는 `ACTIVITYPLUG_COOKIE_SIGNING_KEY`와
`ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS`도 필요합니다. 인증된 API와 스트리밍
자격 증명이 평문으로 전송되지 않도록 모든 허용 원격 출처는 HTTPS를 사용해야
합니다.

`ACTIVITYPLUG_POSTGRES_PASSWORD`와 `ACTIVITYPLUG_REDIS_PASSWORD`는 배포
시크릿 관리자에서 제공합니다. 각각 32자 이상의 URL 안전 base64 문자(`A-Z`,
`a-z`, `0-9`, `_`, `-`)를 포함해야 하며 서로 다른 값을 사용해야 합니다.
런처는 Docker를 시작하기 전에 이를 확인하고 변수 이름만 보고하며 시크릿 값은
보고하지 않습니다. 런처는 정확히 `config --quiet` 명령만 허용하므로
`pnpm compose:config`는 자격 증명을 표준 출력에 쓰지 않고 렌더링된 구성을
검증합니다.


익명 세션 배포 전환
-------------------

Compose 예제는 `ACTIVITYPLUG_ANONYMOUS_SESSION_MODE`을 `stateless`로
명시합니다. 따라서 인증하지 않은 방문자나 상태 확인마다 영구 저장소 행을 만들지
않습니다. 업그레이드 중 모든 서버가 새 쿠키 형식을 해석할 수 있게 되기 전에 새
형식을 발급하지 않도록, 서버 API와 제품 구성의 기본값은 `stored`입니다.

기존 다중 인스턴스 서비스에서 상태 비저장 세션을 활성화할 때는 두 번에 나누어
배포합니다. 먼저 모드를 `stored`로 유지한 채 이 릴리스를 모든 인스턴스에
배포합니다. 이 단계에서는 기존 불투명 쿠키를 계속 발급하면서 새 디코더가 두
형식을 모두 허용합니다. 모든 인스턴스가 새 디코더를 실행한 뒤 전체 인스턴스의
모드를 함께 `stateless`로 전환합니다. 이전 릴리스가 남아 있는 플릿의 일부에만
상태 비저장 모드를 활성화하지 마십시오.

새 디코더는 기존 불투명 쿠키에서 인증된 세션을 복구합니다. 업그레이드된
인스턴스를 `stored` 모드로 되돌리면, 유효한 상태 비저장 익명 쿠키를 구성된 세션
저장소에 먼저 저장한 다음 불투명 쿠키를 다시 발급합니다.


네트워크 경계
-------------

`product-edge`는 internal이 아닌 네트워크입니다. Caddy와 웹 서비스가 여기에
연결되며, 웹 서비스는 `172.30.0.2`를 유지하고 서버도 Caddy 트래픽 및 외부
인터넷 액세스를 위해 이 네트워크에 연결됩니다. 서버는 계속해서 정확히
`172.30.0.2`만 프록시 주소로 신뢰합니다.

`product-data`는 internal 네트워크입니다. 서버, PostgreSQL, Redis만 여기에
연결됩니다. 따라서 웹 서비스는 데이터베이스나 Redis 서비스 이름을 해석하거나
접근할 수 없습니다. PostgreSQL과 Redis는 호스트 포트를 공개하지 않습니다.
PostgreSQL은 제공된 비밀번호를 사용하고 Redis는 제공된 비밀번호를 요구하며,
두 상태 확인은 인증합니다. 명명된 볼륨은 PostgreSQL 데이터와 Redis append-only
지속성을 보존합니다.

PostgreSQL 이미지는 빈 볼륨을 초기화할 때만 `POSTGRES_PASSWORD`를 적용합니다.
기존 볼륨의 비밀번호는 배포 시크릿을 변경하기 전에 데이터베이스 역할 변경으로
교체합니다.


빌드 컨텍스트 및 런타임 제한
----------------------------

루트 `.dockerignore`는 두 프로덕션 Dockerfile을 위한 허용 목록입니다. 이 목록은
워크스페이스 매니페스트, 필요한 컴파일러 구성, `packages`,
`examples/web-client`만 포함합니다. 로컬 의존성, 생성된 출력, 커버리지, 중첩
worktree, 아티팩트, 로컬 개발 상태, 일반적인 인증서 및 키 파일은 제외합니다.
이미지 빌드를 디버깅하기 위해 이러한 제외 규칙을 약화하지 마십시오. 대신 검토한
입력을 명시적으로 복사하십시오.

모든 서비스는 `restart: unless-stopped`와 제한된 CPU, 메모리, PID 제한을
사용합니다. 웹 및 서버 컨테이너는 읽기 전용 루트 파일시스템으로 실행하고 모든
Linux capability를 삭제하며 권한 상승을 금지하고 작은 쓰기 가능 `/tmp`만
받습니다. Caddy는 권한 없는 프로세스가 HTTPS에 바인딩할 수 있도록
`NET_BIND_SERVICE`만 유지합니다. PostgreSQL과 Redis는 일반적인 쓰기 가능
파일시스템 및 엔트리포인트 권한을 유지하지만 제한된 재시작 및 리소스 정책도
사용합니다.

웹 서비스는 정상 서버를 기다리고, 내구성 서버는 인증된 정상 PostgreSQL 및 Redis
서비스를 기다립니다. 공개 `/health` 엔드포인트는 준비 상태 확인입니다. 내구성
데이터 저장소 중 하나라도 사용할 수 없으면 `503`을 반환하며, 복구 후에는
`200`을 반환합니다. CI smoke test는 외부 TLS 엔드포인트를 통해 각 데이터
저장소의 장애와 복구를 각각 검증합니다.

프로덕션 파일에 `docker compose`를 직접 호출하지 마십시오. Compose 보간은
불변 이미지 참조나 강력한 비밀번호를 강제할 수 없으므로 런처가 지원되는 보안
경계입니다.
