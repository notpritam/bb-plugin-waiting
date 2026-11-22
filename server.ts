// bb-plugin-waiting — backend entry.
//
// "Waiting on you": a checklist of what is ready for you, each item with
// its link. One SQLite table (store.ts); three ways in: RPC for the composer
// card and the home overview, the `bb waiting` CLI, and `waiting_*` agent
// tools. Every write publishes a realtime signal so open cards refetch, and
// rewrites the thread's answers file.
//
// An item with choices opens as a question in its thread, in bb's own
// question menu above the composer (where AskUserQuestion's questions open),
// drawn the way bb draws them (app.tsx). The answer is KEPT for the thread's
// agent, not sent. Cancel hands the item back to the card, whose "Answer"
// opens the question again.
//
// From the card the user can tick an item done, send every kept answer to
// the thread in one message ("Send answers"), say "Do now" (sent at once,
// the thread's agent goes ahead), put it off for later, or move it up next.
//
// The answers file: `waiting-on-you.md` in the thread's storage folder (the
// agent's $BB_THREAD_STORAGE), or under this plugin's data folder when the
// thread storage can't be written.
import { AsyncLocalStorage } from "node:async_hooks";
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
  linkSchema,
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

/** The question form app.tsx registers for bb's question menu (R-385). */
export const QUESTION_RENDERER = "waiting-question";

/** At most this many of a thread's items in one question set, as bb's own. */
export const MAX_QUESTIONS = 10;

/** One item, as the question form shows it. */
export const questionSchema = z.object({
  itemId: z.number().int().positive(),
  title: z.string(),
  needed: z.string().nullable(),
  choices: z.array(z.string()).min(1),
  links: z.array(linkSchema),
  project: z.string().nullable(),
  requirement: z.string().nullable(),
});
export type Question = z.infer<typeof questionSchema>;

/** What the question form gets: a thread's open items with choices. */
export const questionSetSchema = z.object({
  questions: z.array(questionSchema).min(1).max(MAX_QUESTIONS),
});
export type QuestionSet = z.infer<typeof questionSetSchema>;

/** One answer: one of the choices, or the user's own words. */
export const questionAnswerSchema = z.object({
  itemId: z.number().int().positive(),
  answer: z.string().trim().min(1).max(MAX_ANSWER),
  typed: z.boolean(),
});
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;

/** What the form submits: the questions answered; the rest go back to the card. */
export const questionSubmissionSchema = z.object({
  answers: z.array(questionAnswerSchema).max(MAX_QUESTIONS),
});
export type QuestionSubmission = z.infer<typeof questionSubmissionSchema>;

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
      /** Items whose question is open in their thread's question menu. */
      asking: z.array(z.number().int().positive()),
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
  /** "Answer" on the card: open a cancelled question in the menu again. */
  ask: {
    input: z.object({ id: z.number().int().positive() }).strict(),
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
/** bb keeps a question open at most seven days; then it opens again. */
const QUESTION_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
/** bb caps a row label at 80 characters. */
const MAX_ROW_LABEL = 80;
/** Closed by bb (not the user) this soon after opening: wait longer before the next try. */
const QUICK_CLOSE_MS = 10_000;
const REOPEN_MS = 2_000;
const REOPEN_SLOW_MS = 60_000;
/** After this many quick closes in a row, an item's question stays on the card. */
const MAX_QUICK_CLOSES = 3;
/** Re-check "later" items at least this often while one is pending. */
const MAX_RETURN_TIMER_MS = 60 * 60 * 1000;

export default async function plugin(bb: BbPluginApi) {
  // bb ties a question opened during an agent's tool call to that call: the
  // agent is told "the result will arrive separately", and the tool's real
  // result comes later as a message that can start a new turn. Questions
  // here are the item's, not the tool call's, so they open in the context
  // the plugin loaded in, outside every tool call.
  const outsideToolCalls = AsyncLocalStorage.snapshot();
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

  /**
   * Every write: open or close questions in bb's question menu, refetch open
   * cards, and rewrite the touched threads' files.
   */
  async function changed(...threadIds: (string | null)[]): Promise<void> {
    await syncQuestions();
    bb.realtime.publish(CHANGED, { at: Date.now() });
    await syncFiles(threadIds);
  }

  // Threads with something waiting get their file on load, so the path in
  // the instructions exists before the first change; open items with
  // choices get their question.
  const startup = setTimeout(() => {
    void syncQuestions().then(() => bb.realtime.publish(CHANGED, { at: Date.now() }));
    void syncFiles(store.activeThreadIds());
  }, 1_000);

  // ---- bb lookups (thread title, project name) ---------------------------

  interface ThreadLookup {
    info: ThreadInfo;
    /** Archived, deleted or not found: no question opens there. */
    closed: boolean;
    at: number;
  }
  const threadCache = new Map<string, ThreadLookup>();
  async function lookUpThread(threadId: string): Promise<ThreadLookup> {
    const cached = threadCache.get(threadId);
    if (cached !== undefined && Date.now() - cached.at < THREAD_CACHE_MS) return cached;
    let lookup: ThreadLookup = {
      info: { title: null, projectId: null },
      closed: false,
      at: Date.now(),
    };
    try {
      const thread = (await bb.sdk.threads.get({ threadId })) as {
        title?: unknown;
        projectId?: unknown;
        archivedAt?: unknown;
        deletedAt?: unknown;
      };
      lookup = {
        info: {
          title: typeof thread.title === "string" ? thread.title : null,
          projectId: typeof thread.projectId === "string" ? thread.projectId : null,
        },
        closed: typeof thread.archivedAt === "number" || typeof thread.deletedAt === "number",
        at: Date.now(),
      };
    } catch (error) {
      // Not found: a deleted thread gets no question. Anything else: try anyway.
      if (/\b404\b|not found/iu.test(String(error))) lookup = { ...lookup, closed: true };
      bb.log.debug(`thread ${threadId} lookup failed: ${String(error)}`);
    }
    threadCache.set(threadId, lookup);
    return lookup;
  }

  async function threadInfo(threadId: string): Promise<ThreadInfo> {
    return (await lookUpThread(threadId)).info;
  }

  async function projectName(projectId: string): Promise<string | null> {
    try {
      const project = await bb.sdk.projects.get({ projectId });
      return typeof project.name === "string" ? project.name : null;
    } catch {
      return null;
    }
  }

  // ---- questions in bb's own question menu (R-385) -----------------------
  //
  // One question set per thread: its open items with choices (not put off,
  // not cancelled), as tabs, the way bb shows several questions at once. bb
  // hides the composer while a question is open, so one set means one
  // Submit or Cancel brings it back. Submit keeps each answer; anything
  // left unanswered goes back to the card, like Cancel. When the thread's
  // items change anywhere else, the set closes and opens again as they are.

  interface OpenQuestions {
    controller: AbortController;
    signature: string;
    itemIds: number[];
    openedAt: number;
  }
  /** By thread. */
  const questions = new Map<string, OpenQuestions>();
  /** Threads whose set can't open (archived, deleted, bb refused), by signature: the card keeps them. */
  const unaskable = new Map<string, string>();
  /** Sets bb closed right after opening, in a row, by thread. */
  const quickCloses = new Map<string, number>();
  let syncing: Promise<void> | null = null;
  let syncAgain = false;
  let reopenTimer: ReturnType<typeof setTimeout> | undefined;
  let returnTimer: ReturnType<typeof setTimeout> | undefined;

  function wantsQuestion(item: Item, now: number): boolean {
    return (
      item.status === "open" &&
      item.threadId !== null &&
      item.choices.length > 0 &&
      item.askDismissedAt === null &&
      (item.laterUntil === null || item.laterUntil <= now)
    );
  }

  function toQuestion(item: Item): Question {
    return {
      itemId: item.id,
      title: item.title,
      needed: item.needed,
      choices: item.choices,
      links: item.links,
      project: item.project,
      requirement: item.requirement,
    };
  }

  function setSignature(items: readonly Item[]): string {
    return JSON.stringify(items.map(toQuestion));
  }

  /** The set's header in bb's question menu; each item's title is in the form. */
  function setTitle(items: readonly Item[]): string {
    return items.length > 1 ? `Waiting on you · ${items.length} questions` : "Waiting on you";
  }

  function askedItemIds(): Set<number> {
    const ids = new Set<number>();
    for (const open of questions.values()) for (const id of open.itemIds) ids.add(id);
    return ids;
  }

  function resync(): void {
    void syncQuestions().then(() => bb.realtime.publish(CHANGED, { at: Date.now() }));
  }

  function reopenSoon(delay: number): void {
    if (disposed) return;
    if (reopenTimer !== undefined) clearTimeout(reopenTimer);
    reopenTimer = setTimeout(() => {
      reopenTimer = undefined;
      resync();
    }, delay);
  }

  /** Items put off for later get their question back when they return. */
  function scheduleReturn(): void {
    if (returnTimer !== undefined) clearTimeout(returnTimer);
    returnTimer = undefined;
    const at = store.returnsAt(null);
    if (at === null || disposed) return;
    const delay = Math.min(Math.max(at - Date.now(), 0) + 500, MAX_RETURN_TIMER_MS);
    returnTimer = setTimeout(() => {
      returnTimer = undefined;
      resync();
    }, delay);
  }

  /** Unanswered (Cancel, or left out of a Submit): back to the card, where "Answer" opens it again. */
  function handBack(itemIds: readonly number[], at: number): void {
    for (const id of itemIds) {
      const item = store.get(id);
      if (item !== null && item.status === "open") store.setAskDismissed(id, at);
    }
  }

  async function settleQuestions(
    threadId: string,
    entry: OpenQuestions,
    result: Awaited<ReturnType<typeof bb.ui.requestInput>>,
  ): Promise<void> {
    const current = questions.get(threadId) === entry;
    if (current) questions.delete(threadId);
    if (disposed) return;
    const now = Date.now();
    if (result.outcome === "submitted") {
      quickCloses.delete(threadId);
      const parsed = questionSubmissionSchema.safeParse(result.value);
      const answers = parsed.success ? parsed.data.answers : [];
      const answered = new Set<number>();
      for (const { itemId, answer } of answers) {
        if (!entry.itemIds.includes(itemId)) continue;
        const item = store.get(itemId);
        // Kept for the agent (file, instructions, waiting_list); not sent.
        if (item !== null && item.answer === null) store.answer(itemId, answer, now);
        answered.add(itemId);
      }
      handBack(entry.itemIds.filter((id) => !answered.has(id)), now);
      await changed(threadId);
      return;
    }
    // Closed because the items changed here: the new set is already open.
    if (!current) return;
    switch (result.reason) {
      case "user":
        quickCloses.delete(threadId);
        handBack(entry.itemIds, now);
        await changed(threadId);
        return;
      case "plugin-disposed":
        return;
      case "thread-deleted":
        unaskable.set(threadId, entry.signature);
        bb.realtime.publish(CHANGED, { at: now });
        return;
      default: {
        // Timed out, bb restarted, the thread was stopped: open it again.
        const quick = now - entry.openedAt < QUICK_CLOSE_MS;
        const count = quick ? (quickCloses.get(threadId) ?? 0) + 1 : 0;
        quickCloses.set(threadId, count);
        if (count >= MAX_QUICK_CLOSES) {
          bb.log.warn(`${threadId}: its questions keep closing (${result.reason}); they stay on the card`);
          unaskable.set(threadId, entry.signature);
          bb.realtime.publish(CHANGED, { at: now });
          return;
        }
        reopenSoon(quick ? REOPEN_SLOW_MS : REOPEN_MS);
      }
    }
  }

  function describeSubmission(items: readonly Item[], value: unknown) {
    const parsed = questionSubmissionSchema.safeParse(value);
    if (!parsed.success) return {};
    const answers = new Map(parsed.data.answers.map((entry) => [entry.itemId, oneLine(entry.answer)]));
    const only = items.length === 1 ? answers.get(items[0]?.id ?? 0) : undefined;
    const title =
      only !== undefined
        ? `Answered: ${only}`
        : `Answered ${answers.size} of ${items.length}`;
    const lines = items.map((item) => {
      const answer = answers.get(item.id);
      return `- **${oneLine(item.title)}**: ${answer ?? "back on the card, unanswered"}`;
    });
    return {
      title: title.slice(0, MAX_ROW_LABEL),
      detail: `${lines.join("\n")}\n\nKept for this thread's agent, not sent.`,
    };
  }

  function openQuestions(threadId: string, items: Item[], signature: string): void {
    const controller = new AbortController();
    const entry: OpenQuestions = {
      controller,
      signature,
      itemIds: items.map((item) => item.id),
      openedAt: Date.now(),
    };
    questions.set(threadId, entry);
    const payload: QuestionSet = { questions: items.map(toQuestion) };
    let pending: Promise<Awaited<ReturnType<typeof bb.ui.requestInput>>>;
    try {
      pending = outsideToolCalls(() =>
        bb.ui.requestInput(
        {
          threadId,
          rendererId: QUESTION_RENDERER,
          title: setTitle(items),
          payload,
          timeoutMs: QUESTION_TIMEOUT_MS,
          presentation: { label: { pending: "Waiting on you", completed: "Answered" } },
          describeSubmission: (value) => describeSubmission(items, value),
        },
        { signal: controller.signal },
        ),
      );
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (result) => settleQuestions(threadId, entry, result),
      (error: unknown) => {
        if (questions.get(threadId) === entry) questions.delete(threadId);
        if (disposed) return;
        bb.log.warn(`questions not opened in ${threadId}: ${String(error)}`);
        unaskable.set(threadId, signature);
        bb.realtime.publish(CHANGED, { at: Date.now() });
      },
    );
  }

  /** Open each thread's set as it should be, close the rest. Never throws. */
  function syncQuestions(): Promise<void> {
    if (syncing !== null) {
      syncAgain = true;
      return syncing;
    }
    syncing = (async () => {
      do {
        syncAgain = false;
        if (disposed) return;
        const now = Date.now();
        const wanted = new Map<string, Item[]>();
        for (const item of store.list({ now })) {
          if (item.threadId === null || !wantsQuestion(item, now)) continue;
          const set = wanted.get(item.threadId) ?? [];
          if (set.length < MAX_QUESTIONS) set.push(item);
          wanted.set(item.threadId, set);
        }
        const signatures = new Map(
          [...wanted].map(([threadId, items]) => [threadId, setSignature(items)] as const),
        );
        for (const [threadId, open] of [...questions]) {
          if (signatures.get(threadId) !== open.signature) {
            questions.delete(threadId);
            open.controller.abort();
          }
        }
        for (const [threadId, signature] of [...unaskable]) {
          if (signatures.get(threadId) !== signature) unaskable.delete(threadId);
        }
        for (const [threadId, items] of wanted) {
          if (questions.has(threadId)) continue;
          const signature = signatures.get(threadId) ?? "";
          if (unaskable.get(threadId) === signature) continue;
          if ((await lookUpThread(threadId)).closed) {
            unaskable.set(threadId, signature);
            continue;
          }
          if (disposed) return;
          if (questions.has(threadId) || signatures.get(threadId) !== signature) continue;
          openQuestions(threadId, items, signature);
        }
        scheduleReturn();
      } while (syncAgain);
    })()
      .catch((error: unknown) => {
        bb.log.warn(`questions not synced: ${String(error)}`);
      })
      .finally(() => {
        syncing = null;
      });
    return syncing;
  }

  /** "Answer" on the card: the question opens in the menu again. */
  async function reopenQuestion(id: number): Promise<Item> {
    const item = store.setAskDismissed(id, null);
    if (item === null) throw new Error(`No item #${id}`);
    if (item.threadId !== null) {
      unaskable.delete(item.threadId);
      quickCloses.delete(item.threadId);
    }
    await changed(item.threadId);
    return store.get(id) ?? item;
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
        asking: (() => {
          const asked = askedItemIds();
          return items.filter((item) => asked.has(item.id)).map((item) => item.id);
        })(),
        returnsAt: store.returnsAt(scope),
      };
    },
    ask({ id }) {
      return reopenQuestion(id);
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
    description: `A short answer the user can pick; the item opens as a question in the thread's question menu, e.g. --choice Yes --choice No (up to ${MAX_CHOICES}, ${MAX_CHOICE_LENGTH} characters each)`,
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
            "The user's answers (from the question menu or the card) that the agent has not picked up yet; --ack marks them picked up",
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
      "Add an item to the user's \"Waiting on you\" checklist: something ready for them to open, pick, answer or do. Always include the link(s) they need to open, as https:// URLs or thr_… ids (never a local path). When the question has fixed answers, pass choices: the item then opens as a question in this thread's question menu, in bb's own format. The current thread is attached automatically.",
    instructions:
      'When you hand the user something to look at or decide (a review page, a preview, a question with options, a doc to read), add it with waiting_add and its https link. Give choices (e.g. ["Yes", "No"] or ["1", "2", "3"]) whenever the question has fixed answers: the item then opens as a question in this thread\'s question menu (where bb\'s own questions open), and they pick one or type their own. Their answer is kept for you, not sent as a message: read it with waiting_list (ack: true once you act on it) or in $BB_THREAD_STORAGE/waiting-on-you.md. When their reply answers or resolves an item, call waiting_done with its id.',
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
          'Short answers they can pick in the question menu, e.g. ["Yes", "No"] or ["A", "B", "C"]; leave out when the answer is free-form',
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
      "List what is waiting on the user, and the answers they gave (in the question menu or on the card) that you have not picked up yet: this thread's items, or every thread's with scope \"all\". Pass ack: true to mark this thread's answers as picked up once you act on them.",
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
          `${pending.length} ${pending.length === 1 ? "answer" : "answers"} from the user not picked up yet: ${pending.map(answerLine).join("; ")}. Act on them, then call waiting_list with ack: true.`,
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
        "Answers since you last looked (the user gave them in the question menu or on the card; they are kept for you, not sent as messages):",
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
    if (reopenTimer !== undefined) clearTimeout(reopenTimer);
    if (returnTimer !== undefined) clearTimeout(returnTimer);
    for (const open of questions.values()) open.controller.abort();
    questions.clear();
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
