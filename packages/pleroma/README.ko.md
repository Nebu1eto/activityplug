@activityplug/pleroma
=====================

[English](README.md) | 한국어 | [日本語](README.ja.md)

ActivityPlug용 Pleroma 어댑터입니다.


설치
----

~~~~ sh
pnpm add @activityplug/pleroma
~~~~

Node.js 26 이상이 필요합니다. 이 패키지는 ECMAScript 모듈을 사용합니다.


사용법
------

~~~~ ts
import * as activityplug from "@activityplug/pleroma";
~~~~

패키지 루트는 지원되는 공개 API를 노출합니다. 이 릴리스에서 사용할 수
있는 정확한 계약은 내보낸 타입을 참조하십시오.


스트리밍
--------

스트리밍을 사용하려면 어댑터를 만들 때 `webSocket` 팩토리를 제공해야 합니다.
배포 환경의 원격 오리진 정책을 적용하는 팩토리를 제공하십시오. 어댑터는
WebSocket을 직접 만들지 않습니다.

인스턴스는 `configuration.urls.streaming` 또는 이전의
`urls.streaming_api`를 알릴 수 있습니다. 이 엔드포인트의 호스트는 인스턴스
HTTP API와 다를 수 있습니다. 익명 공개 스트림은 팩토리가 허용하면 이 알림
엔드포인트를 사용할 수 있습니다.

인증 스트림은 bearer 토큰을 URL에 넣지 않습니다. 어댑터는 Akkoma와 Pleroma
2.7.1 이상에서 WebSocket 하위 프로토콜을 사용합니다. 더 오래되었거나 버전을
확인할 수 없는 Pleroma는 소켓을 열기 전에 타입이 지정된
`UNSUPPORTED_OPERATION`으로 실패합니다. 인증 스트림에는 암호화된 `wss:`도
필요합니다. 알린 엔드포인트의 오리진이 다르면 권한에는 인스턴스 오리진에서
스트리밍 오리진으로 향하는 정확한 방향성 grant가 필요합니다. 이 grant는 자격
증명 클래스 `oauth-access-token`, 표현 `websocket-subprotocol` 및 실제 공개 작업
`stream.timeline` 또는 `stream.notifications`를 사용합니다. 같은 오리진의 인증
스트림에는 오리진 간 grant가 필요하지 않습니다. 익명 스트림은 하위 프로토콜
자격 증명을 전달하지 않으므로 자격 증명 grant도 필요하지 않지만 팩토리의
이그레스 정책은 계속 적용됩니다.


라이선스
--------

Apache-2.0 OR MIT로 라이선스됩니다. `LICENSE-APACHE`와
`LICENSE-MIT`를 참조하십시오.
