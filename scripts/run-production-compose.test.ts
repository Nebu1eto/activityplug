import { describe, expect, test } from "vitest";

import { composeInvocation, validateProductionComposeCommand } from "./run-production-compose.ts";

describe("production Compose launcher", () => {
  test("isolates durable and memory projects and configuration files", () => {
    expect(composeInvocation("durable", ["config", "--quiet"])).toEqual([
      "compose",
      "--project-name",
      "activityplug-durable",
      "--file",
      "docker-compose.yml",
      "config",
      "--quiet",
    ]);
    expect(composeInvocation("memory", ["config", "--quiet"])).toEqual([
      "compose",
      "--project-name",
      "activityplug-memory",
      "--file",
      "docker-compose.memory.yml",
      "config",
      "--quiet",
    ]);
  });

  test("does not permit configuration output that could reveal secrets", () => {
    expect(() => validateProductionComposeCommand(["config"])).toThrow(
      "must be exactly `config --quiet`",
    );
    expect(() => validateProductionComposeCommand(["--ansi", "never", "config"])).toThrow(
      "must be exactly `config --quiet`",
    );
    expect(() => validateProductionComposeCommand(["config", "--quiet", "--quiet=false"])).toThrow(
      "must be exactly `config --quiet`",
    );
    expect(() => validateProductionComposeCommand(["config", "--quiet"])).not.toThrow();
  });
});
