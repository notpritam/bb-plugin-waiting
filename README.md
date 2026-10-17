# Waiting on you (bb-plugin-waiting)

A bb plugin that keeps a check-mark list of what is ready for you: a review
page to open, a pick to make, a yes or no. Each item carries its link, so you
never dig through a chat to find it. Answer right on the card: the answer is
kept for the thread's agent, so tapping it never interrupts the agent's work.

## Where it shows

- **Above the composer** of the thread it belongs to, drawn like bb's own
  To-do, Running and Uncommitted cards: `Waiting on you · 3`. Expand it to
  see each item with what is needed, its links, the product, the R-number and
  when it was added.
- **On the home screen**, a "Waiting on you" section with everything open
  across threads and projects, grouped by product, each with a link to its
  thread.

## What you can do with an item

- **Tick it** done; it folds away.
- **Answer it**: a question's choices (`Yes` `No`, `1` `2` `3`, `A` `B` `C`)
  sit on the row as small buttons. Tap one and the answer is **kept, not
  sent**: the row stays where it was, ticked, with your answer beside it,
  until the thread's agent picks it up (it reads the answers file or its
  tools, below). Untick it to take the answer back.
- **Send answers** (on the card, when there are answers): sends every answer
  of that thread to its agent in **one** message
  (`Answers: #12 "Keep the handle?": Yes; #14 "Pick a grid": 2`), for when
  you want it woken now.
- **Do now** (row menu): sends at once and tells the thread's agent to go
  ahead; the item leaves the card and the agent ticks it off when finished.
- **Next**: moves it to the top.
- **Later**: tomorrow, next week or a date you pick; hidden until then.
- **Reply…** (in the card): starts `Re #12 "…": ` in the composer; you send it.

A link that is a file on the host (added before 0.3.0) shows in red with a
warning: it doesn't open on the web.

## How agents use it

```sh
bb waiting add "Pick a profile grid" --need "pick 1, 2 or 3" --choice 1 --choice 2 --choice 3 \
  --link "https://foundkeep.app/notpritamsharma|Profile" --project FoundKeep --req R-173
bb waiting edit 12 --choice Yes --choice No
bb waiting list [--everywhere] [--all]     # open items, and answers not picked up yet
bb waiting answers [--ack] [--everywhere]  # the answers; --ack marks this thread's picked up
bb waiting done 12 | reopen 12 | remove 12
```

Agent tools: `waiting_add` (with `choices`), `waiting_done`, `waiting_list`
(`ack: true` picks the thread's answers up). The skill in
`skills/waiting-on-you` carries the rule: *when you hand the user something
to look at or decide, add it here with its link; give choices when the
answers are fixed; read their answers, act on them, then ack them.*

**Answers reach the agent without a message.** Each thread with items has a
file, rewritten on every change:

- `$BB_THREAD_STORAGE/waiting-on-you.md`: the thread's storage folder, as
  the thread's agent sees it (written through bb, on whichever machine the
  thread runs). If that folder can't be written, the file goes to
  `threads/<thread id>.md` in the plugin's data folder, and the agent's
  instructions name that path instead.
- Markdown, three sections: **Answers not picked up yet** (`- #12 "Keep the
  handle?": Yes (answered by the user, 2026-10-17 14:02 UTC)`, or `None.`),
  **Waiting on the user** (each open item with what is needed, its choices
  and links) and, when there are any, **"Do now"** items.

The agent's instructions (built when its session starts) list the thread's
open items, the "Do now" ones, the **answers since it last looked**, any item
whose link is a host path, and the file's path. Because a running session
keeps the instructions it started with, the file, `waiting_list` and
`bb waiting answers` are the live view. Once the agent acts on the answers it
acks them (`waiting_list` with `ack: true`, `bb waiting answers --ack`, or
`waiting_done` on the item); they leave the card, the file and the
instructions, and stay on record (`bb waiting list --all`). Answers you send
with **Send answers** count as picked up.

Links must open on the web, since you may read bb from another device:
`https://…` URLs and `thr_…` thread ids. Local paths (`/home/…`, `~/…`,
`file:…`) are refused with a hint: publish the file (for example with
`omni-media`) or link it on GitHub or the dev site. `target|Label` sets the
label.

## Improvements

[IMPROVEMENTS.md](IMPROVEMENTS.md) is the one list of what to change next.
Add new asks there rather than messaging the thread working on the plugin;
read it before starting work, and move items to Done with their version.

## Development

```sh
npm install
npm run typecheck
npm test                   # better-sqlite3 is built for the Node bb runs on: PATH=/usr/bin:$PATH npm test
bb plugin install .        # path install, builds in place
bb plugin dev              # rebuild + reload on save
```

State lives in the plugin's SQLite database (`bb.storage.database()`).
