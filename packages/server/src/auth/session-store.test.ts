import { describe, it } from "vitest";

import { authSessionStoreContractCases } from "./session-store-contract.js";
import { InMemoryAuthSessionStore } from "./session-store.js";

describe("InMemoryAuthSessionStore", () => {
  for (const contractCase of authSessionStoreContractCases) {
    it(contractCase.name, async () => {
      await contractCase.run({
        createStore: () =>
          new InMemoryAuthSessionStore({
            now: () => new Date("2026-04-26T00:00:00.000Z"),
          }),
      });
    });
  }
});
