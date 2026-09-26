// Sets one version on every package, and pins the twigg-agent alias to the same @twigg/agent.
// Usage: node scripts/set-version.mjs 0.2.0

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: node scripts/set-version.mjs <version>, e.g. 0.2.0");
  process.exit(1);
}

const root = join(import.meta.dirname, "..", "packages");
for (const dir of readdirSync(root)) {
  const file = join(root, dir, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  pkg.version = version;
  if (pkg.dependencies?.["@twigg/agent"]) pkg.dependencies["@twigg/agent"] = version;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${pkg.name}@${version}`);
}
