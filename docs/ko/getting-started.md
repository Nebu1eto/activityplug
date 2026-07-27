시작하기
========

[English](../en/getting-started.md) | 한국어 |
[日本語](../ja/getting-started.md)

이 가이드는 서버 모드부터 시작합니다. 명령줄 서버가 완전한 원격
transport와 origin 정책을 갖추고 있기 때문입니다. 라이브러리 모드에서도
동일한 이식 가능 클라이언트 계약을 직접 쓸 수 있지만, Node.js
애플리케이션은 자체적으로 검증한 remote authority를 제공해야 합니다.


요구 사항
---------

배포 패키지는 Node.js 26 이상이 필요하며 ECMAScript module을 사용합니다.
저장소는 pnpm 11을 사용합니다.


서버 실행
---------

서버와 peer dependency를 설치합니다.

~~~~ sh
pnpm add @activityplug/server @activityplug/core @hono/node-server @logtape/logtape graphql hono
~~~~

아래 `https://social.example`을 ActivityPlug 프로세스가 접근할 수 있는
실제 Fediverse 서버의 canonical HTTPS origin으로 바꾸십시오. 명령줄
서버는 `127.0.0.1:4000`에서 시작하며, 명시적으로 전달한 origin만
허용합니다.

~~~~ sh
pnpm exec activityplug-server \
  --allow-origin https://social.example
~~~~

서버는 foreground에서 계속 실행됩니다. 다른 터미널에서 readiness를
확인하십시오.

~~~~ sh
curl http://127.0.0.1:4000/health
~~~~

HTTP API로 구성된 instance를 감지합니다.

~~~~ sh
curl \
  -H 'Content-Type: application/json' \
  -d '{"origin":"https://social.example"}' \
  http://127.0.0.1:4000/api/v1/instances/detect
~~~~

CLI에는 현재 모든 어댑터가 포함됩니다. 인증·보안 상태는 메모리에
저장되며, access-token import는 기본적으로 비활성화되어 있습니다.
브라우저 모드를 활성화하면 `--browser-memory-stores` 옵션이 있을 때만
브라우저용 in-memory store가 추가됩니다. durable store나 별도 정책이
필요한 애플리케이션은 서버를 프로그래밍 방식으로 구성해야 합니다.
[서버 사용법](server-usage.md)을 참고하십시오.


저장소 예제 실행
----------------

저장소 예제는 전체 통합 경로를 실행합니다.

 -  [Bot](../../examples/bot/README.md)은 Mastodon 또는 Misskey와 함께
    라이브러리 모드를 사용합니다.
 -  [Proxy client](../../examples/proxy-client/README.md)는 HTTP·GraphQL
    서버 API를 호출합니다.
 -  [Web client](../../examples/web-client/README.md)는 메모리 또는 durable
    storage와 함께 브라우저 API를 사용합니다.


다음 가이드 선택
----------------

 -  TypeScript로 직접 통합하고 런타임별 remote authority를 구성하려면
    [라이브러리 사용법](library-usage.md)을 읽으십시오.
 -  GraphQL 또는 HTTP 클라이언트를 개발하려면
    [서버 사용법](server-usage.md)을 읽으십시오.
 -  웹 애플리케이션을 개발하려면
    [브라우저 통합](browser-integration.md)을 읽으십시오.
 -  서버별 기능에 의존하기 전에
    [어댑터와 capability](adapters-and-capabilities.md)를 읽으십시오.
