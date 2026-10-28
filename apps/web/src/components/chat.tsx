// The conversation: what the AI said, what it did, what it asks, and the box
// to answer in. Items are memoised so a streaming message re-renders alone.
import { memo, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Comparison, Question } from "@hardhub/protocol";
import type { ChatItem } from "../lib/project-state";
import { STAGE_LABEL } from "../lib/format";

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
      <details className="thinking" data-testid="questions-answered">
        <summary>
          {questions.length === 1 ? "1 question" : `${questions.length} questions`} · answered
        </summary>
        <p>{questions.map((q) => q.text).join("\n")}</p>
      </details>
    );

  return (
    <form className="qcard" onSubmit={submit} data-testid="questions" data-question-set={id}>
      <div className="qcard-head">
        <span>
          {questions.length === 1 ? "One question" : `${questions.length} questions`}
        </span>
        <span className="muted">Recommended options are selected</span>
      </div>
      {questions.map((q) => (
        <fieldset key={q.id} className="q" disabled={!open} style={{ border: 0, margin: 0, minWidth: 0 }}>
          <legend className="sr-only">{q.text}</legend>
          <div className="label">{q.header}</div>
          <div className="q-text" aria-hidden="true">
            {q.text}
            {q.multi && <span className="muted small"> · pick any</span>}
          </div>
          <div role={q.multi ? "group" : "radiogroup"} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {q.options.map((o) => {
              const on = picked[q.id]?.includes(o.id) ?? false;
              return (
                <button
                  type="button"
                  key={o.id}
                  className="opt"
                  role={q.multi ? "checkbox" : "radio"}
                  aria-checked={on}
                  onClick={() => toggle(q, o.id)}
                  data-testid={`option-${q.id}-${o.id}`}
                >
                  <span className="box" />
                  <span className="body">
                    <span className="title">
                      {o.label}
                      {o.recommended && <span className="tag">Recommended</span>}
                    </span>
                    {o.detail && <span className="detail">{o.detail}</span>}
                  </span>
                </button>
              );
            })}
            <input
              className="input"
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
        <div className="qcard-foot">
          <span className="status">{missing ? `${missing} still to answer` : "Ready to send"}</span>
          <button className="btn btn-solid" type="submit" disabled={missing > 0} data-testid="submit-answers">
            Send answers
          </button>
        </div>
      )}
    </form>
  );
});

/* ---------- comparison ---------- */

export const ComparisonCard = memo(function ComparisonCard({ c }: { c: Comparison }) {
  return (
    <div className="cmp" data-testid="comparison">
      <div className="cmp-title">{c.title}</div>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              {c.columns.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {c.rows.map((r) => (
              <tr key={r.id} className={r.recommended ? "rec" : undefined}>
                {r.cells.map((cell, i) => (
                  <td key={i} className={/^[$\d,.×x ]+$/.test(cell) ? "num" : undefined} style={i === 1 ? { minWidth: 180 } : undefined}>
                    {cell}
                    {i === 0 && r.recommended && <span className="tag" style={{ marginLeft: 8 }}>Recommended</span>}
                    {i === 0 && r.warning && <span className="warn-line">{r.warning}</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {c.note && <div className="cmp-note">{c.note}</div>}
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
        <div className="msg-user">
          {item.answers ? (
            <div className="answers" style={{ marginTop: 0 }}>
              {Object.entries(item.answers).map(([k, v]) => (
                <div key={k}>
                  <span className="muted">{k}: </span>
                  <span style={{ color: "var(--fg)" }}>{v.join(", ")}</span>
                </div>
              ))}
            </div>
          ) : (
            item.text
          )}
        </div>
      );
    case "assistant":
      return <div className={`msg-ai${item.done ? "" : " streaming"}`}>{item.text}</div>;
    case "thinking":
      return (
        <details className="thinking">
          <summary>Reasoning</summary>
          <p>{item.text}</p>
        </details>
      );
    case "tool":
      return (
        <div className={`tool-row ${item.status}`} data-testid="tool-row">
          <span className="state" aria-hidden="true">
            {item.status === "done" ? "✓" : item.status === "error" ? "×" : "•"}
          </span>
          <span>
            {item.label}
            {item.detail && <span className="detail"> · {item.detail}</span>}
          </span>
        </div>
      );
    case "questions":
      return <QuestionCard id={item.id} questions={item.questions} open={openQuestions === item.id} onSubmit={onAnswer} />;
    case "comparison":
      return <ComparisonCard c={item.comparison} />;
    case "stage":
      return <div className="stage-mark">{STAGE_LABEL[item.stage]}</div>;
    case "job":
      return (
        <div className="job" data-testid="job">
          <div className="job-row">
            <span>{item.done ? (item.ok === false ? "Board build failed" : "Board built") : "Building the board"}</span>
            <span className="muted small">{item.done ? "Done" : item.step}</span>
          </div>
          <div className="bar">
            <span style={{ width: `${Math.round(item.progress * 100)}%` }} />
          </div>
        </div>
      );
    case "error":
      return (
        <div className="err" role="alert">
          {item.message}
          {onKeyHelp && (
            <div>
              <button className="btn btn-sm" onClick={onKeyHelp} data-testid="add-key">
                {keyLabel}
              </button>
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
    <div className="chat-log" ref={ref} onScroll={onScroll} data-testid="chat-log" aria-live="polite">
      <div ref={inner} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {start > 0 && (
        <button className="btn btn-sm btn-quiet" style={{ alignSelf: "center" }} onClick={() => setShown((n) => n + WINDOW)}>
          Show {Math.min(start, WINDOW)} earlier
        </button>
      )}
      {items.slice(start).map((it) => (
        <div key={`${it.kind}:${it.id}`} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 60px" }}>
          <ItemView item={it} openQuestions={openQuestions} onAnswer={onAnswer} onKeyHelp={it.kind === "error" && keyError ? onKeyHelp : undefined} keyLabel={keyLabel} />
        </div>
      ))}
      {busy && !items.some((i) => i.kind === "assistant" && !i.done) && (
        <div className="tool-row running" aria-label="Working">
          <span className="state">•</span>
          <span className="muted">Working…</span>
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
    <div className="composer">
      <div className="composer-box">
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
        />
        {busy ? (
          <button className="btn btn-sm" onClick={onStop} data-testid="stop">
            Stop
          </button>
        ) : (
          <button className="btn btn-sm btn-solid" onClick={send} disabled={!text.trim() || disabled} data-testid="send">
            Send
          </button>
        )}
      </div>
      <div className="composer-meta">
        <span>{hint}</span>
        <span className="hide-sm">Enter to send · Shift+Enter for a new line</span>
      </div>
    </div>
  );
}
