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
