---
limits:
  maxTurns: 20
---

# Reading notes

Every `.md` file in `inbox/` is an article someone saved to read later.

1. For each file in `inbox/` that isn't already in the `notes` collection (use the file name as
   the id), read it and save a record with:
   - `title`
   - `summary`: two sentences
   - `topics`: up to three lowercase tags
   - `words`: its length, from `word_count`
2. Write `reading-list.md`: the notes grouped by topic, newest first, one line each with the
   title, the word count and the summary.

Leave the files in `inbox/` as they are.
