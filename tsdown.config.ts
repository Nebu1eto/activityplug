import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  deps: {
    skipNodeModulesBundle: true,
  },
  dts: true,
  entry: ["src/index.ts"],
  format: "esm",
  target: "node24",
  treeshake: true,
});
