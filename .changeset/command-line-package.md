---
"@activityplug/cli": major
"@activityplug/server": major
---

Move the `activityplug-server` command into `@activityplug/cli`, which declares
its runtime packages as dependencies so `npx` and `pnpm dlx` both run it.
`@activityplug/server` no longer ships an executable.
