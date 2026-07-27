Activityplug에 기여하기
=======================

[English](CONTRIBUTING.md) | 한국어 | [日本語](CONTRIBUTING.ja.md)

ActivityPlug는 기여를 환영합니다. 이 가이드는 개발 환경, 코드 규칙, 제출
요건을 다룹니다.


AI 사용
-------

ActivityPlug에는 명시적인 AI 정책이 있습니다. 기여하기 전에
`AI_POLICY.md`를 읽으십시오. AI를 활용한 작업은 커밋 메시지에
`Assisted-by` trailer로 반드시 공개해야 합니다.


개발 환경
---------

저장소는 도구 버전 관리에 mise를 사용합니다.

~~~~ sh
mise install
~~~~

`.mise.toml`에 선언된 Node.js 26과 pnpm 11이 설치됩니다.
`eval "$(mise activate bash)"`로 환경을 활성화하거나 `mise exec`로
명령을 실행하십시오.

의존성 설치:

~~~~ sh
pnpm install
~~~~


검증
----

제출 전에 전체 로컬 검사를 실행하십시오.

~~~~ sh
pnpm typecheck
pnpm format:check
pnpm lint
pnpm test
~~~~

pre-commit hook이 lefthook을 통해 네 가지 검사를 모두 실행합니다. 검사가
실패하면 hook을 건너뛰지 말고 원인을 해결하십시오.


커밋 메시지
-----------

제목 형식: `[<package>] <type>: <summary>`.

저장소 전체에 걸친 변경에는 `[*]`를 사용합니다. 지원하는 type에는 `feat`,
`fix`, `refactor`, `test`, `docs`, `chore` 등이 있습니다. 제목과 본문의
각 bullet은 72자 이내로 작성하십시오.

~~~~ text
[mastodon] feat: add timeline hashtag filter

- Map the hashtag query parameter to the Mastodon v1 endpoint
- Report streaming.hashtag as supported when the factory is present

Assisted-by: Claude Code:claude-opus-4-6
Signed-off-by: Name <email>
~~~~


코드 스타일
-----------

 -  커밋 전에 `pnpm format`으로 포맷하십시오. 저장소는 TypeScript에
    oxfmt, Markdown에 hongdown을 사용합니다.
 -  변경은 해당 작업 범위 안에서만 하십시오. 관계없는 정리를 함께
    묶지 마십시오.
 -  기존 프로젝트 규칙을 따르십시오.
 -  지원하지 않는 동작을 모호한 null이나 불명확한 오류 뒤에 숨기지
    마십시오.


문서화
------

 -  모든 코드 주석과 문서는 영어로 작성합니다.
 -  루트 수준 가이드에는 한국어(`.ko.md`)와 일본어(`.ja.md`) 형제
    파일을 함께 둡니다. `docs/` 아래 문서는 언어별 디렉토리
    (`docs/en/`, `docs/ko/`, `docs/ja/`)로 구분합니다.
 -  패키지·예제 README는 영어로만 작성합니다.
 -  산문을 작성할 때는 자연스러운 문장 구조를 사용하고
    `effective-writing` 스킬을 따르십시오.


테스트
------

정확성 검증이 필요한 동작에 대해 테스트를 작성하십시오. API 계약, 어댑터
매핑, 인증, capability 탐지, ID 변환, 페이지네이션, 오류 처리, 상호 운용
가정이 이에 해당합니다. 사소한 로직, 구현 세부 사항, 외부 라이브러리
동작은 테스트하지 마십시오.


라이선스
--------

기여는 저장소 라이선스와 동일하게 Apache-2.0 OR MIT로 라이선스됩니다.
`LICENSE-APACHE`와 `LICENSE-MIT`를 참고하십시오.
