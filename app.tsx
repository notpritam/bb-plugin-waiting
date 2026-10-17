// bb-plugin-waiting — frontend entry.
//
// Two surfaces, one list:
// 1. A card above the thread composer, drawn like bb's own To-do, Running and
//    Uncommitted cards: "Waiting on you · 3", expanding into a check-mark list.
// 2. A "Waiting on you" section on the home screen with every open item
//    across threads and projects.
//
// Each row: tick it done; tap a choice to answer (the answer is kept for the
// thread's agent and shows quietly in place; nothing is sent); or, from the
// row's menu, "Do now", "Next", "Later" (tomorrow, next week, a date) and
// "Reply…" in the card. The card's "Send answers" sends every kept answer of
// the thread in one message, when the user wants the agent woken.
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
import type { Item, ItemAction, ItemLink, ThreadInfo, rpcContract } from "./server";
import {
  activityRowClass,
  activityTextClass,
} from "@/components/ui/activity-row-styles";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
/** The card header's one action, "Send answers": small, outlined. */
const HEADER_ACTION_CLASS =
  "mr-2 inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-1.5 text-2xs font-medium leading-none text-foreground transition-colors hover:bg-state-hover disabled:pointer-events-none disabled:opacity-50";
/** A choice reads as a button: outlined, foreground text. */
const CHOICE_PILL_CLASS =
  "inline-flex h-4 shrink-0 items-center rounded-full border border-border bg-background px-1.5 text-2xs font-medium leading-none text-foreground transition-colors hover:bg-state-hover disabled:pointer-events-none disabled:opacity-50";
/** bb's row actions: hidden until the row is hovered or focused, always on touch. */
const MORE_BUTTON_CLASS =
  "inline-flex size-5 shrink-0 items-center justify-center rounded-md text-subtle-foreground opacity-0 transition-opacity hover:bg-state-hover hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:bg-state-active data-[state=open]:text-foreground data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100";
const FOLD_AWAY_MS = 450;
/** Re-check "later" items at least this often while one is pending. */
const MAX_RETURN_TIMER_MS = 60 * 60 * 1000;
const LATER_HOUR = 9;

// ---- data --------------------------------------------------------------

interface WaitingData {
  items: Item[];
  threads: Record<string, ThreadInfo>;
  returnsAt: number | null;
}

function useWaitingItems(threadId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<WaitingData | null>(null);
  const refetch = useCallback(
    (): Promise<void> =>
      rpc.call("list", { threadId }).then(setData, () => {
        /* keep the last good list; the next signal retries */
      }),
    [rpc, threadId],
  );
  useEffect(() => {
    void refetch();
  }, [refetch]);
  useRealtime(CHANGED, () => void refetch());
  const connection = useRealtimeConnectionState();
  const seenConnected = useRef(false);
  useEffect(() => {
    if (connection !== "connected") return;
    if (seenConnected.current) void refetch();
    seenConnected.current = true;
  }, [connection, refetch]);
  // Items put off for later come back on their own.
  const returnsAt = data?.returnsAt ?? null;
  useEffect(() => {
    if (returnsAt === null) return;
    const delay = Math.min(Math.max(returnsAt - Date.now(), 0) + 500, MAX_RETURN_TIMER_MS);
    const timer = setTimeout(() => void refetch(), delay);
    return () => clearTimeout(timer);
  }, [returnsAt, refetch]);
  /** Resolves once the list on screen shows the change. */
  const settle = useCallback(
    (call: Promise<unknown>) =>
      call.then(
        () => refetch(),
        (error: unknown) => {
          void refetch();
          throw error;
        },
      ),
    [refetch],
  );
  const setDone = useCallback(
    (id: number, done: boolean) => settle(rpc.call("setDone", { id, done })),
    [rpc, settle],
  );
  const act = useCallback(
    (id: number, action: ItemAction) => settle(rpc.call("act", { id, action })),
    [rpc, settle],
  );
  const sendAnswers = useCallback(
    (forThread: string) => settle(rpc.call("sendAnswers", { threadId: forThread })),
    [rpc, settle],
  );
  return { data, setDone, act, sendAnswers };
}

/** Answered on the card; the thread's agent hasn't picked it up yet. */
function isPendingAnswer(item: Item): boolean {
  return item.status === "done" && item.answer !== null && item.pickedUpAt === null;
}

/** Items tick visibly, then fold away once the server confirms. */
function useFoldAway() {
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);
  const untick = (id: number) =>
    setTicked((previous) => {
      if (!previous.has(id)) return previous;
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  const fold = useCallback((id: number, run: () => Promise<void>) => {
    setTicked((previous) => new Set(previous).add(id));
    const existing = timers.current.get(id);
    if (existing !== undefined) clearTimeout(existing);
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        void run().finally(() => untick(id));
      }, FOLD_AWAY_MS),
    );
  }, []);
  /** Cancel a pending fold; true when there was one. */
  const unfold = useCallback((id: number): boolean => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    untick(id);
    return timer !== undefined;
  }, []);
  return { ticked, fold, unfold };
}

type RowAction = ItemAction | { kind: "done"; done: boolean } | { kind: "reply" };

const FAILED = "Didn't go through. Try again, or reply in the thread.";

/**
 * Routes a row's actions: ticks and "Do now" fold away; an answer stays in
 * place (shown at once, before the server confirms); later/next refetch.
 */
function useRowActions(
  setDone: (id: number, done: boolean) => Promise<void>,
  act: (id: number, action: ItemAction) => Promise<void>,
  reply?: (item: Item) => void,
) {
  const { ticked, fold, unfold } = useFoldAway();
  const [errors, setErrors] = useState<ReadonlyMap<number, string>>(new Map());
  const [answering, setAnswering] = useState<ReadonlyMap<number, string>>(new Map());
  const run = useCallback((id: number, task: () => Promise<void>) => {
    setErrors((previous) => {
      if (!previous.has(id)) return previous;
      const next = new Map(previous);
      next.delete(id);
      return next;
    });
    return task().catch(() => {
      setErrors((previous) => new Map(previous).set(id, FAILED));
    });
  }, []);
  const onAct = useCallback(
    (item: Item, action: RowAction) => {
      switch (action.kind) {
        case "done":
          if (action.done) fold(item.id, () => run(item.id, () => setDone(item.id, true)));
          else if (!unfold(item.id)) void run(item.id, () => setDone(item.id, false));
          return;
        case "answer":
          setAnswering((previous) => new Map(previous).set(item.id, action.answer));
          void run(item.id, () => act(item.id, action)).finally(() =>
            setAnswering((previous) => {
              const next = new Map(previous);
              next.delete(item.id);
              return next;
            }),
          );
          return;
        case "doNow":
          fold(item.id, () => run(item.id, () => act(item.id, action)));
          return;
        case "later":
        case "next":
          void run(item.id, () => act(item.id, action));
          return;
        case "reply":
          reply?.(item);
          return;
      }
    },
    [act, fold, reply, run, setDone, unfold],
  );
  return { ticked, errors, answering, onAct };
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

/** Later times land at 9 in the morning, in the browser's time zone. */
function atLaterHour(date: Date): number {
  const next = new Date(date);
  next.setHours(LATER_HOUR, 0, 0, 0);
  return next.getTime();
}

function tomorrow(): number {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return atLaterHour(date);
}

function nextMonday(): number {
  const date = new Date();
  const ahead = (8 - date.getDay()) % 7 || 7;
  date.setDate(date.getDate() + ahead);
  return atLaterHour(date);
}

function todayInputValue(): string {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function fromDateInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return null;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    LATER_HOUR,
  );
  return Number.isNaN(date.getTime()) ? null : date.getTime();
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
      // Added before links had to open on the web: flag it, quietly.
      return (
        <FileLink
          target={{ kind: "host", hostId: link.hostId, path: link.path }}
          className={cn(LINK_PILL_CLASS, "text-destructive-text")}
          title={`${link.path}: a file on the host, which doesn't open on the web. Ask the agent for an https link.`}
        >
          <Icon name="TriangleAlert" fallback="Info" className="size-2.5 shrink-0" aria-hidden="true" />
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

/** "Pick a date…": opens the native date picker, hidden input and all. */
function PickDateItem({ onPick }: { onPick: (until: number) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <DropdownMenuItem
      onSelect={(event) => {
        event.preventDefault();
        const input = inputRef.current;
        if (input === null) return;
        try {
          input.showPicker();
        } catch {
          input.focus();
        }
      }}
    >
      <Icon name="Calendar" />
      Pick a date…
      <input
        ref={inputRef}
        type="date"
        min={todayInputValue()}
        tabIndex={-1}
        aria-label="Date to come back on"
        className="sr-only"
        onChange={(event) => {
          const until = fromDateInput(event.currentTarget.value);
          if (until !== null) onPick(until);
        }}
      />
    </DropdownMenuItem>
  );
}

function RowMenu({
  title,
  disabled,
  canReply,
  onAct,
}: {
  title: string;
  disabled: boolean;
  canReply: boolean;
  onAct: (action: RowAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const later = (until: number) => {
    setOpen(false);
    onAct({ kind: "later", until });
  };
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`More for "${title}"`}
          className={MORE_BUTTON_CLASS}
        >
          <Icon name="MoreHorizontal" className="size-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onAct({ kind: "doNow" })}>
          <Icon name="Play" />
          Do now
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAct({ kind: "next" })}>
          <Icon name="ArrowUp" />
          Next
        </DropdownMenuItem>
        {canReply ? (
          <DropdownMenuItem onSelect={() => onAct({ kind: "reply" })}>
            <Icon name="CornerDownLeft" />
            Reply…
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Later</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => later(tomorrow())}>
          <Icon name="Clock" />
          Tomorrow
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => later(nextMonday())}>
          <Icon name="Clock" />
          Next week
        </DropdownMenuItem>
        <PickDateItem onPick={later} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ItemRow({
  item,
  ticked,
  error,
  answering,
  onAct,
  canReply,
  thread,
}: {
  item: Item;
  ticked: boolean;
  error: string | undefined;
  /** The choice just tapped, shown before the server confirms it. */
  answering: string | undefined;
  onAct: (action: RowAction) => void;
  canReply: boolean;
  /** Shown only on the overview, where items come from many threads. */
  thread?: { id: string; title: string | null };
}) {
  // Answered: kept for the agent. The row stays, quiet, with the answer.
  const answer = answering ?? (isPendingAnswer(item) ? item.answer : null);
  const answered = answer !== null;
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
        "group flex min-w-0 items-start gap-2 text-xs transition-opacity",
      )}
    >
      <Checkbox
        id={checkboxId}
        checked={ticked || answered}
        disabled={answering !== undefined}
        onCheckedChange={(checked) => onAct({ kind: "done", done: checked === true })}
        aria-label={
          answered
            ? `Take back the answer to "${item.title}"`
            : `Mark "${item.title}" ${ticked ? "not done" : "done"}`
        }
        className="mt-0.5"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* An answered row's title doesn't toggle: only its check mark takes the answer back. */}
        <label
          htmlFor={answered ? undefined : checkboxId}
          className={answered ? "leading-5" : "cursor-pointer leading-5"}
        >
          <span
            className={
              answered
                ? "text-muted-foreground"
                : activityTextClass(state, "text-foreground")
            }
          >
            {item.title}
          </span>
          {answered ? (
            <span className="text-subtle-foreground">
              {" · "}
              <span className="font-medium text-muted-foreground">{answer}</span>
            </span>
          ) : item.needed === null ? null : (
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
          {answered
            ? null
            : item.choices.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  disabled={ticked}
                  className={CHOICE_PILL_CLASS}
                  title={`Answer "${choice}"; it is kept for the thread's agent`}
                  onClick={() => onAct({ kind: "answer", answer: choice })}
                >
                  {choice}
                </button>
              ))}
          {error === undefined ? null : (
            <span role="alert" className="text-2xs text-destructive">
              {error}
            </span>
          )}
        </div>
      </div>
      {answered ? (
        <span className="size-5 shrink-0" aria-hidden="true" />
      ) : (
        <RowMenu title={item.title} disabled={ticked} canReply={canReply} onAct={onAct} />
      )}
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
  const { data, setDone, act, sendAnswers } = useWaitingItems(threadId);
  // "Reply…" starts the answer in this thread's composer.
  const reply = useCallback(
    (item: Item) => {
      const lead = composer.text.trim() === "" ? "" : "\n";
      composer.insert(`${lead}Re #${item.id} "${item.title}": `, { at: "end" });
      composer.focus();
    },
    [composer],
  );
  const { ticked, errors, answering, onAct } = useRowActions(setDone, act, reply);
  const [isExpanded, setExpanded] = useStoredExpanded(`${pluginId}:card-expanded`);
  const focus = useDisclosureFocusHandoff(isExpanded, () => setExpanded(!isExpanded));
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const items = data?.items ?? [];
  if (threadId === null || items.length === 0) return null;
  const bodyId = `waiting-card-body-${threadId}`;
  const toggleId = `waiting-card-toggle-${threadId}`;
  const answeredCount = items.filter(
    (item) => answering.has(item.id) || isPendingAnswer(item),
  ).length;
  const openCount = items.length - answeredCount;
  const counts = [
    ...(openCount > 0 ? [String(openCount)] : []),
    ...(answeredCount > 0 ? [`${answeredCount} answered`] : []),
  ];
  const summary = `Waiting on you · ${counts.join(" · ")}`;
  const onSend = () => {
    setSending(true);
    setSendError(null);
    sendAnswers(threadId)
      .catch(() => setSendError(FAILED))
      .finally(() => setSending(false));
  };
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
          aria-label={summary}
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
        {answeredCount > 0 ? (
          <button
            type="button"
            disabled={sending || answering.size > 0}
            className={HEADER_ACTION_CLASS}
            title="Send every answer to this thread in one message, to wake its agent. Otherwise they wait for it, unsent."
            onClick={onSend}
          >
            {sending ? "Sending…" : "Send answers"}
          </button>
        ) : null}
      </div>
      {sendError === null ? null : (
        <p role="alert" className="px-3 pb-1.5 text-2xs text-destructive">
          {sendError}
        </p>
      )}
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
              error={errors.get(item.id)}
              answering={answering.get(item.id)}
              onAct={(action) => onAct(item, action)}
              canReply
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
  const { data, setDone, act } = useWaitingItems(null);
  const { ticked, errors, answering, onAct } = useRowActions(setDone, act);
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
                error={errors.get(item.id)}
                answering={answering.get(item.id)}
                onAct={(action) => onAct(item, action)}
                canReply={false}
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
