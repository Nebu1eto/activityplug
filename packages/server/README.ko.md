@activityplug/server
====================

[English](README.md) | 한국어 | [日本語](README.ja.md)

ActivityPlug의 GraphQL 및 HTTP 서버 인터페이스를 제공합니다.


설치
----

~~~~ sh
pnpm add @activityplug/server
~~~~

Node.js 26 이상이 필요합니다. 이 패키지는 ECMAScript 모듈을 사용합니다.


사용법
------

~~~~ ts
import * as activityplug from "@activityplug/server";
~~~~

패키지 루트는 지원되는 공개 API를 노출합니다. 이 릴리스에서 사용할 수
있는 정확한 계약은 내보낸 타입을 참조하십시오.


명령줄 서버
-----------

이 패키지는 `activityplug-server` 바이너리를 설치합니다. 최소 서버는 루프백의
4000번 포트에 바인딩됩니다.

~~~~ sh
pnpm exec activityplug-server
~~~~

리스너를 변경하려면 `--host`와 `--port`를 사용합니다. 런타임이 접속할 수 있는
각 HTTPS 원격 ActivityPub 서버마다 `--allow-origin`을 반복해서 지정합니다.
사설망 또는 루프백 목적지는 `--allow-private-networks`도 필요합니다.

~~~~ sh
pnpm exec activityplug-server \
  --host 0.0.0.0 \
  --port 8080 \
  --allow-origin https://social.example
~~~~

`--browser-origin`이 없으면 브라우저 라우트는 비활성화됩니다. CLI 브라우저
모드는 개발 전용이며, 최소 32바이트의 패딩 없는 base64url 서명 키와 명시적인
인메모리 저장소가 필요합니다.

~~~~ sh
export ACTIVITYPLUG_BROWSER_COOKIE_SIGNING_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
pnpm exec activityplug-server \
  --browser-origin https://client.example \
  --browser-memory-stores \
  --trusted-proxy 10.0.0.10
~~~~

`--trusted-proxy`에는 정확한 IP 주소를 지정하며 반복할 수 있습니다. 즉시 연결된
피어가 이 목록에 있을 때만 전달된 클라이언트 주소 헤더를 신뢰합니다. CLI
브라우저 모드는 프로덕션에 사용하지 마십시오. 세션, OAuth 상태, 스트림 티켓,
요청 제한 및 챌린지가 프로세스에만 존재하며 재시작하면 사라집니다. 프로덕션은
`createActivityPlugServer()`로 영속 저장소를 구성하십시오.

익명 브라우저 세션은 기본적으로 stateless입니다. embedding이
`anonymousSessionMode: "stored"`를 선택하면 모든 할당은 저장소의 원자적
admission 연산을 사용합니다. `storedSessionCapacity`의 기본값은 live 세션
10,000개, `storedSessionCapacityPerClient`는 16개,
`storedSessionCreationLimit`는 60초 `storedSessionCreationWindowMilliseconds`
마다 32회입니다. 신뢰된 client-IP resolver가 client별 식별자를 제공하며
저장소에는 그 HMAC만 저장합니다.

인증된 원격 작업이 자격 증명 발급자와 다른 오리진에 자격 증명을 보낼 때는
`createActivityPlugServer()`의 `remoteCredentialGrants`를 사용하십시오. 각
grant는 발급자, 수신자, 공개 작업, 자격 증명 클래스 및 표현이 모두 정확히
일치해야 합니다. 서버는 인증된 WebSocket 검사를 포함해 이 grant를 검증된
`RemoteAuthority`에 전달합니다. 같은 오리진 작업과 익명 작업에는 오리진 간 자격
증명 grant가 필요하지 않습니다.

생성된 전체 옵션 설명은 `pnpm exec activityplug-server --help`로 확인할 수
있습니다.


수명 주기
---------

`createActivityPlugServer()`는 자신이 소유한 보안 상태 수명 주기를 시작하고 그
시작 작업을 `ready`로 노출합니다. 요청은 `ready`를 기다리며, 애플리케이션도
준비 상태를 알리기 전에 이를 기다려야 합니다. `start()`는 Node 리스너를
반환합니다.

~~~~ ts
const activityPlug = createActivityPlugServer({ adapters });

await activityPlug.ready;
activityPlug.start({ hostname: "127.0.0.1", port: 4000 });

try {
  // 애플리케이션을 실행합니다.
} finally {
  await activityPlug.close();
}
~~~~

`close()`는 멱등입니다. 이 서버를 통해 만든 리스너와 서버가 소유한 보안 상태
수명 주기만 닫습니다. `await activityPlug[Symbol.asyncDispose]()`도 동일합니다.
저장소 클라이언트와 그 밖의 주입된 자원은 호출자가 소유하며, 정리 작업자가
이미 닫힌 의존성을 사용하지 않도록 서버를 닫은 뒤에 닫아야 합니다.


라이선스
--------

Apache-2.0 OR MIT로 라이선스됩니다. `LICENSE-APACHE`와
`LICENSE-MIT`를 참조하십시오.
