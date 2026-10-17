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

Nothing open.

## Proposed (ours, waiting on Pritam's yes)

- [ ] **A tick on a question tells its thread.** Ticking a question item
  with the check mark, instead of tapping a choice, closes it without telling
  the thread that asked, so the agent can't tell "done" from "skipped". On
  16 Oct five FoundKeep questions were ticked this way and their threads had
  to treat them as "no change". Idea: a tick on an item with choices sends
  `Re #n "…": closed without an answer` to its thread, or asks "Done or
  skip?" first. Found 2026-10-16, not asked yet.

## Done

- [x] **Answers are kept, not sent** (v0.3.0, 2026-10-17, R-105): tapping a
  choice keeps the answer (who, item, choice, time) and ticks the item as
  answered; nothing is sent. The answer shows quietly in place on the card
  until the thread's agent picks it up. Each thread has a file its agent
  reads, `$BB_THREAD_STORAGE/waiting-on-you.md` (or `threads/<id>.md` in the
  plugin's data folder when thread storage can't be written), rewritten on
  every change: answers not picked up yet, then what still waits, then
  "Do now". The agent's instructions gain "Answers since you last looked" and
  the file's path; `waiting_list` and `bb waiting list` show each answer;
  `bb waiting answers --ack` or `waiting_list` with `ack: true` marks them
  picked up. The card's one "Send answers" sends every pending answer of the
  thread in one message. "Reply…" and "Do now" still send. Answers from
  before 0.3.0 count as sent.
- [x] **Links must open on the web** (v0.3.0, 2026-10-17, R-104):
  `waiting_add`, `bb waiting add` and `bb waiting edit` refuse local paths
  (`/home/…`, `~/…`, `file:`) with a hint (publish with `omni-media`, link
  GitHub or the dev site, or a `thr_…` id); `https://` and `thr_` stay. An
  older item whose link is a path shows the link in red with a warning on
  the card, and is flagged in the CLI, the tools and the agent's
  instructions.
- [x] **More than a check mark** (v0.2.0, 2026-10-16, R-102): choices as
  buttons that answer in the item's thread; a row menu with Do now, Next,
  Later (tomorrow, next week, a date) and Reply…; `bb waiting edit` and
  `waiting_add` choices.
- [x] **The checklist** (v0.1.0, 2026-10-16, R-101): a card above the
  composer like bb's To-do and Running cards, a home-screen section across
  threads, `bb waiting` CLI and the `waiting_*` tools.
