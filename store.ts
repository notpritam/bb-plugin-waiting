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

export const itemStatusSchema = z.enum(["open", "done"]);
export type ItemStatus = z.infer<typeof itemStatusSchema>;
export const doneBySchema = z.enum(["user", "agent"]);
export type DoneBy = z.infer<typeof doneBySchema>;

export const itemSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  needed: z.string().nullable(),
  links: z.array(linkSchema),
  threadId: z.string().nullable(),
  projectId: z.string().nullable(),
  project: z.string().nullable(),
  requirement: z.string().nullable(),
  status: itemStatusSchema,
  createdAt: z.number(),
  doneAt: z.number().nullable(),
  doneBy: doneBySchema.nullable(),
});
export type Item = z.infer<typeof itemSchema>;

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
];

interface ItemRow {
  id: number;
  title: string;
  needed: string | null;
  links: string;
  thread_id: string | null;
  project_id: string | null;
  project: string | null;
  requirement: string | null;
  status: string;
  created_at: number;
  done_at: number | null;
  done_by: string | null;
}

function parseLinks(raw: string): ItemLink[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = z.array(linkSchema).safeParse(parsed);
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
    links: parseLinks(row.links),
    threadId: row.thread_id,
    projectId: row.project_id,
    project: row.project,
    requirement: row.requirement,
    status: status.success ? status.data : "open",
    createdAt: row.created_at,
    doneAt: row.done_at,
    doneBy: doneBy.success ? doneBy.data : null,
  };
}

export interface NewItem {
  title: string;
  needed: string | null;
  links: ItemLink[];
  threadId: string | null;
  projectId: string | null;
  project: string | null;
  requirement: string | null;
  createdAt?: number;
}

export interface ListFilter {
  threadId?: string | null;
  includeDone?: boolean;
}

export class WaitingStore {
  constructor(private readonly db: Database.Database) {}

  insert(input: NewItem): Item {
    const createdAt = input.createdAt ?? Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO items (title, needed, links, thread_id, project_id, project, requirement, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(
        input.title,
        input.needed,
        JSON.stringify(input.links),
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

  list(filter: ListFilter = {}): Item[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.threadId !== undefined && filter.threadId !== null) {
      clauses.push("thread_id = ?");
      params.push(filter.threadId);
    }
    if (!filter.includeDone) {
      clauses.push("status = 'open'");
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM items ${where}
         ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at ASC, id ASC`,
      )
      .all(...params) as ItemRow[];
    return rows.map(rowToItem);
  }

  setDone(id: number, done: boolean, by: DoneBy, at = Date.now()): Item | null {
    const existing = this.get(id);
    if (existing === null) return null;
    if (done) {
      this.db
        .prepare(
          `UPDATE items SET status = 'done', done_at = ?, done_by = ? WHERE id = ?`,
        )
        .run(at, by, id);
    } else {
      this.db
        .prepare(
          `UPDATE items SET status = 'open', done_at = NULL, done_by = NULL WHERE id = ?`,
        )
        .run(id);
    }
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

export interface LinkTargetContext {
  /** Host a bare path belongs to. */
  hostId: string | null;
  /** Expands a leading `~` when the path lives on the server's own machine. */
  homeDir: string | null;
}

const THREAD_ID_PATTERN = /^(?:@thread:)?(thr_[a-z0-9]+)(?:#.*)?$/iu;

/**
 * Turn one free-form link target into a typed link. `target|label` sets the
 * label; URLs, absolute paths, `~/…` paths and `thr_…` ids are recognised.
 * Returns null when the target cannot be a link.
 */
export function parseLinkTarget(
  raw: string,
  context: LinkTargetContext,
): ItemLink | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const separator = trimmed.indexOf("|");
  const target =
    separator === -1 ? trimmed : trimmed.slice(0, separator).trim();
  const labelPart = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
  const label = labelPart === "" ? null : labelPart;
  if (/^https?:\/\//iu.test(target)) {
    return { kind: "url", url: target, label };
  }
  const threadMatch = THREAD_ID_PATTERN.exec(target);
  if (threadMatch !== null) {
    const threadId = threadMatch[1];
    if (threadId === undefined) return null;
    return { kind: "thread", threadId, label };
  }
  if (target.startsWith("/") || target.startsWith("~/") || target === "~") {
    if (context.hostId === null) return null;
    let path = target;
    if (path.startsWith("~")) {
      if (context.homeDir === null) return null;
      path = context.homeDir + path.slice(1);
    }
    return { kind: "file", hostId: context.hostId, path, label };
  }
  return null;
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

/** One readable line per item for CLI and tool output. */
export function formatItemLine(item: Item): string {
  const box = item.status === "done" ? "[x]" : "[ ]";
  const meta = [item.project, item.requirement].filter(
    (part): part is string => part !== null && part !== "",
  );
  const head = `${box} #${item.id} ${item.title}`;
  const needed =
    item.needed === null || item.needed === "" ? "" : ` — ${item.needed}`;
  const metaText = meta.length > 0 ? ` (${meta.join(" · ")})` : "";
  const links = item.links.map((link) => `\n      ${linkText(link)}`).join("");
  return `${head}${needed}${metaText}${links}`;
}
