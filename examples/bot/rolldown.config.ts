import { defineConfig } from "rolldown";
import { dts } from "rolldown-plugin-dts";

export default defineConfig({
  input: {
    cli: "src/cli.ts",
    index: "src/index.ts",
  },
  external: /^[^./]/,
  platform: "node",
  plugins: [dts({ sourcemap: true })],
  output: {
    cleanDir: true,
    chunkFileNames: "[name]-[hash].mjs",
    dir: "dist",
    entryFileNames: "[name].mjs",
    format: "esm",
    preserveModules: true,
    sourcemap: true,
  },
});
