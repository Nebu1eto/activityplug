import { createActivityPlug } from "@activityplug/core";
import {
  fediverseE2EEnabled,
  expectReadBaseline,
  targetsForAdapter,
} from "@activityplug/e2e-fixtures";
import { describe, expect, it } from "vitest";

import { createHolloAdapter } from "./index.js";

const targets = targetsForAdapter("hollo");

describe.skipIf(!fediverseE2EEnabled || targets.length === 0)("Hollo Docker E2E", () => {
  it.each(targets)(
    "reads the seeded relationship from $origin",
    async (target) => {
      if (target.token === undefined || target.socialActionHandle === undefined) {
        throw new TypeError("Hollo relationship E2E requires a token and target account.");
      }
      const discoveryClient = createActivityPlug({
        adapter: createHolloAdapter(),
        origin: target.origin,
      });
      const instance = await discoveryClient.instances.getProfile();
      expect(instance.capabilities["accounts.relationships"].status).toBe("supported");

      const client = createActivityPlug({
        adapter: createHolloAdapter(),
        origin: target.origin,
        capabilities: instance.capabilities,
      });
      const session = await client.auth.injectToken({ accessToken: target.token });
      const account = await client.accounts.getByHandle({ handle: target.socialActionHandle });
      if (account === null) throw new TypeError("Hollo relationship target lookup failed.");

      await expect(
        client.social.relationship({ session, accountId: account.ref.id }),
      ).resolves.toMatchObject({
        account: { id: account.ref.id, rawId: account.ref.rawId },
        following: true,
        showingReblogs: true,
        notifying: false,
      });
    },
    60_000,
  );

  it.each(targets)(
    "reads $origin",
    async (target) => {
      await expectReadBaseline(target, createHolloAdapter());
    },
    60_000,
  );
});
