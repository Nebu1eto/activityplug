import {
  fediverseE2EEnabled,
  expectReadBaseline,
  targetsForAdapter,
} from "@activityplug/e2e-fixtures";
import ky from "ky";
import { describe, it } from "vitest";

import { createHolloAdapter } from "./index.js";

const targets = targetsForAdapter("hollo");

describe.skipIf(!fediverseE2EEnabled || targets.length === 0)("Hollo Docker E2E", () => {
  it.each(targets)("reads $origin", async (target) => {
    await expectReadBaseline(
      target,
      createHolloAdapter(
        target.token === undefined
          ? {}
          : {
              httpClient: ky.create({
                prefix: target.origin,
                headers: { Authorization: `Bearer ${target.token}` },
                redirect: "manual",
              }),
            },
      ),
    );
  });
});
