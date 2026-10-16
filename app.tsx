// bb-plugin-waiting — frontend entry.
//
// Two surfaces, one list:
// 1. A card above the thread composer, drawn like bb's own To-do, Running and
//    Uncommitted cards: "Waiting on you · 3", expanding into a check-mark list.
// 2. A "Waiting on you" section on the home screen with every open item
//    across threads and projects.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  definePluginApp,
  experimental_FileLink as FileLink,
  experimental_usePluginId as usePluginId,
  UrlLink,
  useBbNavigate,
  useComposer,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { Item, ItemLink, ThreadInfo, rpcContract } from "./server";
import {
  activityRowClass,
  activityTextClass,
} from "@/components/ui/activity-row-styles";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import {
  PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
  PromptStackCollapseRow,
  PromptStackHoverChevron,
  useDisclosureFocusHandoff,
} from "@/components/ui/prompt-stack-disclosure";
import { cn } from "@/lib/utils";

/** Same channel server.ts publishes on (a value import would pull the server in). */
const CHANGED = "waiting-changed";
/** Row height bb's composer cards reserve. */
const CARD_ROW_HEIGHT = 32;
/** bb's PROMPT_STACK_CARD_HEADER_BUTTON_CLASS. */
const CARD_HEADER_BUTTON_CLASS =
  "flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-none px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-background/80";
const LINK_PILL_CLASS =
  "inline-flex h-4 max-w-56 min-w-0 shrink-0 items-center gap-0.5 rounded-full bg-surface-recessed px-1.5 text-2xs leading-none text-subtle-foreground transition-colors hover:text-foreground";
const FOLD_AWAY_MS = 450;

// ---- data --------------------------------------------------------------

interface WaitingData {
  items: Item[];
  threads: Record<string, ThreadInfo>;
}

function useWaitingItems(threadId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<WaitingData | null>(null);
  const refetch = useCallback(() => {
    rpc.call("list", { threadId }).then(setData, () => {
      /* keep the last good list; the next signal retries */
    });
  }, [rpc, threadId]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime(CHANGED, refetch);
  const connection = useRealtimeConnectionState();
  const seenConnected = useRef(false);
  useEffect(() => {
    if (connection !== "connected") return;
    if (seenConnected.current) refetch();
    seenConnected.current = true;
  }, [connection, refetch]);
  const setDone = useCallback(
    (id: number, done: boolean) =>
      rpc.call("setDone", { id, done }).then(refetch, refetch),
    [rpc, refetch],
  );
  return { data, refetch, setDone };
}

/** Items tick visibly, then fold away once the server confirms. */
function useFoldAway(setDone: (id: number, done: boolean) => Promise<void>) {
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);
  const tick = useCallback(
    (id: number, done: boolean) => {
      setTicked((previous) => {
        const next = new Set(previous);
        if (done) next.add(id);
        else next.delete(id);
        return next;
      });
      const existing = timers.current.get(id);
      if (existing !== undefined) clearTimeout(existing);
      if (!done) {
        void setDone(id, false);
        return;
      }
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          void setDone(id, true).finally(() => {
            setTicked((previous) => {
              if (!previous.has(id)) return previous;
              const next = new Set(previous);
              next.delete(id);
              return next;
            });
          });
        }, FOLD_AWAY_MS),
      );
    },
    [setDone],
  );
  return { ticked, tick };
}

// ---- small pieces ------------------------------------------------------

function HandGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M18 11V6a2 2 0 0 0-4 0" />
      <path d="M14 10V4a2 2 0 0 0-4 0v2" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </svg>
  );
}

function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

function linkLabel(link: ItemLink): string {
  if (link.label !== null && link.label !== "") return link.label;
  switch (link.kind) {
    case "url": {
      try {
        const url = new URL(link.url);
        const text = `${url.host}${url.pathname.replace(/\/$/u, "")}${url.search}`;
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

function LinkPill({ link }: { link: ItemLink }) {
  const navigate = useBbNavigate();
  const label = linkLabel(link);
  const inner = (
    <>
      <span className="min-w-0 truncate">{label}</span>
      <Icon name="ArrowUpRight" className="size-2.5 shrink-0" aria-hidden="true" />
    </>
  );
  switch (link.kind) {
    case "url":
      return (
        <UrlLink href={link.url} className={LINK_PILL_CLASS} title={link.url}>
          {inner}
        </UrlLink>
      );
    case "file":
      return (
        <FileLink
          target={{ kind: "host", hostId: link.hostId, path: link.path }}
          className={LINK_PILL_CLASS}
          title={link.path}
        >
          {inner}
        </FileLink>
      );
    case "thread":
      return (
        <button
          type="button"
          className={LINK_PILL_CLASS}
          title={link.threadId}
          onClick={() => navigate.toThread(link.threadId)}
        >
          {inner}
        </button>
      );
  }
}

function ThreadPill({ threadId, title }: { threadId: string; title: string | null }) {
  const navigate = useBbNavigate();
  return (
    <button
      type="button"
      className={LINK_PILL_CLASS}
      title="Open the thread"
      onClick={() => navigate.toThread(threadId)}
    >
      <Icon name="MessageSquare" className="size-2.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{title ?? "Untitled thread"}</span>
    </button>
  );
}

function ItemRow({
  item,
  ticked,
  onTick,
  thread,
}: {
  item: Item;
  ticked: boolean;
  onTick: (done: boolean) => void;
  /** Shown only on the overview, where items come from many threads. */
  thread?: { id: string; title: string | null };
}) {
  const state = ticked ? "completed" : "pending";
  const meta: string[] = [];
  if (item.project !== null) meta.push(item.project);
  if (item.requirement !== null) meta.push(item.requirement);
  meta.push(relativeTime(item.createdAt));
  const checkboxId = `waiting-item-${item.id}`;
  return (
    <li
      className={activityRowClass(
        state,
        "flex min-w-0 items-start gap-2 text-xs transition-opacity",
      )}
    >
      <Checkbox
        id={checkboxId}
        checked={ticked}
        onCheckedChange={(checked) => onTick(checked === true)}
        aria-label={`Mark "${item.title}" ${ticked ? "not done" : "done"}`}
        className="mt-0.5"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={checkboxId} className="cursor-pointer leading-5">
          <span className={activityTextClass(state, "text-foreground")}>
            {item.title}
          </span>
          {item.needed === null ? null : (
            <span className="text-muted-foreground"> · {item.needed}</span>
          )}
        </label>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <span
            className="text-2xs text-subtle-foreground"
            title={new Date(item.createdAt).toLocaleString()}
          >
            {meta.join(" · ")}
          </span>
          {thread === undefined ? null : (
            <ThreadPill threadId={thread.id} title={thread.title} />
          )}
          {item.links.map((link, index) => (
            <LinkPill key={`${item.id}-${index}`} link={link} />
          ))}
        </div>
      </div>
    </li>
  );
}

/** bb's AnimatedDisclosureBody: grid-row collapse, top border, collapse row. */
function DisclosureBody({
  id,
  labelledBy,
  isExpanded,
  collapseLabel,
  collapseRef,
  onCollapse,
  children,
}: {
  id: string;
  labelledBy: string;
  isExpanded: boolean;
  collapseLabel: string;
  collapseRef: RefObject<HTMLButtonElement | null>;
  onCollapse: () => void;
  children: ReactNode;
}) {
  const [realized, setRealized] = useState(isExpanded);
  if (isExpanded && !realized) setRealized(true);
  return (
    <section
      id={id}
      role="region"
      aria-labelledby={labelledBy}
      aria-hidden={!isExpanded}
      inert={!isExpanded}
      className={cn(
        "grid overflow-hidden transition-[grid-template-rows,opacity,border-color] duration-200 ease-out",
        isExpanded
          ? "grid-rows-[1fr] border-t border-border opacity-100"
          : "pointer-events-none grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="overflow-hidden bg-popover">
        {realized || isExpanded ? children : null}
        <div className="px-1 pb-1">
          <PromptStackCollapseRow
            buttonRef={collapseRef}
            controlsId={id}
            label={collapseLabel}
            onCollapse={onCollapse}
          />
        </div>
      </div>
    </section>
  );
}

function useStoredExpanded(key: string): [boolean, (next: boolean) => void] {
  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const update = useCallback(
    (next: boolean) => {
      setExpanded(next);
      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        /* storage unavailable: state is per mount */
      }
    },
    [key],
  );
  return [expanded, update];
}

// ---- the composer card -------------------------------------------------

function WaitingCard() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const pluginId = usePluginId();
  const { data, setDone } = useWaitingItems(threadId);
  const { ticked, tick } = useFoldAway(setDone);
  const [isExpanded, setExpanded] = useStoredExpanded(`${pluginId}:card-expanded`);
  const focus = useDisclosureFocusHandoff(isExpanded, () => setExpanded(!isExpanded));
  const items = data?.items ?? [];
  if (threadId === null || items.length === 0) return null;
  const bodyId = `waiting-card-body-${threadId}`;
  const toggleId = `waiting-card-toggle-${threadId}`;
  const summary = `Waiting on you · ${items.length}`;
  return (
    <div
      className="overflow-hidden"
      style={{ minHeight: CARD_ROW_HEIGHT }}
      aria-label="Waiting on you"
    >
      <div className="flex items-center">
        <button
          type="button"
          id={toggleId}
          aria-expanded={isExpanded}
          aria-controls={bodyId}
          aria-label={`${summary} ${items.length === 1 ? "item" : "items"}`}
          ref={focus.triggerRef}
          onClick={focus.onTriggerClick}
          className={cn(CARD_HEADER_BUTTON_CLASS, PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS)}
        >
          <HandGlyph className="size-3.5 shrink-0 text-foreground" />
          <span className="min-w-0 flex-1 truncate text-left font-medium">
            {summary}
          </span>
          <PromptStackHoverChevron isExpanded={isExpanded} />
        </button>
      </div>
      <DisclosureBody
        id={bodyId}
        labelledBy={toggleId}
        isExpanded={isExpanded}
        collapseLabel="Collapse waiting on you"
        collapseRef={focus.collapseRef}
        onCollapse={focus.onCollapseClick}
      >
        <ul className="max-h-64 space-y-1 overflow-y-auto px-2.5 pb-2 pt-2">
          {items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              ticked={ticked.has(item.id)}
              onTick={(done) => tick(item.id, done)}
            />
          ))}
        </ul>
      </DisclosureBody>
    </div>
  );
}

// ---- the home overview -------------------------------------------------

function groupByProject(items: readonly Item[]): [string, Item[]][] {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const key = item.project ?? "";
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  });
}

function Overview() {
  const { data, setDone } = useWaitingItems(null);
  const { ticked, tick } = useFoldAway(setDone);
  if (data === null) return null;
  if (data.items.length === 0) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Nothing waiting on you.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {groupByProject(data.items).map(([project, items]) => (
        <section key={project || "none"} className="space-y-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">
            {project === "" ? "Elsewhere" : project}
            <span className="text-subtle-foreground"> · {items.length}</span>
          </h3>
          <ul className="space-y-1 rounded-lg border border-border bg-card px-1.5 py-1.5">
            {items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                ticked={ticked.has(item.id)}
                onTick={(done) => tick(item.id, done)}
                thread={
                  item.threadId === null
                    ? undefined
                    : {
                        id: item.threadId,
                        title: data.threads[item.threadId]?.title ?? null,
                      }
                }
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "waiting",
    scopes: ["thread"],
    banners: [{ id: "card", chrome: "card", component: WaitingCard }],
  });
  app.slots.homepageSection({
    id: "overview",
    title: "Waiting on you",
    component: Overview,
  });
});
