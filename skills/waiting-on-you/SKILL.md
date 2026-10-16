---
name: waiting-on-you
description: Keep the user's "Waiting on you" checklist (the Waiting on you plugin) with the `bb waiting` CLI or the waiting_add, waiting_done and waiting_list tools. Use whenever you hand the user something to open, pick, answer or do, and when their reply resolves one. Give choices when the question has fixed answers.
---

# Waiting on you

A check-mark list of what is ready for the user, each item with its link, so
they never dig through the chat for a review page. It shows as a card above
the composer of the thread it belongs to ("Waiting on you · 3") and, across
every thread and project, on bb's home screen.

From the card they can: tick an item done; **answer** a question by tapping
one of its choices (the answer lands in your thread as their message, e.g.
`Re #12 "Keep the handle?": Yes`, and the item is ticked off); say **Do now**
(you get `Re #12 "…": do it now, go ahead.`; the item leaves the card and your
instructions tell you to finish it and call `waiting_done`); put it off for
**Later** (hidden until then); move it up **Next**; or **Reply…** in the
composer.

**The rule:** when you hand the user something to look at or decide, add it here
with its link. When the answers are fixed, give choices so they can answer from
the card.

## Tools (preferred inside a thread)

| Tool | What it does |
| --- | --- |
| `waiting_add` | Add an item: `title`, `needed` (what you need from them), `choices` (`["Yes", "No"]`, `["1", "2", "3"]`, up to 6), `links` (`[{ target, label? }]`), `project`, `requirement`. The thread is attached automatically. |
| `waiting_done` | Tick an item off by its number, including one they said "Do now" to once you finished it. |
| `waiting_list` | This thread's open items, or `scope: "all"` for everything. |

## CLI

```sh
bb waiting add "Pick a profile grid" --need "pick 1, 2 or 3" \
  --choice 1 --choice 2 --choice 3 \
  --link "https://foundkeep.app/notpritamsharma|Profile" --project FoundKeep --req R-173
bb waiting edit 12 --choice Yes --choice No   # replace choices (`--choice none` clears); also --title, --need, --link
bb waiting list              # this thread's open items (later ones marked)
bb waiting list --everywhere # every thread and project
bb waiting list --all        # include done items
bb waiting done 12           # the user answered or did it
bb waiting reopen 12
bb waiting remove 12         # only for items that should never have existed
```

Add `--json` for machine-readable output. Inside a thread the item links to
that thread; pass `--thread thr_…` from elsewhere.

## Links

`--link` and `links[].target` accept `https://…` URLs, absolute paths, `~/…`
paths (on the thread's machine) and `thr_…` thread ids. Put a label after a
bar: `https://…|Review page`. Every item should carry at least one link: the
page to open, the doc to read, or the preview to look at.

## Keep it honest

- One item per decision or thing to open. A short title, then what is needed
  ("pick 1, 2 or 3", "yes or no", "read and reply"), and the choices when they
  are fixed. Keep choices short: one or two words each.
- Tick an item off the moment their message resolves it; the open items of the
  thread are listed in your instructions with their numbers. An answer from
  the card is already ticked off.
- Do not add work you are still doing. Only what is waiting on them.
