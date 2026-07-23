어댑터와 capability
===================

[English](adapters-and-capabilities.md) | 한국어 |
[日本語](adapters-and-capabilities.ja.md)

ActivityPlug 어댑터는 특정 서버 계열의 API를 공통 클라이언트 계약으로
변환합니다. 이 계약이 모든 서버가 모든 작업을 구현한다는 뜻은 아닙니다.
Capability 판정은 선택한 어댑터·인스턴스에서 애플리케이션이 의존할 수
있는 동작을 나타냅니다.


지원 서버 소프트웨어
--------------------

| 어댑터 패키지              | 어댑터 ID    | 감지 소프트웨어 | API 계열             |
| -------------------------- | ------------ | --------------- | -------------------- |
| `@activityplug/mastodon`   | `mastodon`   | Mastodon        | Mastodon             |
| `@activityplug/pleroma`    | `pleroma`    | Pleroma, Akkoma | 확장된 Mastodon 호환 |
| `@activityplug/misskey`    | `misskey`    | Misskey         | Misskey              |
| `@activityplug/hackerspub` | `hackerspub` | HackersPub      | GraphQL과 HTTP       |
| `@activityplug/hollo`      | `hollo`      | Hollo           | 확장된 Mastodon 호환 |

`@activityplug/mastodon-base`는 Mastodon 호환 어댑터 작성자를 위한
구현 패키지입니다. 호출자가 어댑터 identity, 지원 소프트웨어 이름,
계열별 동작을 제공하므로, 범용 자동 소프트웨어 감지용으로 쓰기에는
적합하지 않습니다.

요청에서 어댑터를 지정하지 않으면 ActivityPlug 서버는 등록된 어댑터를
순서대로 시험합니다. 감지된 소프트웨어 identity가 어댑터 메타데이터의
ID, kind, `supportedSoftware` 중 하나와 일치할 때 프로필을
받아들입니다. 어댑터 ID를 지정하면 해당 어댑터를 바로 선택하고, 계열
이름 일치 검사 없이 인스턴스 discovery를 실행합니다. discovery는
형식이 잘못되었거나 호환되지 않는 응답을 여전히 거부할 수 있습니다.


Capability 판정
---------------

`CapabilityName`의 모든 이름은 `CapabilityDecision`으로 판정됩니다.

~~~~ ts
interface CapabilityDecision {
  readonly name: CapabilityName;
  readonly status: "supported" | "unsupported" | "unknown";
  readonly source: "static" | "nodeinfo" | "oauth" | "instance" | "probe";
  readonly reason?: string;
  readonly constraints?: CapabilityConstraints;
  readonly raw?: unknown;
}
~~~~

세 status의 의미는 서로 다릅니다.

 -  `supported`: 선택한 어댑터와 확인된 근거가 작업을 허용합니다.
 -  `unsupported`: 어댑터가 작업을 제공하지 않는 명시적인 이유가
    있습니다.
 -  `unknown`: 소프트웨어 identity나 안정적인 버전을 알 수 없어,
    어댑터가 지원 여부를 입증할 수 없는 경우가 대부분입니다.

선택 기능은 `supported`일 때만 노출하십시오. `unknown`은 낙관적인
지원을 뜻하지 않습니다.

~~~~ ts
const profile = await client.instances.detect();
const decision = profile.capabilities["posts.update"];

switch (decision.status) {
  case "supported":
    // Offer editing.
    break;
  case "unsupported":
    console.log(decision.reason);
    break;
  case "unknown":
    // Hide or disable editing until support can be established.
    break;
}
~~~~

`constraints`는 지원되는 작업의 범위를 좁힐 수 있습니다. 게시물
생성은 허용 입력 형태를 기록하고, 미디어 capability는 바이트,
항목 수, MIME type 한도를 선언할 수 있습니다. 서버가 표현할 수 없는
입력을 만들기 전에 제약을 확인하십시오.


정적 계층과 감지 계층
---------------------

어댑터 메타데이터에는 완전한 정적 capability 집합이 있습니다. 빠진
항목은 `unknown`이 됩니다. ActivityPlug는 이후 NodeInfo, OAuth
메타데이터, 인스턴스 문서, 명시적 프로브에서 얻은 근거를 병합할 수
있습니다.

소스 계층의 순서는 다음과 같습니다.

~~~~ text
static < nodeinfo < oauth < instance < probe
~~~~

`unknown`이 아닌 판정은 이전 `unknown` 판정을 대체합니다. `unknown`
판정은 기존 `supported`·`unsupported` 결과를 지우지 않습니다. 확실성이
같으면 순위가 높은 소스가 우선합니다.

감지한 계열·버전에 따라 달라지는 Mastodon 호환 동작의 예는 다음과
같습니다.

 -  Mastodon 게시물 수정에는 3.5.0 이상이 필요합니다.
 -  Mastodon 비동기 미디어 업로드에는 3.1.3 이상이 필요합니다.
 -  Mastodon 미디어 삭제에는 4.4.0 이상이 필요합니다.
 -  Mastodon filter v2 엔드포인트에는 4.0.0 이상이 필요합니다.
 -  Pleroma·Akkoma에는 Mastodon 버전 기준 대신 계열별 판정을
    적용합니다.
 -  Hollo relationship 조회에는 감지된 0.1.0 이상 버전이 필요합니다.
 -  스트리밍 판정에는 주입된 팩터리, 발견한 엔드포인트, 계열, 버전,
    transport 보안이 반영됩니다.

감지가 반환하는 인스턴스 프로필에는 병합된 집합이 있습니다. 감지 후
두 번째 직접 클라이언트를 만들 때는 `profile.capabilities`와
`profile.software`를 모두 전달하십시오. ActivityPlug 서버는 이 전달을
자동으로 수행합니다.


기능 비교
---------

다음 표는 어댑터별 동작 범위를 요약합니다. `예`는 해당 기능군을
매핑한다는 뜻이며, 그 안의 모든 작업이 조건 없이 지원된다는 뜻은
아닙니다. 작업·버전별 판정은 유효 capability 집합을 확인하십시오.

| 기능군                    | Mastodon         | Pleroma/Akkoma   | Misskey        | HackersPub  | Hollo  |
| ------------------------- | ---------------- | ---------------- | -------------- | ----------- | ------ |
| OAuth authorization code  | 예               | 예               | 예             | 아니요      | 예     |
| Token 가져오기            | 예               | 예               | 예             | 예          | 예     |
| Email challenge / passkey | 아니요           | 아니요           | 아니요         | 둘 다       | 아니요 |
| Home 및 public 타임라인   | 예               | 예               | 예             | 예          | 예     |
| List 및 list 타임라인     | 예               | 예               | 예             | 아니요      | 예     |
| Follow request            | 예               | 예               | 예             | 아니요      | 예     |
| 게시물 수정               | 버전에 따라 결정 | 계열에 따라 결정 | 아니요         | 아니요      | 예     |
| Quote 생성                | 아니요           | 예               | 예             | 예          | 예     |
| Emoji reaction            | 아니요           | 예               | 예             | 예          | 예     |
| 미디어 업로드             | 버전에 따라 결정 | 예               | 예             | 부분 흐름만 | 예     |
| URL 미디어 가져오기       | 아니요           | 아니요           | WebSocket 사용 | 예          | 아니요 |
| 타임라인 / 알림 스트림    | 감지 결과        | 감지 결과        | 주입한 팩터리  | 아니요      | 아니요 |
| Filter                    | 버전에 따라 결정 | 예               | 아니요         | 아니요      | 아니요 |
| 예약 게시물               | 예               | 예               | 아니요         | 아니요      | 아니요 |

HackersPub 미디어 업로드가 부분 흐름으로 표시된 이유는 다음과
같습니다. GraphQL upload mutation은 이미지를 저장할 수 있지만, 매핑된
`createNote` mutation은 그 이미지를 첨부할 수 없습니다. 따라서 이식
가능한 `media.upload` capability는 `unsupported`이고, URL 가져오기는
별도 작업으로 제공됩니다.


작업 강제
---------

코어 클라이언트는 어댑터를 호출하기 전에 공개 작업에 연결된 capability를
검사합니다. 판정이 `supported`가 아니면 `UNSUPPORTED_OPERATION` 코드의
`ActivityPlugError`를 던집니다. 오류 context에는 작업과, 해당하는 경우
capability 이름이 포함됩니다.

어댑터는 단일 capability로 표현할 수 없는 입력 의존 조건도 검증합니다.

 -  Mastodon 호환 API에서 poll과 media를 함께 넣은 게시물 거부
 -  HackersPub 게시물 생성에서 content warning 또는 media attachment
    거부
 -  인증 WebSocket에서 신뢰할 수 있는 Misskey 버전 감지 요구
 -  원격 API에 신뢰할 수 있는 커서가 없을 때 검색 커서 거부

이 실패는 `null`, 빈 collection, 조용히 바뀐 입력이 아니라 타입이
지정된 오류로 나타납니다.


어댑터 선택
-----------

지원하려는 소프트웨어 계열의 구체 패키지를 사용하십시오. 여러 인스턴스를
다루는 서비스는 필요한 어댑터를 모두 등록하고 신뢰할 수 있는 감지가
선택하도록 합니다. 어댑터 자체의 인스턴스 감지를 실행하지 않은 채
신뢰할 수 없는 소프트웨어 이름 문자열로 어댑터를 고르지 마십시오.

선택적 UI·API 동작에는 다음 순서를 적용합니다.

1.  선택한 origin의 유효 capability 집합을 얻습니다.
2.  `status === "supported"`인지 확인합니다.
3.  선언된 제약을 적용합니다.
4.  Discovery가 확인한 근거와 실제 원격 인스턴스가 다를 수 있으므로
    `UNSUPPORTED_OPERATION`을 처리합니다.

Transport에 민감한 capability는
[스트리밍과 미디어](streaming-and-media.ko.md)를, 오류 모델은
[오류와 문제 해결](errors-and-troubleshooting.ko.md)을 참고하십시오.
