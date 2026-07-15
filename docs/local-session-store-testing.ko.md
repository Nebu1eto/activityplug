로컬 세션 저장소 테스트
=======================

ActivityPlug에는 Redis와 PostgreSQL 인증 세션 저장소를 위한 Docker Compose
환경이 포함되어 있습니다.

통합 테스트를 실행하기 전에 로컬 서비스를 시작하세요.

~~~~ sh
pnpm compose:dev
~~~~

컨테이너 기반 통합 테스트를 실행합니다.

~~~~ sh
pnpm test:integration
~~~~

기본 엔드포인트는 다음과 같습니다.

 -  Redis: `redis://127.0.0.1:56379`
 -  PostgreSQL:
    `postgres://activityplug:activityplug@127.0.0.1:55432/activityplug`

다른 로컬 환경이 해당 포트를 사용 중이면 `ACTIVITYPLUG_REDIS_URL`과
`ACTIVITYPLUG_POSTGRES_URL`로 값을 바꾸세요.
