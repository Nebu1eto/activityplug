import { describe, expect, it } from "vitest";

import {
  type CapabilityName,
  capabilityNames,
  deprecatedCapabilityAliases,
  publicOperations,
} from "../index.js";

describe("public operation registry", () => {
  it("uses unique exact names with non-empty canonical capability lists", () => {
    const names = publicOperations.map(({ name }) => name);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["capabilities", "search", "viewer"]));
    for (const operation of publicOperations) {
      expect(operation.capabilities.length, operation.name).toBeGreaterThan(0);
      for (const capability of operation.capabilities) {
        expect(capabilityNames, `${operation.name}: ${capability}`).toContain(capability);
      }
    }
  });

  it("maps every canonical capability to at least one public operation", () => {
    for (const capability of capabilityNames) {
      expect(
        publicOperations.some((operation) =>
          (operation.capabilities as readonly CapabilityName[]).includes(capability),
        ),
        capability,
      ).toBe(true);
    }
  });

  it("uses one URL-ingestion operation and only a deprecated capability alias", () => {
    expect(publicOperations.filter(({ name }) => name === "media.ingestUrl")).toEqual([
      expect.objectContaining({ capabilities: ["media.urlIngestion"] }),
    ]);
    expect(publicOperations.some(({ name }) => (name as string) === "media.uploadFromUrl")).toBe(
      false,
    );
    expect(deprecatedCapabilityAliases["media.remoteUrlUpload"]).toBe("media.urlIngestion");
    expect(capabilityNames).not.toContain("media.remoteUrlUpload");
  });
});
