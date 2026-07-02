import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/interfaces/cli/tail.ts"],
  format: ["esm"],
  outDir: "dist",
  sourcemap: true,
  removeNodeProtocol: false,
});
