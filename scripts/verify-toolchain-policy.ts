import { readFile, readdir } from "node:fs/promises";

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly engines?: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly overrides?: unknown;
  readonly packageManager?: string;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly pnpm?: { readonly overrides?: unknown; readonly peerDependencyRules?: unknown };
  readonly scripts?: Readonly<Record<string, string>>;
}

const forbiddenDependencies = new Set(["gql.tada", "graphql-http", "graphql-yoga", "tsdown"]);
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export async function verifyToolchainPolicy(root: URL): Promise<string[]> {
  const violations: string[] = [];
  const manifests = await packageManifests(root);
  const internalPackages = new Set(
    manifests
      .map(([, manifest]) => manifest.name)
      .filter((name): name is string => name !== undefined),
  );

  for (const [path, manifest] of manifests) {
    if (path === "package.json") {
      requireValue(violations, path, "engines.node", manifest.engines?.node, ">=26 <27");
      requireValue(violations, path, "engines.pnpm", manifest.engines?.pnpm, ">=11 <12");
      if (!/^pnpm@11\.\d+\.\d+$/.test(manifest.packageManager ?? "")) {
        violations.push(`${path}: packageManager must select an exact pnpm 11 release`);
      }
      const typescript = manifest.devDependencies?.["typescript"];
      if (!/^\^?7\./.test(typescript ?? "")) {
        violations.push(`${path}: devDependencies.typescript must select TypeScript 7`);
      }
    }

    if (manifest.overrides !== undefined) violations.push(`${path}: overrides is forbidden`);
    if (manifest.pnpm?.overrides !== undefined)
      violations.push(`${path}: pnpm.overrides is forbidden`);
    if (manifest.pnpm?.peerDependencyRules !== undefined) {
      violations.push(`${path}: pnpm.peerDependencyRules is forbidden`);
    }

    for (const [name, command] of Object.entries(manifest.scripts ?? {}).toSorted(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (
        name === "build" &&
        /\brolldown\b/.test(command) &&
        !/--configLoader(?:=|\s+)native\b/.test(command)
      ) {
        violations.push(`${path}: scripts.build must use native Rolldown config loading`);
      }
      for (const dependency of forbiddenDependencies) {
        if (command.includes(dependency)) {
          violations.push(`${path}: scripts.${name} references forbidden ${dependency}`);
        }
      }
    }

    for (const section of dependencySections) {
      const dependencies = manifest[section];
      if (dependencies === undefined) continue;
      for (const [name, version] of Object.entries(dependencies).toSorted(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const key = `${section}.${name}`;
        if (forbiddenDependencies.has(name)) violations.push(`${path}: ${key} is forbidden`);
        if (name === "graphql" && !/^\^?17\./.test(version)) {
          violations.push(`${path}: ${key} must select GraphQL 17`);
        }
        if (internalPackages.has(name) && version !== "workspace:*") {
          violations.push(`${path}: ${key} must be workspace:*`);
        }
      }
    }
  }

  const workspace = await readFile(new URL("pnpm-workspace.yaml", root), "utf8");
  for (const key of ["overrides", "peerDependencyRules"] as const) {
    if (new RegExp(`^\\s*${key}:`, "m").test(workspace)) {
      violations.push(`pnpm-workspace.yaml: ${key} is forbidden`);
    }
  }

  return violations;
}

async function packageManifests(root: URL): Promise<readonly [string, PackageManifest][]> {
  const paths = ["package.json"];
  for (const directory of ["examples", "packages"] as const) {
    for (const entry of await readdir(new URL(`${directory}/`, root), { withFileTypes: true })) {
      if (entry.isDirectory()) paths.push(`${directory}/${entry.name}/package.json`);
    }
  }
  return Promise.all(
    paths
      .toSorted()
      .map(async (path) => [path, JSON.parse(await readFile(new URL(path, root), "utf8"))]),
  );
}

function requireValue(
  violations: string[],
  path: string,
  key: string,
  actual: string | undefined,
  expected: string,
): void {
  if (actual !== expected) violations.push(`${path}: ${key} must be ${expected}`);
}
