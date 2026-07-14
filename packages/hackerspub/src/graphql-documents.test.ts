import { readFile } from "node:fs/promises";

import { buildSchema, parse, validate, type DocumentNode, type GraphQLSchema } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";

import * as documents from "./graphql-documents.js";
import { postSelection } from "./mapping.js";

describe("HackersPub GraphQL documents", () => {
  let schema: GraphQLSchema;

  beforeAll(async () => {
    const schemaSource = await readFile(
      new URL("./fixtures/hackerspub-schema.graphql", import.meta.url),
      "utf8",
    );
    schema = buildSchema(schemaSource);
  });

  it("validates every exported document against the pinned upstream schema", () => {
    const exportedDocuments = Object.entries(documents)
      .filter(([, document]) => isDocumentNode(document))
      .map(([name, document]) => [name, document as unknown as DocumentNode] as const);

    expect(Object.keys(documents)).toEqual(
      expect.arrayContaining([
        "completeLoginChallengeDocument",
        "getPasskeyAuthenticationOptionsDocument",
        "loginByEmailDocument",
        "loginByPasskeyDocument",
        "uploadMediaDocument",
      ]),
    );
    expect(exportedDocuments.length).toBeGreaterThan(10);
    for (const [name, document] of exportedDocuments) {
      expect(validate(schema, document), name).toEqual([]);
    }
  });

  it("keeps interface fields direct and concrete Question fields fragmented", () => {
    const document = parse(`
      query ($id: ID!) {
        node(id: $id) {
          ... on Post {
            ${postSelection()}
          }
        }
      }
    `);

    expect(validate(schema, document)).toEqual([]);
  });
});

function isDocumentNode(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const kind: unknown = Reflect.get(value, "kind");
  return kind === "Document";
}
