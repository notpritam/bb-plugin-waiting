import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { formatItemLine, parseItemId, parseLinkTarget } from "../store";

async function host() {
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
      },
      projects: { get: async () => ({ id: "proj_1", name: "FoundKeep" }) },
      environments: { get: async () => ({ id: "env_1", hostId: "host_omni" }) },
      system: { config: async () => ({ primaryHostId: "host_omni" }) },
    },
  });
  await plugin(created.bb);
  return created;
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
        "--req",
        "173",
        "--json",
      ],
      { threadId: "thr_1", projectId: "proj_1" },
    );
    expect(added.exitCode).toBe(0);
    const item = JSON.parse(added.stdout ?? "{}") as {
      id: number;
      project: string | null;
      requirement: string | null;
      links: { kind: string }[];
      threadId: string | null;
    };
    expect(item.project).toBe("FoundKeep");
    expect(item.requirement).toBe("R-173");
    expect(item.threadId).toBe("thr_1");
    expect(item.links.map((link) => link.kind)).toEqual(["url", "file"]);
    expect(harness.realtimeSignals.length).toBe(1);

    const listed = await harness.behavior.callRpc("list", { threadId: "thr_1" });
    expect(listed).toMatchObject({
      items: [{ id: item.id, status: "open" }],
      threads: { thr_1: { title: "FoundKeep HQ" } },
    });

    const other = await harness.behavior.callRpc("list", { threadId: "thr_2" });
    expect(other).toMatchObject({ items: [] });

    const done = await harness.behavior.runCli(["done", `#${item.id}`]);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain("[x]");

    const open = await harness.behavior.callRpc("list", { threadId: "thr_1" });
    expect(open).toMatchObject({ items: [] });
    const all = await harness.behavior.callRpc("list", {
      threadId: "thr_1",
      includeDone: true,
    });
    expect(all).toMatchObject({
      items: [{ id: item.id, status: "done", doneBy: "agent" }],
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

  it("exposes tools and lists the thread's open items in instructions", async () => {
    const { harness } = await host();
    const added = await harness.behavior.callAgentTool(
      "waiting_add",
      {
        title: "Turn Show my finds on",
        needed: "yes or no",
        links: [{ target: "https://foundkeep.app/notpritamsharma", label: "Profile" }],
        requirement: "R-177",
      },
      { threadId: "thr_1", projectId: "proj_1" },
    );
    expect(String(added)).toContain("#1 Turn Show my finds on");

    const listed = await harness.behavior.callAgentTool(
      "waiting_list",
      { scope: "thread", includeDone: false },
      { threadId: "thr_1", projectId: "proj_1" },
    );
    expect(String(listed)).toContain("https://foundkeep.app/notpritamsharma");

    const instructions = harness.registrations.instructionProvider;
    expect(instructions).not.toBeNull();
    expect(instructions?.({ threadId: "thr_1", projectId: "proj_1" })).toContain(
      "#1 Turn Show my finds on (yes or no)",
    );
    expect(instructions?.({ threadId: "thr_2", projectId: "proj_1" })).toBeNull();

    const ticked = await harness.behavior.callAgentTool(
      "waiting_done",
      { id: 1 },
      { threadId: "thr_1", projectId: "proj_1" },
    );
    expect(String(ticked)).toContain("[x] #1");
    await harness.lifecycle.dispose();
  });

  it("formats one readable line per item", () => {
    expect(
      formatItemLine({
        id: 3,
        title: "Delete the old collection?",
        needed: "yes or no",
        links: [{ kind: "url", url: "https://foundkeep.app/a", label: null }],
        threadId: null,
        projectId: null,
        project: "FoundKeep",
        requirement: "R-160",
        status: "open",
        createdAt: 0,
        doneAt: null,
        doneBy: null,
      }),
    ).toBe(
      "[ ] #3 Delete the old collection? — yes or no (FoundKeep · R-160)\n      https://foundkeep.app/a",
    );
  });
});
