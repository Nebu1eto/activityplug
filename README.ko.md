<h1>
  <img src="https://raw.githubusercontent.com/Nebu1eto/activityplug/main/docs/public/activityplug.svg" alt="ActivityPlug logo" width="40" height="40" align="absmiddle" />
  ActivityPlug
</h1>

[![npm](https://img.shields.io/npm/v/%40activityplug%2Fcore?logo=npm)](https://www.npmjs.com/package/@activityplug/core)
[![Docs](https://img.shields.io/badge/docs-vitepress-059669)](https://activityplug.dev/)
[![CI](https://github.com/Nebu1eto/activityplug/actions/workflows/ci.yml/badge.svg)](https://github.com/Nebu1eto/activityplug/actions/workflows/ci.yml)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](#license)

[English](README.md) | 한국어 | [日本語](README.ja.md)

ActivityPlug는 서로 다른 클라이언트 API를 가진 ActivityPub 서버들을 하나의
TypeScript 계약으로 통합합니다. 라이브러리로 직접 가져다 쓸 수도 있고,
함께 제공되는 GraphQL·HTTP·브라우저 서버를 통해 사용할 수도 있습니다.

현재 어댑터는 Mastodon, Pleroma·Akkoma, Misskey, Hollo, HackersPub을
지원합니다. 각 어댑터는 capability를 보고하므로, 애플리케이션에서 특정
기능을 노출하기 전에 지원 여부를 먼저 확인할 수 있습니다. 지원하지 않는
동작은 `UNSUPPORTED_OPERATION` typed error로 실패합니다.


통합 방식 선택
--------------

신뢰할 수 있는 애플리케이션 코드에서 Fediverse 서버를 직접 호출한다면
**라이브러리 모드**를 사용합니다. `@activityplug/core`와 대상 서버의
어댑터를 설치한 뒤, 런타임에 맞는 remote authority를 지정합니다.

여러 클라이언트가 하나의 통제된 API 경계를 공유해야 한다면 **서버
모드**를 사용합니다. `@activityplug/server`는 GraphQL·HTTP API, 원격
origin 정책, 선택적 브라우저 route를 제공하며, `@activityplug/cli`는 같은
서버를 명령줄에서 실행합니다.

웹 애플리케이션에서 ActivityPlug session identifier와 원격 credential을
브라우저 저장소에 남기지 않아야 한다면 **브라우저 API**를 사용합니다.
브라우저 route는 불투명 서명 BFF cookie와 CSRF 보호를 사용합니다.

[시작 가이드](docs/ko/getting-started.md)를 먼저 읽고 아래 문서로
이동하십시오.

 -  [라이브러리 사용법](docs/ko/library-usage.md)
 -  [서버 사용법](docs/ko/server-usage.md)
 -  [브라우저 통합](docs/ko/browser-integration.md)
 -  [API 표면](docs/ko/api-surfaces.md)


공개 패키지
-----------

| 패키지                                                                  | 역할                                                                               |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`@activityplug/core`](packages/core/README.md)                         | 이식 가능한 타입, 클라이언트 서비스, capability, identifier, error, transport 경계 |
| [`@activityplug/mastodon`](packages/mastodon/README.md)                 | Mastodon 어댑터                                                                    |
| [`@activityplug/pleroma`](packages/pleroma/README.md)                   | Pleroma·Akkoma 어댑터                                                              |
| [`@activityplug/misskey`](packages/misskey/README.md)                   | Misskey 어댑터                                                                     |
| [`@activityplug/hollo`](packages/hollo/README.md)                       | Hollo 어댑터                                                                       |
| [`@activityplug/hackerspub`](packages/hackerspub/README.md)             | HackersPub 어댑터                                                                  |
| [`@activityplug/mastodon-base`](packages/mastodon-base/README.md)       | Mastodon 호환 어댑터의 공통 기반                                                   |
| [`@activityplug/server`](packages/server/README.md)                     | GraphQL·HTTP·브라우저 서버 표면                                                    |
| [`@activityplug/cli`](packages/cli/README.md)                           | 명령줄 서버                                                                        |
| [`@activityplug/session-postgres`](packages/session-postgres/README.md) | 서버 배포용 PostgreSQL lifecycle store                                             |
| [`@activityplug/session-redis`](packages/session-redis/README.md)       | 서버 배포용 Redis 단기 store와 제한                                                |


예제
----

 -  [`examples/bot`](examples/bot/README.md)은 멘션에 응답하는 bot으로
    라이브러리 모드를 시연합니다.
 -  [`examples/proxy-client`](examples/proxy-client/README.md)는 서버
    모드의 HTTP·GraphQL 클라이언트를 시연합니다.
 -  [`examples/web-client`](examples/web-client/README.md)는 브라우저
    API와 배포 가능한 서버 구성을 시연합니다.


요구 사항
---------

ActivityPlug 패키지는 Node.js 26 이상이 필요하며 ECMAScript module을
사용합니다. 저장소는 pnpm 11을 사용합니다.


문서
----

[문서 색인](docs/ko/README.md)은 작업과 독자별로 가이드를 분류합니다.
Capability 동작, 인증, streaming, storage, 배포, 보안, 아키텍처, 어댑터
개발, 테스트, 마이그레이션 문서를 확인할 수 있습니다.


라이선스
--------

Apache-2.0 OR MIT 라이선스로 제공됩니다. `LICENSE-APACHE`와
`LICENSE-MIT`를 참고하십시오.
