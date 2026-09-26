# twigg-agent

```text
                                                (@) | (@)
████████╗██╗    ██╗██╗ ██████╗  ██████╗          \  |  /
╚══██╔══╝██║    ██║██║██╔════╝ ██╔════╝     (@)   \ | /   (@)
   ██║   ██║ █╗ ██║██║██║  ███╗██║  ███╗     \_____\|/_____/
   ██║   ██║███╗██║██║██║   ██║██║   ██║            |
   ██║   ╚███╔███╔╝██║╚██████╔╝╚██████╔╝            |
   ╚═╝    ╚══╝╚══╝ ╚═╝ ╚═════╝  ╚═════╝             |
            a   g   e   n   t                       |
```

A one-shot, non-interactive agent for the command line. Give it a Markdown file of instructions and
it works through them with tools. It and exits with `success`, `failed` or `needs_clarification`. It
never stops to ask questions, so it fits cron jobs, CI and scripts.

It runs on the [Twigg](https://twigg.ai) API, which manages the context.
the twigg-agent is purely a harness runs the agent loop and the tools on your machine.

- **Built-in tools:** read, write, edit, delete, glob, grep, web_fetch, todo, wait, parallel
  subagents, and bash if you enable it.
- **Your own tools, in any language:** a folder with a `tool.json` and a program that reads JSON
  on stdin. Publish them on npm and install them like any package. See [Writing tools](docs/tools.md).
- **Limits and permissions:** cost, turn and time budgets; read, write, delete and network
  switches; a root folder for file tools; secrets such as `.env` and keys always off limits.

> [!WARNING]
> **The bash tool is disabled by default**, because it gives the agent unsandboxed shell access:
> it can do anything your user can, outside the working directory and around every other
> restriction. You can enable it with `--allow-bash` (or `"permissions": { "bash": true }` in a
> settings file), but we recommend running the agent in a VM, container or other safe environment
> if you do. See [Enabling bash](#enabling-bash).

## Install

Requires Node 22.13 or later and a Twigg API key.

```sh
npm install -g @twigg/agent
export TWIGG_API_KEY=tw_live_...    # or put TWIGG_API_KEY=... in ./.env
```

## Usage

```sh
twigg-agent task.md --model claude-sonnet-5 --max-cost 1 --output result.json
```

`task.md` is a plain Markdown file. It may start with YAML frontmatter using the same keys as a settings
file; frontmatter can only tighten permissions and limits, never loosen them.

```markdown
---
limits:
  maxTurns: 40
permissions:
  network: false
---

Find every TODO comment under src/, group them by file, and write TODO.md.
```

Settings can also live in a JSON file (`--settings settings.json`). Precedence is flags, then
frontmatter, then the settings file, then defaults. `twigg-agent --help` lists every option.

```json
{
  "model": "claude-sonnet-5",
  "namespace": "my-team/reports",
  "tools": ["@twigg/agent-database"],
  "permissions": { "network": false, "protectedPaths": ["secrets/**"] },
  "limits": { "maxCostUsd": 2, "maxTurns": 60, "timeout": "20m" },
  "subagents": { "maxConcurrent": 3 }
}
```

**Exit codes:** `0` success, `1` failed, `2` needs clarification, `3` limit reached, `4` harness
or config error, `130` interrupted. `--output` writes the full result (summary, cost, tokens,
subagents) as JSON.

**Namespaces:** chats go under `twigg-agent/<namespace>` in Twigg. Set the system prompt for a
namespace on the Twigg dashboard; the harness adds its own operating rules to the first message.
You can also configure things like retention and compation settings in the twigg dashboard by
using this namespace.

## Enabling bash

Bash is off by default, and every run where it is off says so in its first lines:

```
ℹ config  bash is disabled by default. Enable it with --allow-bash (or "permissions": { "bash": true } in settings). It runs without a sandbox, so use a VM or container.
```

Turn it on with the flag or in a settings file:

```sh
twigg-agent task.md --allow-bash
```

```json
{ "permissions": { "bash": true } }
```

Bash is only offered when **both** of the below are true:

1. **You enabled it**, with `--allow-bash` or `permissions.bash` in settings. An instructions
   file's frontmatter can turn bash off for that task, but it can never turn it on.
2. **No other permission is switched off.** Bash has no sandbox, so it could get around most restrictions:
   with read, write, delete or network off, bash stays off. That
   includes restrictions set in a settings file or frontmatter, not just flags. The log names the
   one responsible:

   ```
   ℹ config  bash disabled: network is switched off, and bash runs without a sandbox, so it could get around that
   ```

   Remove that restriction (for example `"network": false` in your settings) to use bash.

`--disable-tool bash` always turns it off. When bash is off the agent is told so, so it won't try
to use it; if a task can't be done without it, the run ends with `failed` and says why.

## Tools

| Package | Tools | |
| --- | --- | --- |
| [`@twigg/agent-database`](packages/tool-database) | `db_collections`, `db_find`, `db_get`, `db_upsert`, `db_delete` | A persistent JSON document store on SQLite. No setup. |

```sh
npm install -g @twigg/agent-database
twigg-agent task.md --tool @twigg/agent-database
twigg-agent tools --tool @twigg/agent-database   # check a tool is ready
```

[Writing tools](docs/tools.md) explains the format, and
[`examples/tools/word-count`](examples/tools/word-count) is a complete tool in 12 lines of Python.
[`examples/notes`](examples/notes) is a small agent that uses both.

## Development

This repo is a pnpm workspace: [`packages/agent`](packages/agent) is the CLI and
[`packages/tool-database`](packages/tool-database) the database tool.

```sh
corepack enable
pnpm install
pnpm check      # typecheck, lint, test
pnpm build      # bundle the CLI to packages/agent/dist/cli.js
node packages/agent/dist/cli.js --help
```

`pnpm --filter @twigg/agent gen:api` regenerates the API types from Twigg's OpenAPI spec.

## License

[MIT](LICENSE)
