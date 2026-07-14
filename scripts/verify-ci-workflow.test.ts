import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";
import { parse } from "yaml";

const repositoryRoot = new URL("../", import.meta.url);

type Workflow = {
  jobs?: {
    "final-evidence"?: {
      needs?: string;
      steps?: Array<{ run?: string }>;
    };
    quality?: {
      steps?: Array<{ run?: string }>;
    };
    "package-release-gate"?: {
      needs?: string[];
    };
    "production-compose"?: {
      env?: Record<string, string>;
      steps?: Array<{ if?: string; name?: string; run?: string }>;
    };
  };
};

describe("CI workflow", () => {
  test("runs bounded durable and memory Compose smoke checks before release gates", async () => {
    const workflow = parse(
      await readFile(new URL(".github/workflows/ci.yml", repositoryRoot), "utf8"),
    ) as Workflow;
    const compose = workflow.jobs?.["production-compose"];
    const runs = compose?.steps?.flatMap((step) => (step.run === undefined ? [] : step.run)) ?? [];

    expect(compose?.env).toMatchObject({
      ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS: "https://mastodon.example",
      ACTIVITYPLUG_PNPM_VERSION: "11.12.0",
    });
    expect(compose?.env?.["ACTIVITYPLUG_COOKIE_SIGNING_KEY"]).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(compose?.env?.["ACTIVITYPLUG_POSTGRES_PASSWORD"]).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(compose?.env?.["ACTIVITYPLUG_REDIS_PASSWORD"]).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(runs.join("\n")).toEqual(expect.stringContaining("pnpm compose:up"));
    expect(runs.join("\n")).toEqual(expect.stringContaining("pnpm compose:memory:up"));
    expect(runs.join("\n")).toEqual(expect.stringContaining("pnpm compose:health"));
    expect(runs.join("\n")).toEqual(expect.stringContaining("pnpm compose:memory:health"));
    const composeRun = compose?.steps?.find(
      (step) => step.name === "Start and verify production Compose stacks",
    )?.run;
    const cleanupRun = compose?.steps?.find(
      (step) => step.name === "Remove production Compose services",
    )?.run;

    expect(composeRun).toContain("assert_app_hardening");
    expect(composeRun).toContain("ReadonlyRootfs");
    expect(composeRun).toContain("no-new-privileges:true");
    expect(composeRun).toContain("NET_BIND_SERVICE");
    expect(composeRun).toContain("durable stop");
    expect(composeRun).toContain("durable rm --force");
    expect(composeRun).toContain('test "$status" = 503');
    expect(composeRun).toContain("durable up --wait");
    expect(composeRun).toContain("postgres_sql");
    expect(composeRun).toContain("activityplug_compose_persistence_probe");
    expect(composeRun).toContain("redis_command");
    expect(composeRun).toContain("activityplug:compose:persistence-probe");
    expect(composeRun).toContain('test "$durable_server_after_recovery" = "$durable_server"');
    expect(composeRun).toContain("assert_public_browser_boundary");
    expect(composeRun).toContain("/v1/browser/session");
    expect(composeRun).toContain("__Host-activityplug=");
    expect(composeRun).toContain("anonymous browser cookie mode mismatch");
    expect(composeRun).toContain('Buffer.from(encodedCookie, "base64url")');
    expect(composeRun).toContain("httponly");
    expect(composeRun).toContain("secure");
    expect(composeRun).toContain("samesite=lax");
    expect(composeRun).toContain("/v1/browser/logout");
    expect(composeRun).toContain("X-ActivityPlug-CSRF");
    expect(composeRun).toContain('test "$valid_status" = 200');
    expect(composeRun).toContain('test "$unsafe_status" = 403');
    expect(composeRun).toContain("/v1/browser/not-listed");
    expect(composeRun).toContain('test "$unlisted_status" = 404');
    expect(composeRun).toContain("--cookie-jar");
    expect(composeRun).toContain("trap 'rm -rf \"$smoke_directory\"' EXIT");
    expect(composeRun).toContain('rm -rf "$smoke_directory"');
    expect(composeRun).toContain("trap - EXIT");
    expect(composeRun).not.toContain("! docker");
    expect(composeRun).toContain('assert_app_hardening "$durable_web" true activityplug');
    expect(composeRun).toContain('assert_app_hardening "$durable_server" false node');
    expect(composeRun).toContain("durable_web_networks=$(docker inspect");
    expect(composeRun).toContain('grep -Fq product-data <<<"$durable_web_networks"');
    expect(composeRun).toContain('assert_app_hardening "$memory_web" true activityplug');
    expect(composeRun).toContain('assert_app_hardening "$memory_server" false node');
    expect(composeRun).toContain("if docker network inspect");
    expect(composeRun).toContain(
      "assert_public_browser_boundary .dev/caddy-memory-root.crt https://localhost:8444",
    );
    expect(cleanupRun).toContain("durable down --volumes --remove-orphans");
    expect(cleanupRun).toContain("memory down --volumes --remove-orphans");
    expect(cleanupRun).toContain("status=0");
    expect(cleanupRun).toContain("|| status=1");
    expect(cleanupRun).toContain("label=com.docker.compose.project=$project");
    expect(cleanupRun).toContain("for project in activityplug-durable activityplug-memory");
    expect(cleanupRun).toContain("activityplug-durable_product-data");
    expect(cleanupRun).toContain("activityplug-memory_product-backend");
    expect(cleanupRun).toContain("activityplug-durable_activityplug-postgres");
    expect(cleanupRun).toContain("activityplug-durable_activityplug-redis");
    expect(cleanupRun).toContain("activityplug-memory_activityplug-memory-caddy");
    expect(cleanupRun).toContain("activityplug-memory_activityplug-memory-caddy-config");
    expect(cleanupRun).toContain(".dev/caddy-root.crt");
    expect(cleanupRun).toContain(".dev/caddy-memory-root.crt");
    expect(cleanupRun).toContain('exit "$status"');
    expect(workflow.jobs?.["package-release-gate"]?.needs).toContain("production-compose");
    expect(compose?.steps).toContainEqual(
      expect.objectContaining({ if: "always()", name: "Remove production Compose services" }),
    );
  });

  test("gates uploaded final evidence through the repository verifier", async () => {
    const workflow = parse(
      await readFile(new URL(".github/workflows/ci.yml", repositoryRoot), "utf8"),
    ) as Workflow;
    const finalEvidence = workflow.jobs?.["final-evidence"];
    const runs =
      finalEvidence?.steps?.flatMap((step) => (step.run === undefined ? [] : step.run)) ?? [];

    expect(finalEvidence?.needs).toBe("package-release-gate");
    expect(runs).toContain(
      "pnpm verify:final-evidence -- --output artifacts/verification/platform-hardening.json",
    );
  });
});
