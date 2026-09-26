# Notes example

A small agent that summarises saved articles into the database and writes a reading list. It uses
[`@twigg/agent-database`](../../packages/tool-database) and the
[`word-count`](../tools/word-count) example tool, which is written in Python.

```sh
npm i -g @twigg/agent @twigg/agent-database
export TWIGG_API_KEY=tw_live_...
cd examples/notes
twigg-agent task.md --settings settings.json
```

Run it twice: the second run skips the articles already in the database. Look at the data with
`twigg-agent-db dump`, run in this folder.

`settings.json` switches the network off, so bash stays off here even with `--allow-bash`; the
task doesn't need either. See [Enabling bash](../../README.md#enabling-bash).
