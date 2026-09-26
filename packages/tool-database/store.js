// A small document store on SQLite: named collections of JSON records keyed by id.

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const COLLECTION = /^[a-z][a-z0-9_]{0,63}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$/;
const RESERVED = new Set(["id", "created_at", "updated_at"]);
const OPS = new Set(["eq", "ne", "in", "nin", "lt", "lte", "gt", "gte", "exists", "contains"]);

export class InputError extends Error {}

/** Where twigg-agent keeps this package's state, relative to the agent's working directory. */
const DEFAULT_STATE_DIR = ".twigg-agent/state/twigg__agent-database";

/**
 * The database file: `DB_PATH` if set, else `db.sqlite` in the state directory twigg-agent gives
 * the tool, else in that same directory under the current one (for people using the CLI).
 * @param {NodeJS.ProcessEnv} env
 */
export function databasePath(env) {
  if (env.DB_PATH) return resolve(env.DB_PATH);
  return resolve(env.TWIGG_AGENT_STATE_DIR || DEFAULT_STATE_DIR, "db.sqlite");
}

/** @param {NodeJS.ProcessEnv} env */
export function openStore(env) {
  const file = databasePath(env);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS records (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (collection, id)
    );`);
  return new Store(db);
}

class Store {
  /** @param {DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  collections() {
    return this.db
      .prepare(
        "SELECT collection, COUNT(*) AS count, MAX(updated_at) AS last_updated FROM records GROUP BY collection ORDER BY collection",
      )
      .all()
      .map((r) => ({ ...r }));
  }

  /**
   * Creates or updates records. Each change merges `set` into the record, removes `unset`
   * fields and appends each `append` value to that field's list. All changes apply or none do.
   * @param {string} collection
   * @param {{ id: string, set?: Record<string, unknown>, unset?: string[],
   *   append?: Record<string, unknown> }[]} changes
   */
  upsert(collection, changes, now = new Date().toISOString()) {
    checkCollection(collection);
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 100) {
      throw new InputError('"records" must be a list of 1 to 100 changes.');
    }
    const get = this.db.prepare(
      "SELECT data, created_at FROM records WHERE collection = ? AND id = ?",
    );
    const put = this.db.prepare(
      `INSERT INTO records (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    );
    const results = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const c of changes) {
        const id = checkId(c?.id);
        const row = get.get(collection, id);
        const data = row ? JSON.parse(String(row.data)) : {};
        for (const [k, v] of Object.entries(objectOrEmpty(c.set, "set"))) {
          checkWritable(k);
          data[k] = v;
        }
        for (const k of listOrEmpty(c.unset, "unset")) {
          checkWritable(k);
          delete data[k];
        }
        for (const [k, v] of Object.entries(objectOrEmpty(c.append, "append"))) {
          checkWritable(k);
          if (data[k] === undefined) data[k] = [];
          if (!Array.isArray(data[k]))
            throw new InputError(`"${k}" on ${id} is not a list, so it can't be appended to.`);
          data[k].push(v);
        }
        const json = JSON.stringify(data);
        if (json.length > 100_000) throw new InputError(`record ${id} would exceed 100 KB.`);
        put.run(collection, id, json, row ? String(row.created_at) : now, now);
        results.push({ id, created: !row });
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return results;
  }

  /** @param {string} collection @param {string[]} ids */
  get(collection, ids) {
    checkCollection(collection);
    const list = listOrEmpty(ids, "ids").map(checkId);
    const q = this.db.prepare("SELECT * FROM records WHERE collection = ? AND id = ?");
    return {
      records: list
        .map((id) => q.get(collection, id))
        .filter(Boolean)
        .map(toRecord),
      missing: list.filter((id) => !q.get(collection, id)),
    };
  }

  /**
   * @param {string} collection
   * @param {{ where?: Record<string, unknown>, order_by?: string, desc?: boolean,
   *   limit?: number, offset?: number }} q
   */
  find(collection, q = {}) {
    checkCollection(collection);
    const params = [collection];
    const clauses = ["collection = ?"];
    for (const [field, cond] of Object.entries(objectOrEmpty(q.where, "where"))) {
      const expr = column(field);
      const ops =
        cond !== null && typeof cond === "object" && !Array.isArray(cond) ? cond : { eq: cond };
      for (const [op, value] of Object.entries(ops)) {
        if (!OPS.has(op))
          throw new InputError(`unknown operator "${op}" (use ${[...OPS].join(", ")}).`);
        clauses.push(condition(expr, op, value, params));
      }
    }
    const limit = q.limit === undefined ? 50 : q.limit;
    const offset = q.offset === undefined ? 0 : q.offset;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new InputError('"limit" must be 1 to 200.');
    if (!Number.isInteger(offset) || offset < 0)
      throw new InputError('"offset" must be 0 or more.');
    const order = q.order_by
      ? `${column(q.order_by)} ${q.desc ? "DESC" : "ASC"}, id`
      : "created_at, id";
    const where = clauses.join(" AND ");
    const total = Number(
      this.db.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${where}`).get(...params)?.n ?? 0,
    );
    const rows = this.db
      .prepare(`SELECT * FROM records WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    return { total, offset, records: rows.map(toRecord) };
  }

  /** @param {string} collection @param {string[]} ids */
  delete(collection, ids) {
    checkCollection(collection);
    const list = listOrEmpty(ids, "ids").map(checkId);
    if (!list.length) throw new InputError('"ids" must list at least one id.');
    const del = this.db.prepare("DELETE FROM records WHERE collection = ? AND id = ?");
    let deleted = 0;
    for (const id of list) deleted += Number(del.run(collection, id).changes);
    return { deleted };
  }
}

function toRecord(row) {
  return {
    id: row.id,
    ...JSON.parse(String(row.data)),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** SQL expression for a field: a column for id/created_at/updated_at, else a JSON path. */
function column(field) {
  if (typeof field !== "string" || !FIELD.test(field))
    throw new InputError(`invalid field name "${field}".`);
  if (RESERVED.has(field)) return field;
  return `json_extract(data, '$.${field}')`;
}

function condition(expr, op, value, params) {
  const scalar = (v) => {
    if (v === null || ["string", "number", "boolean"].includes(typeof v))
      return typeof v === "boolean" ? Number(v) : v;
    throw new InputError(`"${op}" needs a string, number, boolean or null.`);
  };
  switch (op) {
    case "eq":
      if (value === null) return `${expr} IS NULL`;
      params.push(scalar(value));
      return `${expr} = ?`;
    case "ne":
      if (value === null) return `${expr} IS NOT NULL`;
      params.push(scalar(value));
      return `(${expr} IS NULL OR ${expr} <> ?)`;
    case "in":
    case "nin": {
      if (!Array.isArray(value) || !value.length)
        throw new InputError(`"${op}" needs a non-empty list.`);
      params.push(...value.map(scalar));
      const list = `(${value.map(() => "?").join(", ")})`;
      return op === "in" ? `${expr} IN ${list}` : `(${expr} IS NULL OR ${expr} NOT IN ${list})`;
    }
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      params.push(scalar(value));
      return `${expr} ${{ lt: "<", lte: "<=", gt: ">", gte: ">=" }[op]} ?`;
    case "exists":
      return value ? `${expr} IS NOT NULL` : `${expr} IS NULL`;
    case "contains":
      if (typeof value !== "string") throw new InputError('"contains" needs a string.');
      params.push(`%${value.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      return `LOWER(CAST(${expr} AS TEXT)) LIKE ? ESCAPE '\\'`;
  }
}

function checkCollection(c) {
  if (typeof c !== "string" || !COLLECTION.test(c)) {
    throw new InputError('"collection" must be lowercase letters, digits and _ (e.g. "leads").');
  }
}

function checkId(id) {
  if (typeof id !== "string" || !id.trim() || id.length > 200)
    throw new InputError("each id must be a non-empty string of at most 200 characters.");
  return id;
}

function checkWritable(k) {
  if (RESERVED.has(k)) throw new InputError(`"${k}" is managed by the database and can't be set.`);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw new InputError(`invalid field name "${k}".`);
}

function objectOrEmpty(v, name) {
  if (v === undefined) return {};
  if (v === null || typeof v !== "object" || Array.isArray(v))
    throw new InputError(`"${name}" must be an object.`);
  return v;
}

function listOrEmpty(v, name) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new InputError(`"${name}" must be a list.`);
  return v;
}
