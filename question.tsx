// The question form for a thread's items with choices, in bb's own question
// menu above the composer (R-385).
//
// Drawn the way bb draws its own questions (the Ask User Question form): one
// tab per item when there are several ("1 of 3"), one row per choice with
// its number key, "Other…" to type an answer (with bb's voice input),
// Cancel, Back, Next and Submit answer. Above the choices: the item, what is
// needed, and its links. Submit keeps each answer for the thread's agent (it
// is not sent); Cancel, and any item left unanswered, go back to the
// Waiting on you card.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
} from "react";
import {
  experimental_VoiceInputTextarea as VoiceInputTextarea,
  experimental_useQuestionFormHost as useQuestionFormHost,
  type ExperimentalQuestionShortcut,
  type PluginPendingInteractionProps,
} from "@get-bb/plugin-sdk/app";
import type { ItemLink, QuestionSubmission } from "./server";
import { LinkPill, readLink } from "./links";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** bb's label for the free-text row. */
const OTHER_LABEL = "Other…";
/** bb's free-text box: grows from this height to the max, then scrolls. */
const OTHER_MIN_HEIGHT = 84;
const OTHER_MAX_HEIGHT = 158;
const MAX_ANSWER = 400;
const MAX_QUESTIONS = 10;
const DRAFT_PREFIX = "waiting.question-draft.v1:";
/** bb's tab strip: fade edges past this scroll, keep this margin around the current tab. */
const TAB_SCROLL_EPSILON = 1;
const TAB_SCROLL_MARGIN = 24;

// ---- bb's button, as its question form uses it --------------------------

const BUTTON_BASE =
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors duration-150 hover:duration-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_[data-icon-root]]:pointer-events-none [&_[data-icon-root]]:size-4 [&_[data-icon-root]]:shrink-0";
const BUTTON_VARIANT = {
  default: "bg-foreground text-background hover:bg-foreground/90",
  outline: "border border-input bg-transparent hover:bg-state-hover hover:text-foreground",
  ghost:
    "hover:bg-state-hover hover:text-foreground aria-pressed:bg-state-active aria-pressed:text-foreground aria-pressed:hover:bg-state-active data-[state=open]:bg-state-active data-[state=open]:text-foreground data-[state=open]:hover:bg-state-active",
} as const;
const BUTTON_SMALL = "h-8 rounded-md px-3 text-xs";

function FormButton({
  variant = "default",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON_VARIANT }) {
  return (
    <button
      type="button"
      className={cn(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SMALL, className)}
      {...props}
    />
  );
}

// ---- the payload --------------------------------------------------------

interface Question {
  itemId: number;
  title: string;
  needed: string | null;
  choices: string[];
  links: ItemLink[];
  project: string | null;
  requirement: string | null;
}

/** The server's payload, checked: the app never trusts its shape. */
function readQuestions(value: unknown): Question[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>).questions;
  if (!Array.isArray(raw)) return null;
  const questions = raw
    .map(readQuestion)
    .filter((question): question is Question => question !== null)
    .slice(0, MAX_QUESTIONS);
  return questions.length > 0 ? questions : null;
}

function readQuestion(value: unknown): Question | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.itemId !== "number" || typeof raw.title !== "string") return null;
  if (!Array.isArray(raw.choices)) return null;
  const choices = raw.choices.filter((choice): choice is string => typeof choice === "string");
  if (choices.length === 0) return null;
  const links = Array.isArray(raw.links)
    ? raw.links.map(readLink).filter((link): link is ItemLink => link !== null)
    : [];
  const text = (field: unknown) => (typeof field === "string" && field.trim() !== "" ? field : null);
  return {
    itemId: raw.itemId,
    title: raw.title,
    needed: text(raw.needed),
    choices,
    links,
    project: text(raw.project),
    requirement: text(raw.requirement),
  };
}

// ---- the drafts: picks survive switching threads and a re-opened set ----

interface FormState {
  selected: string | null;
  otherSelected: boolean;
  otherText: string;
}

const EMPTY_STATE: FormState = { selected: null, otherSelected: false, otherText: "" };

function draftKey(question: Question): string {
  return `${DRAFT_PREFIX}${question.itemId}`;
}

function readDraft(question: Question): FormState {
  try {
    const raw = JSON.parse(window.localStorage.getItem(draftKey(question)) ?? "null") as unknown;
    if (typeof raw !== "object" || raw === null) return EMPTY_STATE;
    const draft = raw as Record<string, unknown>;
    const selected =
      typeof draft.selected === "string" && question.choices.includes(draft.selected)
        ? draft.selected
        : null;
    return {
      selected,
      otherSelected: draft.otherSelected === true,
      otherText: typeof draft.otherText === "string" ? draft.otherText.slice(0, MAX_ANSWER) : "",
    };
  } catch {
    return EMPTY_STATE;
  }
}

/** The answer a question's state gives, or null while it has none. */
function answerOf(state: FormState): { answer: string; typed: boolean } | null {
  if (state.otherSelected) {
    const text = state.otherText.trim().slice(0, MAX_ANSWER);
    return text === "" ? null : { answer: text, typed: true };
  }
  return state.selected === null ? null : { answer: state.selected, typed: false };
}

function useDrafts(questions: readonly Question[]) {
  const [states, setStates] = useState<Record<number, FormState>>(() =>
    Object.fromEntries(questions.map((question) => [question.itemId, readDraft(question)])),
  );
  const stateOf = useCallback(
    (question: Question): FormState => states[question.itemId] ?? EMPTY_STATE,
    [states],
  );
  const update = useCallback((question: Question, change: (previous: FormState) => FormState) => {
    setStates((previous) => {
      const next = change(previous[question.itemId] ?? EMPTY_STATE);
      try {
        window.localStorage.setItem(draftKey(question), JSON.stringify(next));
      } catch {
        /* storage unavailable: the pick lasts while the form is open */
      }
      return { ...previous, [question.itemId]: next };
    });
  }, []);
  const clear = useCallback(() => {
    for (const question of questions) {
      try {
        window.localStorage.removeItem(draftKey(question));
      } catch {
        /* nothing kept */
      }
    }
  }, [questions]);
  return { stateOf, update, clear };
}

// ---- bb's host shortcuts ------------------------------------------------

type FormAction = "cancel" | "next" | "previous" | "submit";

/** Newer bb also binds form-level keys (Submit, Cancel); older bb has only the number keys. */
interface FormHost {
  shortcuts: ReadonlyMap<string, ExperimentalQuestionShortcut>;
  registerChoiceHandler(handler: (index: number) => boolean): () => void;
  actionShortcuts?: ReadonlyMap<FormAction, ExperimentalQuestionShortcut>;
  registerActionHandler?(handler: (action: FormAction) => boolean): () => void;
}

function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(pointer: coarse)");
    const onChange = () => setCoarse(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return coarse;
}

// ---- the pieces ----------------------------------------------------------

/** One choice: bb's option row (a round check, the label, its key). */
function OptionRow({
  checked,
  label,
  shortcut,
  onSelect,
}: {
  checked: boolean;
  label: string;
  shortcut: ExperimentalQuestionShortcut | undefined;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors",
        checked ? "bg-surface-selected" : "hover:bg-state-hover",
      )}
    >
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full border",
          checked ? "border-primary bg-primary text-primary-foreground" : "border-input",
        )}
      >
        {checked ? <Icon name="Check" className="size-3" aria-hidden="true" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-foreground">{label}</span>
      </span>
      {shortcut ? (
        <kbd aria-hidden="true" className="shrink-0 text-xs font-normal text-subtle-foreground">
          {shortcut.label}
        </kbd>
      ) : null}
    </button>
  );
}

/** bb's edge fade on the tab strip. */
function TabFade({ side, visible }: { side: "left" | "right"; visible: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-y-0 z-10 w-6",
        side === "left"
          ? "left-0 bg-gradient-to-l from-transparent to-surface-recessed-solid"
          : "right-0 bg-gradient-to-r from-transparent to-surface-recessed-solid",
        visible ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

/** bb's question tabs: one per item, struck through once answered, "1 of 3". */
function QuestionTabs({
  questions,
  currentIndex,
  answered,
  disabled,
  onSelect,
}: {
  questions: readonly Question[];
  currentIndex: number;
  answered: (question: Question) => boolean;
  disabled: boolean;
  onSelect: (index: number) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [fades, setFades] = useState({ start: false, end: false });
  const measure = useCallback(() => {
    const strip = stripRef.current;
    if (strip === null) return;
    const max = strip.scrollWidth - strip.clientWidth;
    const start = strip.scrollLeft > TAB_SCROLL_EPSILON;
    const end = strip.scrollLeft < max - TAB_SCROLL_EPSILON;
    setFades((previous) =>
      previous.start === start && previous.end === end ? previous : { start, end },
    );
  }, []);
  useEffect(() => {
    const strip = stripRef.current;
    if (strip === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [measure]);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const tab = tabRefs.current[currentIndex];
    if (strip !== null && tab) {
      const left = tab.offsetLeft - TAB_SCROLL_MARGIN;
      const right = tab.offsetLeft + tab.offsetWidth + TAB_SCROLL_MARGIN;
      if (left < strip.scrollLeft) strip.scrollLeft = Math.max(0, left);
      else if (right > strip.scrollLeft + strip.clientWidth) {
        strip.scrollLeft = right - strip.clientWidth;
      }
    }
    measure();
  }, [currentIndex, measure, questions.length]);
  return (
    <div className="mb-2 flex shrink-0 items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <TabFade side="left" visible={fades.start} />
        <TabFade side="right" visible={fades.end} />
        <div
          ref={stripRef}
          onScroll={measure}
          data-question-tabs=""
          className="relative flex min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {questions.map((question, index) => {
            const current = index === currentIndex;
            return (
              <div
                key={question.itemId}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                className={cn(
                  "relative inline-flex h-7 shrink-0 items-center rounded-md",
                  current ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-state-hover",
                )}
              >
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onSelect(index)}
                  aria-pressed={current}
                  title={question.title}
                  className="flex h-full min-w-0 items-center rounded-md px-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span
                    className={cn("truncate text-xs", answered(question) ? "line-through" : undefined)}
                    style={{ maxWidth: "180px" }}
                  >
                    {question.title}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {currentIndex + 1} of {questions.length}
      </span>
    </div>
  );
}

function QuestionForm({
  questions,
  submit,
  cancel,
}: {
  questions: Question[];
  submit: (value: QuestionSubmission) => Promise<void>;
  cancel: () => Promise<void>;
}) {
  const host = useQuestionFormHost() as FormHost;
  const { stateOf, update, clear } = useDrafts(questions);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [busy, setBusy] = useState<"submit" | "cancel" | null>(null);
  const [voiceActive, setVoiceActive] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const coarse = useCoarsePointer();

  const count = questions.length;
  const index = Math.min(currentIndex, count - 1);
  const question = questions[index] ?? questions[0]!;
  const state = stateOf(question);
  const isFirst = index === 0;
  const isLast = index === count - 1;
  const answers = questions.flatMap((entry) => {
    const answer = answerOf(stateOf(entry));
    return answer === null ? [] : [{ itemId: entry.itemId, ...answer }];
  });
  const locked = busy !== null || voiceActive;
  // Any answered item can be kept; the rest go back to the card.
  const canSubmit = !locked && answers.length > 0;

  const onSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setBusy("submit");
    try {
      await submit({ answers });
      clear();
    } catch {
      // bb shows what went wrong above the form; the picks stay.
      setBusy(null);
    }
  }, [answers, canSubmit, clear, submit]);

  const onCancel = useCallback(async () => {
    if (busy !== null) return;
    setBusy("cancel");
    try {
      await cancel();
    } catch {
      setBusy(null);
    }
  }, [busy, cancel]);

  /** bb's primary button: Next, or Submit on the last question. */
  const onPrimary = useCallback(() => {
    if (locked) return;
    if (isLast) {
      void onSubmit();
      return;
    }
    setCurrentIndex(index + 1);
  }, [index, isLast, locked, onSubmit]);

  const pick = useCallback(
    (entry: Question, choice: string) =>
      update(entry, (previous) => ({ ...previous, selected: choice, otherSelected: false })),
    [update],
  );
  const pickOther = useCallback(
    (entry: Question) =>
      update(entry, (previous) => ({ ...previous, selected: null, otherSelected: true })),
    [update],
  );

  // Number keys pick a row, the way they do in bb's own questions.
  useEffect(() => {
    if (busy !== null || voiceActive) return;
    return host.registerChoiceHandler((choiceIndex) => {
      if (choiceIndex < question.choices.length) {
        const choice = question.choices[choiceIndex];
        if (choice === undefined) return false;
        pick(question, choice);
        rootRef.current?.focus();
        return true;
      }
      if (choiceIndex === question.choices.length) {
        pickOther(question);
        return true;
      }
      return false;
    });
  }, [busy, host, pick, pickOther, question, voiceActive]);

  // Submit, Cancel, Back and Next keys, where bb binds them.
  const actionRef = useRef<(action: FormAction) => boolean>(() => false);
  actionRef.current = (action) => {
    if (action === "cancel") {
      if (busy !== null) return false;
      void onCancel();
      return true;
    }
    if (locked) return false;
    if (action === "submit") {
      if (isLast && !canSubmit) return false;
      onPrimary();
    } else if (action === "previous") {
      if (isFirst) return false;
      setCurrentIndex(index - 1);
    } else {
      if (isLast) return false;
      setCurrentIndex(index + 1);
    }
    rootRef.current?.focus();
    return true;
  };
  const registerAction = host.registerActionHandler;
  useEffect(() => {
    if (registerAction === undefined) return;
    return registerAction.call(host, (action) => actionRef.current(action));
  }, [host, registerAction]);

  // bb's free-text box grows with what is typed.
  useLayoutEffect(() => {
    const box = textRef.current;
    if (box === null || !state.otherSelected) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(Math.max(box.scrollHeight, OTHER_MIN_HEIGHT), OTHER_MAX_HEIGHT)}px`;
  }, [question.itemId, state.otherSelected, state.otherText]);

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.target !== event.currentTarget ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.key !== "Enter" ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      busy !== null
    ) {
      return;
    }
    event.preventDefault();
    onPrimary();
  };

  const onTextKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      coarse ||
      event.nativeEvent.isComposing ||
      event.key !== "Enter" ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    actionRef.current("submit");
  };

  const meta = [question.project, question.requirement].filter(
    (part): part is string => part !== null,
  );
  const hasContext = meta.length > 0 || question.links.length > 0;
  const shortcutFor = (action: FormAction) => host.actionShortcuts?.get(action)?.ariaKeyshortcuts;

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-question-form=""
      onKeyDown={onRootKeyDown}
      className="-m-1 flex min-h-0 flex-col rounded-md p-1 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {count > 1 ? (
        <QuestionTabs
          questions={questions}
          currentIndex={index}
          answered={(entry) => answerOf(stateOf(entry)) !== null}
          disabled={locked}
          onSelect={setCurrentIndex}
        />
      ) : null}
      <fieldset key={question.itemId} disabled={busy !== null} className="min-w-0">
        <legend className="sr-only">{question.title}</legend>
        <div className="text-xs font-medium text-foreground">{question.title}</div>
        {question.needed === null ? null : (
          <div className="mt-0.5 text-xs leading-snug text-muted-foreground">{question.needed}</div>
        )}
        {hasContext ? (
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
            {meta.length > 0 ? (
              <span className="text-2xs text-subtle-foreground">{meta.join(" · ")}</span>
            ) : null}
            {question.links.map((link, linkIndex) => (
              <LinkPill key={`${question.itemId}-${linkIndex}`} link={link} />
            ))}
          </div>
        ) : null}
        <div className="mt-2 space-y-0.5">
          {question.choices.map((choice, choiceIndex) => (
            <OptionRow
              key={choice}
              checked={!state.otherSelected && state.selected === choice}
              label={choice}
              shortcut={host.shortcuts.get(String(choiceIndex))}
              onSelect={() => pick(question, choice)}
            />
          ))}
          <OptionRow
            checked={state.otherSelected}
            label={OTHER_LABEL}
            shortcut={host.shortcuts.get(String(question.choices.length))}
            onSelect={() => pickOther(question)}
          />
        </div>
        {state.otherSelected ? (
          <VoiceInputTextarea
            ref={textRef}
            aria-label={`${question.title}: your answer`}
            value={state.otherText}
            rows={1}
            autoFocus={!coarse}
            autoComplete="off"
            maxLength={MAX_ANSWER}
            onValueChange={(value) => update(question, (previous) => ({ ...previous, otherText: value }))}
            onVoiceInputActiveChange={setVoiceActive}
            onKeyDown={onTextKeyDown}
            placeholder="Type your own answer…"
            className="mt-2 block w-full resize-none overflow-y-auto rounded-md border border-border bg-surface-raised px-3 py-2 text-xs leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:border-ring/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
            style={{ minHeight: `${OTHER_MIN_HEIGHT}px`, maxHeight: `${OTHER_MAX_HEIGHT}px` }}
          />
        ) : null}
      </fieldset>
      <div className="mt-3 flex shrink-0 items-center justify-between gap-2">
        <FormButton
          variant="ghost"
          aria-keyshortcuts={shortcutFor("cancel")}
          title="Back to the Waiting on you card, unanswered"
          disabled={busy !== null}
          onClick={() => void onCancel()}
        >
          Cancel
        </FormButton>
        <div className="flex items-center gap-2">
          {isFirst ? null : (
            <FormButton
              variant="outline"
              aria-keyshortcuts={shortcutFor("previous")}
              disabled={locked}
              onClick={() => setCurrentIndex(index - 1)}
            >
              Back
            </FormButton>
          )}
          <FormButton
            aria-keyshortcuts={shortcutFor("submit")}
            title={isLast ? "Kept for this thread's agent, not sent. Unanswered ones go back to the card." : undefined}
            disabled={locked || (isLast && !canSubmit)}
            onClick={onPrimary}
          >
            {busy === "submit" ? (
              <Icon name="Spinner" className="size-3 animate-spin" aria-hidden="true" />
            ) : null}
            {isLast ? "Submit answer" : "Next"}
          </FormButton>
        </div>
      </div>
    </div>
  );
}

/** The pending-interaction slot's component, registered as "waiting-question". */
export function WaitingQuestion({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const questions = useMemo(() => readQuestions(interaction.payload), [interaction.payload]);
  if (questions === null) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">This question could not be displayed.</p>
        <FormButton variant="outline" onClick={() => void cancel().catch(() => {})}>
          Cancel
        </FormButton>
      </div>
    );
  }
  return (
    <QuestionForm
      key={interaction.id}
      questions={questions}
      submit={(value) => submit({ answers: value.answers.map((answer) => ({ ...answer })) })}
      cancel={cancel}
    />
  );
}
