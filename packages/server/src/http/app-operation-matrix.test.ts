import { publicOperations } from "@activityplug/core";
import { describe, expect, it } from "vitest";

import { publicOperationMatrix, reservedOperationMatrix } from "./app-operation-matrix.js";

describe("application operation matrix metadata", () => {
  it("links every current server row to the authoritative core registry", () => {
    const operationNames = new Set(publicOperations.map(({ name }) => name));

    for (const row of [...publicOperationMatrix, ...reservedOperationMatrix]) {
      expect(operationNames.has(row.operation), `${row.graphqlType} ${row.graphqlField}`).toBe(
        true,
      );
    }
  });
});
