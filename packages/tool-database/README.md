# @twigg/agent-database

A persistent database for [twigg-agent](https://github.com/Twigg-AI-Ltd/twigg-agent): named
**collections** of JSON **records**, each with an `id`. It is stored in SQLite, built into Node,
so there is nothing else to install.

```sh
npm install -g @twigg/agent-database
twigg-agent task.md --tool @twigg/agent-database
```

or in a settings file: `"tools": ["@twigg/agent-database"]`.

| Tool | What it does | Permission |
| --- | --- | --- |
| `db_collections` | Lists collections with record counts. | read |
| `db_find` | Filters, sorts and pages a collection. | read |
| `db_get` | Fetches records by id. | read |
| `db_upsert` | Creates or updates up to 100 records atomically. `set` merges fields, `unset` removes them, and `append` adds to a list (for example a history of comments). | write |
| `db_delete` | Deletes records by id. | delete |

`--no-write` and `--no-delete` (or a subagent denied them) leave out the tools that need them, so
a run can read the database without changing it.

`where` in `db_find` takes a value (equals) or operators: `eq`, `ne`, `in`, `nin`, `lt`, `lte`,
`gt`, `gte`, `exists`, and `contains` (case-insensitive, also inside lists). Dot paths reach
nested fields. `id`, `created_at` and `updated_at` are built in.

## Where the data lives

In `.twigg-agent/state/twigg__agent-database/db.sqlite` under the agent's working directory, so
each project has its own database and upgrades don't touch it. The agent reaches it only through
these tools. Set `DB_PATH` to put it somewhere else:

```json
{ "tools": [{ "use": "@twigg/agent-database", "env": { "DB_PATH": "/data/crm.sqlite" } }] }
```

Back the file up if the data matters: it exists only on that machine.

## Looking at the data yourself

Run these in the agent's working directory:

```sh
twigg-agent-db path            # where the database file is
twigg-agent-db dump            # every collection, as JSON
twigg-agent-db dump leads      # one collection
sqlite3 "$(twigg-agent-db path)"
```

## How it's built

This package is also the reference for writing twigg-agent tools: [`tool.json`](tool.json)
declares five tools that share one program, [`db.js`](db.js) reads the arguments from stdin, and
the state goes in `TWIGG_AGENT_STATE_DIR`. See
[Writing tools](https://github.com/Twigg-AI-Ltd/twigg-agent/blob/main/docs/tools.md).
