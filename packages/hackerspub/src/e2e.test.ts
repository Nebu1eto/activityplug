import {
  fediverseE2EEnabled,
  expectReadBaseline,
  targetsForAdapter,
} from "@activityplug/e2e-fixtures";
import { describe, it } from "vitest";

import { createHackersPubAdapter } from "./index.js";

const targets = targetsForAdapter("hackerspub");

describe.skipIf(!fediverseE2EEnabled || targets.length === 0)("HackersPub Docker E2E", () => {
  it.each(targets)("reads $origin", async (target) => {
    await expectReadBaseline(target, createHackersPubAdapter());
  });
});
