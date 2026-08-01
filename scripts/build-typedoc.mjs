import { spawnSync } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(
  pnpm,
  ["--dir", "tools/docs", "exec", "typedoc", "--options", "../../typedoc.json"],
  { stdio: "inherit" },
);

if (result.error !== undefined) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
