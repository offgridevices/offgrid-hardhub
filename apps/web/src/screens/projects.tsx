import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { STAGES, type ProjectSummary } from "@hardhub/protocol";
import { ArrowRightIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { Screen, TopBar } from "../components/topbar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useApp } from "../lib/app";
import { navigate, onLink } from "../lib/router";
import { STAGE_LABEL, STAGE_TONE, ago } from "../lib/format";

const EXAMPLES = [
  "A box with five USB ports I can switch from Home Assistant",
  "A battery soil-moisture sensor that lasts a season",
  "A CAN bus logger for my car with an SD card",
  "An LED strip controller with Wi-Fi and a button",
];
const EXAMPLE_DOTS = ["bg-plum", "bg-moss", "bg-sky", "bg-gold"];
const DOT = { ember: "bg-ember", moss: "bg-moss", sky: "bg-sky", gold: "bg-gold", plum: "bg-plum" } as const;

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
    <Screen>
      <TopBar />
      {noKey && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-ember/10 px-4 py-2.5 text-sm text-ember-text" data-testid="no-key-bar">
          <span>Connect the Claude or ChatGPT you already pay for, or add an API key, so HardHub can design.</span>
          <Button size="sm" variant="outline" asChild>
            <a href="/settings" onClick={onLink}>
              Set up AI
            </a>
          </Button>
        </div>
      )}
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-14 px-4 pb-20 pt-12 sm:pt-20">
        <section className="flex flex-col gap-5">
          <Badge tone="ember" className="self-start">
            <SparklesIcon />
            New board
          </Badge>
          <h1 className="text-4xl font-semibold leading-[1.05] tracking-tight text-balance sm:text-5xl">What do you want to build?</h1>
          <p className="max-w-[56ch] text-base text-soft sm:text-lg">
            Say what it should do, in your own words. HardHub asks what it needs to know, proposes parts with prices, and you decide.
          </p>
          <form className="flex flex-col gap-3 rounded-xl border border-input bg-card p-3 pl-4 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30" onSubmit={start}>
            <textarea
              className="min-h-20 resize-none bg-transparent text-base outline-none placeholder:text-muted-foreground"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKey}
              placeholder="A box behind my 3D printer with five USB ports that turn on when a print starts…"
              aria-label="Describe the hardware you want to build"
              data-testid="prompt-input"
            />
            <div className="flex items-center gap-3">
              <span className="hidden text-sm text-muted-foreground sm:inline">Plain words are fine. You can change anything later.</span>
              <span className="grow" />
              <Button type="submit" disabled={!prompt.trim() || busy} data-testid="prompt-submit">
                {busy ? "Starting…" : "Start designing"}
                <ArrowRightIcon />
              </Button>
            </div>
          </form>
          <div className="flex flex-wrap gap-2" aria-label="Examples">
            {EXAMPLES.map((x, i) => (
              <button
                key={x}
                type="button"
                onClick={() => setPrompt(x)}
                className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-left text-sm text-soft transition-colors hover:border-input hover:text-foreground"
              >
                <span className={cn("size-2 shrink-0 rounded-full", EXAMPLE_DOTS[i % EXAMPLE_DOTS.length])} />
                {x}
              </button>
            ))}
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-lg font-semibold">Your boards</h2>
            {list && list.length > 0 && <span className="num text-xs text-muted-foreground">{list.length}</span>}
          </div>
          {list === null ? (
            <Loader className="my-6" />
          ) : list.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">Nothing yet. Your first board will show up here.</p>
          ) : (
            <ul className="overflow-hidden rounded-xl border bg-card" data-testid="project-list">
              {list.map((p) => {
                const at = STAGES.indexOf(p.stage);
                const tone = STAGE_TONE[p.stage];
                return (
                  <li key={p.id} className="flex items-center gap-2 border-b pr-2 last:border-b-0 hover:bg-foreground/[0.03]" data-testid="project-row">
                    <a className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1.5 py-3.5 pl-4 outline-none focus-visible:bg-accent" href={`/p/${p.id}`} onClick={onLink}>
                      <span className="min-w-0 flex-[1_1_12rem] truncate font-medium">{p.name}</span>
                      <span className="flex items-center gap-3">
                        <Badge tone={tone}>{STAGE_LABEL[p.stage]}</Badge>
                        <span className="hidden gap-[3px] sm:flex" aria-label={`Step ${at + 1} of ${STAGES.length}`}>
                          {STAGES.map((s, i) => (
                            <span key={s} className={cn("h-1 w-3 rounded-full", i <= at ? DOT[tone] : "bg-foreground/10")} />
                          ))}
                        </span>
                      </span>
                      <span className="num w-20 text-right text-xs text-muted-foreground">{ago(p.updated_at)}</span>
                    </a>
                    {asking === p.id ? (
                      <span className="flex items-center gap-2" role="group" aria-label={`Delete ${p.name}?`}>
                        <span className="hidden text-sm sm:inline">Delete it and its files?</span>
                        <Button size="xs" variant="destructive" onClick={() => remove(p)} disabled={deleting === p.id} data-testid="delete-confirm">
                          {deleting === p.id ? "Deleting…" : "Delete"}
                        </Button>
                        <Button size="xs" variant="outline" onClick={() => setAsking(null)} disabled={deleting === p.id}>
                          Keep
                        </Button>
                      </span>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="icon-sm" onClick={() => setAsking(p.id)} aria-label={`Delete ${p.name}`} data-testid="delete-board">
                            <Trash2Icon />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Delete</TooltipContent>
                      </Tooltip>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </Screen>
  );
}
