# @twigg/agent

A one-shot, non-interactive agent CLI for the [Twigg](https://twigg.ai) API, with tools you
can write in any language. One file, no dependencies, about 105 kB installed.

```sh
npm install -g @twigg/agent
export TWIGG_API_KEY=tw_live_...    # create one at https://twigg.ai
twigg-agent models                  # the models your key can use
twigg-agent task.md --model claude-sonnet-5 --max-cost 1
```

> The bash tool is disabled by default because it gives the agent unsandboxed shell access. You
> can enable it with `--allow-bash`, but we recommend running the agent in a VM or other safe
> environment if you do.

Documentation, tools and examples: https://github.com/Twigg-AI-Ltd/twigg-agent
