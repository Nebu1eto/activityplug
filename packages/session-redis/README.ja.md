@activityplug/session-Redis
===========================

[English](README.md) | [한국어](README.ko.md) | 日本語

ActivityPlug サーバーモード向けの Redis
認証セッションおよびライフサイクルストレージです。


インストール
------------

~~~~ sh
pnpm add @activityplug/session-redis
~~~~

Node.js 26 以降が必要です。このパッケージは ECMAScript モジュールを使用します。


使用方法
--------

~~~~ ts
import * as activityplug from "@activityplug/session-redis";
~~~~

パッケージルートは、サポートされる公開 API を公開します。このリリースで
利用可能な正確な契約については、エクスポートされた型を参照してください。


ライセンス
----------

Apache-2.0 OR MIT の条件でライセンスされます。`LICENSE-APACHE` と
`LICENSE-MIT` を参照してください。
