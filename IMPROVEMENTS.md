# Waiting on you: improvements

The one list of what to change in this plugin. New asks are added here, from
any thread, instead of being sent as a message to the thread working on the
plugin (a message interrupts that agent). Whoever works on the plugin next
reads this file first, builds the open items, and moves each one to Done with
its version.

Each item: a checkbox, a short title, then the ask in plain words, the date
and its HQ requirement (`R-<n>` in `~/personal/apps/hq-platform/docs/requirements.md`,
where Pritam's own words are kept).

## Open

- [ ] **Answers are kept, not sent.** Tapping a choice sends `Re #n "…": Yes`
  to the item's thread at once, which interrupts its agent mid-turn (on 17
  Oct nine answers landed one by one inside other work). Store the answer
  instead: in a file the thread's agent can read, and in `waiting_list` /
  `bb waiting`, so the agent picks answers up at its next turn or when asked.
  Pritam: "it should store in a file which access will have the agent so
  instead of sending each answer one by one agent can just read there when
  required or requested". 2026-10-17, R-105.
- [ ] **Links must open on the web.** Pritam reads bb remotely, so a link to
  a file on the host (`/home/…`, `~/…`) doesn't open for him, and agents
  keep adding them. `waiting_add`, `bb waiting add` and `bb waiting edit`
  should refuse a local path with a clear message (publish it with
  `omni-media`, or link GitHub or the dev site), and the card should flag any
  existing item whose link is a path. 2026-10-16, R-104.

## Proposed (ours, waiting on Pritam's yes)

- [ ] **A tick on a question tells its thread.** Ticking a question item
  with the check mark, instead of tapping a choice, closes it without telling
  the thread that asked, so the agent can't tell "done" from "skipped". On
  16 Oct five FoundKeep questions were ticked this way and their threads had
  to treat them as "no change". Idea: a tick on an item with choices sends
  `Re #n "…": closed without an answer` to its thread, or asks "Done or
  skip?" first. Found 2026-10-16, not asked yet.

## Done

- [x] **More than a check mark** (v0.2.0, 2026-10-16, R-102): choices as
  buttons that answer in the item's thread; a row menu with Do now, Next,
  Later (tomorrow, next week, a date) and Reply…; `bb waiting edit` and
  `waiting_add` choices.
- [x] **The checklist** (v0.1.0, 2026-10-16, R-101): a card above the
  composer like bb's To-do and Running cards, a home-screen section across
  threads, `bb waiting` CLI and the `waiting_*` tools.
