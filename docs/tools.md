# Writing tools

A tool is a folder with a `tool.json` and a program. The program can be in any language: the
harness sends the model's arguments as JSON on stdin and gives the model whatever the program
prints. Nothing gets imported into the harness, so a broken tool can't break a run.

```
my-tool/
  tool.json      the manifest (below)
  index.js       the program: any language works
  README.md      what it does and which settings it needs
```

## Using a tool

List tools in a settings file, or add them with `--tool` (repeatable):

```jsonc
{
  "tools": [
    "@twigg/agent-database",                                      // an npm package
    "./tools/my-tool",                                            // a folder, relative to this file
    { "use": "@acme/weather", "env": { "WEATHER_UNITS": "metric" } } // with settings for the tool
  ]
}
```

- **Packages** are found in `node_modules` above the settings file (or the current directory for
  `--tool`), then next to twigg-agent itself, so project, global and `npx -p` installs all work.
- **Paths** start with `.`, `/` or `~`.
- Tools can't be added from an instructions file's frontmatter.
- If a listed tool can't be used, the run stops before it starts. `twigg-agent tools` shows each
  tool and what is missing.

## tool.json

```json
{
  "name": "get_weather",
  "description": "What the model sees: when to use it and what it returns.",
  "input_schema": {
    "type": "object",
    "properties": { "city": { "type": "string" } },
    "required": ["city"]
  },
  "command": ["node", "index.js"],
  "env": ["WEATHER_API_KEY"],
  "permissions": ["network"]
}
```

| Field | |
| --- | --- |
| `name` | Letters, digits, `_` and `-`. It can't be a built-in tool's name. |
| `description` | What the model reads to decide when to call it. Worth writing carefully. |
| `input_schema` | JSON Schema for the arguments. The top level must be an object. |
| `command` | The program and its arguments, run in the tool's folder, never through a shell. `node` means the Node running twigg-agent. |
| `env` | Environment variables the tool needs. It can't be used until all are set. |
| `permissions` | What the tool does: any of `read`, `write`, `delete`, `network`. The tool is left out of runs and subagents where one of these is denied, so `--no-write` makes a database read-only. `"network": true` is shorthand for `["network"]`. |
| `trust` | `trusted`, `customer_data` (the default) or `untrusted`. Twigg labels the result with it. Use `untrusted` for outside content such as email or web pages. |
| `needs_npm_install` | The folder has dependencies that must be installed first. |

`tool.json` can also be an array of manifests: several tools sharing one program and one state
directory. [`@twigg/agent-database`](../packages/tool-database) does this.

## How a call runs

- **Input:** the arguments, as JSON on stdin.
- **Output:** stdout is what the model sees. Keep it compact; JSON is fine.
- **Exit codes:**
  - `0`: success.
  - `3`: the tool refused by its own policy, for example a recipient not on an allow list. Print
    what was refused, phrased to follow "I tried to …". The model is told the user blocked it and
    must not work around it.
  - Anything else: an error. The model sees stdout, stderr and the exit code.
- **Limits:** the per-call timeout applies (`--tool-timeout`), and Ctrl-C kills the tool.

### Environment

A tool gets only what it asks for, never the whole environment:

- `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TZ` and `TMPDIR`;
- the variables it declares in `env`, from the environment;
- a `.env` file in its folder, if there is one (handy for local tools);
- the `env` values given to it in settings;
- `TWIGG_AGENT_CWD`: the agent's working directory;
- `TWIGG_AGENT_STATE_DIR`: a folder for the tool's state (below).

`TWIGG_API_KEY` is never passed on unless a tool declares it.

### State

A tool that needs to remember things between calls or runs keeps them in
`TWIGG_AGENT_STATE_DIR`, which is `.twigg-agent/state/<tool>/` in the agent's working directory.
The harness creates it, and it belongs to the project, not the tool's install, so upgrades don't
lose it and each project has its own. The agent can't reach it with its file tools: only through
the tool. Add `.twigg-agent/` to your `.gitignore`.

## Security

Tool folders and `.twigg-agent/` are protected: file tools refuse them and bash commands that
mention them are blocked. Bash is off unless the user passes `--allow-bash`, and it has no
sandbox, so when it is on it could still get at them if it tried hard. Keep keys scoped as
narrowly as the provider allows.

## Publishing a tool

Put `tool.json` at the root of an npm package and include it in `files`. Adding the
`twigg-agent-tool` keyword helps people find it. See
[`packages/tool-database`](../packages/tool-database) for a complete example.
