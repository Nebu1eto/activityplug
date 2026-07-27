오류 및 문제 해결
=================

[English](../en/errors-and-troubleshooting.md) | 한국어 |
[日本語](../ja/errors-and-troubleshooting.md)

ActivityPlug는 typed 오류 계약으로 `ActivityPlugError`를 사용합니다.
동일한 코드가 프로세스 내 서비스, 공개 HTTP API, GraphQL API를
관통합니다. 브라우저 경계는 이를 더 좁은 제품 지향 코드 집합으로
매핑합니다.


Typescript에서 오류 처리
------------------------

코드나 컨텍스트를 읽기 전에 `isActivityPlugError()`로 확인하십시오.

~~~~ ts
import { isActivityPlugError } from "@activityplug/core";

try {
  await client.posts.get({ id });
} catch (error) {
  if (!isActivityPlugError(error)) throw error;

  if (error.code === "UNSUPPORTED_OPERATION") {
    disableUnsupportedAction(error.context.capability);
    return;
  }

  reportActivityPlugFailure(error.code, error.context);
}
~~~~

`context`에는 `adapter`, `origin`, `operation`, `capability`, 내부
`raw` 값이 포함될 수 있습니다. 공개 전송에서는 `raw`를 생략합니다.


오류 코드
---------

| 코드                     | 의미                                              | 일반적인 조치                                        |
| ------------------------ | ------------------------------------------------- | ---------------------------------------------------- |
| `ADAPTER_NOT_FOUND`      | 구성된 어댑터가 요청과 일치하지 않음              | 어댑터 ID와 서버 어댑터 목록 확인                    |
| `AUTH_REQUIRED`          | 작업에 인증이 필요함                              | 인증하거나 브라우저 세션 갱신                        |
| `AUTH_EXPIRED`           | 저장된 또는 원격 자격 증명이 만료됨               | 다시 인증하고 동일한 자격 증명으로 재시도하지 않음   |
| `AUTH_UNSUPPORTED`       | 어댑터가 요청된 인증 전략을 지원하지 않음         | 기능이 지원하는 전략 선택                            |
| `CAPABILITY_UNKNOWN`     | 지원 여부를 안전하게 판단할 수 없음               | 작업을 피하거나 시도 전에 사용자에게 확인            |
| `UNSUPPORTED_OPERATION`  | 어댑터가 해당 작업을 구현하지 않음을 명시함       | 작업을 비활성화하고 기능 사유 사용                   |
| `VALIDATION_FAILED`      | 입력, ID, origin 또는 구성 값이 잘못됨            | 요청을 수정하고 동일한 입력으로 재시도하지 않음      |
| `NOT_FOUND`              | 요청한 원격 또는 로컬 엔티티가 없음               | 오래된 참조를 제거하거나 포함 리소스 갱신            |
| `CONFLICT`               | 현재 원격 또는 로컬 상태가 변경을 막음            | 재시도 여부를 결정하기 전에 상태 갱신                |
| `RATE_LIMITED`           | 로컬 또는 원격 속도 제한이 요청을 거부함          | 있으면 `Retry-After` 준수                            |
| `REMOTE_PROTOCOL_ERROR`  | upstream 응답이 예상 프로토콜을 위반함            | 어댑터, origin, 작업을 기록하고 upstream 호환성 확인 |
| `REMOTE_ERROR`           | upstream 서버가 다른 실패를 반환함                | upstream 상태와 로그를 확인하고 안전할 때만 재시도   |
| `NETWORK_ERROR`          | 원격 연결 실패                                    | DNS, TLS, 라우팅, origin 정책 확인                   |
| `TIMEOUT`                | 구성된 요청 기한 만료                             | upstream 지연 시간과 요청 예산 확인                  |
| `ORIGIN_NOT_ALLOWED`     | origin 정책이 원격 origin을 거부함                | 의도한 정확한 origin을 추가하거나 요청 수정          |
| `REQUEST_LIMIT_EXCEEDED` | 요청, 응답, 업로드 또는 스트림이 한도를 초과함    | 페이로드를 줄이거나 의도적인 배포 제한 조정          |
| `INTERNAL_ERROR`         | 서버가 더 안전하고 구체적인 오류를 노출할 수 없음 | 서버 로그를 연결하고 실패한 작업 보존                |

`CAPABILITY_UNKNOWN`과 `UNSUPPORTED_OPERATION`은 다릅니다.
`CAPABILITY_UNKNOWN`은 어댑터가 지원 여부를 확정할 수 없다는 뜻이고,
`UNSUPPORTED_OPERATION`은 작업을 사용할 수 없다고 확정한 것입니다.


공개 HTTP 매핑
--------------

공개 HTTP 오류는 다음 형식을 사용합니다.

~~~~ json
{
  "error": {
    "code": "ORIGIN_NOT_ALLOWED",
    "message": "Remote origin is not allowed by this server.",
    "origin": "https://social.example",
    "operation": "instance.detect"
  }
}
~~~~

선택적 공개 컨텍스트 필드는 `adapter`, `origin`, `operation`,
`capability`입니다.

| HTTP 상태 | ActivityPlug 코드                                                                      |
| --------- | -------------------------------------------------------------------------------------- |
| `400`     | `AUTH_UNSUPPORTED`, `CAPABILITY_UNKNOWN`, `UNSUPPORTED_OPERATION`, `VALIDATION_FAILED` |
| `401`     | `AUTH_REQUIRED`, `AUTH_EXPIRED`                                                        |
| `403`     | `ORIGIN_NOT_ALLOWED`                                                                   |
| `404`     | `ADAPTER_NOT_FOUND`, `NOT_FOUND`                                                       |
| `409`     | `CONFLICT`                                                                             |
| `413`     | `REQUEST_LIMIT_EXCEEDED`                                                               |
| `429`     | `RATE_LIMITED`                                                                         |
| `502`     | `REMOTE_PROTOCOL_ERROR`, `REMOTE_ERROR`, `NETWORK_ERROR`                               |
| `504`     | `TIMEOUT`                                                                              |
| `500`     | `INTERNAL_ERROR` 및 분류되지 않은 서버 실패                                            |

속도 제한 오류에 양수 `retryAfterSeconds` 값이 있으면 응답에
`Retry-After`가 포함됩니다.


GraphQL 매핑
------------

GraphQL 구문, 본문 형태, 검증 실패는 일반 GraphQL 오류와 함께
HTTP 400을 반환합니다. 요청을 읽거나 분석하는 동안
`ActivityPlugError`가 발생하면 HTTP 상태는 위 표를 따르고, 세부
정보는 `extensions.activityplug` 아래에 나타납니다.

~~~~ json
{
  "errors": [
    {
      "message": "Remote origin is not allowed by this server.",
      "extensions": {
        "activityplug": {
          "code": "ORIGIN_NOT_ALLOWED",
          "origin": "https://social.example",
          "operation": "instance.detect"
        }
      }
    }
  ]
}
~~~~

GraphQL 실행 중 발생한 오류는 성공한 GraphQL HTTP 응답 안의 실행
오류로 유지됩니다. HTTP 상태가 200이어도 클라이언트는 `errors`
배열을 검사해야 합니다. ActivityPlug 전용 제어 흐름에는
`extensions.activityplug.code`를 사용하십시오.

서버는 쿼리 변수 또는 요청 본문의 GraphQL 세션 ID를 거부합니다.
세션은 `Authorization: Bearer <session-id>`로 전송하십시오.


브라우저 매핑
-------------

브라우저 경계는 전체 내부 코드 집합을 노출하지 않습니다.

| 브라우저 코드      | HTTP 상태 | 원인                                                           |
| ------------------ | --------- | -------------------------------------------------------------- |
| `BAD_REQUEST`      | `400`     | 잘못된 브라우저 입력, 요청 제한 또는 잘못 구성된 경계 요청     |
| `UNAUTHENTICATED`  | `401`     | 없거나 만료되었거나 유효하지 않은 브라우저 또는 인증 세션      |
| `FORBIDDEN`        | `403`     | CSRF, 교차 origin 또는 원격 origin 거부                        |
| `NOT_FOUND`        | `404`     | 없는 라우트, 어댑터 또는 엔티티                                |
| `CONFLICT`         | `409`     | 세션 또는 원격 상태 충돌                                       |
| `UNSUPPORTED`      | `422`     | 지원되지 않는 인증, 알 수 없는 기능 또는 지원되지 않는 작업    |
| `RATE_LIMITED`     | `429`     | 인증 시작 또는 upstream 속도 제한                              |
| `UPSTREAM_FAILURE` | `502`     | 원격 프로토콜, 원격, 네트워크, 시간 초과 또는 예기치 않은 실패 |

모든 브라우저 오류에는 `code`, `message`, 생성된 `requestId`가
있습니다. 속도 제한 오류에는 `retryAfterSeconds`와 `Retry-After`
헤더도 포함될 수 있습니다. 사용자에게 보이는 실패와 로그를
연결하려면 `requestId`를 사용하십시오.

중단된 브라우저 요청은 빈 본문과 상태 499를 반환합니다. upstream
오류가 아니라 클라이언트 취소로 처리하십시오.


서버가 인스턴스에 접속하지 않음
-------------------------------

### `ORIGIN_NOT_ALLOWED`

`createActivityPlugServer()`는 `originPolicy`가 없으면 모든 원격
origin을 거부합니다. 정확한 허용 목록을 구성하십시오.

~~~~ ts
import {
  createActivityPlugServer,
  createOriginPolicy,
} from "@activityplug/server";

const activityPlug = createActivityPlugServer({
  adapters,
  originPolicy: createOriginPolicy([
    "https://social.example",
    "https://community.example",
  ]),
});
~~~~

CLI 사용자는 `--allow-origin`을 반복 지정해야 합니다. CLI 허용
목록의 origin은 HTTPS를 사용해야 하며, 경로나 자격 증명을 포함할
수 없습니다.

### 비공개 또는 루프백 주소가 거부됨

허용된 origin도 차단된 주소로 해석될 수 있습니다. 배포가 비공개
네트워크에 접속하도록 의도된 경우에만
`allowPrivateNetworks: true` 또는 `--allow-private-networks`를
사용하십시오. 명시적인 origin 정책을 유지하십시오. 주소 허용이
이를 대체하지는 않습니다.

### HTTP는 작동하지만 스트리밍이 실패함

Mastodon 호환 및 Misskey 어댑터의 스트리밍에는 WebSocket 팩토리
주입이 필요합니다. HTTP와 동일한 origin 정책 및 조회 규칙으로
`createNodePinnedWebSocketFactory()`를 사용하십시오. 선택한
어댑터가 요청한 스트리밍 기능을 지원한다고 보고하는지도
확인하십시오.


인증 실패
---------

### Bearer 자격 증명이 거부됨

공개 HTTP 및 GraphQL은 `Authorization` 헤더의 ActivityPlug
세션 ID만 허용합니다. URL과 요청 본문에서 `sessionId`를
제거하십시오.

브라우저 라우트는 반대로 `Authorization`을 거부하고
`__Host-activityplug` 쿠키를 사용합니다.
`GET /v1/browser/session`으로 부트스트랩하십시오.

### 토큰 가져오기가 오류를 반환함

토큰 가져오기는 기본적으로 비활성화되어 있습니다. 애플리케이션에
명시적인 가져오기 흐름이 있을 때만 `tokenImport.enabled: true`를
설정하십시오. `guard`가 구성되어 있으면 요청이 해당 가드도
충족해야 합니다.

### 영속 OAuth 콜백을 완료할 수 없음

영속 인증 세션 저장소에는 호환되는 영속 `oauthClientSecrets`
저장소가 필요합니다. 둘 다 `@activityplug/session-postgres`에서
구성하십시오. 영속 세션을 기본 인메모리 비밀 저장소와 함께
사용하지 마십시오.

### 브라우저 CSRF 실패

`GET /v1/browser/session`을 가져오고 반환된 CSRF 토큰을 메모리에
보관한 뒤, 안전하지 않은 요청에서 구성된 CSRF 헤더로
전송하십시오. 쿠키와 토큰이 같은 브라우저 세션을 가리키도록
`credentials: "same-origin"`을 포함하십시오.

401 이후에는 비공개 상태를 폐기하기 전에 세션을 다시
가져오십시오. 갱신 중 네트워크 실패가 로그아웃의 증거는
아닙니다. 가상의 익명 세션을 캐시하지 않고, 비공개 캐시 상태를
지운 뒤 갱신 실패를 표시하십시오.
[브라우저 통합](browser-integration.md#인증-복구)을
참고하십시오.

### OAuth 콜백이 인증 없이 앱으로 돌아옴

브라우저 콜백은 콜백 세부 정보를 노출하지 않고, 만료되었거나
사용되었거나 일치하지 않거나 잘못된 OAuth 상태를 의도적으로
`returnTo`로 리디렉션합니다. 다음을 확인하십시오.

 -  외부 리디렉션 후에도 브라우저 쿠키가 유지되었는지
 -  콜백 URL이 구성된 공개 origin을 사용하는지
 -  OAuth 상태 및 챌린지 저장소를 처리 복제본들이 공유하는지
 -  서버 시계 및 저장소 만료 동작이 올바른지
 -  원격 origin과 어댑터가 원래 시작 요청과 일치하는지

그런 다음 `GET /v1/browser/session`을 가져와 현재 상태를
확인하십시오.


브라우저 스트림 실패
--------------------

브라우저 스트림 티켓은 일회용이고, 하나의 브라우저 세션과 하나의
작업에 연결되며, 60초 후 만료됩니다. `/v1/browser/stream`을
열기 직전에 티켓을 요청하십시오.

사용된 티켓을 재시도하지 마십시오. 현재 쿠키와 CSRF 토큰으로 새
티켓을 요청하십시오. 티켓 생성과 스트림 사용이 서로 다른
복제본에 도달할 수 있다면 공유 `StreamTicketStore`를 사용하십시오.

브라우저 스트림은 서버 전송 이벤트를 사용합니다. 역방향 프록시
버퍼링을 비활성화하고, 예상 하트비트 간격보다 긴 유휴 시간
제한을 사용하십시오.


상태 확인이 503을 반환함
------------------------

`GET /health`는 구성된 `readiness` 콜백이 거짓을 반환하거나
거부할 때만 503을 반환합니다. 콜백이 검사하는 각 의존성을
확인하십시오. 기본 상태 구현은 데이터베이스나 Redis를 탐색하지
않습니다.

가능하면 의존성 검사를 짧게 유지하고 일반 요청 풀과
분리하십시오. 프로덕션 웹 클라이언트 예제는 별도로 제한된
PostgreSQL 및 Redis 준비 상태 클라이언트를 사용합니다.


제한으로 인해 요청 실패
-----------------------

`REQUEST_LIMIT_EXCEEDED`는 JSON, GraphQL 문서, 멀티파트 업로드,
원격 구조화 응답 또는 스트림 버퍼에 적용될 수 있습니다. 작업을
식별하고 페이로드를 `requestLimits` 및 `graphqlLimits`와
비교하십시오.

이 설정들은 서로 다른 계층을 다룹니다. `requestLimits`는 전송
크기와 스트림 버퍼링을, `graphqlLimits`는 GraphQL 문서 형태와
resolver 동시성을 다룹니다. `createBudgetScope`가 반환한
`BudgetScope`는 이와 별도로 작업별 원격 요청, 읽기, 바이트,
노드, 동시성, 기한을 제한합니다. 강제된 작업 예산을 소진해도
`REQUEST_LIMIT_EXCEEDED`가 발생할 수 있습니다.

요청이 정상인지 확인하기 전에 제한을 높이지 마십시오. 거부
계층과 로그에 기록된 사유를 예측할 수 있도록 프록시 제한을
ActivityPlug 제한에 맞추십시오.


종료가 멈추거나 리소스가 열린 채로 남음
---------------------------------------

주입된 데이터베이스 또는 Redis 클라이언트를 닫기 전에
`await activityPlug.close()`를 호출하십시오. 서버는 자체
리스너와 소유한 정리 수명주기를 닫지만, 주입된 클라이언트를
소유하지는 않습니다.

애플리케이션이 `startActivityPlugServer()`를 직접 사용하면
반환된 Node 서버를 소유하므로 직접 닫아야 합니다. 리스너와
ActivityPlug 보안 상태 수명주기를 하나의 객체로 조정하려면
`createActivityPlugServer()`를 사용하십시오.


관련 문서
---------

 -  [서버 사용법](server-usage.md)
 -  [브라우저 통합](browser-integration.md)
 -  [인증 및 세션](authentication-and-sessions.md)
 -  [세션 저장소](session-storage.md)
 -  [보안 모델](security-model.md)
