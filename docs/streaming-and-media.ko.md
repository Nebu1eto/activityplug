스트리밍과 미디어
=================

[English](streaming-and-media.md) | 한국어 |
[日本語](streaming-and-media.ja.md)

ActivityPlug는 타임라인과 알림 WebSocket을 비동기 event stream으로
정규화합니다. 로컬 파일 업로드와 서버 측 URL 가져오기는 지원 범위와
보안 속성이 다르므로 별도 작업으로 제공합니다.


스트리밍 지원
-------------

| 어댑터         | 타임라인                                    | 알림                                | Conversation  |
| -------------- | ------------------------------------------- | ----------------------------------- | ------------- |
| Mastodon       | 감지된 지원                                 | 감지된 지원                         | 지원하지 않음 |
| Pleroma/Akkoma | 감지된 지원                                 | 감지된 지원                         | 지원하지 않음 |
| Misskey        | 주입한 팩토리, 인증 시 Misskey 13.14.0 이상 | 주입한 팩토리, Misskey 13.14.0 이상 | 지원하지 않음 |
| HackersPub     | 지원하지 않음                               | 지원하지 않음                       | 지원하지 않음 |
| Hollo          | 지원하지 않음                               | 지원하지 않음                       | 지원하지 않음 |

Mastodon 호환 감지는 주입된 팩토리, 알려진 스트리밍 endpoint,
소프트웨어 계열, 버전, endpoint 암호화 여부를 확인합니다. Misskey는
팩토리가 있으면 타임라인과 알림 스트리밍을 지원하는 것으로 보고하고,
credential 사용 시 신뢰할 수 있는 버전 검사를 적용합니다.


WebSocket 팩토리
----------------

어댑터는 전역 WebSocket을 직접 만들지 않습니다. Host가
`WebSocketFactory`를 주입합니다.

~~~~ ts
type WebSocketFactory = (
  url: string,
  protocols?: string | string[],
  signal?: AbortSignal,
  options?: {
    readonly operation: string;
    readonly authorization?: string;
  },
) => WebSocket | Promise<WebSocket>;
~~~~

팩토리는 보안 경계이며, 다음을 수행해야 합니다.

 -  배포 환경의 origin allowlist 적용
 -  연결 전에 허용된 공개 address를 resolve하고 pin
 -  전달된 abort signal 보존
 -  runtime에 적합한 connection 및 frame 한도 적용
 -  값이 있으면 `options.authorization`을 WebSocket HTTP
    `Authorization` 헤더에 설정
 -  credential을 노출할 수 있는 URL, protocol, authorization 값,
    오류를 log에 남기지 않음

브라우저 표준 `WebSocket` constructor는 임의의 `Authorization` 헤더를
설정할 수 없습니다. token을 URL에 넣어 헤더를 대체하지 마십시오.
handshake header를 지원하는 서버 측 WebSocket 구현을 사용하거나, 인증
스트리밍을 제공하지 마십시오.

`options.operation`은 `stream.timeline`, `stream.notifications`,
Misskey URL 가져오기의 `media.ingestUrl` 같은 공개 작업 이름입니다.
검증된 팩토리는 이 값으로 정책을 적용할 수 있습니다.


Credential 표현
---------------

ActivityPlug는 스트리밍 credential을 query parameter나 URL userinfo에
넣지 않습니다. credential처럼 보이는 parameter가 포함된 알려진
스트리밍 URL은 거부합니다.

표현 방식은 어댑터에 따라 다릅니다.

| 어댑터               | Credential 표현         |
| -------------------- | ----------------------- |
| Mastodon             | `authorization-header`  |
| Pleroma 2.7.1 이상   | `websocket-subprotocol` |
| Akkoma               | `websocket-subprotocol` |
| Misskey 13.14.0 이상 | `authorization-header`  |

authorization-header mode에서는 어댑터가 완전한 `Bearer ...` 값을
`options.authorization`으로 전달합니다. subprotocol mode에서는 token을
WebSocket protocol 값으로 전달합니다. 팩토리는 요청된 표현을
보존해야 합니다.

인증된 socket은 `wss:`를 사용해야 합니다. 익명 타임라인 스트림은
허용된 plaintext endpoint를 사용할 수 있지만, host의 egress 정책은
계속 적용됩니다. 알림 스트림에는 항상 세션이 필요합니다.


알려진 endpoint와 origin grant
------------------------------

Mastodon 호환 인스턴스는 `configuration.urls.streaming` 또는 기존
`urls.streaming_api`로 스트리밍 endpoint를 알릴 수 있습니다.
어댑터는 해당 endpoint를 사용하고 경로를
`/api/v1/streaming/`으로 정규화합니다. 알려진 endpoint가 없으면
인스턴스 origin을 fallback으로 사용합니다.

스트리밍 endpoint는 HTTP API와 다른 origin일 수 있습니다. 해당
origin으로 credential을 보내려면 방향이 정확한
`RemoteCredentialGrant`가 필요합니다.

~~~~ ts
const credentialGrants = [
  {
    issuer: "https://social.example",
    recipient: "https://stream.example",
    operation: "stream.timeline",
    credentialClass: "oauth-access-token",
    representations: ["authorization-header"],
  },
] as const;
~~~~

grant에는 방향과 작업이 지정됩니다. 타임라인 grant는 알림, 반대
방향의 origin 쌍, 다른 credential class, 다른 표현을 허용하지
않습니다. Pleroma와 Akkoma에는 `authorization-header` 대신
`websocket-subprotocol`을 사용하십시오.

동일 origin의 인증 socket은 remote authority가 허용한 동일 origin
표현을 사용하며, cross-origin grant가 필요하지 않습니다. Misskey는
감지한 인스턴스 origin을 socket에 사용하므로, 현재 인증 스트림과
URL 가져오기 경로는 동일 origin입니다.


스트림 사용
-----------

스트림은 `AsyncIterable<StreamEvent>` 값입니다.

~~~~ ts
const stream = await client.streams.timeline({
  type: "home",
  session,
  signal: abortController.signal,
});

for await (const event of stream) {
  if (event.type === "timeline.update") {
    console.log(event.post);
  }
  if (event.type === "delete") {
    console.log(event.deleted.ref);
  }
}
~~~~

타임라인 kind는 `home`, `public`, `local`, `hashtag`, `list`입니다.
인증 요구 사항은 서버와 버전에 따라 다릅니다. 선택한 타임라인이나
인스턴스가 요구하면 세션을 전달하십시오. 취소하면 iteration이
종료되고 socket이 안전하게 닫힙니다.

어댑터는 인식한 원격 event를 다음 값으로 정규화합니다.

 -  `timeline.update`
 -  `notification`
 -  `delete`
 -  `edit`
 -  `filters.changed`
 -  `heartbeat`

모든 어댑터가 모든 event type을 내보내지는 않습니다. 인식한 event의
형식이 잘못되면 typed protocol error로 실패하며, 알 수 없는 원격
event type은 무시합니다.


로컬 파일 미디어 업로드
-----------------------

`client.media.upload`는 호출자가 제공한 `Blob`을 전송합니다.

~~~~ ts
const attachment = await client.media.upload({
  session,
  file,
  filename: "photo.jpg",
  description: "A view across the harbor",
});
~~~~

지원 범위는 어댑터마다 다릅니다.

 -  Mastodon 업로드는 버전에 따라 결정됩니다. ActivityPlug는 가능한
    경우 비동기 미디어 endpoint를 사용합니다.
 -  Pleroma와 Akkoma는 미디어 업로드를 지원합니다.
 -  Misskey는 업로드, metadata 수정, 삭제를 지원합니다.
 -  Hollo는 업로드와 metadata 수정을 지원하지만 삭제는 지원하지
    않습니다.
 -  HackersPub의 `media.upload` capability는 매핑된 게시물 생성
    mutation이 업로드된 이미지를 첨부할 수 없어 지원되지 않습니다.

Mastodon 호환 업로드 경로는 `sensitive: true`를 거부합니다. 해당
metadata 수정 경로는 `false`를 포함해 `sensitive` 필드 자체가
존재하면 거부합니다. Misskey는 업로드와 metadata 수정 모두에서
sensitivity를 지원합니다.

업로드한 attachment는 자동으로 게시되지 않습니다. 지원되는 게시물
생성 작업에 opaque media ID를 전달하십시오. 입력을 결합하기 전에
게시물과 미디어 capability 제약을 확인하십시오.


URL 미디어 가져오기
-------------------

`client.media.ingestUrl`은 원격 서버에 URL 가져오기를 요청합니다.

~~~~ ts
const attachment = await client.media.ingestUrl({
  session,
  url: "https://media.example/photo.jpg",
  signal: abortController.signal,
});
~~~~

Misskey와 HackersPub만 이 작업을 구현합니다.

Misskey는 `drive/files/upload-from-url`을 시작하고 인증된 동일
origin WebSocket에서 완료 event를 기다립니다. 주입된 팩토리, 신뢰할
수 있게 감지한 Misskey 13.14.0 이상, `wss:`, authorization-header
지원이 필요합니다. description과 sensitivity 값을 함께 전달합니다.

HackersPub는 GraphQL URL-upload mutation을 호출합니다. WebSocket은
사용하지 않지만, 매핑된 mutation이 값을 저장할 수 없으므로
description과 sensitivity를 거부합니다.

Mastodon, Pleroma/Akkoma, Hollo는 매핑된 URL 가져오기 endpoint를
제공하지 않습니다. ActivityPlug는 리소스를 애플리케이션으로
내려받아 암묵적으로 다시 업로드하지 않습니다. 그렇게 하면 network
trust, resource limit, failure semantics가 바뀌기 때문입니다.


실패 처리
---------

스트리밍과 미디어 작업은 typed `ActivityPlugError` 코드를 사용합니다.
일반적인 경우는 다음과 같습니다.

 -  팩토리, 버전, endpoint, 원격 기능을 사용할 수 없을 때
    `UNSUPPORTED_OPERATION`
 -  세션이 없거나 만료됐을 때 `AUTH_REQUIRED` 또는 `AUTH_EXPIRED`
 -  허용하지 않은 credential 대상이나 표현, 또는 암호화하지 않은
    인증 socket에 `ORIGIN_NOT_ALLOWED`
 -  검증된 연결이 실패할 때 `NETWORK_ERROR`
 -  인식한 event 형식이 잘못됐을 때 `REMOTE_PROTOCOL_ERROR`
 -  한도가 있는 stream 또는 frame이 한도를 초과할 때
    `REQUEST_LIMIT_EXCEEDED`

어댑터, 인스턴스, 설정을 변경하지 않았다면 `UNSUPPORTED_OPERATION`을
재시도하지 마십시오. 재연결 정책은 애플리케이션이 담당합니다.
어댑터는 stream과 abort 동작을 노출하지만, 반복되는 연결 실패를
숨기지 않습니다.

capability 선택은
[어댑터와 capability](adapters-and-capabilities.ko.md)를, HTTP 및
WebSocket egress 정책은 [보안 모델](security-model.ko.md)을
참고하십시오.
