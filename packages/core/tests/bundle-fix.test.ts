import { equal } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixNodeBuiltins } from "../scripts/fix-node-builtins.mjs";

test("build rewrite restores node:sqlite in the bundled core output", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "lathe-bundle-fix-"));
  try {
    const dist = join(tmp, "dist");
    await mkdir(dist, { recursive: true });
    const bundle = join(dist, "index.js");
    await writeFile(bundle, 'import { DatabaseSync } from "sqlite";\n', "utf8");

    fixNodeBuiltins(dist);

    const text = await readFile(bundle, "utf8");
    equal(text.includes('from "node:sqlite"'), true);
    equal(text.includes('from "sqlite"'), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
