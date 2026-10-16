# Waiting on you (bb-plugin-waiting)

A bb plugin that keeps a check-mark list of what is ready for you: a review
page to open, a pick to make, a yes or no. Each item carries its link, so you
never dig through a chat to find it.

## Where it shows

- **Above the composer** of the thread it belongs to, drawn like bb's own
  To-do, Running and Uncommitted cards: `Waiting on you · 3`. Expand it to
  see each item with what is needed, its links, the product, the R-number and
  when it was added. Tick an item and it folds away.
- **On the home screen**, a "Waiting on you" section with everything open
  across threads and projects, grouped by product, each with a link to its
  thread.

## How agents use it

```sh
bb waiting add "Pick a profile grid" --need "pick 1, 2 or 3" \
  --link "https://foundkeep.app/notpritamsharma|Profile" --project FoundKeep --req R-173
bb waiting list [--everywhere] [--all]
bb waiting done 12 | reopen 12 | remove 12
```

Agent tools: `waiting_add`, `waiting_done`, `waiting_list`. The skill in
`skills/waiting-on-you` carries the rule: *when you hand the user something to
look at or decide, add it here with its link.* The thread's open items are
also appended to the agent's instructions, so it can tick one off when their
reply answers it.

Links accept `https://…`, absolute paths, `~/…` (on the thread's machine) and
`thr_…` thread ids; `target|Label` sets the label.

## Development

```sh
npm install
npm run typecheck
npm test
bb plugin install .        # path install, builds in place
bb plugin dev              # rebuild + reload on save
```

State lives in the plugin's SQLite database (`bb.storage.database()`).
