// bb-plugin-waiting — storage and pure logic.
//
// One SQLite table of "waiting on you" items. Everything here is free of
// bb wiring so it can be unit-tested with a plain better-sqlite3 database.
import type Database from "better-sqlite3";
import { z } from "zod";

export const linkSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("url"),
    url: z.string().min(1),
    label: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("file"),
    hostId: z.string().min(1),
    path: z.string().min(1),
    label: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("thread"),
    threadId: z.string().min(1),
    label: z.string().nullable(),
  }),
]);
export type ItemLink = z.infer<typeof linkSchema>;

/** open: waits on the user · doing: the user said "do now", the agent is on it · done. */
export const itemStatusSchema = z.enum(["open", "doing", "done"]);
export type ItemStatus = z.infer<typeof itemStatusSchema>;
export const doneBySchema = z.enum(["user", "agent"]);
export type DoneBy = z.infer<typeof doneBySchema>;

export const MAX_CHOICES = 6;
export const MAX_CHOICE_LENGTH = 40;
export const choicesSchema = z
  .array(z.string().min(1).max(MAX_CHOICE_LENGTH))
  .max(MAX_CHOICES);

export const itemSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  needed: z.string().nullable(),
  links: z.array(linkSchema),
  /** Short answers the user can tap on the card, e.g. ["Yes", "No"]. */
  choices: z.array(z.string()),
  threadId: z.string().nullable(),
  projectId: z.string().nullable(),
  project: z.string().nullable(),
  requirement: z.string().nullable(),
  status: itemStatusSchema,
  /** The answer the user gave from the card, when they did. */
  answer: z.string().nullable(),
  /** When they tapped it. Answers are kept for the agent, not sent. */
  answeredAt: z.number().nullable(),
  /** When the thread's agent picked the answer up (or it was sent); null while it waits. */
  pickedUpAt: z.number().nullable(),
  /** When the user sent it to the thread with "Send answers". */
  sentAt: z.number().nullable(),
  /** Hidden from the card until this time ("Later"). */
  laterUntil: z.number().nullable(),
  /** Set by "Next": newest wins the top of the list. */
  nextAt: z.number().nullable(),
  createdAt: z.number(),
  doneAt: z.number().nullable(),
  doneBy: doneBySchema.nullable(),
});
export type Item = z.infer<typeof itemSchema>;

/** Append-only: bb records each statement and rejects edits to shipped ones. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    needed TEXT,
    links TEXT NOT NULL DEFAULT '[]',
    thread_id TEXT,
    project_id TEXT,
    project TEXT,
    requirement TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    done_at INTEGER,
    done_by TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS items_thread_status ON items(thread_id, status)`,
  // 0.2.0 — answer on the card, do now, later, next.
  `ALTER TABLE items ADD COLUMN choices TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE items ADD COLUMN answer TEXT`,
  `ALTER TABLE items ADD COLUMN later_until INTEGER`,
  `ALTER TABLE items ADD COLUMN next_at INTEGER`,
  // 0.3.0 — answers are kept for the agent instead of sent one by one.
  `ALTER TABLE items ADD COLUMN answered_at INTEGER`,
  `ALTER TABLE items ADD COLUMN picked_up_at INTEGER`,
  `ALTER TABLE items ADD COLUMN sent_at INTEGER`,
  // Answers given before 0.3.0 were sent to their thread at once.
  `UPDATE items SET answered_at = done_at, sent_at = done_at, picked_up_at = done_at WHERE answer IS NOT NULL`,
];

interface ItemRow {
  id: number;
  title: string;
  needed: string | null;
  links: string;
  choices: string;
  thread_id: string | null;
  project_id: string | null;
  project: string | null;
  requirement: string | null;
  status: string;
  answer: string | null;
  answered_at: number | null;
  picked_up_at: number | null;
  sent_at: number | null;
  later_until: number | null;
  next_at: number | null;
  created_at: number;
  done_at: number | null;
  done_by: string | null;
}

function parseJsonArray<T>(raw: string, schema: z.ZodType<T[]>): T[] {
  try {
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

function rowToItem(row: ItemRow): Item {
  const status = itemStatusSchema.safeParse(row.status);
  const doneBy = doneBySchema.safeParse(row.done_by);
  return {
    id: row.id,
    title: row.title,
    needed: row.needed,
    links: parseJsonArray(row.links, z.array(linkSchema)),
    choices: parseJsonArray(row.choices, z.array(z.string())),
    threadId: row.thread_id,
    projectId: row.project_id,
    project: row.project,
    requirement: row.requirement,
    status: status.success ? status.data : "open",
    answer: row.answer,
    answeredAt: row.answered_at,
    pickedUpAt: row.picked_up_at,
    sentAt: row.sent_at,
    laterUntil: row.later_until,
    nextAt: row.next_at,
    createdAt: row.created_at,
    doneAt: row.done_at,
    doneBy: doneBy.success ? doneBy.data : null,
  };
}

export interface NewItem {
  title: string;
  needed: string | null;
  links: ItemLink[];
  choices: string[];
  threadId: string | null;
  projectId: string | null;
  project: string | null;
  requirement: string | null;
  createdAt?: number;
}

export interface ItemPatch {
  title?: string;
  needed?: string | null;
  links?: ItemLink[];
  choices?: string[];
}

export interface ListFilter {
  threadId?: string | null;
  includeDone?: boolean;
  /** Include answered items whose answer the agent has not picked up yet. */
  includeAnswered?: boolean;
  /** Include items the user put off for later; the card leaves them out. */
  includeLater?: boolean;
  now?: number;
}

/** Answered on the card, and the thread's agent has not picked it up yet. */
export function isPendingAnswer(item: Item): boolean {
  return item.status === "done" && item.answer !== null && item.pickedUpAt === null;
}

const PENDING_ANSWER_SQL =
  "(status = 'done' AND answer IS NOT NULL AND picked_up_at IS NULL)";

export class WaitingStore {
  constructor(private readonly db: Database.Database) {}

  insert(input: NewItem): Item {
    const createdAt = input.createdAt ?? Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO items (title, needed, links, choices, thread_id, project_id, project, requirement, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(
        input.title,
        input.needed,
        JSON.stringify(input.links),
        JSON.stringify(input.choices),
        input.threadId,
        input.projectId,
        input.project,
        input.requirement,
        createdAt,
      );
    const item = this.get(Number(result.lastInsertRowid));
    if (item === null) throw new Error("insert did not produce a row");
    return item;
  }

  get(id: number): Item | null {
    const row = this.db
      .prepare(`SELECT * FROM items WHERE id = ?`)
      .get(id) as ItemRow | undefined;
    return row === undefined ? null : rowToItem(row);
  }

  /**
   * Open items (and answers waiting for the agent, which keep their place)
   * first, then doing, then done; within that, "Next" items on top (newest
   * press first), the rest oldest first.
   */
  list(filter: ListFilter = {}): Item[] {
    const now = filter.now ?? Date.now();
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.threadId !== undefined && filter.threadId !== null) {
      clauses.push("thread_id = ?");
      params.push(filter.threadId);
    }
    if (!filter.includeDone) {
      clauses.push(
        filter.includeAnswered ? `(status = 'open' OR ${PENDING_ANSWER_SQL})` : "status = 'open'",
      );
    }
    if (!filter.includeLater) {
      clauses.push("(later_until IS NULL OR later_until <= ?)");
      params.push(now);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM items ${where}
         ORDER BY CASE WHEN status = 'open' OR ${PENDING_ANSWER_SQL} THEN 0
                       WHEN status = 'doing' THEN 1 ELSE 2 END,
                  (next_at IS NULL) ASC, next_at DESC, created_at ASC, id ASC`,
      )
      .all(...params) as ItemRow[];
    return rows.map(rowToItem);
  }

  /** When the earliest "later" item comes back, so a card can refetch then. */
  returnsAt(threadId: string | null, now = Date.now()): number | null {
    const row = this.db
      .prepare(
        `SELECT MIN(later_until) AS at FROM items
         WHERE status = 'open' AND later_until > ? ${threadId === null ? "" : "AND thread_id = ?"}`,
      )
      .get(...(threadId === null ? [now] : [now, threadId])) as
      | { at: number | null }
      | undefined;
    return row?.at ?? null;
  }

  update(id: number, patch: ItemPatch): Item | null {
    const existing = this.get(id);
    if (existing === null) return null;
    this.db
      .prepare(
        `UPDATE items SET title = ?, needed = ?, links = ?, choices = ? WHERE id = ?`,
      )
      .run(
        patch.title ?? existing.title,
        patch.needed === undefined ? existing.needed : patch.needed,
        JSON.stringify(patch.links ?? existing.links),
        JSON.stringify(patch.choices ?? existing.choices),
        id,
      );
    return this.get(id);
  }

  /** Tick off (the check mark, or the agent) or put back on the list. */
  setDone(id: number, done: boolean, by: DoneBy, at = Date.now()): Item | null {
    const existing = this.get(id);
    if (existing === null) return null;
    if (done && existing.status === "done" && existing.answer !== null) {
      // Already answered: ticking it again (the agent's waiting_done) means
      // the answer was picked up; the answer itself stays on record.
      this.db
        .prepare(`UPDATE items SET picked_up_at = COALESCE(picked_up_at, ?) WHERE id = ?`)
        .run(at, id);
    } else if (done) {
      this.db
        .prepare(
          `UPDATE items SET status = 'done', done_at = ?, done_by = ?, answer = NULL,
             answered_at = NULL, picked_up_at = NULL, sent_at = NULL, later_until = NULL
           WHERE id = ?`,
        )
        .run(at, by, id);
    } else {
      this.db
        .prepare(
          `UPDATE items SET status = 'open', done_at = NULL, done_by = NULL, answer = NULL,
             answered_at = NULL, picked_up_at = NULL, sent_at = NULL
           WHERE id = ?`,
        )
        .run(id);
    }
    return this.get(id);
  }

  /**
   * The user tapped a choice: keep the answer for the thread's agent and tick
   * the item as answered. Nothing is sent.
   */
  answer(id: number, answer: string, at = Date.now()): Item | null {
    const existing = this.get(id);
    if (existing === null) return null;
    this.db
      .prepare(
        `UPDATE items SET status = 'done', done_at = ?, done_by = 'user', answer = ?,
           answered_at = ?, picked_up_at = NULL, sent_at = NULL, later_until = NULL
         WHERE id = ?`,
      )
      .run(at, answer, at, id);
    return this.get(id);
  }

  /** Answers the agent has not picked up yet, oldest first. */
  pendingAnswers(threadId: string | null): Item[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM items WHERE ${PENDING_ANSWER_SQL}
         ${threadId === null ? "" : "AND thread_id = ?"}
         ORDER BY answered_at ASC, id ASC`,
      )
      .all(...(threadId === null ? [] : [threadId])) as ItemRow[];
    return rows.map(rowToItem);
  }

  /** The agent read these answers; they leave its list and the card. */
  pickUp(ids: readonly number[], at = Date.now()): number {
    let changes = 0;
    const statement = this.db.prepare(
      `UPDATE items SET picked_up_at = ? WHERE id = ? AND ${PENDING_ANSWER_SQL}`,
    );
    for (const id of ids) changes += statement.run(at, id).changes;
    return changes;
  }

  /** "Send answers": they went to the thread in one message. */
  markSent(ids: readonly number[], at = Date.now()): number {
    let changes = 0;
    const statement = this.db.prepare(
      `UPDATE items SET sent_at = ?, picked_up_at = ? WHERE id = ? AND ${PENDING_ANSWER_SQL}`,
    );
    for (const id of ids) changes += statement.run(at, at, id).changes;
    return changes;
  }

  /** Threads with something open, being done, or an answer waiting. */
  activeThreadIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT thread_id FROM items
         WHERE thread_id IS NOT NULL AND (status IN ('open', 'doing') OR ${PENDING_ANSWER_SQL})`,
      )
      .all() as { thread_id: string }[];
    return rows.map((row) => row.thread_id);
  }

  /** "Do now": the agent has it; it stops waiting on the user. */
  setDoing(id: number): Item | null {
    const existing = this.get(id);
    if (existing === null) return null;
    this.db
      .prepare(`UPDATE items SET status = 'doing', later_until = NULL WHERE id = ?`)
      .run(id);
    return this.get(id);
  }

  /** "Later": hide until `until`; null brings it back. */
  setLater(id: number, until: number | null): Item | null {
    const existing = this.get(id);
    if (existing === null) return null;
    this.db.prepare(`UPDATE items SET later_until = ? WHERE id = ?`).run(until, id);
    return this.get(id);
  }

  /** "Next": to the top of the list (and back from later, if it was). */
  setNext(id: number, at = Date.now()): Item | null {
    const existing = this.get(id);
    if (existing === null) return null;
    this.db
      .prepare(`UPDATE items SET next_at = ?, later_until = NULL WHERE id = ?`)
      .run(at, id);
    return this.get(id);
  }

  remove(id: number): boolean {
    const result = this.db.prepare(`DELETE FROM items WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /** Distinct thread ids among the given items, in first-seen order. */
  static threadIds(items: readonly Item[]): string[] {
    const seen = new Set<string>();
    for (const item of items) {
      if (item.threadId !== null) seen.add(item.threadId);
    }
    return [...seen];
  }
}

/** Accept `12`, `#12` or `w12`; anything else is null. */
export function parseItemId(raw: string): number | null {
  const match = /^#?w?(\d{1,9})$/u.exec(raw.trim());
  if (match === null) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Trim, drop empties and duplicates, cap length and count. */
export function normalizeChoices(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const choices: string[] = [];
  for (const value of raw) {
    const choice = value.trim().slice(0, MAX_CHOICE_LENGTH);
    if (choice === "" || seen.has(choice)) continue;
    seen.add(choice);
    choices.push(choice);
    if (choices.length === MAX_CHOICES) break;
  }
  return choices;
}

const THREAD_ID_PATTERN = /^(?:@thread:)?(thr_[a-z0-9]+)(?:#.*)?$/iu;

/** Split `target|label` into its parts. */
function splitTarget(raw: string): { target: string; label: string | null } {
  const trimmed = raw.trim();
  const separator = trimmed.indexOf("|");
  const target = separator === -1 ? trimmed : trimmed.slice(0, separator).trim();
  const labelPart = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
  return { target, label: labelPart === "" ? null : labelPart };
}

/**
 * A file on a machine (`/home/…`, `~/…`, `file:…`): the user reads bb on the
 * web, often from another device, so these don't open for them.
 */
export function isLocalPathTarget(raw: string): boolean {
  const { target } = splitTarget(raw);
  return (
    target.startsWith("/") ||
    target.startsWith("~/") ||
    target === "~" ||
    /^file:/iu.test(target)
  );
}

/**
 * Turn one free-form link target into a typed link. `target|label` sets the
 * label; `https://…` URLs and `thr_…` thread ids are links. Local paths are
 * not (see isLocalPathTarget); null for anything that cannot be a link.
 */
export function parseLinkTarget(raw: string): ItemLink | null {
  const { target, label } = splitTarget(raw);
  if (target === "") return null;
  if (/^https?:\/\/\S+$/iu.test(target)) {
    return { kind: "url", url: target, label };
  }
  const threadMatch = THREAD_ID_PATTERN.exec(target);
  if (threadMatch !== null) {
    const threadId = threadMatch[1];
    if (threadId === undefined) return null;
    return { kind: "thread", threadId, label };
  }
  return null;
}

export const LINK_HELP =
  "use an https:// link (publish a file with omni-media, or link it on GitHub or the dev site) or a thr_… thread id";

/** Typed links, or the reason some targets were refused. */
export function parseLinkTargets(
  targets: readonly string[],
): { links: ItemLink[] } | { error: string } {
  const links: ItemLink[] = [];
  const local: string[] = [];
  const bad: string[] = [];
  for (const raw of targets) {
    if (isLocalPathTarget(raw)) {
      local.push(splitTarget(raw).target);
      continue;
    }
    const link = parseLinkTarget(raw);
    if (link === null) bad.push(raw.trim());
    else links.push(link);
  }
  const problems: string[] = [];
  if (local.length > 0) {
    problems.push(
      `a local path doesn't open for the user on the web: ${local.join(", ")}`,
    );
  }
  if (bad.length > 0) problems.push(`not a link: ${bad.join(", ")}`);
  if (problems.length > 0) {
    return { error: `${problems.join("; ")} (${LINK_HELP})` };
  }
  return { links };
}

/** Links added before 0.3.0 may be host paths; the card flags them. */
export function hasPathLink(item: Item): boolean {
  return item.links.some((link) => link.kind === "file");
}

/** Short human label for a link when none was given. */
export function linkLabel(link: ItemLink): string {
  if (link.label !== null && link.label !== "") return link.label;
  switch (link.kind) {
    case "url": {
      try {
        const url = new URL(link.url);
        const path = url.pathname.replace(/\/$/u, "");
        const text = `${url.host}${path}${url.search}`;
        return text.length > 48 ? `${text.slice(0, 45)}…` : text;
      } catch {
        return link.url;
      }
    }
    case "file": {
      const parts = link.path.split("/").filter((part) => part !== "");
      const tail = parts.slice(-2).join("/");
      return tail === "" ? link.path : tail;
    }
    case "thread":
      return "thread";
  }
}

/** Plain-text form of a link for CLI and tool output. */
export function linkText(link: ItemLink): string {
  switch (link.kind) {
    case "url":
      return link.url;
    case "file":
      return link.path;
    case "thread":
      return `@thread:${link.threadId}`;
  }
}

/**
 * "Send answers": every pending answer of a thread in one user message, e.g.
 * `Answers: #12 "Keep the handle?": Yes; #14 "Pick a grid": 2`.
 */
export function answersMessage(items: readonly Item[]): string {
  const parts = items
    .filter((item) => item.answer !== null)
    .map((item) => `#${item.id} "${oneLine(item.title)}": ${oneLine(item.answer ?? "")}`);
  return `Answers: ${parts.join("; ")}`;
}

/** The user message sent when they press "Do now". */
export function doNowMessage(item: Item): string {
  return `Re #${item.id} "${item.title}": do it now, go ahead.`;
}

function shortDate(at: number): string {
  return new Date(at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

/** `2026-10-17 14:02 UTC`: one reading for every agent and machine. */
export function utcStamp(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Keep stored text on one line. */
export function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

const PATH_FLAG = "(a file on the host: doesn't open on the web; replace it with an https link)";

/** One readable line per item for CLI and tool output. */
export function formatItemLine(item: Item, now = Date.now()): string {
  const box =
    item.status === "done" ? "[x]" : item.status === "doing" ? "[>]" : "[ ]";
  const meta = [item.project, item.requirement].filter(
    (part): part is string => part !== null && part !== "",
  );
  if (item.laterUntil !== null && item.laterUntil > now && item.status === "open") {
    meta.push(`later: ${shortDate(item.laterUntil)}`);
  }
  const head = `${box} #${item.id} ${item.title}`;
  const needed =
    item.needed === null || item.needed === "" ? "" : ` — ${item.needed}`;
  const choices = item.choices.length > 0 ? ` [${item.choices.join(" / ")}]` : "";
  const metaText = meta.length > 0 ? ` (${meta.join(" · ")})` : "";
  let answer = "";
  if (item.answer !== null) {
    answer = ` → ${item.answer}`;
    if (isPendingAnswer(item) && item.answeredAt !== null) {
      answer += ` (answered ${utcStamp(item.answeredAt)}, not picked up yet)`;
    } else if (item.sentAt !== null) {
      answer += " (sent)";
    }
  }
  const doing = item.status === "doing" ? " → do now" : "";
  const links = item.links
    .map((link) => `\n      ${linkText(link)}${link.kind === "file" ? ` ${PATH_FLAG}` : ""}`)
    .join("");
  return `${head}${needed}${choices}${metaText}${answer}${doing}${links}`;
}

/** Where the answers file sits inside a thread's storage folder. */
export const ANSWERS_FILE_NAME = "waiting-on-you.md";

/**
 * The per-thread file the thread's agent reads: answers not picked up yet,
 * then what still waits on the user, then what they said "Do now" to.
 * Rewritten whole on every change.
 */
export function answersFileText(input: {
  threadId: string;
  items: readonly Item[];
  now?: number;
}): string {
  const now = input.now ?? Date.now();
  const pending = input.items.filter(isPendingAnswer);
  const open = input.items.filter((item) => item.status === "open");
  const doing = input.items.filter((item) => item.status === "doing");
  const linkLines = (item: Item) =>
    item.links.map(
      (link) => `  - ${linkText(link)}${link.kind === "file" ? ` ${PATH_FLAG}` : ""}`,
    );
  const lines: string[] = [
    "# Waiting on you",
    "",
    `Kept by the Waiting on you plugin for thread ${input.threadId}; rewritten on every change. Updated ${utcStamp(now)}.`,
    "",
    "## Answers not picked up yet",
    "",
  ];
  if (pending.length === 0) {
    lines.push("None.");
  } else {
    for (const item of pending) {
      const at = item.answeredAt === null ? "" : `, ${utcStamp(item.answeredAt)}`;
      lines.push(
        `- #${item.id} "${oneLine(item.title)}": ${oneLine(item.answer ?? "")} (answered by the user${at})`,
      );
    }
    lines.push(
      "",
      "Act on these, then run `bb waiting answers --ack` (or call waiting_list with ack: true) so they leave this list.",
    );
  }
  lines.push("", "## Waiting on the user", "");
  if (open.length === 0) {
    lines.push("Nothing.");
  } else {
    for (const item of open) {
      const needed = item.needed === null ? "" : `: ${oneLine(item.needed)}`;
      const choices = item.choices.length > 0 ? ` [${item.choices.join(" / ")}]` : "";
      const meta = [item.project, item.requirement].filter(
        (part): part is string => part !== null && part !== "",
      );
      const metaText = meta.length > 0 ? ` (${meta.join(" · ")})` : "";
      const later =
        item.laterUntil !== null && item.laterUntil > now
          ? ` (put off until ${utcStamp(item.laterUntil)})`
          : "";
      lines.push(`- #${item.id} ${oneLine(item.title)}${needed}${choices}${metaText}${later}`);
      lines.push(...linkLines(item));
    }
  }
  if (doing.length > 0) {
    lines.push("", '## "Do now" (do these, then call waiting_done with the number)', "");
    for (const item of doing) {
      lines.push(`- #${item.id} ${oneLine(item.title)}`);
      lines.push(...linkLines(item));
    }
  }
  return `${lines.join("\n")}\n`;
}
