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
HTTP API와 다를 수 있습니다. 어댑터는 알린 엔드포인트를 사용하고
`/api/v1/streaming/`을 추가하므로, 인스턴스 HTTPS 오리진과 알린 스트리밍
HTTPS 오리진을 모두 허용하십시오. 예를 들어 서버가 `wss://stream.example`을
알리면 `https://stream.example`을 허용하십시오.

Pleroma 래퍼는 명시적으로 `legacy-query`를 기본값으로 사용합니다. 따라서 인증된
스트림은 `options.authorization`이 아니라 URL 쿼리로 액세스 토큰을 전달합니다.
이 URL에는 자격 증명이 포함되므로 암호화된 `wss:` 대상을 사용하십시오. 대상이
WebSocket `Authorization` 헤더 인증을 지원하는 경우에만
`streamingAuthentication: "authorization-header"`를 설정하십시오.


라이선스
--------

Apache-2.0 OR MIT로 라이선스됩니다. `LICENSE-APACHE`와
`LICENSE-MIT`를 참조하십시오.
