import { type ActivityPlugAdapter } from "@activityplug/core";
import {
  type AdapterE2ETarget,
  fediverseE2EEnabled,
  targetsForAdapter,
} from "@activityplug/e2e-fixtures";
import { createHackersPubAdapter } from "@activityplug/hackerspub";
import { createHolloAdapter } from "@activityplug/hollo";
import { createMastodonAdapter } from "@activityplug/mastodon";
import { createMisskeyAdapter } from "@activityplug/misskey";
import { createPleromaAdapter } from "@activityplug/pleroma";
import { describe, it } from "vitest";

import { expectServerBaseline } from "./e2e-baseline.js";

const targets: { target: AdapterE2ETarget; adapter: ActivityPlugAdapter }[] = [
  ...targetsForAdapter("mastodon").map((target) => ({
    target,
    adapter: createMastodonAdapter(),
  })),
  ...targetsForAdapter("misskey").map((target) => ({
    target,
    adapter: createMisskeyAdapter(),
  })),
  ...targetsForAdapter("pleroma").map((target) => ({
    target,
    adapter: createPleromaAdapter(),
  })),
  ...targetsForAdapter("hollo").map((target) => ({
    target,
    adapter: createHolloAdapter(),
  })),
  ...targetsForAdapter("hackerspub").map((target) => ({
    target,
    adapter: createHackersPubAdapter(),
  })),
];

describe.runIf(fediverseE2EEnabled)("server Fediverse E2E APIs", () => {
  it.each(targets)(
    "serves HTTP and GraphQL read APIs for $target.adapter",
    async ({ target, adapter }) => {
      await expectServerBaseline(target, adapter);
    },
    180_000,
  );
});
