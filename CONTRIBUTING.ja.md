ActivityPlug への貢献
=====================

[English](CONTRIBUTING.md) | [한국어](CONTRIBUTING.ko.md) | 日本語

ActivityPlug はコントリビューションを歓迎します。このガイドでは開発環境、
コーディング規則、提出時の要件を説明します。


AI の利用
---------

ActivityPlug には明示的な AI ポリシがあります。貢献前に `AI_POLICY.md` を
読んでください。AI を利用した作業はコミットメッセージの `Assisted-by`
トレーラで開示する必要があります。


開発環境
--------

リポジトリはツールバージョン管理に mise を使います。

~~~~ sh
mise install
~~~~

`.mise.toml` に宣言された Node.js 26 と pnpm 11 がインストールされます。
`eval "$(mise activate bash)"` で環境を有効化するか、`mise exec` で
コマンドを実行してください。

依存関係をインストールします。

~~~~ sh
pnpm install
~~~~


検証
----

提出前にローカルチェックをすべて実行してください。

~~~~ sh
pnpm typecheck
pnpm format:check
pnpm lint
pnpm test
~~~~

pre-commit hook は lefthook を通じて 4 つのチェックを実行します。失敗した
場合は hook をスキップするのではなく、原因を修正してください。


コミットメッセージ
------------------

件名の形式は `[<package>] <type>: <summary>` です。

リポジトリ全体の変更には `[*]` を使います。type には `feat`、`fix`、
`refactor`、`test`、`docs`、`chore` などを指定します。件名と本文の各箇条
書きは 72 文字以内に収めてください。

~~~~ text
[mastodon] feat: add timeline hashtag filter

- Map the hashtag query parameter to the Mastodon v1 endpoint
- Report streaming.hashtag as supported when the factory is present

Assisted-by: Claude Code:claude-opus-4-6
Signed-off-by: Name <email>
~~~~


コードスタイル
--------------

 -  コミット前に `pnpm format` を実行してください。リポジトリでは
    TypeScript に oxfmt、Markdown に hongdown を使います。
 -  変更はタスクの範囲に限定してください。関連しない整理を含めないで
    ください。
 -  既存のプロジェクト規約に従ってください。
 -  サポートしていない動作を曖昧な null や不明確なエラーで隠さないで
    ください。


ドキュメント
------------

 -  コードコメントとドキュメントはすべて英語で記述します。
 -  ルートレベルのガイドと `docs/` 配下のドキュメントには韓国語
    (`.ko.md`) と日本語 (`.ja.md`) の兄弟ファイルを用意します。
 -  パッケージと example の README は英語のみです。
 -  自然な文体を用い、文章の作成時は `effective-writing` スキルに従って
    ください。


テスト
------

正しさの検証が必要な動作のテストを書いてください。対象は API 契約、
アダプタマッピング、認証、capability 検出、ID 変換、ページネーション、
エラー処理、相互運用性の前提です。自明なロジック、実装の詳細、外部
ライブラリの動作はテストしないでください。


ライセンス
----------

コントリビューションはリポジトリのライセンスに合わせ Apache-2.0 OR MIT
で提供されます。`LICENSE-APACHE` と `LICENSE-MIT` を参照してください。
