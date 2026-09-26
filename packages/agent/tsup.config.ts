import { defineConfig } from "tsup";

// Ships as one self-contained file: every dependency is bundled in, so installing the CLI pulls in
// nothing else. The require shim lets bundled CommonJS code load Node built-ins from ESM.
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  minify: true,
  noExternal: [/.*/],
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
});
