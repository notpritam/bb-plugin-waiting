---
name: waiting-on-you
description: Keep the user's "Waiting on you" checklist (the Waiting on you plugin) with the `bb waiting` CLI or the waiting_add, waiting_done and waiting_list tools. Use whenever you hand the user something to open, pick, answer or do, and when their reply resolves one.
---

# Waiting on you

A check-mark list of what is ready for you, each item with its link, so they
never dig through the chat for a review page. It shows as a card above the
composer of the thread it belongs to ("Waiting on you · 3") and, across every
thread and project, on bb's home screen. They tick items there; you tick them
when their message answers them. Done items fold away.

**The rule:** when you hand the user something to look at or decide, add it here
with its link.

## Tools (preferred inside a thread)

| Tool | What it does |
| --- | --- |
| `waiting_add` | Add an item: `title`, `needed` (what you need from them), `links` (`[{ target, label? }]`), `project`, `requirement`. The thread is attached automatically. |
| `waiting_done` | Tick an item off by its number. |
| `waiting_list` | This thread's open items, or `scope: "all"` for everything. |

## CLI

```sh
bb waiting add "Pick a profile grid" --need "pick 1, 2 or 3" \
  --link "https://foundkeep.app/notpritamsharma|Profile" --project FoundKeep --req R-173
bb waiting list              # this thread's open items
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
  ("pick 1, 2 or 3", "yes or no", "read and reply").
- Tick an item off the moment their message resolves it; the open items of the
  thread are listed in your instructions with their numbers.
- Do not add work you are still doing. Only what is waiting on them.
