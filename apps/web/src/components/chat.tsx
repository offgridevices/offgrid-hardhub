// The conversation: what the AI said, what it did, what it asks, and the box
// to answer in. Items are memoised so a streaming message re-renders alone.
import { memo, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Comparison, Question } from "@hardhub/protocol";
import type { ChatItem } from "../lib/project-state";
import { STAGE_LABEL } from "../lib/format";
import { ArrowUpIcon, CheckIcon, ChevronRightIcon, LoaderCircleIcon, SquareIcon, XIcon } from "lucide-react";
import { ChoiceRow } from "./choice";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const FOLD = "group rounded-lg text-sm text-muted-foreground [&_summary]:flex [&_summary]:cursor-pointer [&_summary]:list-none [&_summary]:items-center [&_summary]:gap-1.5 [&_summary::-webkit-details-marker]:hidden";

/* ---------- questions ---------- */

export const QuestionCard = memo(function QuestionCard({
  id,
  questions,
  open,
  onSubmit,
}: {
  id: string;
  questions: Question[];
  open: boolean;
  onSubmit(answers: Record<string, string[]>): void;
}) {
  // the recommended option is pre-selected: the person confirms or changes it
  const [picked, setPicked] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, q.options.filter((o) => o.recommended).slice(0, q.multi ? undefined : 1).map((o) => o.id)])),
  );
  const [other, setOther] = useState<Record<string, string>>({});

  const toggle = (q: Question, opt: string) =>
    setPicked((p) => {
      const cur = p[q.id] ?? [];
      if (!q.multi) return { ...p, [q.id]: [opt] };
      return { ...p, [q.id]: cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt] };
    });

  const missing = questions.filter((q) => !(picked[q.id]?.length || other[q.id]?.trim())).length;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (missing) return;
    const answers: Record<string, string[]> = {};
    for (const q of questions) {
      const labels = (picked[q.id] ?? []).map((oid) => q.options.find((o) => o.id === oid)?.label ?? oid);
      const free = other[q.id]?.trim();
      // "Other" text replaces a single-choice pick and adds to a multi-choice one
      answers[q.header] = free ? (q.multi ? [...labels, free] : [free]) : labels;
    }
    onSubmit(answers);
  };

  if (!open)
    return (
      <details className={FOLD} data-testid="questions-answered">
        <summary>
          <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
          {questions.length === 1 ? "1 question" : `${questions.length} questions`} · answered
        </summary>
        <p className="mt-2 whitespace-pre-wrap pl-5">{questions.map((q) => q.text).join("\n")}</p>
      </details>
    );

  return (
    <form className="flex flex-col gap-5 rounded-xl border border-ember/30 bg-card p-4" onSubmit={submit} data-testid="questions" data-question-set={id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge tone="ember">{questions.length === 1 ? "One question" : `${questions.length} questions`}</Badge>
        <span className="text-xs text-muted-foreground">Recommended options are selected</span>
      </div>
      {questions.map((q) => (
        <fieldset key={q.id} className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" disabled={!open}>
          <legend className="sr-only">{q.text}</legend>
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{q.header}</div>
          <div className="font-medium" aria-hidden="true">
            {q.text}
            {q.multi && <span className="text-sm font-normal text-muted-foreground"> · pick any</span>}
          </div>
          <div role={q.multi ? "group" : "radiogroup"} className="flex flex-col gap-2">
            {q.options.map((o) => {
              const on = picked[q.id]?.includes(o.id) ?? false;
              return (
                <ChoiceRow
                  key={o.id}
                  multi={q.multi}
                  checked={on}
                  onClick={() => toggle(q, o.id)}
                  data-testid={`option-${q.id}-${o.id}`}
                  title={o.label}
                  detail={o.detail}
                  tag={o.recommended && <Badge tone="moss">Recommended</Badge>}
                />
              );
            })}
            <Input
              placeholder="Other — type your own answer"
              value={other[q.id] ?? ""}
              onChange={(e) => setOther((x) => ({ ...x, [q.id]: e.target.value }))}
              aria-label={`Other answer for: ${q.text}`}
              data-testid={`other-${q.id}`}
            />
          </div>
        </fieldset>
      ))}
      {open && (
        <div className="flex items-center justify-between gap-3 border-t pt-4">
          <span className="text-sm text-muted-foreground">{missing ? `${missing} still to answer` : "Ready to send"}</span>
          <Button type="submit" disabled={missing > 0} data-testid="submit-answers">
            Send answers
          </Button>
        </div>
      )}
    </form>
  );
});

/* ---------- comparison ---------- */

export const ComparisonCard = memo(function ComparisonCard({ c }: { c: Comparison }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card" data-testid="comparison">
      <div className="border-b px-4 py-3 font-medium">{c.title}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              {c.columns.map((h) => (
                <th key={h} className="whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {c.rows.map((r) => (
              <tr key={r.id} className={cn("border-b last:border-0", r.recommended && "bg-moss/[0.07]")}>
                {r.cells.map((cell, i) => (
                  <td key={i} className={cn("px-3 py-2.5 align-top", /^[$\d,.×x ]+$/.test(cell) && "num whitespace-nowrap")} style={i === 1 ? { minWidth: 180 } : undefined}>
                    {cell}
                    {i === 0 && r.recommended && (
                      <Badge tone="moss" className="ml-2">
                        Recommended
                      </Badge>
                    )}
                    {i === 0 && r.warning && <span className="mt-1 block text-xs text-gold-text">{r.warning}</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {c.note && <div className="border-t px-4 py-3 text-sm text-muted-foreground">{c.note}</div>}
    </div>
  );
});

/* ---------- one chat item ---------- */

const ItemView = memo(function ItemView({
  item,
  openQuestions,
  onAnswer,
  onKeyHelp,
  keyLabel,
}: {
  item: ChatItem;
  openQuestions: string | null;
  onAnswer(a: Record<string, string[]>): void;
  onKeyHelp?: () => void;
  keyLabel: string;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="ml-auto w-fit max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-secondary px-3.5 py-2.5">
          {item.answers ? (
            <div className="flex flex-col gap-1 text-sm">
              {Object.entries(item.answers).map(([k, v]) => (
                <div key={k}>
                  <span className="text-muted-foreground">{k}: </span>
                  <span>{v.join(", ")}</span>
                </div>
              ))}
            </div>
          ) : (
            item.text
          )}
        </div>
      );
    case "assistant":
      return (
        <div className={cn("whitespace-pre-wrap text-foreground/90", !item.done && "after:ml-0.5 after:inline-block after:h-4 after:w-1.5 after:translate-y-0.5 after:bg-ember after:[animation:hh-blink_1s_steps(1)_infinite] after:content-['']")}>
          {item.text}
        </div>
      );
    case "thinking":
      return (
        <details className={FOLD}>
          <summary>
            <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
            Reasoning
          </summary>
          <p className="mt-2 whitespace-pre-wrap pl-5">{item.text}</p>
        </details>
      );
    case "tool":
      return (
        <div className="flex items-start gap-2 text-sm" data-testid="tool-row">
          <span className="mt-0.5" aria-hidden="true">
            {item.status === "done" ? (
              <CheckIcon className="size-4 text-moss" />
            ) : item.status === "error" ? (
              <XIcon className="size-4 text-clay" />
            ) : (
              <LoaderCircleIcon className="size-4 animate-spin text-ember" />
            )}
          </span>
          <span className={item.status === "running" ? "text-foreground" : "text-soft"}>
            {item.label}
            {item.detail && <span className="text-muted-foreground"> · {item.detail}</span>}
          </span>
        </div>
      );
    case "questions":
      return <QuestionCard id={item.id} questions={item.questions} open={openQuestions === item.id} onSubmit={onAnswer} />;
    case "comparison":
      return <ComparisonCard c={item.comparison} />;
    case "stage":
      return (
        <div className="flex items-center gap-3 text-xs font-medium text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          {STAGE_LABEL[item.stage]}
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    case "job":
      return (
        <div className="flex flex-col gap-2 rounded-xl border bg-card px-3.5 py-3" data-testid="job">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium">
              {item.job.startsWith("edit-")
                ? item.done
                  ? item.ok === false
                    ? "Your edits are in · a check needs a look"
                    : "Your edits are in · checked"
                  : "Checking your edits in KiCad"
                : item.done
                  ? item.ok === false
                    ? "Board build failed"
                    : "Board built"
                  : "Building the board"}
            </span>
            <span className="text-xs text-muted-foreground">{item.done ? "Done" : item.step}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
            <span
              className={cn("block h-full rounded-full transition-[width] duration-500", item.done ? (item.ok === false ? (item.job.startsWith("edit-") ? "bg-gold" : "bg-clay") : "bg-moss") : "bg-ember")}
              style={{ width: `${Math.round(item.progress * 100)}%` }}
            />
          </div>
        </div>
      );
    case "edit":
      return (
        <div className="mx-auto flex w-fit items-center gap-2 rounded-full bg-foreground/[0.05] px-3 py-1 text-xs text-muted-foreground" data-testid="board-edit">
          <span className={cn("size-1.5 rounded-full", item.ok ? "bg-moss" : "bg-clay")} aria-hidden="true" />
          {item.summary}
        </div>
      );
    case "error":
      return (
        <div className="flex flex-col gap-2 rounded-xl bg-clay/10 px-3.5 py-3 text-sm text-clay-text" role="alert">
          {item.message}
          {onKeyHelp && (
            <div>
              <Button size="sm" variant="outline" onClick={onKeyHelp} data-testid="add-key">
                {keyLabel}
              </Button>
            </div>
          )}
        </div>
      );
  }
});

/* ---------- the log ---------- */

// Long conversations render only their tail; earlier items load on request.
// Each item also uses content-visibility, so off-screen ones cost no layout.
const WINDOW = 120;

export function ChatLog({
  items,
  openQuestions,
  busy,
  onAnswer,
  keyError,
  onKeyHelp,
  keyLabel,
}: {
  items: ChatItem[];
  openQuestions: string | null;
  busy: boolean;
  onAnswer(a: Record<string, string[]>): void;
  keyError: boolean;
  onKeyHelp(): void;
  keyLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [shown, setShown] = useState(WINDOW);
  const start = Math.max(0, items.length - shown);

  // follow the stream while the reader is at the bottom; leave them be if
  // they scrolled up. Content grows as items lay out, so watch its size too.
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    const el = ref.current;
    const box = inner.current;
    if (!el || !box) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, []);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5" ref={ref} onScroll={onScroll} data-testid="chat-log" aria-live="polite">
      <div ref={inner} className="flex flex-col gap-4">
      {start > 0 && (
        <Button variant="ghost" size="sm" className="self-center" onClick={() => setShown((n) => n + WINDOW)}>
          Show {Math.min(start, WINDOW)} earlier
        </Button>
      )}
      {items.slice(start).map((it) => (
        <div key={`${it.kind}:${it.id}`} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 60px" }}>
          <ItemView item={it} openQuestions={openQuestions} onAnswer={onAnswer} onKeyHelp={it.kind === "error" && keyError ? onKeyHelp : undefined} keyLabel={keyLabel} />
        </div>
      ))}
      {busy && !items.some((i) => i.kind === "assistant" && !i.done) && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-label="Working">
          <LoaderCircleIcon className="size-4 animate-spin text-ember" aria-hidden="true" />
          Working…
        </div>
      )}
      </div>
    </div>
  );
}

/* ---------- composer ---------- */

export function Composer({
  busy,
  disabled,
  onSend,
  onStop,
  hint,
}: {
  busy: boolean;
  disabled?: boolean;
  onSend(text: string): void;
  onStop(): void;
  hint: string;
}) {
  const [text, setText] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);

  // grow with the text up to the CSS max-height
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const send = () => {
    const t = text.trim();
    if (!t || busy || disabled) return;
    onSend(t);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="shrink-0 px-3 pb-3 pt-1">
      <div className="flex flex-col gap-1.5 rounded-xl border border-input bg-sunken/70 p-2 pl-3 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30">
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={busy ? "HardHub is working…" : "Reply, ask, or change anything"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          aria-label="Message HardHub"
          data-testid="chat-input"
          disabled={disabled}
          className="max-h-48 min-h-9 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-xs text-muted-foreground">{hint}</span>
          <span className="grow" />
          <span className="hidden text-xs text-muted-foreground/70 lg:inline">Shift+Enter for a new line</span>
          {busy ? (
            <Button size="sm" variant="outline" onClick={onStop} data-testid="stop">
              <SquareIcon className="size-3 fill-current" />
              Stop
            </Button>
          ) : (
            <Button size="icon-sm" onClick={send} disabled={!text.trim() || disabled} data-testid="send" aria-label="Send">
              <ArrowUpIcon />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
