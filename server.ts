// bb-plugin-waiting — backend entry.
//
// "Waiting on you": a checklist of what is ready for you, each item with
// its link. One SQLite table (store.ts); three ways in: RPC for the composer
// card and the home overview, the `bb waiting` CLI, and `waiting_*` agent
// tools. Every write publishes a realtime signal so open cards refetch, and
// rewrites the thread's answers file.
//
// From the card the user can tick an item done, answer a question (its
// choices as buttons; the answer is KEPT for the thread's agent, not sent),
// send every kept answer to the thread in one message ("Send answers"), say
// "Do now" (sent at once, the thread's agent goes ahead), put it off for
// later, or move it up next.
//
// The answers file: `waiting-on-you.md` in the thread's storage folder (the
// agent's $BB_THREAD_STORAGE), or under this plugin's data folder when the
// thread storage can't be written.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  ANSWERS_FILE_NAME,
  MAX_CHOICES,
  MAX_CHOICE_LENGTH,
  MIGRATIONS,
  WaitingStore,
  answersFileText,
  answersMessage,
  choicesSchema,
  doNowMessage,
  formatItemLine,
  hasPathLink,
  itemSchema,
  normalizeChoices,
  oneLine,
  parseItemId,
  parseLinkTargets,
  utcStamp,
  type DoneBy,
  type Item,
  type ItemLink,
  type ItemPatch,
} from "./store";

export type { Item, ItemLink } from "./store";

const threadInfoSchema = z.object({
  title: z.string().nullable(),
  projectId: z.string().nullable(),
});
export type ThreadInfo = z.infer<typeof threadInfoSchema>;

const MAX_ANSWER = 400;

export const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answer"), answer: z.string().min(1).max(MAX_ANSWER) }),
  z.object({ kind: z.literal("doNow") }),
  z.object({ kind: z.literal("later"), until: z.number().int().positive() }),
  z.object({ kind: z.literal("next") }),
]);
export type ItemAction = z.infer<typeof actionSchema>;

export const rpcContract = defineRpcContract({
  list: {
    input: z
      .object({
        threadId: z.string().nullable().optional(),
        includeDone: z.boolean().optional(),
      })
      .strict(),
    output: z.object({
      /** Open items, and answered ones whose answer waits for the agent. */
      items: z.array(itemSchema),
      threads: z.record(z.string(), threadInfoSchema),
      /** When the earliest "later" item comes back, so the card can refetch. */
      returnsAt: z.number().nullable(),
    }),
  },
  setDone: {
    input: z.object({ id: z.number().int().positive(), done: z.boolean() }).strict(),
    output: itemSchema,
  },
  act: {
    input: z.object({ id: z.number().int().positive(), action: actionSchema }).strict(),
    output: itemSchema,
  },
  /** Every kept answer of a thread, sent to it in one message. */
  sendAnswers: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ sent: z.number().int().nonnegative(), text: z.string() }),
  },
});

/** Realtime channel app.tsx listens on. */
export const CHANGED = "waiting-changed";

const MAX_TITLE = 160;
const MAX_NEEDED = 400;
const MAX_LINKS = 12;
const THREAD_CACHE_MS = 60_000;
/** A file write never holds a card or a command longer than this. */
const FILE_WRITE_TIMEOUT_MS = 5_000;
/** What the agent is told when the file is in its thread storage. */
const THREAD_STORAGE_FILE = `$BB_THREAD_STORAGE/${ANSWERS_FILE_NAME}`;

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS]);
  const store = new WaitingStore(db);

  // ---- the answers file, one per thread ----------------------------------

  /** Where each thread's file was last written; the instructions name it. */
  const filePaths = new Map<string, string>();
  const writes = new Map<string, Promise<void>>();
  let disposed = false;

  function fallbackPath(threadId: string): string | null {
    const dbPath = typeof db.name === "string" ? db.name : "";
    if (dbPath === "" || dbPath === ":memory:") return null;
    return join(dirname(dbPath), "threads", `${threadId}.md`);
  }

  async function writeAnswersFile(threadId: string): Promise<void> {
    if (disposed) return;
    const items = store
      .list({ threadId, includeDone: true, includeLater: true })
      .filter((item) => item.status !== "done" || (item.answer !== null && item.pickedUpAt === null));
    const content = answersFileText({ threadId, items });
    try {
      const location = await bb.sdk.threads.storageLocation({ threadId });
      await bb.sdk.files.write({
        hostId: location.hostId,
        path: `${location.storageRootPath.replace(/\/$/u, "")}/${ANSWERS_FILE_NAME}`,
        content,
        createParents: true,
      });
      filePaths.set(threadId, THREAD_STORAGE_FILE);
      return;
    } catch (error) {
      bb.log.debug(`thread storage write for ${threadId} failed: ${String(error)}`);
    }
    const path = fallbackPath(threadId);
    if (path === null) return;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
      filePaths.set(threadId, path);
    } catch (error) {
      bb.log.warn(`answers file for ${threadId} not written: ${String(error)}`);
    }
  }

  /** Rewrite a thread's file after the writes before it; never throws. */
  function syncFile(threadId: string): Promise<void> {
    const previous = writes.get(threadId) ?? Promise.resolve();
    const next = previous.then(() => writeAnswersFile(threadId)).catch(() => {});
    writes.set(threadId, next);
    void next.finally(() => {
      if (writes.get(threadId) === next) writes.delete(threadId);
    });
    return next;
  }

  async function syncFiles(threadIds: readonly (string | null)[]): Promise<void> {
    const ids = [...new Set(threadIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(ids.map(syncFile)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FILE_WRITE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  /** Every write: refetch open cards and rewrite the touched threads' files. */
  async function changed(...threadIds: (string | null)[]): Promise<void> {
    bb.realtime.publish(CHANGED, { at: Date.now() });
    await syncFiles(threadIds);
  }

  // Threads with something waiting get their file on load, so the path in
  // the instructions exists before the first change.
  const startup = setTimeout(() => {
    void syncFiles(store.activeThreadIds());
  }, 1_000);

  // ---- bb lookups (thread title, project name) ---------------------------

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

  /** Typed links from free-form targets; throws naming the refused ones. */
  function parseLinks(targets: readonly string[]): ItemLink[] {
    const result = parseLinkTargets(targets.slice(0, MAX_LINKS));
    if ("error" in result) throw new Error(result.error);
    return result.links;
  }

  interface AddInput {
    title: string;
    needed: string | null;
    linkTargets: readonly string[];
    choices: readonly string[];
    project: string | null;
    requirement: string | null;
    threadId: string | null;
    projectId: string | null;
  }

  async function addItem(input: AddInput): Promise<Item> {
    const title = input.title.trim().slice(0, MAX_TITLE);
    if (title === "") throw new Error("title is required");
    const links = parseLinks(input.linkTargets);
    let project = input.project?.trim() ?? "";
    if (project === "" && input.projectId !== null) {
      project = (await projectName(input.projectId)) ?? "";
    }
    const requirement = normalizeRequirement(input.requirement);
    const item = store.insert({
      title,
      needed: emptyToNull(input.needed?.slice(0, MAX_NEEDED) ?? null),
      links,
      choices: normalizeChoices(input.choices),
      threadId: input.threadId,
      projectId: input.projectId,
      project: emptyToNull(project),
      requirement,
    });
    await changed(item.threadId);
    return item;
  }

  async function markDone(id: number, done: boolean, by: DoneBy): Promise<Item | null> {
    const item = store.setDone(id, done, by);
    if (item !== null) await changed(item.threadId);
    return item;
  }

  /** The user's message into a thread, so its agent acts on it. */
  async function sendToThread(threadId: string, text: string): Promise<void> {
    await bb.sdk.threads.send({
      threadId,
      mode: "auto",
      input: [{ type: "text", text, mentions: [] }],
    });
  }

  async function actOn(id: number, action: ItemAction): Promise<Item> {
    const item = store.get(id);
    if (item === null) throw new Error(`No item #${id}`);
    let updated: Item | null;
    switch (action.kind) {
      case "answer":
        // Kept for the agent (file, instructions, waiting_list); not sent.
        updated = store.answer(id, action.answer);
        break;
      case "doNow":
        if (item.threadId === null) {
          throw new Error(`#${item.id} has no thread to hand it to`);
        }
        await sendToThread(item.threadId, doNowMessage(item));
        updated = store.setDoing(id);
        break;
      case "later":
        updated = store.setLater(id, action.until);
        break;
      case "next":
        updated = store.setNext(id);
        break;
    }
    if (updated === null) throw new Error(`No item #${id}`);
    await changed(updated.threadId);
    return updated;
  }

  /** "Send answers": one message with every kept answer of the thread. */
  async function sendAnswers(threadId: string): Promise<{ sent: number; text: string }> {
    const pending = store.pendingAnswers(threadId);
    if (pending.length === 0) throw new Error("No answers to send");
    const text = answersMessage(pending);
    await sendToThread(threadId, text);
    const sent = store.markSent(pending.map((item) => item.id));
    await changed(threadId);
    return { sent, text };
  }

  /** The agent read its thread's answers: they leave its list and the card. */
  async function pickUp(threadId: string): Promise<Item[]> {
    const pending = store.pendingAnswers(threadId);
    if (pending.length === 0) return [];
    store.pickUp(pending.map((item) => item.id));
    await changed(threadId);
    return pending;
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
      const scope = threadId ?? null;
      const items = store.list({
        threadId: scope,
        includeDone: includeDone ?? false,
        includeAnswered: true,
      });
      return {
        items,
        threads: await threadsFor(items),
        returnsAt: store.returnsAt(scope),
      };
    },
    async setDone({ id, done }) {
      const item = await markDone(id, done, "user");
      if (item === null) throw new Error(`No item #${id}`);
      return item;
    },
    act({ id, action }) {
      return actOn(id, action);
    },
    sendAnswers({ threadId }) {
      return sendAnswers(threadId);
    },
  });

  // ---- CLI: bb waiting ---------------------------------------------------

  const jsonOption = {
    type: "boolean",
    description: "Emit machine-readable JSON",
  } as const;

  const choiceOption = {
    type: "string",
    repeatable: true,
    description: `A short answer the user can tap on the card, e.g. --choice Yes --choice No (up to ${MAX_CHOICES}, ${MAX_CHOICE_LENGTH} characters each)`,
    aliases: ["choices", "option"],
  } as const;

  const linkOption = {
    type: "string",
    repeatable: true,
    description:
      "A link the user can open on the web: https://… or thr_… (no local paths); add a label with `target|Label`",
    aliases: ["url", "links"],
    placeholder: "target|label",
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

  function invalid(error: unknown): PluginCliError {
    return new PluginCliError(
      error instanceof Error ? error.message : String(error),
      { code: "invalid_value" },
    );
  }

  function reply(json: boolean, value: unknown, text: string) {
    return { exitCode: 0, stdout: json ? JSON.stringify(value) : text };
  }

  function answerLine(item: Item): string {
    const at = item.answeredAt === null ? "" : ` (answered ${utcStamp(item.answeredAt)})`;
    return `#${item.id} "${oneLine(item.title)}": ${oneLine(item.answer ?? "")}${at}`;
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
            link: linkOption,
            choice: choiceOption,
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
                choices: input.options.choice,
                project: input.options.project ?? null,
                requirement: input.options.req ?? null,
                threadId,
                projectId,
              });
            } catch (error) {
              throw invalid(error);
            }
            return reply(input.options.json, item, `Added ${formatItemLine(item)}`);
          },
        }),
        edit: cliCommand({
          summary: "Change an item's title, what is needed, its choices or links",
          positionals: [
            { name: "id", description: "Item number, e.g. 12 or #12", required: true },
          ],
          options: {
            title: { type: "string", description: "New title" },
            need: {
              type: "string",
              description: "New wording of what is needed",
              aliases: ["needed", "ask"],
            },
            choice: { ...choiceOption, description: `${choiceOption.description}; replaces the current ones, \`--choice none\` clears them` },
            link: { ...linkOption, description: `${linkOption.description}; replaces the current ones` },
            json: jsonOption,
          },
          async run(input) {
            const id = requireId(input.positionals.id);
            const existing = store.get(id);
            if (existing === null) throw notFound(id);
            const patch: ItemPatch = {};
            if (input.options.title !== undefined) {
              const title = input.options.title.trim().slice(0, MAX_TITLE);
              if (title === "") throw invalid(new Error("title is required"));
              patch.title = title;
            }
            if (input.options.need !== undefined) {
              patch.needed = emptyToNull(input.options.need.slice(0, MAX_NEEDED));
            }
            if (input.options.choice.length > 0) {
              patch.choices =
                input.options.choice.length === 1 && input.options.choice[0] === "none"
                  ? []
                  : normalizeChoices(input.options.choice);
            }
            if (input.options.link.length > 0) {
              try {
                patch.links = parseLinks(input.options.link);
              } catch (error) {
                throw invalid(error);
              }
            }
            const item = store.update(id, patch);
            if (item === null) throw notFound(id);
            await changed(item.threadId);
            return reply(input.options.json, item, formatItemLine(item));
          },
        }),
        done: cliCommand({
          summary: "Tick an item off (the user answered or did it)",
          positionals: [
            { name: "id", description: "Item number, e.g. 12 or #12", required: true },
          ],
          options: { json: jsonOption },
          async run(input) {
            const id = requireId(input.positionals.id);
            const item = await markDone(id, true, "agent");
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
          async run(input) {
            const id = requireId(input.positionals.id);
            const item = await markDone(id, false, "agent");
            if (item === null) throw notFound(id);
            return reply(input.options.json, item, formatItemLine(item));
          },
        }),
        list: cliCommand({
          summary:
            "List open items and answers not picked up yet: this thread's inside a thread, everything otherwise",
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
            const items = store.list({
              threadId,
              includeDone: input.options.all,
              includeAnswered: true,
              includeLater: true,
            });
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
        answers: cliCommand({
          summary:
            "The user's answers from the card that the agent has not picked up yet; --ack marks them picked up",
          options: {
            ack: {
              type: "boolean",
              description:
                "Mark this thread's answers as picked up, so they leave the card, the file and your instructions",
              aliases: ["pick-up", "read"],
            },
            everywhere: {
              type: "boolean",
              description: "Every thread's answers (read only; --ack works on one thread)",
              aliases: ["global"],
            },
            thread: {
              type: "string",
              description: "This thread's answers; defaults to the current thread",
            },
            json: jsonOption,
          },
          async run(input, ctx) {
            const threadId = input.options.everywhere
              ? null
              : (input.options.thread ?? ctx.threadId ?? null);
            if (input.options.ack && threadId === null) {
              throw new PluginCliError("--ack works on one thread's answers", {
                code: "invalid_value",
                hint: "Run it inside the thread, or pass --thread thr_….",
              });
            }
            const answers = input.options.ack
              ? await pickUp(threadId as string)
              : store.pendingAnswers(threadId);
            const filePath = threadId === null ? null : (filePaths.get(threadId) ?? null);
            let text: string;
            if (answers.length === 0) {
              text = "No answers waiting.";
            } else {
              const lines = answers.map((item) =>
                threadId === null && item.threadId !== null
                  ? `${answerLine(item)}\n      @thread:${item.threadId}`
                  : answerLine(item),
              );
              const footer = input.options.ack
                ? `Picked up ${answers.length} ${answers.length === 1 ? "answer" : "answers"}.`
                : threadId === null
                  ? ""
                  : "Act on them, then run `bb waiting answers --ack`.";
              text = [...lines, ...(footer === "" ? [] : [footer])].join("\n");
            }
            return reply(
              input.options.json,
              { answers, pickedUp: input.options.ack, file: filePath },
              text,
            );
          },
        }),
        remove: cliCommand({
          summary: "Delete an item that should never have been added",
          positionals: [
            { name: "id", description: "Item number, e.g. 12 or #12", required: true },
          ],
          options: { json: jsonOption },
          async run(input) {
            const id = requireId(input.positionals.id);
            const existing = store.get(id);
            if (existing === null || !store.remove(id)) throw notFound(id);
            await changed(existing.threadId);
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
      .describe(
        "An https:// URL or a thr_… thread id. Local paths (/home/…, ~/…, file:) are refused: the user reads bb on the web",
      ),
    label: z.string().max(80).optional().describe("Short label shown on the chip"),
  });

  bb.agents.registerTool({
    name: "waiting_add",
    description:
      "Add an item to the user's \"Waiting on you\" checklist: something ready for them to open, pick, answer or do. Always include the link(s) they need to open, as https:// URLs or thr_… ids (never a local path). When the question has fixed answers, pass choices so they can answer from the card. The current thread is attached automatically.",
    instructions:
      'When you hand the user something to look at or decide (a review page, a preview, a question with options, a doc to read), add it with waiting_add and its https link. Give choices (e.g. ["Yes", "No"] or ["1", "2", "3"]) whenever the question has fixed answers: they can tap one on the card. A tapped answer is kept for you, not sent as a message: read it with waiting_list (ack: true once you act on it) or in $BB_THREAD_STORAGE/waiting-on-you.md. When their reply answers or resolves an item, call waiting_done with its id.',
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
      choices: choicesSchema
        .optional()
        .describe(
          'Short answers they can tap, e.g. ["Yes", "No"] or ["A", "B", "C"]; leave out when the answer is free-form',
        ),
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
    async execute({ title, needed, choices, links, project, requirement }, ctx) {
      try {
        const item = await addItem({
          title,
          needed: needed ?? null,
          linkTargets: (links ?? []).map((link) =>
            link.label === undefined ? link.target : `${link.target}|${link.label}`,
          ),
          choices: choices ?? [],
          project: project ?? null,
          requirement: requirement ?? null,
          threadId: ctx.threadId,
          projectId: ctx.projectId,
        });
        return `Added ${formatItemLine(item)}`;
      } catch (error) {
        return {
          content: [
            { type: "text", text: `Not added: ${error instanceof Error ? error.message : String(error)}` },
          ],
          isError: true,
        };
      }
    },
  });

  bb.agents.registerTool({
    name: "waiting_done",
    description:
      "Tick an item off the user's \"Waiting on you\" checklist once they have answered, picked or done it, or once you finished what they told you to do now.",
    presentation: {
      label: {
        pending: "Ticking off Waiting on you",
        completed: "Ticked off Waiting on you",
      },
    },
    parameters: z.object({
      id: z.number().int().positive().describe("The item number from waiting_add or waiting_list"),
    }),
    async execute({ id }) {
      const item = await markDone(id, true, "agent");
      if (item === null) {
        return { content: [{ type: "text", text: `No item #${id}` }], isError: true };
      }
      return `Done ${formatItemLine(item)}`;
    },
  });

  bb.agents.registerTool({
    name: "waiting_list",
    description:
      "List what is waiting on the user, and the answers they tapped on the card that you have not picked up yet: this thread's items, or every thread's with scope \"all\". Pass ack: true to mark this thread's answers as picked up once you act on them.",
    presentation: {
      label: {
        pending: "Reading Waiting on you",
        completed: "Read Waiting on you",
      },
    },
    parameters: z.object({
      scope: z.enum(["thread", "all"]).default("thread"),
      includeDone: z.boolean().default(false),
      ack: z
        .boolean()
        .default(false)
        .describe(
          "Mark this thread's answers as picked up, so they leave the card, the answers file and your list",
        ),
    }),
    async execute({ scope, includeDone, ack }, ctx) {
      const items = store.list({
        threadId: scope === "thread" ? ctx.threadId : null,
        includeDone,
        includeAnswered: true,
        includeLater: true,
      });
      const pending = store.pendingAnswers(ctx.threadId);
      const threads = scope === "all" ? await threadsFor(items) : {};
      const lines = items.map((item) => {
        const line = formatItemLine(item);
        if (scope === "thread" || item.threadId === null) return line;
        const title = threads[item.threadId]?.title ?? item.threadId;
        return `${line}\n      @thread:${item.threadId} (${title})`;
      });
      if (lines.length === 0) lines.push("Nothing waiting on the user.");
      if (ack) {
        const picked = await pickUp(ctx.threadId);
        if (picked.length > 0) {
          lines.push(
            "",
            `Picked up ${picked.length} ${picked.length === 1 ? "answer" : "answers"}: ${picked.map(answerLine).join("; ")}`,
          );
        }
      } else if (pending.length > 0) {
        lines.push(
          "",
          `${pending.length} ${pending.length === 1 ? "answer" : "answers"} from the card not picked up yet: ${pending.map(answerLine).join("; ")}. Act on them, then call waiting_list with ack: true.`,
        );
      }
      return lines.join("\n");
    },
  });

  // Standing context, built when the thread's agent session starts: answers
  // kept for it, the open items (so it can tick one off when the user's
  // message answers it), the ones handed back with "Do now", and where the
  // live answers file is.
  bb.agents.contributeInstructions(({ threadId }) => {
    const items = store.list({ threadId, includeDone: true, includeLater: true });
    const answers = items.filter(
      (item) => item.status === "done" && item.answer !== null && item.pickedUpAt === null,
    );
    const waiting = items.filter((item) => item.status === "open").slice(0, 20);
    const doing = items.filter((item) => item.status === "doing").slice(0, 20);
    if (answers.length + waiting.length + doing.length === 0) return null;
    const now = Date.now();
    const file = filePaths.get(threadId) ?? THREAD_STORAGE_FILE;
    const sections: string[] = ["Waiting on you (a plugin): the user's checklist for this thread."];
    if (answers.length > 0) {
      sections.push(
        "Answers since you last looked (the user tapped them on the card; they are kept for you, not sent as messages):",
        answers
          .slice(0, 20)
          .map(
            (item) =>
              `- #${item.id} "${oneLine(item.title)}": ${oneLine(item.answer ?? "")}${item.answeredAt === null ? "" : ` (${utcStamp(item.answeredAt)})`}`,
          )
          .join("\n"),
        "Act on them, then call waiting_list with ack: true (or run `bb waiting answers --ack`) so they are not repeated.",
      );
    }
    if (waiting.length > 0) {
      sections.push(
        "Waiting on the user:",
        waiting
          .map((item) => {
            const needed = item.needed === null ? "" : ` (${oneLine(item.needed)})`;
            const choices =
              item.choices.length > 0 ? ` [${item.choices.join(" / ")}]` : "";
            const later =
              item.laterUntil !== null && item.laterUntil > now
                ? ` — put off until ${new Date(item.laterUntil).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
                : "";
            return `- #${item.id} ${oneLine(item.title)}${needed}${choices}${later}`;
          })
          .join("\n"),
      );
    }
    if (doing.length > 0) {
      sections.push(
        'The user pressed "Do now" on these; do them, then call waiting_done with the number:',
        doing.map((item) => `- #${item.id} ${oneLine(item.title)}`).join("\n"),
      );
    }
    const pathLinked = [...waiting, ...doing].filter(hasPathLink);
    if (pathLinked.length > 0) {
      sections.push(
        `These link to a file on the host, which doesn't open for the user on the web: ${pathLinked.map((item) => `#${item.id}`).join(", ")}. Replace it with an https link: \`bb waiting edit <n> --link https://…\`.`,
      );
    }
    sections.push(
      `New answers arrive without a message. The live list is ${file} (also waiting_list and \`bb waiting answers\`); the list above is as of when this session started, so read it when you take up one of these items, when the user mentions answering, and before you report back. A message starting \`Answers:\` is the user sending you their answers at once; those are already picked up. When their message answers or resolves an open item, call waiting_done with its number. When you hand them something new to open or decide, call waiting_add with an https link (or a thr_… id, never a local path), and give choices when the answers are fixed.`,
    );
    return sections.join("\n");
  });

  bb.onDispose(() => {
    disposed = true;
    clearTimeout(startup);
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
