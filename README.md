# Waiting on you (bb-plugin-waiting)

A bb plugin that keeps a check-mark list of what is ready for you: a review
page to open, a pick to make, a yes or no. Each item carries its link, so you
never dig through a chat to find it. Answer right on the card.

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
  sit on the row as small buttons. Tap one and it is sent to the item's
  thread as your message (`Re #12 "Keep the handle?": Yes`), so the agent
  acts on it; the item is ticked off.
- **Do now** (row menu): tells the thread's agent to go ahead; the item leaves
  the card and the agent ticks it off when finished.
- **Next**: moves it to the top.
- **Later**: tomorrow, next week or a date you pick; hidden until then.
- **Reply…** (in the card): starts `Re #12 "…": ` in the composer.

## How agents use it

```sh
bb waiting add "Pick a profile grid" --need "pick 1, 2 or 3" --choice 1 --choice 2 --choice 3 \
  --link "https://foundkeep.app/notpritamsharma|Profile" --project FoundKeep --req R-173
bb waiting edit 12 --choice Yes --choice No
bb waiting list [--everywhere] [--all]
bb waiting done 12 | reopen 12 | remove 12
```

Agent tools: `waiting_add` (with `choices`), `waiting_done`, `waiting_list`.
The skill in `skills/waiting-on-you` carries the rule: *when you hand the user
something to look at or decide, add it here with its link; give choices when
the answers are fixed.* The thread's open items, and the ones the user said
"Do now" to, are appended to the agent's instructions.

Links accept `https://…`, absolute paths, `~/…` (on the thread's machine) and
`thr_…` thread ids; `target|Label` sets the label.

## Improvements

[IMPROVEMENTS.md](IMPROVEMENTS.md) is the one list of what to change next.
Add new asks there rather than messaging the thread working on the plugin;
read it before starting work, and move items to Done with their version.

## Development

```sh
npm install
npm run typecheck
npm test
bb plugin install .        # path install, builds in place
bb plugin dev              # rebuild + reload on save
```

State lives in the plugin's SQLite database (`bb.storage.database()`).
