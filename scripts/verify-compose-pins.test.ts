import { expect, it } from "vitest";

import {
  verifyComposePins,
  verifyComposeText,
  verifyProductionEnvironment,
} from "./verify-compose-pins.js";

const digest = "a".repeat(64);

it("accepts every owned Compose image in the repository", async () => {
  await expect(verifyComposePins(new URL("../", import.meta.url))).resolves.toEqual([]);
});

it("accepts digest-pinned services and immutable source commits", () => {
  expect(
    verifyComposeText(
      `
services:
  database:
    image: postgres:18.4-alpine@sha256:${digest}
  search:
    image: docker.elastic.co/elasticsearch/elasticsearch:7.17.25@sha256:${digest}
  source:
    build:
      context: ./source
      additional_contexts:
        upstream: "https://example.com/upstream.git?tag=v1.0.0&checksum=0123456789abcdef0123456789abcdef01234567"
      args:
        SOURCE_REF: 0123456789abcdef0123456789abcdef01234567
`,
      "fixture.yml",
    ),
  ).toEqual([]);
});

it("accepts required production image variables and matching build arguments", () => {
  expect(
    verifyComposeText(
      `
services:
  web:
    build:
      context: .
      args:
        NODE_IMAGE: \${ACTIVITYPLUG_NODE_IMAGE:?set a digest-pinned Node image}
    image: \${ACTIVITYPLUG_CADDY_IMAGE:?set a digest-pinned Caddy image}
`,
      "fixture.yml",
    ),
  ).toEqual([]);
});

it("rejects optional or mismatched production image variables", () => {
  expect(
    verifyComposeText(
      `
services:
  web:
    build:
      context: .
      args:
        NODE_IMAGE: \${ACTIVITYPLUG_WRONG_IMAGE:-node:26}
    image: \${ACTIVITYPLUG_CADDY_IMAGE:-caddy:latest}
`,
      "fixture.yml",
    ),
  ).toEqual([
    expect.stringContaining("digest-pinned image"),
    expect.stringContaining("must require its digest-pinned ACTIVITYPLUG_NODE_IMAGE variable"),
  ]);
});

it("fails production preflight before Compose sees missing or mutable images", () => {
  expect(verifyProductionEnvironment({})).toEqual(
    expect.arrayContaining([
      expect.stringContaining("ACTIVITYPLUG_NODE_IMAGE"),
      expect.stringContaining("ACTIVITYPLUG_PNPM_VERSION"),
    ]),
  );
  expect(
    verifyProductionEnvironment({
      ACTIVITYPLUG_NODE_IMAGE: `node:latest@sha256:${digest}`,
      ACTIVITYPLUG_CADDY_IMAGE: `caddy:2.11@sha256:${digest}`,
      ACTIVITYPLUG_POSTGRES_IMAGE: `postgres:18@sha256:${digest}`,
      ACTIVITYPLUG_REDIS_IMAGE: `redis:8@sha256:${digest}`,
      ACTIVITYPLUG_PNPM_VERSION: "11.12.0",
      ACTIVITYPLUG_POSTGRES_PASSWORD: "A".repeat(32),
      ACTIVITYPLUG_REDIS_PASSWORD: "B".repeat(32),
    }),
  ).toEqual(["ACTIVITYPLUG_NODE_IMAGE must not use the latest tag"]);
});

it("requires durable data passwords without exposing their values", () => {
  const secret = "A".repeat(32);
  const environment = {
    ACTIVITYPLUG_NODE_IMAGE: `node:26@sha256:${digest}`,
    ACTIVITYPLUG_CADDY_IMAGE: `caddy:2.11@sha256:${digest}`,
    ACTIVITYPLUG_POSTGRES_IMAGE: `postgres:18@sha256:${digest}`,
    ACTIVITYPLUG_REDIS_IMAGE: `redis:8@sha256:${digest}`,
    ACTIVITYPLUG_PNPM_VERSION: "11.12.0",
  };

  const missing = verifyProductionEnvironment(environment);
  expect(missing).toEqual(
    expect.arrayContaining([
      expect.stringContaining("ACTIVITYPLUG_POSTGRES_PASSWORD"),
      expect.stringContaining("ACTIVITYPLUG_REDIS_PASSWORD"),
    ]),
  );
  expect(missing.join("\n")).not.toContain(secret);
  expect(
    verifyProductionEnvironment({
      ...environment,
      ACTIVITYPLUG_POSTGRES_PASSWORD: secret,
      ACTIVITYPLUG_REDIS_PASSWORD: `${secret.slice(0, 31)}+`,
    }),
  ).toEqual(["ACTIVITYPLUG_REDIS_PASSWORD must contain at least 32 URL-safe base64 characters"]);
  expect(
    verifyProductionEnvironment({
      ...environment,
      ACTIVITYPLUG_POSTGRES_PASSWORD: secret,
      ACTIVITYPLUG_REDIS_PASSWORD: "B".repeat(32),
    }),
  ).toEqual([]);
  expect(
    verifyProductionEnvironment({
      ...environment,
      ACTIVITYPLUG_POSTGRES_PASSWORD: secret,
      ACTIVITYPLUG_REDIS_PASSWORD: secret,
    }),
  ).toEqual(["ACTIVITYPLUG_POSTGRES_PASSWORD and ACTIVITYPLUG_REDIS_PASSWORD must differ"]);
});

it("requires only web images for memory-mode Compose", () => {
  expect(
    verifyProductionEnvironment(
      {
        ACTIVITYPLUG_NODE_IMAGE: `node:26@sha256:${digest}`,
        ACTIVITYPLUG_CADDY_IMAGE: `caddy:2.11@sha256:${digest}`,
        ACTIVITYPLUG_PNPM_VERSION: "11.12.0",
      },
      "memory",
    ),
  ).toEqual([]);
});

it.each([
  ["a tag without a digest", "postgres:18.4-alpine", "digest-pinned image"],
  ["an uppercase digest", `postgres:18.4-alpine@sha256:${"A".repeat(64)}`, "digest-pinned image"],
  ["a short digest", `postgres:18.4-alpine@sha256:${"a".repeat(63)}`, "digest-pinned image"],
  ["the latest tag", `postgres:latest@sha256:${digest}`, "must not use the latest tag"],
  [
    "Elasticsearch outside 7.x",
    `docker.elastic.co/elasticsearch/elasticsearch:8.19.0@sha256:${digest}`,
    "must select Elasticsearch 7.x",
  ],
])("rejects %s and reports its file and service", (_case, image, message) => {
  expect(
    verifyComposeText(
      `
services:
  unsafe-service:
    image: ${image}
`,
      "unsafe-compose.yml",
    ),
  ).toEqual([expect.stringContaining("unsafe-compose.yml: service unsafe-service")]);
  expect(
    verifyComposeText(`services: { unsafe-service: { image: ${image} } }`, "unsafe.yml")[0],
  ).toContain(message);
});

it("rejects mutable Git and source refs", () => {
  expect(
    verifyComposeText(
      `
services:
  source-builder:
    build:
      context: ./source
      args:
        SOURCE_REF: main
`,
      "source-compose.yml",
    ),
  ).toEqual([
    expect.stringContaining(
      "source-compose.yml: service source-builder build arg SOURCE_REF must use an exact lowercase Git commit",
    ),
  ]);
});

it.each([
  ["a mutable remote context", "https://example.com/upstream.git#main"],
  ["an arbitrary local context", "./anything"],
])("rejects a spoofed source ref paired with %s", (_case, context) => {
  expect(
    verifyComposeText(
      `
services:
  source-builder:
    build:
      context: ${context}
      args:
        SOURCE_REF: 0123456789abcdef0123456789abcdef01234567
`,
      "source-compose.yml",
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.stringContaining(
        "source-compose.yml: service source-builder build arg SOURCE_REF must be bound to a remote Git context checksum",
      ),
    ]),
  );
});

it("rejects a mutable remote additional context", () => {
  expect(
    verifyComposeText(
      `
services:
  source-builder:
    build:
      context: .
      additional_contexts:
        upstream: https://example.com/upstream.git#main
`,
      "source-compose.yml",
    ),
  ).toEqual([
    "source-compose.yml: service source-builder additional context upstream must use an exact lowercase Git checksum",
  ]);
});
