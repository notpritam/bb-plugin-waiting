import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import {
  MIGRATIONS,
  WaitingStore,
  answersFileText,
  answersMessage,
  formatItemLine,
  isLocalPathTarget,
  parseItemId,
  parseLinkTarget,
  parseLinkTargets,
  type Item,
} from "../store";

interface SentMessage {
  threadId: string;
  mode: string;
  input: { type: string; text?: string }[];
}

interface WrittenFile {
  hostId?: string;
  path: string;
  content: string;
  createParents?: boolean;
}

async function host(options: { storage?: "ok" | "fails" } = {}) {
  const sent: SentMessage[] = [];
  const files: WrittenFile[] = [];
  const created = createFakePluginHost({
    pluginId: "waiting",
    sdk: {
      threads: {
        get: async () => ({
          id: "thr_1",
          title: "FoundKeep HQ",
          projectId: "proj_1",
          environmentId: "env_1",
        }),
        send: async (args: SentMessage) => {
          sent.push(args);
          return { ok: true, delivery: "sent" };
        },
        storageLocation: async ({ threadId }: { threadId: string }) => {
          if (options.storage === "fails") throw new Error("host offline");
          return { hostId: "host_omni", storageRootPath: `/srv/bb/thread-storage/${threadId}` };
        },
      },
      files: {
        write: async (args: WrittenFile) => {
          files.push(args);
          return { ok: true };
        },
      },
      projects: { get: async () => ({ id: "proj_1", name: "FoundKeep" }) },
    },
  });
  await plugin(created.bb);
  /** The latest content written to a thread's answers file in thread storage. */
  const fileFor = (threadId: string) =>
    files.filter((file) => file.path === `/srv/bb/thread-storage/${threadId}/waiting-on-you.md`).at(-1)
      ?.content ?? null;
  return { ...created, sent, files, fileFor };
}

const ctx = { threadId: "thr_1", projectId: "proj_1" };

interface ListResult {
  items: Item[];
  returnsAt: number | null;
}

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: 3,
    title: "Delete the old collection?",
    needed: "yes or no",
    links: [{ kind: "url", url: "https://foundkeep.app/a", label: null }],
    choices: [],
    threadId: null,
    projectId: null,
    project: "FoundKeep",
    requirement: "R-160",
    status: "open",
    answer: null,
    answeredAt: null,
    pickedUpAt: null,
    sentAt: null,
    laterUntil: null,
    nextAt: null,
    createdAt: 0,
    doneAt: null,
    doneBy: null,
    ...overrides,
  };
}

describe("store helpers", () => {
  it("parses item ids in the forms agents type", () => {
    expect(parseItemId("12")).toBe(12);
    expect(parseItemId("#12")).toBe(12);
    expect(parseItemId("w7")).toBe(7);
    expect(parseItemId("twelve")).toBeNull();
    expect(parseItemId("0")).toBeNull();
  });

  it("parses link targets", () => {
    expect(parseLinkTarget("https://foundkeep.app/x|Profile")).toEqual({
      kind: "url",
      url: "https://foundkeep.app/x",
      label: "Profile",
    });
    expect(parseLinkTarget("@thread:thr_abc")).toEqual({
      kind: "thread",
      threadId: "thr_abc",
      label: null,
    });
    expect(parseLinkTarget("thr_abc|Review thread")).toEqual({
      kind: "thread",
      threadId: "thr_abc",
      label: "Review thread",
    });
    expect(parseLinkTarget("not a link")).toBeNull();
    expect(parseLinkTarget("~/docs/a.md")).toBeNull();
  });

  it("refuses local paths: they don't open on the web", () => {
    for (const target of [
      "/home/pritam/docs/a.md",
      "~/docs/a.md",
      "~",
      "file:///home/pritam/a.png",
      "FILE:/tmp/x",
      "/tmp/shot.png|Screenshot",
    ]) {
      expect(isLocalPathTarget(target)).toBe(true);
    }
    for (const target of ["https://github.com/notpritam/x", "thr_abc", "docs/a.md"]) {
      expect(isLocalPathTarget(target)).toBe(false);
    }
    const refused = parseLinkTargets(["https://foundkeep.app", "~/notes/grid.md", "/home/pritam/x.png|Shot"]);
    expect(refused).toEqual({
      error: expect.stringContaining("a local path doesn't open for the user on the web: ~/notes/grid.md, /home/pritam/x.png"),
    });
    expect("error" in refused && refused.error).toContain("omni-media");
    expect("error" in refused && refused.error).toContain("thr_");
    const mixed = parseLinkTargets(["just words", "~/a"]);
    expect("error" in mixed && mixed.error).toMatch(/local path.*~\/a; not a link: just words/u);
    expect(parseLinkTargets(["https://a.example/x", "thr_q1"])).toEqual({
      links: [
        { kind: "url", url: "https://a.example/x", label: null },
        { kind: "thread", threadId: "thr_q1", label: null },
      ],
    });
  });

  it("formats one readable line per item", () => {
    expect(formatItemLine(item())).toBe(
      "[ ] #3 Delete the old collection? — yes or no (FoundKeep · R-160)\n      https://foundkeep.app/a",
    );
    expect(formatItemLine(item({ choices: ["Yes", "No"], links: [] }))).toBe(
      "[ ] #3 Delete the old collection? — yes or no [Yes / No] (FoundKeep · R-160)",
    );
    expect(
      formatItemLine(item({ status: "done", answer: "Yes", links: [] })),
    ).toBe("[x] #3 Delete the old collection? — yes or no (FoundKeep · R-160) → Yes");
    expect(formatItemLine(item({ status: "doing", links: [] }))).toBe(
      "[>] #3 Delete the old collection? — yes or no (FoundKeep · R-160) → do now",
    );
    const later = Date.UTC(2026, 9, 20, 9);
    expect(formatItemLine(item({ laterUntil: later, links: [] }), later - 1000)).toContain(
      "later: 20 Oct",
    );
    const answeredAt = Date.UTC(2026, 9, 17, 14, 2);
    expect(
      formatItemLine(item({ status: "done", answer: "Yes", answeredAt, links: [] })),
    ).toBe(
      "[x] #3 Delete the old collection? — yes or no (FoundKeep · R-160) → Yes (answered 2026-10-17 14:02 UTC, not picked up yet)",
    );
    expect(
      formatItemLine(
        item({ status: "done", answer: "Yes", answeredAt, pickedUpAt: answeredAt, sentAt: answeredAt, links: [] }),
      ),
    ).toBe("[x] #3 Delete the old collection? — yes or no (FoundKeep · R-160) → Yes (sent)");
    expect(
      formatItemLine(item({ links: [{ kind: "file", hostId: "h", path: "/home/p/a.md", label: null }] })),
    ).toContain("/home/p/a.md (a file on the host: doesn't open on the web");
  });

  it("puts every answer in one message", () => {
    expect(
      answersMessage([
        item({ id: 12, title: "Keep the handle?", answer: "Yes" }),
        item({ id: 14, title: "Pick a  grid", answer: "2" }),
      ]),
    ).toBe('Answers: #12 "Keep the handle?": Yes; #14 "Pick a grid": 2');
  });

  it("writes the answers file: answers first, then what waits, then do now", () => {
    const now = Date.UTC(2026, 9, 17, 14, 5);
    const text = answersFileText({
      threadId: "thr_1",
      now,
      items: [
        item({ id: 12, title: "Keep the handle?", status: "done", answer: "Yes", answeredAt: Date.UTC(2026, 9, 17, 14, 2) }),
        item({ id: 14, title: "Pick a grid", needed: "pick one", choices: ["1", "2"], requirement: null }),
        item({ id: 15, title: "Add the alias", status: "doing", links: [] }),
      ],
    });
    expect(text).toContain("Kept by the Waiting on you plugin for thread thr_1; rewritten on every change. Updated 2026-10-17 14:05 UTC.");
    expect(text).toContain(
      '## Answers not picked up yet\n\n- #12 "Keep the handle?": Yes (answered by the user, 2026-10-17 14:02 UTC)',
    );
    expect(text).toContain("`bb waiting answers --ack`");
    expect(text).toContain("## Waiting on the user\n\n- #14 Pick a grid: pick one [1 / 2] (FoundKeep)\n  - https://foundkeep.app/a");
    expect(text).toContain('## "Do now" (do these, then call waiting_done with the number)\n\n- #15 Add the alias');
    expect(text.indexOf("#12")).toBeLessThan(text.indexOf("#14"));
    const empty = answersFileText({ threadId: "thr_1", now, items: [] });
    expect(empty).toContain("## Answers not picked up yet\n\nNone.");
    expect(empty).toContain("## Waiting on the user\n\nNothing.");
  });

  it("marks answers given before 0.3.0 as already sent", () => {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS.slice(0, 6)) db.exec(statement);
    db.prepare(
      `INSERT INTO items (title, links, choices, status, created_at, done_at, done_by, answer)
       VALUES ('Old question', '[]', '["Yes","No"]', 'done', 1, 5, 'user', 'Yes')`,
    ).run();
    for (const statement of MIGRATIONS.slice(6)) db.exec(statement);
    const store = new WaitingStore(db);
    expect(store.get(1)).toMatchObject({ answer: "Yes", answeredAt: 5, sentAt: 5, pickedUpAt: 5 });
    expect(store.pendingAnswers(null)).toEqual([]);
    db.close();
  });
});

describe("bb waiting", () => {
  it("adds, lists, ticks off and folds away items per thread", async () => {
    const { harness } = await host();
    const added = await harness.behavior.runCli(
      [
        "add",
        "Pick a profile grid",
        "--need",
        "pick 1, 2 or 3",
        "--link",
        "https://foundkeep.app/notpritamsharma|Profile",
        "--link",
        "thr_grid|Grid thread",
        "--choice",
        "1",
        "--choice",
        "2",
        "--choice",
        "3",
        "--req",
        "173",
        "--json",
      ],
      ctx,
    );
    expect(added.exitCode).toBe(0);
    const parsed = JSON.parse(added.stdout ?? "{}") as Item;
    expect(parsed.project).toBe("FoundKeep");
    expect(parsed.requirement).toBe("R-173");
    expect(parsed.threadId).toBe("thr_1");
    expect(parsed.choices).toEqual(["1", "2", "3"]);
    expect(parsed.links.map((link) => link.kind)).toEqual(["url", "thread"]);
    expect(harness.realtimeSignals.length).toBe(1);

    const listed = await harness.behavior.callRpc("list", { threadId: "thr_1" });
    expect(listed).toMatchObject({
      items: [{ id: parsed.id, status: "open" }],
      threads: { thr_1: { title: "FoundKeep HQ" } },
      returnsAt: null,
    });

    const other = await harness.behavior.callRpc("list", { threadId: "thr_2" });
    expect(other).toMatchObject({ items: [] });

    const done = await harness.behavior.runCli(["done", `#${parsed.id}`]);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain("[x]");

    const open = await harness.behavior.callRpc("list", { threadId: "thr_1" });
    expect(open).toMatchObject({ items: [] });
    const all = await harness.behavior.callRpc("list", {
      threadId: "thr_1",
      includeDone: true,
    });
    expect(all).toMatchObject({
      items: [{ id: parsed.id, status: "done", doneBy: "agent" }],
    });

    const missing = await harness.behavior.runCli(["done", "999"]);
    expect(missing.exitCode).not.toBe(0);
    await harness.lifecycle.dispose();
  });

  it("rejects targets that are not links", async () => {
    const { harness } = await host();
    const result = await harness.behavior.runCli(
      ["add", "Broken", "--link", "just words"],
      { threadId: "thr_1" },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not a link");
    await harness.lifecycle.dispose();
  });

  it("edits choices and wording in place", async () => {
    const { harness } = await host();
    await harness.behavior.runCli(["add", "Count Do Not Track visits?", "--need", "yes or no"], ctx);
    const edited = await harness.behavior.runCli(
      ["edit", "1", "--choice", "Yes", "--choice", "No", "--need", "yes or no; default is no", "--json"],
      ctx,
    );
    expect(edited.exitCode).toBe(0);
    expect(JSON.parse(edited.stdout ?? "{}")).toMatchObject({
      id: 1,
      choices: ["Yes", "No"],
      needed: "yes or no; default is no",
    });
    const cleared = await harness.behavior.runCli(["edit", "1", "--choice", "none", "--json"], ctx);
    expect(JSON.parse(cleared.stdout ?? "{}")).toMatchObject({ choices: [] });
    const missing = await harness.behavior.runCli(["edit", "9", "--title", "x"], ctx);
    expect(missing.exitCode).not.toBe(0);
    await harness.lifecycle.dispose();
  });

  it("refuses local paths in add, edit and waiting_add", async () => {
    const { harness } = await host();
    const added = await harness.behavior.runCli(
      ["add", "Read the plan", "--link", "/home/pritam/plan.md"],
      ctx,
    );
    expect(added.exitCode).not.toBe(0);
    expect(added.stderr).toContain("a local path doesn't open for the user on the web: /home/pritam/plan.md");
    expect(added.stderr).toContain("omni-media");

    await harness.behavior.runCli(["add", "Read the plan", "--link", "https://github.com/notpritam/x"], ctx);
    const edited = await harness.behavior.runCli(["edit", "1", "--link", "~/plan.md"], ctx);
    expect(edited.exitCode).not.toBe(0);
    expect(edited.stderr).toContain("~/plan.md");
    const kept = (await harness.behavior.callRpc("list", { threadId: "thr_1" })) as ListResult;
    expect(kept.items[0]?.links).toEqual([
      { kind: "url", url: "https://github.com/notpritam/x", label: null },
    ]);

    const tool = (await harness.behavior.callAgentTool(
      "waiting_add",
      { title: "See the shot", links: [{ target: "file:///tmp/shot.png" }] },
      ctx,
    )) as { isError?: boolean; content?: { text: string }[] };
    expect(tool.isError).toBe(true);
    expect(tool.content?.[0]?.text).toContain("Not added: a local path");

    const allowed = await harness.behavior.callAgentTool(
      "waiting_add",
      { title: "See the thread", links: [{ target: "thr_abc", label: "Review" }] },
      ctx,
    );
    expect(String(allowed)).toContain("Added [ ] #2 See the thread");
    await harness.lifecycle.dispose();
  });

  it("keeps an answer from the card for the agent instead of sending it", async () => {
    const { harness, sent, files, fileFor } = await host();
    await harness.behavior.callAgentTool(
      "waiting_add",
      { title: "Delete the old collection?", needed: "yes or no", choices: ["Yes", "No"] },
      ctx,
    );
    await harness.behavior.callAgentTool("waiting_add", { title: "Pick a grid", choices: ["1", "2"] }, ctx);
    const answered = await harness.behavior.callRpc("act", {
      id: 1,
      action: { kind: "answer", answer: "Yes" },
    });
    expect(answered).toMatchObject({ status: "done", doneBy: "user", answer: "Yes", pickedUpAt: null, sentAt: null });
    expect((answered as Item).answeredAt).toEqual(expect.any(Number));
    // Nothing is sent: the agent working in the thread is not interrupted.
    expect(sent).toEqual([]);

    // The card keeps it, in place, until the agent picks it up.
    const card = (await harness.behavior.callRpc("list", { threadId: "thr_1" })) as ListResult;
    expect(card.items.map((entry) => [entry.id, entry.answer])).toEqual([
      [1, "Yes"],
      [2, null],
    ]);

    // The thread's file, in its storage folder, has it.
    const file = fileFor("thr_1") ?? "";
    expect(files.at(-1)).toMatchObject({ hostId: "host_omni", createParents: true });
    expect(file).toMatch(/## Answers not picked up yet\n\n- #1 "Delete the old collection\?": Yes \(answered by the user, \d{4}-\d\d-\d\d \d\d:\d\d UTC\)/u);
    expect(file).toContain("- #2 Pick a grid [1 / 2]");

    // So do the instructions, the tool and the CLI.
    const instructions = harness.registrations.instructionProvider?.(ctx) ?? "";
    expect(instructions).toContain("Answers since you last looked");
    expect(instructions).toContain('- #1 "Delete the old collection?": Yes');
    expect(instructions).toContain("$BB_THREAD_STORAGE/waiting-on-you.md");
    const listed = String(
      await harness.behavior.callAgentTool("waiting_list", { scope: "thread", includeDone: false, ack: false }, ctx),
    );
    expect(listed).toContain("[x] #1 Delete the old collection? — yes or no [Yes / No] (FoundKeep) → Yes (answered");
    expect(listed).toContain("1 answer from the card not picked up yet");
    const cliList = await harness.behavior.runCli(["list"], ctx);
    expect(cliList.stdout).toContain("#1 Delete the old collection?");
    expect(cliList.stdout).toContain("→ Yes (answered");
    const cliAnswers = await harness.behavior.runCli(["answers"], ctx);
    expect(cliAnswers.stdout).toMatch(/^#1 "Delete the old collection\?": Yes \(answered /u);

    // Picked up: it leaves the card, the file and the instructions; the answer stays on record.
    const acked = String(
      await harness.behavior.callAgentTool("waiting_list", { scope: "thread", includeDone: false, ack: true }, ctx),
    );
    expect(acked).toContain('Picked up 1 answer: #1 "Delete the old collection?": Yes');
    const after = (await harness.behavior.callRpc("list", { threadId: "thr_1" })) as ListResult;
    expect(after.items.map((entry) => entry.id)).toEqual([2]);
    expect(fileFor("thr_1")).toContain("## Answers not picked up yet\n\nNone.");
    expect(harness.registrations.instructionProvider?.(ctx)).not.toContain("Answers since you last looked");
    const again = await harness.behavior.runCli(["answers", "--ack"], ctx);
    expect(again.stdout).toBe("No answers waiting.");
    const record = await harness.behavior.runCli(["list", "--all", "--json"], ctx);
    expect(JSON.parse(record.stdout ?? "{}").items).toContainEqual(
      expect.objectContaining({ id: 1, answer: "Yes", pickedUpAt: expect.any(Number) }),
    );
    expect(sent).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("takes an answer back with the check mark, and waiting_done keeps it", async () => {
    const { harness } = await host();
    await harness.behavior.callAgentTool("waiting_add", { title: "Keep the handle?", choices: ["Yes", "No"] }, ctx);
    await harness.behavior.callRpc("act", { id: 1, action: { kind: "answer", answer: "No" } });
    const back = await harness.behavior.callRpc("setDone", { id: 1, done: false });
    expect(back).toMatchObject({ status: "open", answer: null, answeredAt: null });

    await harness.behavior.callRpc("act", { id: 1, action: { kind: "answer", answer: "Yes" } });
    const done = String(await harness.behavior.callAgentTool("waiting_done", { id: 1 }, ctx));
    expect(done).toContain("→ Yes");
    const answers = await harness.behavior.runCli(["answers", "--json"], ctx);
    expect(JSON.parse(answers.stdout ?? "{}")).toMatchObject({ answers: [] });
    await harness.lifecycle.dispose();
  });

  it("sends every kept answer in one message with Send answers", async () => {
    const { harness, sent, fileFor } = await host();
    for (const title of ["Keep the handle?", "Pick a grid", "Turn it on?"]) {
      await harness.behavior.callAgentTool("waiting_add", { title, choices: ["Yes", "No", "2"] }, ctx);
    }
    await harness.behavior.runCli(["add", "Elsewhere?", "--choice", "Yes", "--thread", "thr_2"], ctx);
    await harness.behavior.callRpc("act", { id: 1, action: { kind: "answer", answer: "Yes" } });
    await harness.behavior.callRpc("act", { id: 2, action: { kind: "answer", answer: "2" } });
    await harness.behavior.callRpc("act", { id: 4, action: { kind: "answer", answer: "Yes" } });
    expect(sent).toEqual([]);

    const result = await harness.behavior.callRpc("sendAnswers", { threadId: "thr_1" });
    expect(result).toEqual({ sent: 2, text: 'Answers: #1 "Keep the handle?": Yes; #2 "Pick a grid": 2' });
    expect(sent).toEqual([
      {
        threadId: "thr_1",
        mode: "auto",
        input: [{ type: "text", text: 'Answers: #1 "Keep the handle?": Yes; #2 "Pick a grid": 2', mentions: [] }],
      },
    ]);
    // Sent answers are picked up: off the card and the file; the other thread's answer stays.
    const card = (await harness.behavior.callRpc("list", { threadId: "thr_1" })) as ListResult;
    expect(card.items.map((entry) => entry.id)).toEqual([3]);
    expect(fileFor("thr_1")).toContain("## Answers not picked up yet\n\nNone.");
    const cli = await harness.behavior.runCli(["list", "--all"], ctx);
    expect(cli.stdout).toContain("#1 Keep the handle? [Yes / No / 2] (FoundKeep) → Yes (sent)");
    const elsewhere = await harness.behavior.runCli(["answers", "--everywhere"], ctx);
    expect(elsewhere.stdout).toContain('#4 "Elsewhere?": Yes');
    expect(elsewhere.stdout).toContain("@thread:thr_2");
    const ackEverywhere = await harness.behavior.runCli(["answers", "--everywhere", "--ack"], ctx);
    expect(ackEverywhere.exitCode).not.toBe(0);

    // Nothing left to send.
    await expect(harness.behavior.callRpc("sendAnswers", { threadId: "thr_1" })).rejects.toThrow();
    expect(sent.length).toBe(1);
    await harness.lifecycle.dispose();
  });

  it("falls back to a file in the plugin's folder when thread storage can't be written", async () => {
    const { harness, bb, files } = await host({ storage: "fails" });
    await harness.behavior.callAgentTool("waiting_add", { title: "Keep the handle?", choices: ["Yes", "No"] }, ctx);
    await harness.behavior.callRpc("act", { id: 1, action: { kind: "answer", answer: "Yes" } });
    expect(files).toEqual([]);
    const path = join(dirname(bb.storage.database().name), "threads", "thr_1.md");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain('- #1 "Keep the handle?": Yes');
    expect(harness.registrations.instructionProvider?.(ctx)).toContain(`The live list is ${path}`);
    await harness.lifecycle.dispose();
  });

  it("flags items whose link is a host path", async () => {
    const { harness, bb } = await host();
    await harness.behavior.callAgentTool("waiting_add", { title: "Old item" }, ctx);
    bb.storage
      .database()
      .prepare(`UPDATE items SET links = ? WHERE id = 1`)
      .run(JSON.stringify([{ kind: "file", hostId: "host_omni", path: "/home/pritam/a.md", label: null }]));
    expect(harness.registrations.instructionProvider?.(ctx)).toContain(
      "These link to a file on the host, which doesn't open for the user on the web: #1.",
    );
    const cli = await harness.behavior.runCli(["list"], ctx);
    expect(cli.stdout).toContain("/home/pritam/a.md (a file on the host: doesn't open on the web");
    await harness.lifecycle.dispose();
  });

  it("hands an item to the agent with Do now", async () => {
    const { harness, sent } = await host();
    await harness.behavior.callAgentTool("waiting_add", { title: "Add the dmarc@ alias" }, ctx);
    const doing = await harness.behavior.callRpc("act", { id: 1, action: { kind: "doNow" } });
    expect(doing).toMatchObject({ status: "doing" });
    expect(sent[0]?.input[0]?.text).toBe('Re #1 "Add the dmarc@ alias": do it now, go ahead.');

    // Off the card, but the agent is told to finish it.
    const open = await harness.behavior.callRpc("list", { threadId: "thr_1" });
    expect(open).toMatchObject({ items: [] });
    const instructions = harness.registrations.instructionProvider?.(ctx) ?? "";
    expect(instructions).toContain('pressed "Do now"');
    expect(instructions).toContain("#1 Add the dmarc@ alias");

    const finished = await harness.behavior.callAgentTool("waiting_done", { id: 1 }, ctx);
    expect(String(finished)).toContain("[x] #1");
    expect(harness.registrations.instructionProvider?.(ctx)).toBeNull();
    await harness.lifecycle.dispose();
  });

  it("puts items off for later and moves others up next", async () => {
    const { harness } = await host();
    for (const title of ["First", "Second", "Third"]) {
      await harness.behavior.callAgentTool("waiting_add", { title }, ctx);
    }
    const until = Date.now() + 60 * 60 * 1000;
    await harness.behavior.callRpc("act", { id: 1, action: { kind: "later", until } });
    await harness.behavior.callRpc("act", { id: 3, action: { kind: "next" } });

    const card = (await harness.behavior.callRpc("list", { threadId: "thr_1" })) as ListResult;
    expect(card.items.map((entry) => entry.id)).toEqual([3, 2]);
    expect(card.returnsAt).toBe(until);

    // The CLI and the agent still see the later item, marked.
    const cli = await harness.behavior.runCli(["list"], ctx);
    expect(cli.stdout).toContain("#1 First (FoundKeep · later:");
    expect(harness.registrations.instructionProvider?.(ctx)).toContain("#1 First — put off until");

    // "Next" brings a later item straight back.
    await harness.behavior.callRpc("act", { id: 1, action: { kind: "next" } });
    const back = (await harness.behavior.callRpc("list", { threadId: "thr_1" })) as ListResult;
    expect(back.items.map((entry) => entry.id)).toEqual([1, 3, 2]);
    expect(back.returnsAt).toBeNull();
    await harness.lifecycle.dispose();
  });

  it("exposes tools and lists the thread's open items in instructions", async () => {
    const { harness } = await host();
    const added = await harness.behavior.callAgentTool(
      "waiting_add",
      {
        title: "Turn Show my finds on",
        needed: "on or off",
        choices: ["On", "Off"],
        links: [{ target: "https://foundkeep.app/notpritamsharma", label: "Profile" }],
        requirement: "R-177",
      },
      ctx,
    );
    expect(String(added)).toContain("#1 Turn Show my finds on — on or off [On / Off]");

    const listed = await harness.behavior.callAgentTool(
      "waiting_list",
      { scope: "thread", includeDone: false, ack: false },
      ctx,
    );
    expect(String(listed)).toContain("https://foundkeep.app/notpritamsharma");

    const instructions = harness.registrations.instructionProvider;
    expect(instructions).not.toBeNull();
    expect(instructions?.(ctx)).toContain("#1 Turn Show my finds on (on or off) [On / Off]");
    expect(instructions?.({ threadId: "thr_2", projectId: "proj_1" })).toBeNull();

    const ticked = await harness.behavior.callAgentTool("waiting_done", { id: 1 }, ctx);
    expect(String(ticked)).toContain("[x] #1");
    await harness.lifecycle.dispose();
  });
});
