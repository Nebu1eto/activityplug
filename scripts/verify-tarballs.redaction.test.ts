import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

import { containsCredential, redactText } from "../.github/scripts/redact-evidence.mjs";

const execFileAsync = promisify(execFile);
const redactor = new URL("../.github/scripts/redact-evidence.mjs", import.meta.url).pathname;

describe("CI evidence redaction", () => {
  test("recursively redacts JSON credential fields without changing stage metadata", () => {
    const evidence = JSON.stringify({
      token: "abc123",
      nested: {
        access_token: "secret456",
        refreshToken: "secret789",
        clientSecret: "client-secret",
        password: "pw789",
        sessionId: "session-123",
        csrfToken: "csrf-123",
        challengeId: "challenge-123",
        setCookie: "activityplug=session-123; Secure",
        databaseUrl: "postgresql://activityplug:db-password@postgres/activityplug",
        redisUrl: "redis://:redis-password@redis/0",
      },
      stage: "adapter-test",
      status: "failed",
      target: "mastodon",
    });
    const redacted = redactText(evidence);

    for (const credential of [
      "abc123",
      "secret456",
      "secret789",
      "client-secret",
      "pw789",
      "session-123",
      "csrf-123",
      "challenge-123",
      "db-password",
      "redis-password",
    ]) {
      expect(redacted).not.toContain(credential);
    }
    expect(redacted).toContain('"stage":"adapter-test"');
    expect(redacted).toContain('"status":"failed"');
    expect(redacted).toContain('"target":"mastodon"');
    expect(containsCredential(redacted)).toBe(false);
  });

  test("redacts headers, assignments, DSN userinfo, and query secrets in plain logs", () => {
    const evidence = [
      'Authorization: Bearer live-token token="abc123" refresh_token=secret456',
      "Cookie: activityplug=session-123; csrf=csrf-123",
      "Set-Cookie: activityplug=session-456; Secure; HttpOnly",
      "DATABASE_URL=postgresql://activityplug:db-password@postgres/activityplug",
      "REDIS_URL=redis://:redis-password@redis/0",
      "callback=https://product.example/callback?code=oauth-code&state=oauth-state",
    ].join("\n");
    const redacted = redactText(evidence);

    for (const credential of [
      "live-token",
      "abc123",
      "secret456",
      "session-123",
      "session-456",
      "csrf-123",
      "db-password",
      "redis-password",
      "oauth-code",
      "oauth-state",
    ]) {
      expect(redacted).not.toContain(credential);
    }
    expect(containsCredential(redacted)).toBe(false);
  });

  test("redacts credential patterns inside non-sensitive JSON string fields", () => {
    const evidence = JSON.stringify({
      message: "Authorization: Bearer live-token",
      callback: "https://product.example/callback?code=oauth-code&state=oauth-state",
      detail: "Cookie: activityplug=session-123",
      connection: "postgresql://activityplug:db-password@postgres/activityplug",
      stage: "adapter-test",
    });
    const sanitized = redactText(evidence);

    for (const credential of [
      "live-token",
      "oauth-code",
      "oauth-state",
      "session-123",
      "db-password",
    ]) {
      expect(sanitized).not.toContain(credential);
    }
    expect(sanitized).toContain('"stage":"adapter-test"');
    expect(containsCredential(evidence)).toBe(true);
    expect(containsCredential(sanitized)).toBe(false);
  });

  test("recursively redacts JSON serialized inside evidence string fields", () => {
    const evidence = JSON.stringify({
      stage: "adapter-test",
      payload: JSON.stringify({
        request: JSON.stringify({
          authorization: "Bearer nested-token",
          refresh_token: "nested-refresh-token",
        }),
      }),
    });

    const sanitized = redactText(evidence);

    expect(sanitized).not.toContain("nested-token");
    expect(sanitized).not.toContain("nested-refresh-token");
    expect(sanitized).toContain('"stage":"adapter-test"');
    expect(containsCredential(evidence)).toBe(true);
    expect(containsCredential(sanitized)).toBe(false);
  });

  test("detects every original adversarial credential sample", () => {
    const samples = [
      '{"sessionId":"session-123","stage":"adapter-test"}',
      "Cookie: activityplug=session-123",
      "Set-Cookie: activityplug=session-123; Secure",
      "csrf=csrf-123 challengeId=challenge-123",
      "postgresql://activityplug:db-password@postgres/activityplug",
      "redis://:redis-password@redis/0",
      "https://product.example/callback?code=oauth-code&state=oauth-state",
      "Authorization: Bearer live-token",
      '{"message":"Authorization: Bearer nested-token","stage":"adapter-test"}',
    ];

    for (const sample of samples) {
      expect(containsCredential(sample), sample).toBe(true);
      expect(containsCredential(redactText(sample)), sample).toBe(false);
    }
  });

  test("fails closed when checking unsanitized evidence files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "activityplug-evidence-test-"));
    const evidence = join(directory, "evidence.log");
    const samples = [
      '{"sessionId":"session-123","stage":"adapter-test"}',
      "Cookie: activityplug=session-123",
      "DATABASE_URL=postgresql://activityplug:db-password@postgres/activityplug",
      "https://product.example/callback?code=oauth-code&state=oauth-state",
    ];
    try {
      await writeFile(evidence, `${samples.join("\n")}\n`);
      await expect(execFileAsync("node", [redactor, "--check", evidence])).rejects.toThrow();

      await writeFile(evidence, `${samples.map(redactText).join("\n")}\n`);
      await expect(execFileAsync("node", [redactor, "--check", evidence])).resolves.toMatchObject({
        stdout: "",
        stderr: "",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
