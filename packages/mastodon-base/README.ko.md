@activityplug/mastodon-base
===========================

[English](README.md) | 한국어 | [日本語](README.ja.md)

Mastodon 호환 ActivityPlug 어댑터를 위한 공통 지원을 제공합니다.


설치
----

~~~~ sh
pnpm add @activityplug/mastodon-base
~~~~

Node.js 26 이상이 필요합니다. 이 패키지는 ECMAScript 모듈을 사용합니다.


사용법
------

~~~~ ts
import * as activityplug from "@activityplug/mastodon-base";
~~~~

패키지 루트는 지원되는 공개 API를 노출합니다. 이 릴리스에서 사용할 수
있는 정확한 계약은 내보낸 타입을 참조하십시오.


스트리밍
--------

스트리밍에는 주입된 `webSocket` 팩토리가 필요합니다. 서버 애플리케이션은
토큰이 포함된 URL에 연결하기 전에 자체 이그레스 정책과 DNS 고정을 적용해야
하므로, 어댑터는 전역 WebSocket 구현을 사용하지 않습니다.


라이선스
--------

Apache-2.0 OR MIT로 라이선스됩니다. `LICENSE-APACHE`와
`LICENSE-MIT`를 참조하십시오.
