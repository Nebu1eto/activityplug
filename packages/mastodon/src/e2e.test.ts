import {
  fediverseE2EEnabled,
  expectReadBaseline,
  targetsForAdapter,
} from "@activityplug/e2e-fixtures";
import { describe, it } from "vitest";

import { createMastodonAdapter } from "./index.js";

const targets = targetsForAdapter("mastodon");

describe.skipIf(!fediverseE2EEnabled || targets.length === 0)("Mastodon Docker E2E", () => {
  it.each(targets)("reads $origin", async (target) => {
    await expectReadBaseline(target, createMastodonAdapter());
  });
});
