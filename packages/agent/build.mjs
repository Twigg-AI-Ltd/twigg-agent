// Builds dist/cli.js: one self-contained file with every dependency bundled in, so installing the
// CLI pulls in nothing else. Fails if the file outgrows its size budget or needs a package at run
// time. `--watch` rebuilds on change.

import { chmod, readFile, rm } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { build, context } from "esbuild";

const OUT = "dist/cli.js";
/** The most dist/cli.js may weigh. Raise it on purpose, not by accident. */
const BUDGET_BYTES = 120_000;

const options = {
  entryPoints: ["src/cli.ts"],
  outfile: OUT,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  minify: true,
  legalComments: "none",
  metafile: true,
  banner: { js: "#!/usr/bin/env node" },
};

if (process.argv.includes("--watch")) {
  const ctx = await context({ ...options, minify: false, logLevel: "info" });
  await ctx.watch();
} else {
  await rm("dist", { recursive: true, force: true });
  const { metafile } = await build(options);
  const output = metafile.outputs[OUT];
  const packages = output.imports.map((i) => i.path).filter((p) => !p.startsWith("node:"));
  await chmod(OUT, 0o755);
  const file = await readFile(OUT);
  const kB = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;
  console.log(`${OUT}  ${kB(file.length)}  (${kB(gzipSync(file).length)} gzipped)`);
  if (packages.length > 0) {
    console.error(`${OUT} needs packages at run time: ${[...new Set(packages)].join(", ")}`);
    process.exitCode = 1;
  }
  if (file.length > BUDGET_BYTES) {
    console.error(`${OUT} is over its budget of ${kB(BUDGET_BYTES)}`);
    process.exitCode = 1;
  }
}
