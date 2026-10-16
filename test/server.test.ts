import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { formatItemLine, parseItemId, parseLinkTarget, type Item } from "../store";

interface SentMessage {
  threadId: string;
  mode: string;
  input: { type: string; text?: string }[];
}

async function host() {
  const sent: SentMessage[] = [];
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
      },
      projects: { get: async () => ({ id: "proj_1", name: "FoundKeep" }) },
      environments: { get: async () => ({ id: "env_1", hostId: "host_omni" }) },
      system: { config: async () => ({ primaryHostId: "host_omni" }) },
    },
  });
  await plugin(created.bb);
  return { ...created, sent };
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
    const context = { hostId: "host_omni", homeDir: "/home/pritam" };
    expect(parseLinkTarget("https://foundkeep.app/x|Profile", context)).toEqual({
      kind: "url",
      url: "https://foundkeep.app/x",
      label: "Profile",
    });
    expect(parseLinkTarget("~/docs/a.md", context)).toEqual({
      kind: "file",
      hostId: "host_omni",
      path: "/home/pritam/docs/a.md",
      label: null,
    });
    expect(parseLinkTarget("@thread:thr_abc", context)).toEqual({
      kind: "thread",
      threadId: "thr_abc",
      label: null,
    });
    expect(parseLinkTarget("not a link", context)).toBeNull();
    expect(parseLinkTarget("~/x", { hostId: "h", homeDir: null })).toBeNull();
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
        "~/notes/grid.md",
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
    expect(parsed.links.map((link) => link.kind)).toEqual(["url", "file"]);
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

  it("answers from the card into the item's thread and ticks it off", async () => {
    const { harness, sent } = await host();
    await harness.behavior.callAgentTool(
      "waiting_add",
      { title: "Delete the old collection?", needed: "yes or no", choices: ["Yes", "No"] },
      ctx,
    );
    const answered = await harness.behavior.callRpc("act", {
      id: 1,
      action: { kind: "answer", answer: "Yes" },
    });
    expect(answered).toMatchObject({ status: "done", doneBy: "user", answer: "Yes" });
    expect(sent).toEqual([
      {
        threadId: "thr_1",
        mode: "auto",
        input: [{ type: "text", text: 'Re #1 "Delete the old collection?": Yes', mentions: [] }],
      },
    ]);
    const open = await harness.behavior.callRpc("list", { threadId: "thr_1" });
    expect(open).toMatchObject({ items: [] });
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
      { scope: "thread", includeDone: false },
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
