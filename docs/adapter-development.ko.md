어댑터 개발
===========

[English](adapter-development.md) | 한국어 | [日本語](adapter-development.ja.md)

ActivityPlug 어댑터는 하나의 원격 클라이언트 API 계약을
`@activityplug/core`의 정규화된 계약에 매핑합니다. 대상 소프트웨어가
제공하며 필수 의미를 잃지 않고 매핑할 수 있는 동작만 구현하십시오.


안정적인 메타데이터 정의
------------------------

`ActivityPlugAdapter`와 완전한 capability 집합으로 시작합니다.

~~~~ ts
import {
  capability,
  createCapabilitySet,
  type ActivityPlugAdapter,
} from "@activityplug/core";

export const exampleAdapter: ActivityPlugAdapter = {
  metadata: {
    id: "example",
    displayName: "Example",
    kind: "activitypub",
    supportedSoftware: ["example"],
    staticCapabilities: createCapabilitySet({
      "instance.nodeInfo": capability("supported"),
      "posts.read": capability("supported"),
      "posts.create": capability(
        "unsupported",
        "The Example API does not expose post creation.",
      ),
    }),
  },
};
~~~~

ID는 비어 있으면 안 되며 공백이나 제어 문자를 포함할 수 없습니다.
불투명 ID와 페이지 커서에 포함되므로 출시 후에도 안정적으로
유지해야 합니다. `supportedSoftware`에는 어댑터가 실제로 감지하고
매핑하는 소프트웨어 계약만 지정하십시오.

`createCapabilitySet()`은 생략된 capability를 `unknown`으로
채웁니다. 원격 API가 이식 가능한 동작을 제공하지 않는다고
확인되었다면 이유와 함께 명시적인 `unsupported` 결정을
사용하십시오. 감지, 버전 또는 프로브에 따라 지원 여부가 달라진다면
`unknown`을 사용하십시오.


작업 그룹 구현
--------------

어댑터가 매핑하는 선택적 작업 그룹만 추가하십시오. 각 메서드는
정규화된 입력과 `AdapterOperationContext`를 받습니다. 다음 항목을
사용합니다.

 -  선택된 정규 인스턴스에는 `context.origin`
 -  로깅과 원격 접근을 위한 공개 작업에는 `context.operation`
 -  HTTP에는 `context.fetch`를 사용하고, 전역 fetch는 사용하지 않음
 -  저장된 자격 증명 확인에는 `context.sessionStore`
 -  인스턴스 origin 밖이나 WebSocket 팩토리를 통해 자격 증명을
    전달하기 전에는 `context.assertCredentialAllowed`
 -  공개 작업의 예산을 공유해야 하는 중첩 작업에는 `context.budget`
 -  인스턴스별 결정에는 `context.capabilities`와
    `context.detectedSoftware`

`ORIGIN_NOT_ALLOWED`나 `REQUEST_LIMIT_EXCEEDED`를 잡아서 다른
오류로 바꾸지 마십시오. 이러한 오류는 호출자의 보안 경계에
속합니다.


엔티티와 식별자 매핑
--------------------

`@activityplug/core`가 내보내는 정규화된 엔티티 타입을
반환하십시오. 각 참조는 `createEntityRef()`로 만듭니다.

~~~~ ts
import { createEntityRef, type Account } from "@activityplug/core";

function accountFromRemote(
  remote: { id: string; username: string },
  adapter: string,
  origin: string,
): Account {
  return {
    ref: createEntityRef({
      adapter,
      origin,
      type: "account",
      id: remote.id,
    }),
    username: remote.username,
    acct: remote.username,
    displayName: remote.username,
    bot: false,
    locked: false,
    raw: remote,
  };
}
~~~~

이 예제는 참조 경계를 보여줍니다. 프로덕션 매핑은 전체 원격 응답을
검증하고 필수 정규화 필드를 모두 채워야 합니다. 엔티티를 만들기
전에 스키마나 명시적인 검증기를 사용하십시오. 필수 원격 필드가
없으면 빈 이식 가능 값이 아니라 `REMOTE_PROTOCOL_ERROR` 또는
`REMOTE_ERROR`입니다.

진단에 도움이 된다면 원격 페이로드를 `raw`에 보존하십시오. 안정적인
어댑터별 추가 항목은 `extensions`에 넣으십시오. 어느 필드도 정규화된
필드의 의미를 바꿔서는 안 됩니다.

클라이언트는 어댑터를 호출하기 전에 들어온 공개 ID를 디코딩하므로,
어댑터 메서드는 원시 ID를 받습니다. 원시 ID를 공개 `ref.id`로
노출하지 마십시오.


페이지네이션 구현
-----------------

정확한 `PageInfo`와 함께 `Connection<Node>`를 반환하십시오. 원격
연속 값을 `encodePageCursor()`로 인코딩하고, 입력은
`decodePageCursor()`로 디코딩하며, 둘 다 다음 항목에 결합합니다.

 -  어댑터 ID
 -  정규 origin
 -  정확한 공개 작업

커서 바이트를 정확히 보존하십시오. 원격 API가 엔티티 ID를 커서로
정의하지 않았다면 마지막 엔티티 ID를 사용하지 마십시오. 원격
엔드포인트에 동등한 의미가 있을 때만 `after`와 `before`를
지원하십시오. 이식 가능한 제한 100과 더 낮은 원격 제한을
적용하십시오.

안정적으로 이어갈 수 없는 검색 API는, 오해를 일으키는 페이지를
반환하는 대신 전달된 커서를 typed 오류로 거부해야 합니다.


인증 구현
---------

지원하는 전략은 `adapter.auth.strategies`를 통해 노출합니다.
전략은 OAuth, 토큰 가져오기, 이메일 챌린지 또는 패스키 메서드와
세션 검증, 지원되는 갱신 및 철회 작업을 구현할 수 있습니다.

전략이 반환한 토큰 집합은 코어 인증 서비스에 저장됩니다. 원격
작업은 세션 저장소에서 자격 증명을 확인해야 하며, 일반적인 서비스
입력으로 호출자가 access token을 제공한다고 가정하면 안 됩니다.
사용 전에 세션이 선택된 어댑터와 origin에 속하는지 확인하십시오.

자격 증명을 보낼 때는 다음 원칙을 지킵니다.

 -  작업 범위의 `context.fetch`를 사용합니다.
 -  올바른 자격 증명 종류와 표현을 선언합니다.
 -  수신 origin이 다르면 정확한 자격 증명 grant를 요구합니다.
 -  URL과 오류 context에 자격 증명을 넣지 않습니다.
 -  `AUTH_REQUIRED`와 `AUTH_EXPIRED`의 구분을 보존합니다.


감지 후 capability 구체화
-------------------------

정적 capability는 어댑터의 기준선을 나타냅니다. 동작이
소프트웨어나 버전에 따라 달라진다면, 검증된 감지 데이터로
`PartialCapabilitySet`을 만들고 적절한 NodeInfo, OAuth,
인스턴스 또는 프로브 계층으로 병합하십시오.

capability 결정은 작업과 일치해야 합니다.

 -  `supported`에는 문서화된 의미를 갖춘 구현이 필요합니다.
 -  `unsupported`에는 메서드가 없거나, capability를 context에
    포함한 `UNSUPPORTED_OPERATION` 오류가 있어야 합니다.
 -  클라이언트는 `unknown`을 지원됨으로 취급해서는 안 됩니다.

허용 입력, 미디어 개수와 크기, MIME 타입 또는 소프트웨어 버전
범위에는 constraint를 사용하십시오. 문서화되지 않은 일부 입력만
받으면서 넓은 작업 전체를 지원한다고 표시하지 마십시오.


오류 매핑
---------

가장 구체적인 이식 가능 코드로 `ActivityPlugError`를 던지십시오.

 -  잘못된 호출자 입력에는 `VALIDATION_FAILED`
 -  자격 증명 상태에는 `AUTH_REQUIRED` 또는 `AUTH_EXPIRED`
 -  사용할 수 없는 이식 가능 동작에는 `UNSUPPORTED_OPERATION`
 -  해당 원격 응답에는 `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`
 -  예상 프로토콜을 위반한 응답에는 `REMOTE_PROTOCOL_ERROR`
 -  그 밖의 유효한 원격 실패에는 `REMOTE_ERROR`
 -  런타임이 아직 분류하지 않은 전송 실패에는 `NETWORK_ERROR`
    또는 `TIMEOUT`

가능하면 어댑터, origin, 작업, capability를 context에 포함하십시오.
유용한 경우 원본 오류를 `cause`로 보존하되, `message`,
`context.raw`, 로그에 토큰이나 원격 비밀을 노출하지 마십시오.


검증된 팩토리가 있을 때만 스트리밍 추가
---------------------------------------

스트리밍 작업 메서드는 `AsyncIterable<StreamEvent>`를
반환합니다. 전역 WebSocket을 읽는 대신 어댑터 옵션을 통해
`WebSocketFactory`를 받으십시오. 신뢰할 수 있는 작업과 선택적
인증 값을 팩토리에 전달합니다.

비동기 팩토리 생성, 대기 이벤트 수, 대기 바이트, 소켓 종료를
제한하려면 코어 도우미를 사용하십시오. 모든 메시지를 매핑하기
전에 검증하십시오. 원격 스트리밍 엔드포인트의 origin이 다르면,
인증을 전달하기 전에 일치하는 자격 증명 grant를 요구하십시오.


테스트 요구 사항
----------------

상호 운용성을 확립하는 어댑터 동작을 테스트하십시오.

 -  필수 필드 검증과 대표적인 엔티티 매핑
 -  클라이언트를 통한 불투명 ID와 정확한 원격 커서 처리
 -  capability 여부에 따른 작업과 명시적으로 지원되지 않는 작업
 -  인증 전략 동작과 자격 증명 배치
 -  원격 HTTP 오류 매핑과 보안 경계 오류 보존
 -  페이지네이션 방향과 연속 의미
 -  capability를 바꾸는 소프트웨어 또는 버전 결정
 -  스트리밍을 구현했다면 인증, 이벤트 매핑, 취소, 제한

대상 API 계약에 초점을 맞춘 fixture를 사용하십시오. `ky`, GraphQL
클라이언트, WebSocket 구현, Zod 또는 다른 의존성 자체를 테스트하지
마십시오. 대표적인 매핑 사례 하나와 잘못된 사례 하나로 계약을
보호할 수 있다면, 모든 선택적 응답 필드를 각각 테스트하지
마십시오.

어댑터를 배포하기 전에 패키지 테스트와 저장소의 타입, 포맷, 린트,
테스트 검사를 실행하십시오.


Mastodon 호환 어댑터
--------------------

대상이 Mastodon 호환 엔드포인트를 구현한다면
`@activityplug/mastodon-base`를 사용하십시오. 갱신 토큰, 로컬
공개 범위, 인용 매개변수, 스트리밍 인증, 감지된 capability처럼
확인된 차이만 설정하십시오. 제품의 응답이나 의미가 기본 매핑과
다르면 작업 그룹을 재정의하십시오.

한 어댑터에만 해당하는 동작을 위해 공유 기본 구현에 제품 분기를
추가하지 마십시오. 기존 Mastodon, Pleroma/Akkoma, Hollo
어댑터에서 기본 설정과 대상별 재정의 예제를 확인할 수 있습니다.


관련 문서
---------

 -  [핵심 개념](concepts.ko.md)
 -  [아키텍처](architecture.ko.md)
 -  [어댑터와 capability](adapters-and-capabilities.ko.md)
 -  [인증과 세션](authentication-and-sessions.ko.md)
 -  [테스트](testing.ko.md)
