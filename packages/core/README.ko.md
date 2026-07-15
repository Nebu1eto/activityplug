@activityplug/core
==================

[English](README.md) | 한국어 | [日本語](README.ja.md)

ActivityPlug의 핵심 계약, 타입, 식별자, 기능 및 서비스 인터페이스를 제공합니다.


설치
----

~~~~ sh
pnpm add @activityplug/core
~~~~

Node.js 26 이상이 필요합니다. 이 패키지는 ECMAScript 모듈을 사용합니다.


사용법
------

~~~~ ts
import * as activityplug from "@activityplug/core";
~~~~

패키지 루트는 지원되는 공개 API를 노출합니다. 이 릴리스에서 사용할 수
있는 정확한 계약은 내보낸 타입을 참조하십시오.


원격 전송 마이그레이션
----------------------

`createActivityPlugClient()`는 더 이상 원시 `fetch` 옵션을 받거나
`globalThis.fetch`로 대체하지 않습니다. 원격 작업에는 명시적인
`RemoteAuthority`가 필요합니다. 지정하지 않으면 첫 원격 작업이 네트워크 I/O
전에 `ORIGIN_NOT_ALLOWED`로 실패합니다.

~~~~ ts
import { createActivityPlugClient, createRemoteAuthority } from "@activityplug/core";

const client = createActivityPlugClient({
  adapter,
  origin: "https://social.example",
  remoteAuthority: createRemoteAuthority({ transport: vettedTransport }),
});
~~~~

`vettedTransport`는 런타임의 목적지, DNS, 사설망 및 응답 한도를 이미 적용해야
합니다. 원시 전역 fetch를 직접 전달하면 거부됩니다. 브라우저 런타임에서만
`createBrowserRemoteAuthority()`를 사용해 브라우저 fetch 경계를 명시적으로
선택할 수 있습니다. ActivityPlug 서버는 자체 검증된 권한을 구성하므로 이
클라이언트 설정이 필요하지 않습니다.

권한은 기본적으로 같은 오리진의 자격 증명을 허용합니다. 오리진 간 자격
증명에는 발급자, 수신자, 공개 작업, 자격 증명 클래스 및 표현이 모두 정확히
일치하는 방향성 `credentialGrants` 항목이 필요합니다. 지원되는 표현은
`authorization-header`, `cookie-header`, `form-body`, `json-body` 및
`websocket-subprotocol`입니다. 익명 작업은 자격 증명을 전달하지 않으므로 자격
증명 grant가 필요하지 않습니다.

일치하는 본문 grant가 없는 오리진 간 폼 또는 JSON 본문은 요청 복제본에서 최대
64 KiB까지만 검사하며 원본 본문은 전송 계층에서 계속 사용할 수 있습니다. 알 수
없는 본문 형식이나 이 한도를 초과하는 본문은 네트워크 I/O 전에 거부됩니다. URL
사용자 정보 또는 알려진 쿼리 매개변수에 있는 자격 증명은 항상 거부되며 URL 대체
경로는 없습니다.


WebSocket 어댑터 유틸리티
-------------------------

패키지 루트에는 `WebSocketFactory`를 주입하는 어댑터 작성자를 위한 지원
유틸리티가 포함됩니다. 팩토리 호출은 신뢰된 작업 이름을 전달받으며
`WebSocketFactoryCallOptions`를 통해 `Authorization` 헤더 값을 받을 수
있습니다. `resolveWebSocketFactoryResult()`는 동기 팩토리를
그대로 유지하고, 비동기 팩토리 대기를 `AbortSignal`로 제한하며, 취소 후
도착한 소켓을 닫습니다. `streamWebSocketMessages()`는 JSON 메시지를
파싱하고 지연된 소비자의 큐를 이벤트 256개와 데이터 1 MiB로 제한합니다.
한도를 초과하면 `REQUEST_LIMIT_EXCEEDED`로 보고합니다.

`closeWebSocketSafely()`는 종료 중 오류 이벤트를 발생시킬 수 있는 Node
호환 소켓을 처리하고, `webSocketFrameByteLength()`는 지원되는 프레임
데이터 크기를 측정합니다. 관련 `MAX_STREAMING_QUEUED_EVENTS` 및
`MAX_STREAMING_QUEUED_BYTES` 상수도 공개 계약에 포함됩니다.


라이선스
--------

Apache-2.0 OR MIT로 라이선스됩니다. `LICENSE-APACHE`와
`LICENSE-MIT`를 참조하십시오.
