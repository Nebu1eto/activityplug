@activityplug/mastodon
======================

[English](README.md) | 한국어 | [日本語](README.ja.md)

ActivityPlug용 Mastodon 어댑터입니다.


설치
----

~~~~ sh
pnpm add @activityplug/mastodon
~~~~

Node.js 26 이상이 필요합니다. 이 패키지는 ECMAScript 모듈을 사용합니다.


사용법
------

~~~~ ts
import * as activityplug from "@activityplug/mastodon";
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

Mastodon은 기본적으로 `authorization-header` 스트리밍 모드를 사용합니다.
인증된 스트림에서는 어댑터가 토큰을 팩토리의 `options.authorization`으로
제공하며 스트리밍 URL에는 토큰이 포함되지 않습니다. 팩토리는 이 값을
WebSocket `Authorization` 헤더로 전달해야 합니다. 알린 엔드포인트의 오리진이
다르면 권한에는 인스턴스 오리진에서 스트리밍 오리진으로 향하는 정확한 방향성
grant도 필요합니다. 이 grant는 자격 증명 클래스 `oauth-access-token`, 표현
`authorization-header` 및 실제 공개 작업 `stream.timeline` 또는
`stream.notifications`를 사용합니다. 같은 오리진의 인증 스트림에는 오리진 간
grant가 필요하지 않습니다. 익명 스트림에는 인증 값이 제공되지 않으므로 자격
증명 grant도 필요하지 않지만 팩토리의 이그레스 정책은 계속 적용됩니다. 인증된
스트림에는 암호화된 `wss:` 대상이 필요합니다.


라이선스
--------

Apache-2.0 OR MIT로 라이선스됩니다. `LICENSE-APACHE`와
`LICENSE-MIT`를 참조하십시오.
