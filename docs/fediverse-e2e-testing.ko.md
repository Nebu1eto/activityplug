Fediverse E2E 테스트
====================

ActivityPlug는 실제 Fediverse 서버를 대상으로 하는 로컬 E2E 테스트에 Docker
Compose를 사용합니다. 대상 매트릭스는 Mastodon, Misskey, Pleroma, Hollo,
HackersPub입니다.

각 대상 서버는 격리된 Docker Compose profile에서 실행됩니다.

 -  각 서버는 격리된 데이터베이스와 캐시를 사용합니다.
 -  업스트림 서버가 요구하는 경우 Docker 서비스 이름과 공개 인스턴스 호스트를
    분리합니다.
 -  공개 호스트는 `mastodon.127.0.0.1.nip.io`처럼 loopback으로 해석되는
    도메인을 사용합니다.
 -  provision 스크립트는 어댑터 테스트에 필요한 로컬 계정, 액세스 토큰, seed
    content를 만들거나 필요한 수동 절차를 설명합니다.
 -  E2E assertion은 각 어댑터 패키지에 둡니다. 공통 파싱과 baseline assertion은
    `packages/e2e-fixtures`에 둡니다.
 -  Compose 파일, 서버 설정, provision 스크립트는 `test/e2e/` 아래에 둡니다.

대상 하나를 시작합니다.

~~~~ sh
docker compose -f test/e2e/docker-compose.yml --profile mastodon up -d --wait
bash test/e2e/provision.mastodon.sh
~~~~

provision된 target을 JSON으로 넘겨 어댑터 E2E 테스트를 실행합니다.

~~~~ sh
ACTIVITYPLUG_FEDIVERSE_TARGETS='[
  {
    "adapter": "mastodon",
    "origin": "http://mastodon.127.0.0.1.nip.io:41080",
    "token": "replace-with-provisioned-token"
  }
]' pnpm test:e2e
~~~~

`ACTIVITYPLUG_FEDIVERSE_TARGETS`가 설정되어 있지 않으면 `pnpm test:e2e`는
Fediverse E2E suite를 skip합니다. provision된 target이 없을 때 실패해야 하는 CI
작업에서는 `ACTIVITYPLUG_FEDIVERSE_E2E_REQUIRED=1`을 설정합니다.

초기 baseline은 인스턴스 프로필 읽기, 토큰이 있을 때의 viewer 검증, 계정 조회,
계정 게시물 목록, ActivityPlug page limit clamp를 검증합니다. 테스트는 공개
인스턴스로 fallback하면 안 됩니다.
