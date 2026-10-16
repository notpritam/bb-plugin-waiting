// bb-plugin-waiting — backend entry.
//
// "Waiting on you": a checklist of what is ready for you, each item with
// its link. One SQLite table (store.ts); three ways in: RPC for the composer
// card and the home overview, the `bb waiting` CLI, and `waiting_*` agent
// tools. Every write publishes a realtime signal so open cards refetch.
import { homedir } from "node:os";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  MIGRATIONS,
  WaitingStore,
  formatItemLine,
  itemSchema,
  parseItemId,
  parseLinkTarget,
  type DoneBy,
  type Item,
  type ItemLink,
} from "./store";

export type { Item, ItemLink } from "./store";

const threadInfoSchema = z.object({
  title: z.string().nullable(),
  projectId: z.string().nullable(),
});
export type ThreadInfo = z.infer<typeof threadInfoSchema>;

export const rpcContract = defineRpcContract({
  list: {
    input: z
      .object({
        threadId: z.string().nullable().optional(),
        includeDone: z.boolean().optional(),
      })
      .strict(),
    output: z.object({
      items: z.array(itemSchema),
      threads: z.record(z.string(), threadInfoSchema),
    }),
  },
  setDone: {
    input: z.object({ id: z.number().int().positive(), done: z.boolean() }).strict(),
    output: itemSchema,
  },
});

/** Realtime channel app.tsx listens on. */
export const CHANGED = "waiting-changed";

const MAX_TITLE = 160;
const MAX_NEEDED = 400;
const MAX_LINKS = 12;
const THREAD_CACHE_MS = 60_000;

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS]);
  const store = new WaitingStore(db);

  function changed(): void {
    bb.realtime.publish(CHANGED, { at: Date.now() });
  }

  // ---- bb lookups (thread title, project name, host for file links) -------

  const threadCache = new Map<string, { info: ThreadInfo; at: number }>();
  async function threadInfo(threadId: string): Promise<ThreadInfo> {
    const cached = threadCache.get(threadId);
    if (cached !== undefined && Date.now() - cached.at < THREAD_CACHE_MS) {
      return cached.info;
    }
    let info: ThreadInfo = { title: null, projectId: null };
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      info = {
        title: typeof thread.title === "string" ? thread.title : null,
        projectId: typeof thread.projectId === "string" ? thread.projectId : null,
      };
    } catch (error) {
      bb.log.debug(`thread ${threadId} lookup failed: ${String(error)}`);
    }
    threadCache.set(threadId, { info, at: Date.now() });
    return info;
  }

  async function projectName(projectId: string): Promise<string | null> {
    try {
      const project = await bb.sdk.projects.get({ projectId });
      return typeof project.name === "string" ? project.name : null;
    } catch {
      return null;
    }
  }

  async function primaryHostId(): Promise<string | null> {
    try {
      const config = await bb.sdk.system.config();
      return typeof config.primaryHostId === "string"
        ? config.primaryHostId
        : null;
    } catch {
      return null;
    }
  }

  /** The machine a thread's workspace lives on, for file links. */
  async function hostForThread(threadId: string | null): Promise<string | null> {
    if (threadId !== null) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        const environmentId =
          typeof thread.environmentId === "string" ? thread.environmentId : null;
        if (environmentId !== null) {
          const environment = await bb.sdk.environments.get({ environmentId });
          if (typeof environment.hostId === "string") return environment.hostId;
        }
      } catch (error) {
        bb.log.debug(`host lookup for ${threadId} failed: ${String(error)}`);
      }
    }
    return primaryHostId();
  }

  interface AddInput {
    title: string;
    needed: string | null;
    linkTargets: readonly string[];
    project: string | null;
    requirement: string | null;
    threadId: string | null;
    projectId: string | null;
  }

  async function addItem(input: AddInput): Promise<Item> {
    const title = input.title.trim().slice(0, MAX_TITLE);
    if (title === "") throw new Error("title is required");
    const hostId = await hostForThread(input.threadId);
    const serverHostId = await primaryHostId();
    const links: ItemLink[] = [];
    const bad: string[] = [];
    for (const raw of input.linkTargets.slice(0, MAX_LINKS)) {
      const link = parseLinkTarget(raw, {
        hostId,
        homeDir: hostId !== null && hostId === serverHostId ? homedir() : null,
      });
      if (link === null) bad.push(raw);
      else links.push(link);
    }
    if (bad.length > 0) {
      throw new Error(
        `not a link: ${bad.join(", ")} (use https://…, an absolute path, ~/… or thr_…)`,
      );
    }
    let project = input.project?.trim() ?? "";
    if (project === "" && input.projectId !== null) {
      project = (await projectName(input.projectId)) ?? "";
    }
    const requirement = normalizeRequirement(input.requirement);
    const item = store.insert({
      title,
      needed: emptyToNull(input.needed?.slice(0, MAX_NEEDED) ?? null),
      links,
      threadId: input.threadId,
      projectId: input.projectId,
      project: emptyToNull(project),
      requirement,
    });
    changed();
    return item;
  }

  function markDone(id: number, done: boolean, by: DoneBy): Item | null {
    const item = store.setDone(id, done, by);
    if (item !== null) changed();
    return item;
  }

  async function threadsFor(items: readonly Item[]): Promise<Record<string, ThreadInfo>> {
    const entries = await Promise.all(
      WaitingStore.threadIds(items).map(
        async (threadId) => [threadId, await threadInfo(threadId)] as const,
      ),
    );
    return Object.fromEntries(entries);
  }

  // ---- RPC for the card and the overview ---------------------------------

  bb.rpc.register(rpcContract, {
    async list({ threadId, includeDone }) {
      const items = store.list({
        threadId: threadId ?? null,
        includeDone: includeDone ?? false,
      });
      return { items, threads: await threadsFor(items) };
    },
    setDone({ id, done }) {
      const item = markDone(id, done, "user");
      if (item === null) throw new Error(`No item #${id}`);
      return item;
    },
  });

  // ---- CLI: bb waiting ---------------------------------------------------

  const jsonOption = {
    type: "boolean",
    description: "Emit machine-readable JSON",
  } as const;

  function requireId(raw: string): number {
    const id = parseItemId(raw);
    if (id === null) {
      throw new PluginCliError(`"${raw}" is not an item id`, {
        code: "invalid_value",
        hint: "Run `bb waiting list` and use the #number it prints.",
      });
    }
    return id;
  }

  function notFound(id: number): PluginCliError {
    return new PluginCliError(`No item #${id}`, {
      code: "not_found",
      hint: "Run `bb waiting list --all` to see every item.",
    });
  }

  function reply(json: boolean, value: unknown, text: string) {
    return { exitCode: 0, stdout: json ? JSON.stringify(value) : text };
  }

  bb.cli.register(
    defineCli({
      name: "waiting",
      summary:
        "Waiting on you: what is ready for you, each item with its link",
      commands: {
        add: cliCommand({
          summary: "Add an item that waits on the user (links the current thread)",
          positionals: [
            {
              name: "title",
              description: `Short title, under ${MAX_TITLE} characters`,
              required: true,
            },
          ],
          options: {
            need: {
              type: "string",
              description: 'What is needed from them, e.g. "pick 1, 2 or 3"',
              aliases: ["needed", "ask"],
            },
            link: {
              type: "string",
              repeatable: true,
              description:
                "A link to open: https://…, an absolute path, ~/… or thr_… ; add a label with `target|Label`",
              aliases: ["url", "links"],
              placeholder: "target|label",
            },
            project: {
              type: "string",
              description:
                "Product or project label; defaults to the thread's bb project",
              aliases: ["product"],
            },
            req: {
              type: "string",
              description: "Requirement number, e.g. R-173",
              aliases: ["requirement", "r"],
            },
            thread: {
              type: "string",
              description: "Thread to attach to; defaults to the current thread",
            },
            json: jsonOption,
          },
          async run(input, ctx) {
            const threadId = input.options.thread ?? ctx.threadId ?? null;
            // An explicit --thread belongs to that thread's project, not the
            // project of the thread running this command.
            let projectId =
              input.options.thread === undefined ? (ctx.projectId ?? null) : null;
            if (projectId === null && threadId !== null) {
              projectId = (await threadInfo(threadId)).projectId;
            }
            let item: Item;
            try {
              item = await addItem({
                title: input.positionals.title,
                needed: input.options.need ?? null,
                linkTargets: input.options.link,
                project: input.options.project ?? null,
                requirement: input.options.req ?? null,
                threadId,
                projectId,
              });
            } catch (error) {
              throw new PluginCliError(
                error instanceof Error ? error.message : String(error),
                { code: "invalid_value" },
              );
            }
            return reply(input.options.json, item, `Added ${formatItemLine(item)}`);
          },
        }),
        done: cliCommand({
          summary: "Tick an item off (the user answered or did it)",
          positionals: [
            { name: "id", description: "Item number, e.g. 12 or #12", required: true },
          ],
          options: { json: jsonOption },
          run(input) {
            const id = requireId(input.positionals.id);
            const item = markDone(id, true, "agent");
            if (item === null) throw notFound(id);
            return reply(input.options.json, item, formatItemLine(item));
          },
        }),
        reopen: cliCommand({
          summary: "Put a done item back on the list",
          positionals: [
            { name: "id", description: "Item number, e.g. 12 or #12", required: true },
          ],
          options: { json: jsonOption },
          run(input) {
            const id = requireId(input.positionals.id);
            const item = markDone(id, false, "agent");
            if (item === null) throw notFound(id);
            return reply(input.options.json, item, formatItemLine(item));
          },
        }),
        list: cliCommand({
          summary:
            "List open items: this thread's inside a thread, everything otherwise",
          options: {
            all: {
              type: "boolean",
              description: "Include done items",
              aliases: ["done"],
            },
            everywhere: {
              type: "boolean",
              description: "Every thread and project, not only this thread",
              aliases: ["global"],
            },
            thread: {
              type: "string",
              description: "Only this thread's items",
            },
            json: jsonOption,
          },
          async run(input, ctx) {
            const threadId = input.options.everywhere
              ? null
              : (input.options.thread ?? ctx.threadId ?? null);
            const items = store.list({ threadId, includeDone: input.options.all });
            const threads = await threadsFor(items);
            const lines = items.map((item) => {
              const line = formatItemLine(item);
              if (threadId !== null || item.threadId === null) return line;
              const title = threads[item.threadId]?.title ?? item.threadId;
              return `${line}\n      @thread:${item.threadId} (${title})`;
            });
            return reply(
              input.options.json,
              { items, threads },
              items.length === 0 ? "Nothing waiting on the user." : lines.join("\n"),
            );
          },
        }),
        remove: cliCommand({
          summary: "Delete an item that should never have been added",
          positionals: [
            { name: "id", description: "Item number, e.g. 12 or #12", required: true },
          ],
          options: { json: jsonOption },
          run(input) {
            const id = requireId(input.positionals.id);
            if (!store.remove(id)) throw notFound(id);
            changed();
            return reply(input.options.json, { removed: true, id }, `Removed #${id}`);
          },
        }),
      },
    }),
  );

  // ---- Agent tools -------------------------------------------------------

  const linkInputSchema = z.object({
    target: z
      .string()
      .min(1)
      .describe("https://… URL, absolute path, ~/… path, or thr_… thread id"),
    label: z.string().max(80).optional().describe("Short label shown on the chip"),
  });

  bb.agents.registerTool({
    name: "waiting_add",
    description:
      "Add an item to the user's \"Waiting on you\" checklist: something ready for them to open, pick, answer or do. Always include the link(s) they need to open. The current thread is attached automatically.",
    instructions:
      "When you hand the user something to look at or decide (a review page, a preview, a question with options, a doc to read), add it with waiting_add and its link. When their reply answers or resolves an item, call waiting_done with its id.",
    presentation: {
      label: {
        pending: "Adding to Waiting on you",
        completed: "Added to Waiting on you",
      },
    },
    parameters: z.object({
      title: z.string().min(1).max(MAX_TITLE).describe("Short title, a few words"),
      needed: z
        .string()
        .max(MAX_NEEDED)
        .optional()
        .describe('What is needed from them, e.g. "pick 1, 2 or 3" or "yes or no"'),
      links: z.array(linkInputSchema).max(MAX_LINKS).optional(),
      project: z
        .string()
        .max(60)
        .optional()
        .describe("Product or project label, e.g. FoundKeep; defaults to the bb project"),
      requirement: z
        .string()
        .max(20)
        .optional()
        .describe("Requirement number when there is one, e.g. R-173"),
    }),
    async execute({ title, needed, links, project, requirement }, ctx) {
      const item = await addItem({
        title,
        needed: needed ?? null,
        linkTargets: (links ?? []).map((link) =>
          link.label === undefined ? link.target : `${link.target}|${link.label}`,
        ),
        project: project ?? null,
        requirement: requirement ?? null,
        threadId: ctx.threadId,
        projectId: ctx.projectId,
      });
      return `Added ${formatItemLine(item)}`;
    },
  });

  bb.agents.registerTool({
    name: "waiting_done",
    description:
      "Tick an item off the user's \"Waiting on you\" checklist once they have answered, picked or done it.",
    presentation: {
      label: {
        pending: "Ticking off Waiting on you",
        completed: "Ticked off Waiting on you",
      },
    },
    parameters: z.object({
      id: z.number().int().positive().describe("The item number from waiting_add or waiting_list"),
    }),
    execute({ id }) {
      const item = markDone(id, true, "agent");
      if (item === null) {
        return { content: [{ type: "text", text: `No item #${id}` }], isError: true };
      }
      return `Done ${formatItemLine(item)}`;
    },
  });

  bb.agents.registerTool({
    name: "waiting_list",
    description:
      "List what is waiting on the user: this thread's items, or every thread's with scope \"all\".",
    presentation: {
      label: {
        pending: "Reading Waiting on you",
        completed: "Read Waiting on you",
      },
    },
    parameters: z.object({
      scope: z.enum(["thread", "all"]).default("thread"),
      includeDone: z.boolean().default(false),
    }),
    async execute({ scope, includeDone }, ctx) {
      const items = store.list({
        threadId: scope === "thread" ? ctx.threadId : null,
        includeDone,
      });
      if (items.length === 0) return "Nothing waiting on the user.";
      const threads = scope === "all" ? await threadsFor(items) : {};
      return items
        .map((item) => {
          const line = formatItemLine(item);
          if (scope === "thread" || item.threadId === null) return line;
          const title = threads[item.threadId]?.title ?? item.threadId;
          return `${line}\n      @thread:${item.threadId} (${title})`;
        })
        .join("\n");
    },
  });

  // Standing context: the open items of this thread, so the agent can tick
  // one off when the user's message answers it.
  bb.agents.contributeInstructions(({ threadId }) => {
    const items = store.list({ threadId, includeDone: false });
    if (items.length === 0) return null;
    const lines = items
      .slice(0, 20)
      .map((item) => {
        const needed = item.needed === null ? "" : ` (${escapeLine(item.needed)})`;
        return `- #${item.id} ${escapeLine(item.title)}${needed}`;
      })
      .join("\n");
    return [
      "Waiting on the user in this thread (the Waiting on you plugin):",
      lines,
      "When their message answers or resolves one, call waiting_done with its number. When you hand them something new to open or decide, call waiting_add with its link.",
    ].join("\n");
  });

  bb.onDispose(() => {
    threadCache.clear();
  });
}

function emptyToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeRequirement(value: string | null): string | null {
  const trimmed = emptyToNull(value);
  if (trimmed === null) return null;
  const match = /^r?-?\s*(\d{1,5})$/iu.exec(trimmed);
  return match === null ? trimmed.slice(0, 20) : `R-${match[1]}`;
}

/** Keep stored text on one line inside instructions. */
function escapeLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
