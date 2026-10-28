import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { STAGES, type ProjectSummary } from "@hardhub/protocol";
import { TopBar } from "../components/topbar";
import { useApp } from "../lib/app";
import { navigate, onLink } from "../lib/router";
import { STAGE_LABEL, ago } from "../lib/format";
import { IconTrash } from "../components/icons";

const EXAMPLES = [
  "A box with five USB ports I can switch from Home Assistant",
  "A battery soil-moisture sensor that lasts a season",
  "A CAN bus logger for my car with an SD card",
  "An LED strip controller with Wi-Fi and a button",
];

export default function Projects() {
  const { backend, me } = useApp();
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // the board being asked about ("delete it?") and the one being deleted
  const [asking, setAsking] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    backend.listProjects().then(setList, (e: Error) => setError(e.message));
  }, [backend]);

  const start = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const p = await backend.createProject({ prompt: text });
      navigate(`/p/${p.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the project");
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
  };
  const noKey = me && !me.llm_ready;

  const remove = async (p: ProjectSummary) => {
    setDeleting(p.id);
    try {
      await backend.deleteProject(p.id);
      setList((l) => l?.filter((x) => x.id !== p.id) ?? null);
      setAsking(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the board");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="screen">
      <TopBar />
      {noKey && (
        <div className="note-bar" data-testid="no-key-bar">
          <span>Connect the Claude or ChatGPT you already pay for, or add an API key, so HardHub can design.</span>
          <a className="btn btn-sm" href="/settings" onClick={onLink}>
            Set up AI
          </a>
        </div>
      )}
      <main className="wrap">
        <section className="home-hero">
          <h1 className="d2">What do you want to build?</h1>
          <p className="lead" style={{ maxWidth: "52ch" }}>
            Say what it should do, in your own words. HardHub asks what it needs to know, proposes parts with prices, and you decide.
          </p>
          <form className="prompt-box" onSubmit={start}>
            <textarea
              className="textarea"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKey}
              placeholder="A box behind my 3D printer with five USB ports that turn on when a print starts…"
              aria-label="Describe the hardware you want to build"
              data-testid="prompt-input"
            />
            <div className="prompt-actions">
              <span className="hint">Plain words are fine. You can change anything later.</span>
              <button className="btn btn-primary" type="submit" disabled={!prompt.trim() || busy} data-testid="prompt-submit">
                {busy ? "Starting…" : "Start designing"}
              </button>
            </div>
          </form>
          <div className="examples" aria-label="Examples">
            {EXAMPLES.map((x) => (
              <button key={x} className="example" type="button" onClick={() => setPrompt(x)}>
                {x}
              </button>
            ))}
          </div>
          {error && (
            <p className="small" style={{ color: "var(--destructive)" }} role="alert">
              {error}
            </p>
          )}
        </section>

        <section>
          <h2 className="section-title">Your boards</h2>
          {list === null ? (
            <div className="spinner-line" style={{ margin: "24px 0" }} />
          ) : list.length === 0 ? (
            <p className="muted small" style={{ padding: "16px 0 64px" }}>
              Nothing yet. Your first board will show up here.
            </p>
          ) : (
            <ul className="project-list" data-testid="project-list">
              {list.map((p) => {
                const at = STAGES.indexOf(p.stage);
                return (
                  <li key={p.id} className="project-row" data-testid="project-row">
                    <a className="project-link" href={`/p/${p.id}`} onClick={onLink}>
                      <span className="project-name">{p.name}</span>
                      <span className="project-stage">
                        <span className="progress-ticks" aria-hidden="true">
                          {STAGES.map((s, i) => (
                            <span key={s} className={i <= at ? "on" : undefined} />
                          ))}
                        </span>
                        <span className="small muted">
                          {STAGE_LABEL[p.stage]} · step {at + 1} of {STAGES.length}
                        </span>
                      </span>
                      <span className="small muted project-when">{ago(p.updated_at)}</span>
                    </a>
                    {asking === p.id ? (
                      <span className="project-confirm" role="group" aria-label={`Delete ${p.name}?`}>
                        <span className="small">Delete it and its files?</span>
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(p)} disabled={deleting === p.id} data-testid="delete-confirm">
                          {deleting === p.id ? "Deleting…" : "Delete"}
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => setAsking(null)} disabled={deleting === p.id}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-quiet btn-icon"
                        onClick={() => setAsking(p.id)}
                        aria-label={`Delete ${p.name}`}
                        title="Delete"
                        data-testid="delete-board"
                      >
                        <IconTrash />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
