@activityplug/session-Postgres
==============================

[English](README.md) | 한국어 | [日本語](README.ja.md)

ActivityPlug 서버 모드를 위한 PostgreSQL 수명 주기 저장소입니다.


설치
----

~~~~ sh
pnpm add @activityplug/session-postgres
~~~~

Node.js 26 이상이 필요합니다. 이 패키지는 ECMAScript 모듈을 사용합니다.


사용법
------

~~~~ ts
import * as activityplug from "@activityplug/session-postgres";
~~~~

패키지 루트는 지원되는 공개 API를 노출합니다. 이 릴리스에서 사용할 수
있는 정확한 계약은 내보낸 타입을 참조하십시오.


서버 연결
---------

요청 처리용 `pg` 풀을 하나 만들고, 트래픽을 받기 전에 수명 주기 테이블을
초기화한 다음, 그 풀에서 모든 PostgreSQL 기반 저장소를 만듭니다. 초기화 함수는
배포를 시작할 때마다 안전하게 호출할 수 있으며 인증 세션, OAuth 상태, OAuth
클라이언트 비밀 및 브라우저 세션 테이블을 만듭니다.

~~~~ ts
import { createActivityPlugServer, InMemoryStreamTicketStore } from "@activityplug/server";
import {
  createPostgresAuthSessionStore,
  createPostgresBrowserSessionStore,
  createPostgresOAuthClientSecretStore,
  createPostgresOAuthStateStore,
  initializePostgresLifecycleStores,
} from "@activityplug/session-postgres";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

await initializePostgresLifecycleStores(pool);

const activityPlug = createActivityPlugServer({
  adapters,
  sessions: createPostgresAuthSessionStore(pool),
  oauthClientSecrets: createPostgresOAuthClientSecretStore(pool),
  browser: {
    publicOrigin: "https://client.example",
    cookieSigningKey,
    browserSessions: createPostgresBrowserSessionStore(pool),
    oauthStates: createPostgresOAuthStateStore(pool),
    streamTickets: new InMemoryStreamTicketStore(),
  },
});

await activityPlug.ready;
activityPlug.start({ hostname: "127.0.0.1", port: 4000 });

try {
  // 애플리케이션을 실행합니다.
} finally {
  await activityPlug.close();
  await pool.end();
}
~~~~

예제의 `adapters`는 애플리케이션이 구성한 어댑터 목록이고,
`cookieSigningKey`는 무작위 바이트가 최소 32개 들어 있는 `Uint8Array`입니다.
인메모리 스트림 티켓 저장소는 예제를 이 패키지에 집중하기 위한 것입니다. 다중
프로세스 또는 프로덕션 브라우저 배포에는 영속 구현을 사용하십시오.

항상 `pool.end()`보다 먼저 ActivityPlug 서버를 닫으십시오. 서버가 소유한 보안
상태 수명 주기는 `close()`가 완료될 때까지 PostgreSQL 정리를 실행할 수 있습니다.
별도로 주입한 `SecurityStateLifecycle`도 호출자가 소유하므로 풀을 끝내기 전에
중지해야 합니다.


라이선스
--------

Apache-2.0 OR MIT로 라이선스됩니다. `LICENSE-APACHE`와
`LICENSE-MIT`를 참조하십시오.
