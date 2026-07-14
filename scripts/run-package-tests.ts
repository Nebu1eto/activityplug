import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = await findRepoRoot(dirname(scriptPath));
const packageRoot = process.cwd();
const integration = process.argv.includes("--integration");
const relativePackageRoot = relative(repoRoot, packageRoot);
const sourceDir = join(packageRoot, "src");

if (!(await pathExists(sourceDir))) {
  console.log(`No src directory found for ${relativePackageRoot}.`);
  process.exit(0);
}

const testFiles = (await findTestFiles(sourceDir))
  .filter((file) =>
    integration ? file.endsWith(".integration.test.ts") : !file.endsWith(".integration.test.ts"),
  )
  .map((file) => relative(repoRoot, file));

if (testFiles.length === 0) {
  const kind = integration ? "integration" : "unit";
  console.error(`No ${kind} tests found for ${relativePackageRoot}.`);
  process.exit(1);
}

const status = await runVitest(testFiles);
process.exit(status);

async function findRepoRoot(start: string): Promise<string> {
  let current = start;
  while (current !== dirname(current)) {
    const packageJsonPath = join(current, "package.json");
    if (await pathExists(packageJsonPath)) {
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        readonly name?: string;
      };
      if (packageJson.name === "activityplug") return current;
    }
    current = dirname(current);
  }
  throw new Error("Could not find the activityplug repository root.");
}

async function findTestFiles(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findTestFiles(path)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files.toSorted();
}

async function runVitest(files: readonly string[]): Promise<number> {
  const child = spawn("pnpm", ["exec", "vitest", "run", ...files], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...(integration ? { ACTIVITYPLUG_INTEGRATION: "1" } : {}),
    },
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`Vitest was terminated by ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
