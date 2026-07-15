@activityplug/misskey
=====================

[English](README.md) | 한국어 | [日本語](README.ja.md)

ActivityPlug용 Misskey 어댑터입니다.


설치
----

~~~~ sh
pnpm add @activityplug/misskey
~~~~

Node.js 26 이상이 필요합니다. 이 패키지는 ECMAScript 모듈을 사용합니다.


사용법
------

~~~~ ts
import * as activityplug from "@activityplug/misskey";
~~~~

패키지 루트는 지원되는 공개 API를 노출합니다. 이 릴리스에서 사용할 수
있는 정확한 계약은 내보낸 타입을 참조하십시오.


스트리밍
--------

스트리밍과 URL 미디어 가져오기에는 주입된 `webSocket` 팩토리가 필요합니다.
서버 애플리케이션은 자체 이그레스 정책과 DNS 고정을 적용해야 하므로 어댑터는
전역 WebSocket 구현을 사용하지 않습니다.

인증된 타임라인, 알림 및 URL 미디어 작업에서 어댑터는 `Bearer ...` 값을
`WebSocketFactoryCallOptions.authorization`으로 전달합니다. 팩토리는 이 값을
WebSocket 핸드셰이크의 `Authorization` 헤더에 넣어야 합니다. 액세스 토큰은
`i` 쿼리 매개변수에 기록되지 않으며 이전 쿼리 대체 경로도 없습니다. 이 헤더를
설정할 수 없는 팩토리나 런타임은 해당 인증 작업을 안전하게 제공할 수 없습니다.

인증된 타임라인, 알림 및 URL 미디어 WebSocket은 감지 결과가 Misskey 13.14.0
이상일 때만 활성화됩니다. 알 수 없거나 더 오래되었거나 Misskey가 아닌 결과는
소켓을 열기 전에 타입이 지정된 `UNSUPPORTED_OPERATION`으로 실패합니다. 어댑터는
실제 공개 작업을 `WebSocketFactoryCallOptions.operation`으로 전달합니다.
작업명은 `stream.timeline`, `stream.notifications` 또는
`media.ingestUrl`입니다. 이 소켓은 감지된 인스턴스 오리진과
`authorization-header` 표현을 사용하므로 오리진 간 자격 증명 grant가 필요하지
않습니다. 익명 스트리밍은 버전 및 자격 증명 검사를 건너뛰지만 주입된 팩토리와
그 이그레스 정책은 계속 사용합니다. URL 미디어 가져오기는 인증 작업이며 익명
대체 경로가 없습니다.

직접 클라이언트는 신뢰할 수 있는 인스턴스 감지를 통해 소프트웨어 프로필을 얻고
운영 클라이언트에 `detectedSoftware`로 전달해야 합니다. 클라이언트를 다시 구성할
때 동일한 어댑터, 오리진 및 검증된 authority를 재사용하십시오.

~~~~ ts
const detector = createActivityPlugClient({ adapter, origin, remoteAuthority });
const profile = await detector.instances.detect();
const client = createActivityPlugClient({
  adapter,
  origin,
  remoteAuthority,
  detectedSoftware: profile.software,
});
~~~~

신뢰할 수 없는 호출자 입력으로 `detectedSoftware`를 채우지 마십시오.
ActivityPlug 서버는 신뢰할 수 있는 감지를 수행하고 이 옵션을 자동으로
전달합니다.


라이선스
--------

Apache-2.0 OR MIT로 라이선스됩니다. `LICENSE-APACHE`와
`LICENSE-MIT`를 참조하십시오.
