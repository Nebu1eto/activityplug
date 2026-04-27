Fediverse E2E 테스트
====================

ActivityPlug는 실제 Fediverse 서버를 대상으로 하는 로컬 E2E 테스트에 Docker
Compose를 사용합니다. 대상 매트릭스는 Mastodon, Misskey, Pleroma, Hollo,
HackersPub입니다.

각 대상 서버는 격리된 Docker Compose profile에서 실행되며, assertion은 각
어댑터 패키지 안에 둡니다.

 -  각 서버는 격리된 데이터베이스와 캐시를 사용합니다.
 -  업스트림 서버가 요구하는 경우 Docker 서비스 이름과 공개 인스턴스 호스트를
    분리합니다.
 -  공개 호스트는 `mastodon.127.0.0.1.nip.io`처럼 loopback으로 해석되는
    도메인을 사용합니다.
 -  provision 스크립트는 어댑터 테스트에 필요한 로컬 계정, 액세스 토큰, seed
    content를 만듭니다.
 -  E2E assertion은 각 어댑터 패키지에 둡니다. 공통 파싱과 baseline assertion은
    `packages/e2e-fixtures`에 둡니다.
 -  Compose 파일, 서버 설정, provision 스크립트는 `test/e2e/` 아래에 둡니다.

Compose 파일은 Misskey, Pleroma, HackersPub를 인접한 소프트웨어 checkout에서
빌드합니다. 기본 경로는 `/Users/Nebuleto/Workspace/activityplug-docs`입니다.
checkout이 다른 위치에 있으면 `ACTIVITYPLUG_SOFTWARE_ROOT`를 설정합니다. 검증한
source revision은 다음과 같습니다.

 -  Misskey: `0f5da633284ffe20c3ed59bb0a5c5866071baac3`.
 -  Pleroma: `683ab39160a2ff95d151887a89217bd1d4a6dcf5`.
 -  HackersPub: `ee596993c26ead89c70f6b8b601a8e8f8d829cb7`.

Docker Desktop 메모리가 작을 때는 대상을 하나씩 실행합니다. 4 GB 메모리 제한은
순차 실행에 충분하며, 전체 매트릭스를 동시에 실행할 필요는 없습니다. 다섯 대상을
모두 증명해야 하는 실행에서는 matrix runner를 사용합니다.

~~~~ sh
bash test/e2e/run-fediverse-matrix.sh
~~~~

대상 하나를 시작하고 provision합니다.

~~~~ sh
docker compose -f test/e2e/docker-compose.yml --profile mastodon up -d --wait
target="$(bash test/e2e/provision.mastodon.sh)"
printf '%s\n' "$target"
~~~~

provision된 target을 JSON으로 넘겨 어댑터 E2E 테스트를 실행합니다.

~~~~ sh
NODE_TLS_REJECT_UNAUTHORIZED=0 \
ACTIVITYPLUG_FEDIVERSE_E2E=1 \
ACTIVITYPLUG_FEDIVERSE_TARGETS="[$target]" \
pnpm test:e2e
~~~~

`ACTIVITYPLUG_FEDIVERSE_TARGETS`가 설정되어 있지 않으면 `pnpm test:e2e`는
Fediverse E2E suite를 skip합니다. provision된 target이 없을 때 실패해야 하는 CI
작업에서는 `ACTIVITYPLUG_FEDIVERSE_E2E_REQUIRED=1`을 설정합니다. 기본 strict
mode는 하나의 target array에 다섯 adapter가 모두 있기를 요구합니다. matrix
runner는 순차 target마다 `ACTIVITYPLUG_FEDIVERSE_REQUIRED_ADAPTERS`를
설정하므로, 모든 서버를 동시에 띄우지 않고도 같은 strict check를 사용할 수
있습니다.

초기 baseline은 인스턴스 프로필 읽기, 토큰이 있을 때의 viewer 검증, 계정 조회,
계정 게시물 목록, ActivityPlug page limit clamp를 검증합니다. 테스트는 공개
인스턴스로 fallback하면 안 됩니다.

대상별 참고 사항:

 -  Mastodon은 이 profile에서 공개 HTTPS origin을 요구하므로 로컬 Caddy 서비스
    뒤에서 실행합니다. `https://mastodon.127.0.0.1.nip.io:41080`을 사용하고,
    이 로컬 테스트에서만 `NODE_TLS_REJECT_UNAUTHORIZED=0`을 설정합니다.
 -  Misskey provision은 데이터베이스에서 federation을 켜고, admin session을 만든
    뒤 seed note와 token target을 생성합니다.
 -  Pleroma provision은 `pleroma_ctl`로 로컬 사용자를 만들고,
    Mastodon-compatible OAuth application을 등록한 뒤 password-grant token과
    public seed status를 만듭니다.
 -  Hollo provision은 account, token, public post에 필요한 PostgreSQL row를 직접
    seed합니다. 고정된 Hollo image가 이 fixture에 필요한 전체
    Mastodon-compatible bootstrap surface를 제공하지 않기 때문입니다.
 -  HackersPub provision은 local instance, account, actor, note source, post에
    필요한 PostgreSQL row를 seed합니다. Docker build는 고정된 `GIT_COMMIT` 값을
    넘기며, container command는 시작 시 `INSTANCE_ACTOR_KEY`를 생성합니다.

어댑터 패키지 테스트는 `@activityplug/e2e-fixtures`를 통해 같은 target JSON을
사용합니다. 어댑터 수준 E2E 테스트를 추가할 때는 `targetsForAdapter()`로 adapter
이름을 필터링하고 실제 adapter instance와 함께 `expectReadBaseline()`을
호출합니다. 서버별 setup은 package test 안이 아니라 `test/e2e/`에 둡니다.

다음 대상을 시작하기 전에 실행 중인 profile을 중지합니다.

~~~~ sh
docker compose -f test/e2e/docker-compose.yml --profile mastodon stop
~~~~
