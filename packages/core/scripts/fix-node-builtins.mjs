import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rewriteSpecifiers = (text) =>
  text
    .replaceAll('from "sqlite"', 'from "node:sqlite"')
    .replaceAll("from 'sqlite'", "from 'node:sqlite'")
    .replaceAll('import("sqlite")', 'import("node:sqlite")')
    .replaceAll("import('sqlite')", "import('node:sqlite')");

export const fixNodeBuiltins = (distDir = resolve(fileURLToPath(new URL("../dist/", import.meta.url)))) => {
  const bundlePath = resolve(distDir, "index.js");
  if (!existsSync(bundlePath)) {
    throw new Error(`missing bundled output: ${bundlePath}`);
  }

  const original = readFileSync(bundlePath, "utf8");
  const rewritten = rewriteSpecifiers(original);
  if (rewritten !== original) {
    writeFileSync(bundlePath, rewritten);
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fixNodeBuiltins();
}
