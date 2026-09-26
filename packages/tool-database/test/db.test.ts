import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCustomTools } from "../../agent/src/tools/custom.js";
import { buildTools } from "../../agent/src/tools/index.js";
import { makeCtx, perms } from "../../agent/test/tools/helpers.js";

const PKG = join(import.meta.dirname, "..");

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "twigg-db-")));
  dirs.push(dir);
  return dir;
}

/** Runs db.js the way the harness does: JSON on stdin, one result on stdout. */
function runDb(
  args: string[],
  input: unknown,
  env: Record<string, string>,
  cwd = PKG,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [join(PKG, "db.js"), ...args],
      { cwd, env: { PATH: process.env.PATH, ...env } },
      (e, stdout, stderr) =>
        resolve({ code: e ? Number(e.code) : 0, out: stdout.trim(), err: stderr.trim() }),
    );
    child.stdin?.end(JSON.stringify(input));
  });
}

describe("database tools", () => {
  async function db(action: string, input: unknown, dir: string) {
    const r = await runDb([action], input, { TWIGG_AGENT_STATE_DIR: dir });
    return { ...r, json: r.code === 0 ? JSON.parse(r.out) : undefined };
  }

  it("creates, merges, appends to and finds records", async () => {
    const dir = await tempDir();
    const up = await db(
      "upsert",
      {
        collection: "leads",
        records: [
          { id: "li_ada", set: { name: "Ada", status: "new", score: 3 } },
          { id: "li_bob", set: { name: "Bob", status: "sent", sent_count: 1, owner: "sam@x.io" } },
        ],
      },
      dir,
    );
    expect(up.json).toEqual({
      saved: [
        { id: "li_ada", created: true },
        { id: "li_bob", created: true },
      ],
    });
    await db(
      "upsert",
      {
        collection: "leads",
        records: [
          {
            id: "li_bob",
            set: { status: "spoken_to" },
            unset: ["owner"],
            append: { comments: { at: "2026-09-26", by: "sam@x.io", text: "Keen, call Friday" } },
          },
        ],
      },
      dir,
    );
    const bob = (await db("get", { collection: "leads", ids: ["li_bob", "li_nope"] }, dir)).json;
    expect(bob.missing).toEqual(["li_nope"]);
    expect(bob.records[0]).toMatchObject({
      id: "li_bob",
      name: "Bob",
      status: "spoken_to",
      sent_count: 1,
      comments: [{ text: "Keen, call Friday" }],
    });
    expect(bob.records[0].owner).toBeUndefined();

    const found = await db(
      "find",
      { collection: "leads", where: { status: { in: ["new", "sent"] } }, order_by: "name" },
      dir,
    );
    expect(found.json.total).toBe(1);
    expect(found.json.records.map((r: { id: string }) => r.id)).toEqual(["li_ada"]);
    const byComment = await db(
      "find",
      {
        collection: "leads",
        where: { comments: { contains: "FRIDAY" }, score: { exists: false } },
      },
      dir,
    );
    expect(byComment.json.records.map((r: { id: string }) => r.id)).toEqual(["li_bob"]);
    const ranged = await db("find", { collection: "leads", where: { score: { gte: 3 } } }, dir);
    expect(ranged.json.total).toBe(1);

    expect((await db("collections", {}, dir)).json.collections).toMatchObject([
      { collection: "leads", count: 2 },
    ]);
    expect((await db("delete", { collection: "leads", ids: ["li_ada"] }, dir)).json).toEqual({
      deleted: 1,
    });
  });

  it("applies a batch all or nothing and rejects bad input without SQL leaking through", async () => {
    const dir = await tempDir();
    const bad = await db(
      "upsert",
      {
        collection: "leads",
        records: [
          { id: "ok", set: { a: 1 } },
          { id: "bad", set: { created_at: "x" } },
        ],
      },
      dir,
    );
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/managed by the database/);
    expect((await db("collections", {}, dir)).json.collections).toEqual([]);

    for (const input of [
      { collection: "Leads; DROP TABLE records", records: [{ id: "x" }] },
      { collection: "leads", where: { "a') OR 1=1 --": 1 } },
      { collection: "leads", where: { a: { regex: "x" } } },
    ]) {
      const r = await db(input.records ? "upsert" : "find", input, dir);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/^Invalid input:/);
    }
  });
});

describe("database file location", () => {
  it("uses DB_PATH, else the harness state dir, else the default under the current dir", async () => {
    const dir = await tempDir();
    expect((await runDb(["path"], {}, { DB_PATH: "/x/y.sqlite" })).out).toBe("/x/y.sqlite");
    expect((await runDb(["path"], {}, { TWIGG_AGENT_STATE_DIR: "/s" })).out).toBe("/s/db.sqlite");
    expect((await runDb(["path"], {}, {}, dir)).out).toBe(
      join(dir, ".twigg-agent/state/twigg__agent-database/db.sqlite"),
    );
  });

  it("dumps nothing, and creates nothing, when there is no database", async () => {
    const dir = await tempDir();
    const r = await runDb(["dump"], {}, {}, dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/No database at/);
    expect(existsSync(join(dir, ".twigg-agent"))).toBe(false);
  });

  it("prints no experimental warning", async () => {
    const dir = await tempDir();
    const r = await runDb(["collections"], {}, { TWIGG_AGENT_STATE_DIR: dir });
    expect(r.err).toBe("");
  });
});

describe("as a twigg-agent plugin", () => {
  async function load() {
    const entries = await loadCustomTools([{ use: "@twigg/agent-database", dir: PKG, env: {} }], {
      PATH: process.env.PATH,
    });
    return entries.map((e) => {
      if (!("tool" in e)) throw new Error(`${e.name}: ${e.problem}`);
      return e.tool;
    });
  }

  it("is ready without any setup", async () => {
    expect((await load()).map((t) => t.name)).toEqual([
      "db_collections",
      "db_find",
      "db_get",
      "db_upsert",
      "db_delete",
    ]);
  });

  it("keeps its data in the agent's state directory between calls", async () => {
    const work = await tempDir();
    const tools = await load();
    const call = (name: string, input: unknown) =>
      tools.find((t) => t.name === name)?.run(input, makeCtx(work));
    await call("db_upsert", { collection: "notes", records: [{ id: "a", set: { n: 1 } }] });
    const got = await call("db_get", { collection: "notes", ids: ["a"] });
    expect(JSON.parse(got?.text ?? "")).toMatchObject({ records: [{ id: "a", n: 1 }] });
    expect(existsSync(join(work, ".twigg-agent/state/twigg__agent-database/db.sqlite"))).toBe(true);
  });

  it("is read-only when writing and deleting are denied", async () => {
    const tools = await load();
    const names = buildTools(perms({ write: false, delete: false }), tools).map((t) => t.name);
    expect(names.filter((n) => n.startsWith("db_"))).toEqual([
      "db_collections",
      "db_find",
      "db_get",
    ]);
  });
});
