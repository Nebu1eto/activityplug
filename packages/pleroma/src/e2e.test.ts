import {
  fediverseE2EEnabled,
  expectReadBaseline,
  targetsForAdapter,
} from "@activityplug/e2e-fixtures";
import { describe, it } from "vitest";

import { createPleromaAdapter } from "./index.js";

const targets = targetsForAdapter("pleroma");

describe.skipIf(!fediverseE2EEnabled || targets.length === 0)("Pleroma Docker E2E", () => {
  it.each(targets)("reads $origin", async (target) => {
    await expectReadBaseline(target, createPleromaAdapter());
  });
});
