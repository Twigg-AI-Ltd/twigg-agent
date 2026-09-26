#!/usr/bin/env node
// Entry point for the db_* tools: `node db.js <action>` with the tool input as JSON on stdin.
// Also a CLI for people: `twigg-agent-db dump [collection]` prints records as JSON, and
// `twigg-agent-db path` prints where the database file is.

import { existsSync } from "node:fs";

// node:sqlite warns that it is experimental on every start; the tool's output must stay clean.
process.removeAllListeners("warning");
const { InputError, databasePath, openStore } = await import("./store.js");

const USAGE = `Usage: twigg-agent-db dump [collection]   Print records as JSON
       twigg-agent-db path                Print the database file's location

Run it in the agent's working directory, or set DB_PATH.`;

async function main() {
  const [action, arg] = process.argv.slice(2);
  if (action === "path") return done(0, databasePath(process.env));
  if (action === "dump") {
    const file = databasePath(process.env);
    if (!existsSync(file)) return done(1, `No database at ${file}.\n\n${USAGE}`);
    const store = openStore(process.env);
    try {
      const names = arg ? [arg] : store.collections().map((c) => c.collection);
      const out = {};
      for (const name of names) {
        const all = [];
        for (let offset = 0; ; offset += 200) {
          const page = store.find(name, { limit: 200, offset });
          all.push(...page.records);
          if (all.length >= page.total || !page.records.length) break;
        }
        out[name] = all;
      }
      return done(0, JSON.stringify(out, null, 2));
    } finally {
      store.close();
    }
  }
  if (!["collections", "upsert", "get", "find", "delete"].includes(action ?? "")) {
    return done(1, USAGE);
  }

  const store = openStore(process.env);
  try {
    const input = JSON.parse((await readStdin()) || "{}");
    switch (action) {
      case "collections":
        return done(0, JSON.stringify({ collections: store.collections() }));
      case "upsert":
        return done(0, JSON.stringify({ saved: store.upsert(input.collection, input.records) }));
      case "get":
        return done(0, JSON.stringify(store.get(input.collection, input.ids)));
      case "find":
        return done(0, JSON.stringify(store.find(input.collection, input)));
      case "delete":
        return done(0, JSON.stringify(store.delete(input.collection, input.ids)));
    }
  } catch (e) {
    if (e instanceof InputError || e instanceof SyntaxError)
      return done(1, `Invalid input: ${e.message}`);
    throw e;
  } finally {
    store.close();
  }
}

function done(code, message) {
  process.stdout.write(`${message}\n`);
  process.exitCode = code;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

main().catch((err) => done(1, `database error: ${err instanceof Error ? err.message : err}`));
