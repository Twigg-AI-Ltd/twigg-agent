import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveApiKey } from "../src/apikey.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "apikey-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveApiKey", () => {
  it("prefers the environment variable", async () => {
    await writeFile(join(dir, ".env"), "TWIGG_API_KEY=from-file\n");
    expect(await resolveApiKey({ TWIGG_API_KEY: "from-env" }, dir)).toEqual({
      key: "from-env",
      source: "env",
    });
  });

  it("falls back to .env, handling quotes, comments and export", async () => {
    await writeFile(join(dir, ".env"), '# comment\nOTHER=1\nexport TWIGG_API_KEY="tw_live_abc"\n');
    expect(await resolveApiKey({}, dir)).toEqual({ key: "tw_live_abc", source: ".env" });
  });

  it("returns undefined when neither has a key", async () => {
    expect(await resolveApiKey({}, dir)).toBeUndefined();
    await writeFile(join(dir, ".env"), "OTHER=1\n");
    expect(await resolveApiKey({ TWIGG_API_KEY: "  " }, dir)).toBeUndefined();
  });

  it("does not load other variables into the environment", async () => {
    await writeFile(join(dir, ".env"), "TWIGG_API_KEY=k\nLEAKY_SECRET=x\n");
    const env: NodeJS.ProcessEnv = {};
    await resolveApiKey(env, dir);
    expect(env).toEqual({});
  });
});
