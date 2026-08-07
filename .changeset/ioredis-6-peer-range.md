---
"@activityplug/session-redis": patch
---

Require `ioredis` 6 as the peer dependency. Applications that install
`@activityplug/session-redis` must upgrade their own `ioredis` dependency
because the previous 5.x range is no longer accepted.
