import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createOpenApiDocument } from "./openapi.js";

interface LocatedSchema {
  readonly path: string;
  readonly schema: unknown;
}

const jsonRecordSchema = z.looseObject({});

function isRecord(value: unknown): value is Record<string, unknown> {
  return jsonRecordSchema.safeParse(value).success;
}

function findRawPropertySchemas(value: unknown, path: string): readonly LocatedSchema[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findRawPropertySchemas(entry, `${path}[${index}]`));
  }
  if (!isRecord(value)) return [];

  const matches: LocatedSchema[] = [];
  const properties = value["properties"];
  if (isRecord(properties) && Object.hasOwn(properties, "raw")) {
    matches.push({ path: `${path}.properties.raw`, schema: properties["raw"] });
  }

  for (const [key, nested] of Object.entries(value)) {
    matches.push(...findRawPropertySchemas(nested, `${path}.${key}`));
  }
  return matches;
}

describe("OpenAPI raw payloads", () => {
  it("leaves every compatibility-sensitive raw property unconstrained", () => {
    const document = createOpenApiDocument();
    const schemas = document.components.schemas as Record<string, unknown>;
    const rawProperties = findRawPropertySchemas(schemas, "components.schemas");

    expect(rawProperties.length).toBeGreaterThan(0);
    for (const { path, schema } of rawProperties) {
      expect(schema, path).toEqual({});
    }
  });
});

describe("OpenAPI ActivityPlugError", () => {
  it("documents the egress, response-limit, and remote protocol codes", () => {
    const document = createOpenApiDocument();
    const schemas = document.components.schemas as Record<string, unknown>;
    const error = schemas["ActivityPlugError"] as {
      readonly properties: { readonly code: { readonly enum: readonly string[] } };
    };

    expect(error.properties.code.enum).toEqual(
      expect.arrayContaining([
        "ORIGIN_NOT_ALLOWED",
        "REQUEST_LIMIT_EXCEEDED",
        "REMOTE_PROTOCOL_ERROR",
      ]),
    );

    const responses = document.components.responses as Record<string, unknown>;
    expect(responses).toHaveProperty("Forbidden");
    expect(responses).toHaveProperty("PayloadTooLarge");

    for (const pathItem of Object.values(document.paths)) {
      for (const operation of Object.values(pathItem)) {
        const operationResponses = (operation as { readonly responses: Record<string, unknown> })
          .responses;
        expect(operationResponses).toHaveProperty("403");
        expect(operationResponses).toHaveProperty("413");
      }
    }
  });

  it("documents retry timing in the 429 header instead of the error body", () => {
    const document = createOpenApiDocument();
    const schemas = document.components.schemas as Record<string, unknown>;
    const error = schemas["ActivityPlugError"] as {
      readonly properties: Record<string, unknown>;
    };

    expect(error.properties).not.toHaveProperty("retryAfterSeconds");

    const responses = document.components.responses as Record<string, unknown>;
    const rateLimited = responses["RateLimited"] as {
      readonly headers: Record<string, unknown>;
    };
    expect(rateLimited.headers).toEqual({
      "Retry-After": {
        description: "The number of seconds to wait before retrying the request.",
        schema: { type: "integer", minimum: 1 },
      },
    });
  });
});
