import { readFile } from "node:fs/promises";
import { matchesGlob } from "node:path";

import { describe, expect, test } from "vitest";
import { parse } from "yaml";

const repositoryRoot = new URL("../", import.meta.url);

type ComposeService = {
  build?: { args?: Record<string, string> };
  cap_add?: string[];
  cap_drop?: string[];
  command?: string[];
  cpus?: string;
  depends_on?: Record<string, { condition?: string }>;
  environment?: Record<string, string>;
  healthcheck?: { test?: string[] };
  mem_limit?: string;
  networks?: Record<string, { ipv4_address?: string }> | string[];
  pids_limit?: number;
  ports?: string[];
  read_only?: boolean;
  restart?: string;
  security_opt?: string[];
  tmpfs?: string[];
  volumes?: string[];
};

type ComposeDocument = {
  name?: string;
  networks?: Record<string, { internal?: boolean; ipam?: { config?: Array<{ subnet?: string }> } }>;
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
};

async function readYaml(path: string): Promise<ComposeDocument> {
  return parse(await readFile(new URL(path, repositoryRoot), "utf8")) as ComposeDocument;
}

function isIncludedByDockerignore(source: string, path: string): boolean {
  let excluded = false;
  const segments = path.split("/");
  const candidates = segments.map((_, index) => segments.slice(0, index + 1).join("/"));
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const rawPattern = negated ? line.slice(1) : line;
    const pattern = rawPattern.endsWith("/") ? rawPattern.slice(0, -1) : rawPattern;
    if (candidates.some((candidate) => matchesGlob(candidate, pattern))) excluded = !negated;
  }
  return !excluded;
}

describe("production Compose", () => {
  test("keeps the production build context allowlisted and credential-free", async () => {
    const dockerignore = await readFile(new URL(".dockerignore", repositoryRoot), "utf8");

    expect(dockerignore).toContain("!package.json");
    expect(dockerignore).toContain("!pnpm-lock.yaml");
    expect(dockerignore).toContain("!pnpm-workspace.yaml");
    expect(dockerignore).toContain("!rolldown.config.ts");
    expect(dockerignore).toContain("!tsconfig.base.json");
    expect(dockerignore).toContain("!packages/**");
    expect(dockerignore).toContain("!examples/web-client/**");
    for (const excludedPath of [
      "**/node_modules",
      "**/dist",
      "**/coverage",
      "**/.worktrees",
      "**/artifacts",
      "**/.dev",
      "**/.env",
      "**/.env.*",
      "**/*.crt",
      "**/*.key",
      "**/*.pem",
      ".env.*",
      "*.crt",
      "*.key",
      "*.pem",
    ]) {
      expect(dockerignore).toContain(excludedPath);
    }
    expect(
      isIncludedByDockerignore(
        dockerignore,
        "packages/server/src/security/test-fixtures/social-example-cert.pem",
      ),
    ).toBe(false);
    expect(
      isIncludedByDockerignore(
        dockerignore,
        "packages/server/src/security/test-fixtures/social-example-key.pem",
      ),
    ).toBe(false);
    expect(isIncludedByDockerignore(dockerignore, "packages/server/src/index.ts")).toBe(true);
    expect(isIncludedByDockerignore(dockerignore, "examples/web-client/src/server.ts")).toBe(true);
    expect(
      isIncludedByDockerignore(dockerignore, "examples/web-client/node_modules/react/index.js"),
    ).toBe(false);
    expect(isIncludedByDockerignore(dockerignore, "packages/server/dist/index.mjs")).toBe(false);
  });

  test("health-gates durable dependencies and persists owned state", async () => {
    const compose = await readYaml("docker-compose.yml");

    expect(compose.services.web?.depends_on?.server?.condition).toBe("service_healthy");
    expect(compose.services.server?.depends_on).toEqual({
      postgres: { condition: "service_healthy" },
      redis: { condition: "service_healthy" },
    });
    expect(compose.services.web?.volumes).toContain("activityplug-caddy:/data");
    expect(compose.services.web?.volumes).toContain("activityplug-caddy-config:/config");
    expect(compose.services.web?.volumes).toContain(
      "./examples/web-client/Caddyfile.local:/etc/caddy/Caddyfile:ro",
    );
    expect(compose.services.postgres?.volumes).toContain(
      "activityplug-postgres:/var/lib/postgresql",
    );
    expect(compose.services.redis?.volumes).toContain("activityplug-redis:/data");
    expect(compose.services.server?.environment).toMatchObject({
      DATABASE_URL:
        "postgresql://activityplug:${ACTIVITYPLUG_POSTGRES_PASSWORD:?set a URL-safe PostgreSQL password}@postgres:5432/activityplug",
      REDIS_URL:
        "redis://:${ACTIVITYPLUG_REDIS_PASSWORD:?set a URL-safe Redis password}@redis:6379/0",
    });
    expect(compose.services.postgres?.environment).toMatchObject({
      POSTGRES_PASSWORD: "${ACTIVITYPLUG_POSTGRES_PASSWORD:?set a URL-safe PostgreSQL password}",
    });
    expect(compose.services.redis?.environment).toMatchObject({
      REDIS_PASSWORD: "${ACTIVITYPLUG_REDIS_PASSWORD:?set a URL-safe Redis password}",
    });
    expect(compose.services.redis?.command).toEqual([
      "/bin/sh",
      "-ec",
      'exec redis-server --appendonly yes --requirepass "$${REDIS_PASSWORD}"',
    ]);
    expect(compose.services.postgres?.healthcheck?.test?.join(" ")).toContain("psql");
    expect(compose.services.postgres?.healthcheck?.test?.join(" ")).toContain(
      "$${POSTGRES_PASSWORD}",
    );
    expect(compose.services.redis?.healthcheck?.test).toEqual([
      "CMD-SHELL",
      'redis-cli --no-auth-warning --user default --pass "$${REDIS_PASSWORD}" ping',
    ]);
    expect(Object.keys(compose.volumes ?? {}).toSorted()).toEqual([
      "activityplug-caddy",
      "activityplug-caddy-config",
      "activityplug-postgres",
      "activityplug-redis",
    ]);
  });

  test("runs memory-mode containers without durable services", async () => {
    const compose = await readYaml("docker-compose.memory.yml");
    const server = compose.services.server;

    expect(compose.name).toBe("activityplug-memory");
    expect(Object.keys(compose.services).toSorted()).toEqual(["server", "web"]);
    expect(compose.services.web?.ports).toEqual(["127.0.0.1:8444:443"]);
    expect(compose.services.web?.networks).toEqual({
      "product-backend": { ipv4_address: "172.31.0.2" },
    });
    expect(server?.networks).toEqual({
      "product-backend": { ipv4_address: "172.31.0.3" },
    });
    expect(server?.environment).toMatchObject({
      ACTIVITYPLUG_STORAGE: "memory",
      ACTIVITYPLUG_PUBLIC_ORIGIN: "https://localhost:8444",
      ACTIVITYPLUG_TRUSTED_PROXY_ADDRESSES: "172.31.0.2",
    });
    expect(server?.environment).not.toHaveProperty("DATABASE_URL");
    expect(server?.environment).not.toHaveProperty("REDIS_URL");
    expect(server?.depends_on).toBeUndefined();
    expect(compose.networks?.["product-backend"]?.ipam?.config).toEqual([
      { subnet: "172.31.0.0/24" },
    ]);
    expect(compose.services.web?.volumes).toEqual(
      expect.arrayContaining([
        "./examples/web-client/Caddyfile.local:/etc/caddy/Caddyfile:ro",
        "activityplug-memory-caddy:/data",
        "activityplug-memory-caddy-config:/config",
      ]),
    );
  });
});
