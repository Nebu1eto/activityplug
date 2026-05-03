import {
  fediverseE2EEnabled,
  expectReadBaseline,
  targetsForAdapter,
} from "@activityplug/e2e-fixtures";
import { describe, it } from "vitest";

import { createMisskeyAdapter } from "./index.js";

const targets = targetsForAdapter("misskey");

describe.skipIf(!fediverseE2EEnabled || targets.length === 0)("Misskey Docker E2E", () => {
  it.each(targets)(
    "reads $origin",
    async (target) => {
      await expectReadBaseline(target, createMisskeyAdapter());
    },
    60_000,
  );
});
