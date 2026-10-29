import { useEffect, useState, type FormEvent } from "react";
import type { BridgeStatus, LlmProvider } from "@hardhub/protocol";
import { ChevronDownIcon, LogOutIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { Screen, TopBar } from "../components/topbar";
import { ChoiceRow } from "../components/choice";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useApp, MOCK, API_URL } from "../lib/app";
import { navigate } from "../lib/router";
import { PROVIDERS, providerInfo } from "../config/llm";
import { getTheme, setTheme, type ThemeChoice } from "../lib/theme";
import { date } from "../lib/format";
import { ConnectAi } from "./connect-ai";

export default function Settings() {
  const { backend, me, setMe } = useApp();
  const [provider, setProvider] = useState<LlmProvider>(me?.llm.provider ?? "anthropic");
  const info = providerInfo(provider);
  const [model, setModel] = useState(me?.llm.provider === provider ? me.llm.model : info.models[0]?.id ?? "");
  const [baseUrl, setBaseUrl] = useState(me?.llm.base_url ?? info.defaultBaseUrl ?? "");
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState<"" | "llm" | "key">("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [theme, setThemeState] = useState<ThemeChoice>(getTheme);
  // HardHub's own chat is optional (an AI app connected over MCP needs none
  // of it): folded away once it is set up
  const [ownChatOpen, setOwnChatOpen] = useState(() => !me?.llm_ready);
  // Claude Code on this computer is offered only where it can run (./hardhub
  // with Claude Code installed), or where it is already the choice
  const [bridgeHere, setBridgeHere] = useState(false);
  useEffect(() => {
    let live = true;
    backend.bridgeStatus().then(
      (b) => live && setBridgeHere(b.available),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [backend]);

  if (!me) return null;
  const saved = me.keys[provider];
  const active = me.llm.provider === provider && me.llm.model === model && (me.llm.base_url ?? "") === (info.needsBaseUrl ? baseUrl : "");

  const pickProvider = (p: LlmProvider) => {
    const i = providerInfo(p);
    setProvider(p);
    setModel(me.llm.provider === p ? me.llm.model : i.models[0]?.id ?? "");
    setBaseUrl(me.llm.provider === p && me.llm.base_url ? me.llm.base_url : i.defaultBaseUrl ?? "");
    setKey("");
    setMsg(null);
  };

  const saveLlm = async () => {
    setSaving("llm");
    setMsg(null);
    try {
      setMe(await backend.setLlm({ provider, model: model.trim(), ...(info.needsBaseUrl ? { base_url: baseUrl.trim() } : {}) }));
      setMsg({ ok: true, text: `HardHub now uses ${info.name}.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not save" });
    } finally {
      setSaving("");
    }
  };

  const saveKey = async (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    setSaving("key");
    setMsg(null);
    try {
      setMe(await backend.saveKey(provider, key.trim()));
      setKey("");
      if (me.llm.provider !== provider) setMe(await backend.setLlm({ provider, model: model.trim(), ...(info.needsBaseUrl ? { base_url: baseUrl.trim() } : {}) }));
      setMsg({ ok: true, text: "Key saved. It is stored encrypted and never shown again." });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Could not save the key" });
    } finally {
      setSaving("");
    }
  };

  const removeKey = async () => {
    setMe(await backend.deleteKey(provider));
    setMsg({ ok: true, text: "Key removed." });
  };

  return (
    <Screen>
      <TopBar back current="settings" />
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 pb-20 pt-10">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
          <p className="text-muted-foreground">Signed in as {me.email}</p>
        </div>

        <ConnectAi />

        <details className="group rounded-xl border bg-card" open={ownChatOpen} onToggle={(e) => setOwnChatOpen(e.currentTarget.open)} data-testid="own-chat">
          <summary className="flex cursor-pointer list-none items-center gap-4 px-5 py-4 [&::-webkit-details-marker]:hidden" data-testid="own-chat-toggle">
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <h2 id="ai-h" className="text-base font-semibold">
                HardHub's own chat
              </h2>
              <span className="text-sm text-muted-foreground">
                {me.llm_ready ? `Optional. In use: ${providerInfo(me.llm.provider).name}.` : "Optional: chat inside HardHub on an AI account you choose, with your own key."}
              </span>
            </span>
            <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="flex flex-col gap-6 border-t px-5 py-5">
            <p className="text-sm text-soft">You pay the provider directly for what you use, and HardHub never marks it up.</p>

            <div className="flex flex-col gap-2" role="radiogroup" aria-label="AI provider">
              {PROVIDERS.filter((p) => p.id !== "claude-code" || bridgeHere || me.llm.provider === "claude-code").map((p) => (
                <ChoiceRow
                  key={p.id}
                  checked={provider === p.id}
                  onClick={() => pickProvider(p.id)}
                  data-testid={`provider-${p.id}`}
                  title={p.name}
                  detail={p.where}
                  tag={
                    <>
                      {p.recommended && <Badge tone="moss">Recommended</Badge>}
                      {me.llm.provider === p.id && <Badge tone="solid">In use</Badge>}
                    </>
                  }
                />
              ))}
            </div>

            {provider === "claude-code" && <ClaudeCodeStatus />}

            <div className="flex flex-col gap-2">
              <Label htmlFor="model">Model</Label>
              {info.models.length > 0 && (
                <div className="flex flex-col gap-2" role="radiogroup" aria-label="Model">
                  {info.models.map((m) => (
                    <ChoiceRow key={m.id} checked={model === m.id} onClick={() => setModel(m.id)} data-testid={`model-${m.id}`} title={m.label} detail={m.note} />
                  ))}
                </div>
              )}
              {info.freeModel && (
                <Input
                  id="model"
                  className="num"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={info.modelPlaceholder ?? "Model name"}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  data-testid="model-input"
                />
              )}
            </div>

            {info.needsBaseUrl && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="base">Server address</Label>
                <Input id="base" className="num" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} inputMode="url" autoCapitalize="off" spellCheck={false} data-testid="base-url" />
                {provider === "ollama" && (
                  <p className="text-sm text-muted-foreground">
                    Start Ollama on this computer and run <span className="num text-foreground">ollama pull {model || "qwen3.5:0.8b"}</span> once. The address above
                    reaches it from HardHub's Docker container.
                  </p>
                )}
              </div>
            )}

            <div>
              <Button onClick={saveLlm} disabled={!model.trim() || saving !== "" || active} data-testid="save-llm">
                {active ? "In use" : saving === "llm" ? "Saving…" : `Use ${info.name}`}
              </Button>
            </div>

            {info.needsKey && (
              <form className="flex flex-col gap-3" onSubmit={saveKey}>
                <Label htmlFor="key">{provider === "anthropic" ? "Claude API key" : `${info.name} key`}</Label>
                {saved ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-sunken px-3.5 py-3 text-sm">
                    <span>
                      Saved key ending <span className="num">…{saved.last4}</span>
                      <span className="text-muted-foreground"> · added {date(saved.added_at)}</span>
                    </span>
                    <Button type="button" variant="outline" size="sm" onClick={removeKey} data-testid="remove-key">
                      Remove
                    </Button>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Input
                    id="key"
                    className="num min-w-[14rem] flex-1"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={saved ? "Paste a new key to replace it" : info.keyHint}
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    data-testid="key-input"
                  />
                  <Button type="submit" disabled={!key.trim() || saving !== ""} data-testid="save-key">
                    {saving === "key" ? "Saving…" : "Save key"}
                  </Button>
                </div>
                {provider === "anthropic" && (
                  <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-soft marker:text-muted-foreground">
                    <li>
                      Open{" "}
                      <a className="text-ember-text underline-offset-4 hover:underline" href={info.keyUrl} target="_blank" rel="noreferrer">
                        Claude Console → API keys
                      </a>{" "}
                      and create a key.
                    </li>
                    <li>On a Max plan, your plan includes monthly API credit: link it in the Console and this key spends it first.</li>
                    <li>Paste the key here. It is encrypted before it is stored, and only ever sent to Anthropic.</li>
                  </ol>
                )}
                {provider !== "anthropic" && info.keyUrl && (
                  <p className="text-sm text-muted-foreground">
                    Create one at{" "}
                    <a className="text-ember-text underline-offset-4 hover:underline" href={info.keyUrl} target="_blank" rel="noreferrer">
                      {new URL(info.keyUrl).host}
                    </a>
                    . It is encrypted before it is stored.
                  </p>
                )}
              </form>
            )}

            {msg && (
              <p className={msg.ok ? "text-sm text-moss-text" : "text-sm text-destructive"} role="status" data-testid="settings-msg">
                {msg.text}
              </p>
            )}
          </div>
        </details>

        <Card className="gap-4" aria-labelledby="acct-h">
          <CardHeader>
            <CardTitle id="acct-h" className="text-base">
              Account
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-muted-foreground">Theme</span>
              <ToggleGroup
                type="single"
                value={theme}
                onValueChange={(t) => {
                  if (!t) return;
                  setTheme(t as ThemeChoice);
                  setThemeState(t as ThemeChoice);
                }}
                aria-label="Theme"
              >
                {(["auto", "dark", "light"] as const).map((t) => (
                  <ToggleGroupItem key={t} value={t} data-testid={`theme-${t}`}>
                    {t === "auto" ? <MonitorIcon /> : t === "dark" ? <MoonIcon /> : <SunIcon />}
                    {t === "auto" ? "Match device" : t === "dark" ? "Dark" : "Light"}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                onClick={async () => {
                  await backend.logout();
                  setMe(null);
                  navigate("/signin", true);
                }}
                data-testid="signout"
              >
                <LogOutIcon />
                Sign out
              </Button>
              <span className="text-sm text-muted-foreground">{MOCK ? "Demo mode: nothing here is saved to a server." : `Server: ${API_URL}`}</span>
            </div>
          </CardContent>
        </Card>
      </main>
    </Screen>
  );
}

/** Is Claude Code on this computer, and signed in to a subscription? (through ./hardhub's bridge) */
function ClaudeCodeStatus() {
  const { backend } = useApp();
  const [s, setS] = useState<BridgeStatus | null>(null);
  useEffect(() => {
    let live = true;
    backend.bridgeStatus().then(
      (r) => live && setS(r),
      (e: Error) => live && setS({ available: false, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [backend]);
  if (!s) return <p className="text-sm text-muted-foreground">Looking for Claude Code on this computer…</p>;
  if (!s.available)
    return (
      <div className="flex flex-col gap-2 rounded-lg bg-sunken px-3.5 py-3 text-sm" data-testid="bridge-status">
        <span>Not available here. {s.error}</span>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-soft marker:text-muted-foreground">
          <li>
            Install Claude Code (<a className="text-ember-text underline-offset-4 hover:underline" href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer">code.claude.com</a>) and Node.js 20 or newer.
          </li>
          <li>
            Run <span className="num">claude</span> once in a terminal and sign in with your Claude account.
          </li>
          <li>
            Run <span className="num">./hardhub</span> again: it starts the helper that lets HardHub use it.
          </li>
        </ol>
      </div>
    );
  const how = !s.signed_in
    ? ", but not signed in: run claude once in a terminal and sign in."
    : s.auth === "claude.ai"
      ? ", signed in with your Claude subscription."
      : s.auth === "api_key" || s.auth === "api_key_helper"
        ? ", signed in with an API key: that is billed to the key, not your plan."
        : ", signed in.";
  return (
    <p className="rounded-lg bg-moss/10 px-3.5 py-3 text-sm text-moss-text" data-testid="bridge-status">
      Claude Code {s.claude} found on this computer{how}
    </p>
  );
}
