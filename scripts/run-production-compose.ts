import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { verifyComposePins, verifyProductionEnvironment } from "./verify-compose-pins.ts";

export type ProductionComposeMode = "durable" | "memory";

const configurations = {
  durable: { file: "docker-compose.yml", projectName: "activityplug-durable" },
  memory: { file: "docker-compose.memory.yml", projectName: "activityplug-memory" },
} as const;

export function composeInvocation(mode: ProductionComposeMode, args: readonly string[]): string[] {
  const configuration = configurations[mode];
  return [
    "compose",
    "--project-name",
    configuration.projectName,
    "--file",
    configuration.file,
    ...args,
  ];
}

export function validateProductionComposeCommand(args: readonly string[]): void {
  if (
    args.includes("config") &&
    (args.length !== 2 || args[0] !== "config" || args[1] !== "--quiet")
  ) {
    throw new Error(
      "Docker Compose config commands must be exactly `config --quiet` to avoid secret output",
    );
  }
}

export async function runProductionCompose(
  mode: ProductionComposeMode,
  args: readonly string[],
): Promise<number> {
  if (args.length === 0) throw new Error("A Docker Compose command is required");
  validateProductionComposeCommand(args);
  const repositoryRoot = new URL("../", import.meta.url);
  const errors = [
    ...(await verifyComposePins(repositoryRoot)),
    ...verifyProductionEnvironment(process.env, mode),
  ];
  if (errors.length > 0) throw new Error(errors.join("\n"));

  const result = spawnSync("docker", composeInvocation(mode, args), {
    cwd: fileURLToPath(repositoryRoot),
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode !== "durable" && mode !== "memory") {
    throw new Error("Mode must be durable or memory");
  }
  process.exitCode = await runProductionCompose(mode, process.argv.slice(3));
}
