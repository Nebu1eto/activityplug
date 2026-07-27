ActivityPlug 테스트
===================

[English](../en/testing.md) | 한국어 | [日本語](../ja/testing.md)

ActivityPlug는 서로 호환되지 않는 Fediverse 서버 사이에서도 안정적으로
유지해야 하는 동작을 테스트합니다. 공개 API contract, 어댑터 mapping,
인증, capability 감지, opaque identifier와 cursor, pagination, typed
error, 보안 경계, 상호 운용성 가정이 여기에 해당합니다.

이러한 동작을 보호하는 최소한의 case만 작성합니다. build tool 설정,
사소한 구현 세부 사항, 외부 라이브러리의 동작은 테스트하지 않습니다.
실패로 인해 ActivityPlug contract가 바뀌거나 지원 workflow가 깨질 때
regression test가 필요합니다.


테스트 계층
-----------

저장소는 검증 경계에 따라 테스트를 구분합니다.

| 계층               | 목적                                                  | 외부 서비스             |
| ------------------ | ----------------------------------------------------- | ----------------------- |
| Unit과 component   | Mapping, validation, error, state, 공개 contract      | 없음                    |
| Store integration  | PostgreSQL과 Redis lifecycle store 동작               | 로컬 container          |
| Browser E2E        | 사용자 journey와 browser-only API 경계                | intercept한 fixture API |
| Production Compose | TLS, process hardening, readiness, durable 장애 복구  | 로컬 container          |
| Fediverse E2E      | 실제 서버 software에 대한 adapter, HTTP, GraphQL 동작 | 격리된 Compose profile  |

개발 중에는 비용이 낮고 범위가 좁은 계층을 실행합니다. 변경이
경계를 넘으면 더 넓은 계층을 사용합니다.


Unit과 component 테스트
-----------------------

저장소 Vitest suite를 실행합니다.

~~~~ sh
pnpm test
~~~~

루트 Vitest 설정은 워크스페이스 패키지 이름을 source entry point로
해석하고, `packages/`, `examples/`, `scripts/` 아래의 테스트를
포함합니다. 패키지의 `test` script는 `scripts/run-package-tests.ts`를
호출합니다. 이 script는 해당 패키지의 integration이 아닌 test file을
선택하며, 하나도 없으면 실패합니다.

변경 범위가 한 패키지에 한정되면 해당 패키지만 실행합니다.

~~~~ sh
pnpm --filter @activityplug/core test
pnpm --filter @activityplug/server test
~~~~

웹 클라이언트는 별도의 Vite/Vitest 설정을 사용합니다.

~~~~ sh
pnpm --filter @activityplug/example-web-client test
~~~~

이 테스트는 `jsdom`에서 실행하며 browser contract, state, rendering,
routing, feature interaction을 검증합니다.

공유되는 결정론적 원격 payload는
[`packages/test-fixtures`](../../packages/test-fixtures/)에 있습니다.
ActivityPlug의 정규화와 discovery 동작을 검증할 때 사용합니다. 현재
upstream 서버가 여전히 같이 동작한다는 증거로는 사용하지 마십시오.
그 동작은 Fediverse E2E 테스트가 검증합니다.


Postgresql과 Redis integration 테스트
-------------------------------------

로컬 data service를 시작합니다.

~~~~ sh
pnpm compose:dev
~~~~

두 lifecycle store integration suite를 실행합니다.

~~~~ sh
pnpm test:integration
~~~~

기본 endpoint는 다음과 같습니다.

 -  PostgreSQL:
    `postgres://activityplug:activityplug@127.0.0.1:55432/activityplug`
 -  Redis: `redis://127.0.0.1:56379`

다른 로컬 환경에서 해당 port를 사용 중이라면
`ACTIVITYPLUG_POSTGRES_URL`이나 `ACTIVITYPLUG_REDIS_URL`을
설정합니다. 작업이 끝나면 서비스를 중지하고 container를 제거합니다.

~~~~ sh
docker compose -f docker-compose.dev.yml down
~~~~

저장된 개발 data까지 삭제해야 할 때만 `--volumes`를 추가합니다.


Browser E2E 테스트
------------------

Chromium runtime을 한 번 설치한 다음 Playwright suite를 실행합니다.

~~~~ sh
pnpm --filter @activityplug/example-web-client exec playwright install chromium
pnpm --filter @activityplug/example-web-client test:e2e
~~~~

Playwright는 frontend를 빌드하고 `http://127.0.0.1:4173`에서
preview합니다. fixture는 browser API call을 intercept하고,
애플리케이션이 원격 Fediverse origin에 직접 연결하지 않는지
검증합니다. project는 영어, 한국어, 일본어 desktop locale과 영어
mobile viewport를 포함합니다. journey는 인증 reload, 타임라인과
opaque cursor, 검색, 프로필, thread, 게시물 action, 이미지 재시도,
접근성 landmark, responsive layout, 알 수 없는 route, logout을
검증합니다.

이 테스트는 실제 서버를 프로비저닝하지 않고 product의 browser
동작을 검증합니다. 어댑터 E2E 테스트를 대체하지 않습니다.


Production compose 테스트
-------------------------

Production Compose 검사는 어댑터 의미가 아니라 배포 가능한
topology를 검증합니다. 유용한 로컬 명령은 다음과 같습니다.

~~~~ sh
pnpm compose:config
pnpm compose:up
pnpm compose:health
pnpm compose:down
~~~~

Memory variant는 port `8444`와 별도의 로컬 CA를 사용합니다.

~~~~ sh
pnpm compose:memory:config
pnpm compose:memory:up
pnpm compose:memory:health
pnpm compose:memory:down
~~~~

두 launcher에는 배포 안내서에 설명된 digest-pinned image와 보안
변수가 필요합니다. CI smoke test는 외부 TLS 경계, cookie와 CSRF
동작, container 제한, PostgreSQL 또는 Redis를 사용할 수 없을 때와
복구된 뒤의 readiness도 검사합니다.


Fediverse E2E matrix
--------------------

ActivityPlug는 Mastodon stable, Mastodon minimum, Misskey, Pleroma,
Hollo, HackersPub에 격리된 Compose profile을 프로비저닝합니다.
각 대상은 자체 data service와 테스트 소유 계정 또는 content를
사용합니다. 서버 suite가 HTTP와 GraphQL을 먼저 검증한 다음, 해당
어댑터 suite가 library API를 검증합니다.

전체 matrix를 순차 실행합니다.

~~~~ sh
bash test/e2e/run-fediverse-matrix.sh
~~~~

runner는 각 profile을 시작하기 전과 종료할 때 container와 named
volume을 초기화합니다. stage 결과는 NDJSON으로 standard output에,
명령, Compose, test log는 standard error에 씁니다. `checkout`과
`build` 뒤에 test runner가 `server-test`를 기록하고, 소비된
fixture를 다시 프로비저닝하면서 `provision`을 기록한 다음
`adapter-test`를 기록합니다. 최초 프로비저닝은 `server-test`보다
먼저 실행하며, 이 단계가 실패해도 `provision`으로 기록합니다.
upstream checkout, build, startup, provisioning 실패는 external로
표시하지만, ActivityPlug assertion 실패는 그렇지 않습니다.

정확한 upstream ref와 commit은
[`test/e2e/versions.env`](../../test/e2e/versions.env)에 기록되어
있습니다. 가져온 source는 저장소 외부의
`${XDG_CACHE_HOME:-$HOME/.cache}/activityplug/fediverse-sources`에
저장됩니다. acquisition 단계는 source가 build context에 들어가기
전에 commit을 검증하고 ignored file을 정리합니다. 이 대상을
public instance로 대체하지 마십시오.

서버별 변경을 진단할 때는 profile 하나를 실행합니다.

~~~~ sh
docker compose -f test/e2e/docker-compose.yml --profile mastodon up -d --wait
target="$(bash test/e2e/provision.mastodon.sh)"

NODE_TLS_REJECT_UNAUTHORIZED=0 \
ACTIVITYPLUG_FEDIVERSE_E2E=1 \
ACTIVITYPLUG_FEDIVERSE_TARGETS="[$target]" \
pnpm test:e2e
~~~~

`NODE_TLS_REJECT_UNAUTHORIZED=0`은 로컬 Mastodon fixture가 생성한
인증서에만 필요합니다. public 또는 production origin에는 사용하지
마십시오.

`ACTIVITYPLUG_FEDIVERSE_TARGETS`가 없으면 `pnpm test:e2e`는
Fediverse suite를 건너뜁니다. 건너뛰기를 실패로 처리해야 하는
환경에서는 strict mode를 설정합니다.

~~~~ sh
ACTIVITYPLUG_FEDIVERSE_E2E_REQUIRED=1 \
ACTIVITYPLUG_FEDIVERSE_REQUIRED_ADAPTERS=mastodon \
ACTIVITYPLUG_FEDIVERSE_TARGETS="[$target]" \
pnpm test:e2e
~~~~

서버 suite가 파괴적 fixture를 사용하므로, 직접 runner는 어댑터
테스트 전에 다시 프로비저닝합니다. 전달한 target payload가 어댑터
suite용으로 이미 프로비저닝된 경우에만
`ACTIVITYPLUG_FEDIVERSE_REPROVISION_PACKAGE_TARGETS=0`을
설정합니다.

[`packages/e2e-fixtures`](../../packages/e2e-fixtures/)의 공통
assertion은 capability에 따라 실행됩니다. 어댑터가 지원을 선언하고
프로비저닝된 대상이 필요한 일회용 fixture를 제공할 때만 instance와
account 읽기, timeline, search, media, post, poll, notification,
follow request, list, filter, scheduled post, social action을
검증합니다.

수동으로 시작한 matrix는 profile을 바꾸기 전에 중지하고
제거합니다.

~~~~ sh
docker compose -f test/e2e/docker-compose.yml --profile '*' \
  down --volumes --remove-orphans
~~~~

Pull request CI workflow는 unit, integration, browser, production
Compose 검사를 실행하지만, 실제 Fediverse matrix는 프로비저닝하지
않습니다. 별도의 `Fediverse E2E` workflow가 schedule 또는 수동
workflow dispatch로 matrix를 실행합니다. 해당 workflow 전에 실제
서버 증거가 필요하면 로컬에서 matrix를 실행하십시오.


테스트 선택과 추가
------------------

다음 조건 중 하나 이상을 보호할 때 범위가 좁은 테스트를
추가합니다.

 -  문서화된 공개 API result 또는 typed failure
 -  지원 서버 사이에서 달라지는 어댑터 mapping
 -  인증, origin, credential, browser 보안 경계
 -  명시적인 unsupported result를 포함한 capability 의존 동작
 -  opaque identifier, cursor, pagination, error 보존
 -  실제 서버 테스트로 검증할 수 있는 상호 운용성 가정

결정론적인 mapping과 validation에는 unit test를 우선합니다.
PostgreSQL 또는 Redis에 의존하는 동작에만 store integration test를
사용합니다. component나 state 계층을 가로지르는 사용자 journey에는
browser E2E test를 사용합니다. 결과가 실제 upstream protocol 동작에
의존할 때 Fediverse E2E assertion을 사용합니다.

같은 invariant를 모든 계층에서 중복 검증하지 않습니다. Rolldown,
Vitest, React, database client, server implementation을 대신
테스트하지 않습니다. 파괴적 E2E resource는 테스트가 소유하게 하고,
선택 기능은 capability에 따라 검증하며, 실제 서버 실행 뒤에는
container와 volume을 정리합니다.
