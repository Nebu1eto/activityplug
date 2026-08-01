---
layout: home

title: ActivityPlug
description: ActivityPub 소프트웨어를 위한 통합 API와 TypeScript 어댑터.

hero:
  name: ActivityPlug
  text: Fediverse를 위한 통합 API
  tagline: 서로 다른 ActivityPub 서버 API를 애플리케이션에 맞는 runtime과 배포 경계에서 사용하세요.
  image:
    src: /activityplug.svg
    alt: ActivityPlug
  actions:
    - theme: brand
      text: 시작하기
      link: /ko/getting-started
    - theme: alt
      text: API 문서
      link: /api/
    - theme: alt
      text: GitHub
      link: https://github.com/Nebu1eto/activityplug

features:
  - icon:
      src: /icons/lucide/package.svg
      alt: 패키지
    title: TypeScript 라이브러리로 사용
    details: 필요한 패키지만 추가하세요. Node.js, Bun, Deno, 브라우저, React Native, Expo에서 ActivityPlug를 사용할 수 있습니다.
    link: /ko/library-usage
  - icon:
      src: /icons/lucide/network.svg
      alt: 네트워크
    title: Gateway server로 실행
    details: JavaScript 생태계 밖의 client에서도 하나의 gateway를 GraphQL, HTTP, WebSocket API로 호출할 수 있습니다.
    link: /ko/server-usage
  - icon:
      src: /icons/lucide/blocks.svg
      alt: 확장 블록
    title: Adapter 추가
    details: 새 서버 API를 공통 인터페이스와 capability model에 매핑해 애플리케이션 코드를 바꾸지 않고 지원 대상을 확장할 수 있습니다.
    link: /ko/adapter-development
---

