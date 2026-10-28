import { useEffect, useState, type FormEvent } from "react";
import type { BridgeStatus, LlmProvider } from "@hardhub/protocol";
import { TopBar } from "../components/topbar";
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
    <div className="screen">
      <TopBar back current="settings" />
      <main className="wrap">
        <div className="settings">
          <div className="pane-head">
            <h1 className="d3">Settings</h1>
            <p className="secondary">Signed in as {me.email}</p>
          </div>

          <ConnectAi />

          <details className="own-chat" open={ownChatOpen} onToggle={(e) => setOwnChatOpen(e.currentTarget.open)} data-testid="own-chat">
            <summary data-testid="own-chat-toggle">
              <span>
                <h2 id="ai-h" className="d4">
                  HardHub's own chat
                </h2>
                <span className="secondary small" style={{ display: "block", marginTop: 6 }}>
                  {me.llm_ready ? `Optional. In use: ${providerInfo(me.llm.provider).name}.` : "Optional: chat inside HardHub on an AI account you choose, with your own key."}
                </span>
              </span>
              <span className="own-chat-sign" aria-hidden="true" />
            </summary>
            <div className="setting own-chat-body">
              <p className="secondary">
                You pay the provider directly for what you use, and HardHub never marks it up.
              </p>

              <div className="choice-list" role="radiogroup" aria-label="AI provider">
                {PROVIDERS.filter((p) => p.id !== "claude-code" || bridgeHere || me.llm.provider === "claude-code").map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="opt"
                    role="radio"
                    aria-checked={provider === p.id}
                    onClick={() => pickProvider(p.id)}
                    data-testid={`provider-${p.id}`}
                  >
                    <span className="box" />
                    <span className="body">
                      <span className="title">
                        {p.name}
                        {p.recommended && <span className="tag">Recommended</span>}
                        {me.llm.provider === p.id && <span className="tag tag-solid">In use</span>}
                      </span>
                      <span className="detail">{p.where}</span>
                    </span>
                  </button>
                ))}
              </div>

              {provider === "claude-code" && <ClaudeCodeStatus />}

              <div className="field">
                <label className="label" htmlFor="model">
                  Model
                </label>
                {info.models.length > 0 && (
                  <div className="choice-list" role="radiogroup" aria-label="Model">
                    {info.models.map((m) => (
                      <button key={m.id} type="button" className="opt" role="radio" aria-checked={model === m.id} onClick={() => setModel(m.id)} data-testid={`model-${m.id}`}>
                        <span className="box" />
                        <span className="body">
                          <span className="title">{m.label}</span>
                          {m.note && <span className="detail">{m.note}</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {info.freeModel && (
                  <input
                    id="model"
                    className="input num"
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
                <div className="field">
                  <label className="label" htmlFor="base">
                    Server address
                  </label>
                  <input
                    id="base"
                    className="input num"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    inputMode="url"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-testid="base-url"
                  />
                  {provider === "ollama" && (
                    <p className="small muted">
                      Start Ollama on this computer and run <span className="num">ollama pull {model || "qwen3.5:0.8b"}</span> once. The address above
                      reaches it from HardHub's Docker container.
                    </p>
                  )}
                </div>
              )}

              <div>
                <button className="btn btn-solid" onClick={saveLlm} disabled={!model.trim() || saving !== "" || active} data-testid="save-llm">
                  {active ? "In use" : saving === "llm" ? "Saving…" : `Use ${info.name}`}
                </button>
              </div>

              {info.needsKey && (
                <form className="field" onSubmit={saveKey} style={{ paddingTop: 8 }}>
                  <label className="label" htmlFor="key">
                    {provider === "anthropic" ? "Claude API key" : `${info.name} key`}
                  </label>
                  {saved ? (
                    <div className="panel" style={{ padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <span>
                        Saved key ending <span className="num">…{saved.last4}</span>
                        <span className="muted small"> · added {date(saved.added_at)}</span>
                      </span>
                      <button type="button" className="btn btn-sm" onClick={removeKey} data-testid="remove-key">
                        Remove
                      </button>
                    </div>
                  ) : null}
                  <div className="key-row">
                    <input
                      id="key"
                      className="input num"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={saved ? "Paste a new key to replace it" : info.keyHint}
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      data-testid="key-input"
                    />
                    <button className="btn btn-primary" type="submit" disabled={!key.trim() || saving !== ""} data-testid="save-key">
                      {saving === "key" ? "Saving…" : "Save key"}
                    </button>
                  </div>
                  {provider === "anthropic" && (
                    <ol className="steps-list">
                      <li>
                        Open{" "}
                        <a href={info.keyUrl} target="_blank" rel="noreferrer">
                          Claude Console → API keys
                        </a>{" "}
                        and create a key.
                      </li>
                      <li>On a Max plan, your plan includes monthly API credit: link it in the Console and this key spends it first.</li>
                      <li>Paste the key here. It is encrypted before it is stored, and only ever sent to Anthropic.</li>
                    </ol>
                  )}
                  {provider !== "anthropic" && info.keyUrl && (
                    <p className="small muted">
                      Create one at{" "}
                      <a href={info.keyUrl} target="_blank" rel="noreferrer">
                        {new URL(info.keyUrl).host}
                      </a>
                      . It is encrypted before it is stored.
                    </p>
                  )}
                </form>
              )}

              {msg && (
                <p className="small" role="status" style={{ color: msg.ok ? "var(--fg-2)" : "var(--destructive)" }} data-testid="settings-msg">
                  {msg.text}
                </p>
              )}
            </div>
          </details>

          <section className="setting" aria-labelledby="acct-h">
            <h2 id="acct-h" className="d4">Account</h2>
            <div className="key-row" role="radiogroup" aria-label="Theme">
              {(["auto", "dark", "light"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`btn btn-sm${theme === t ? " btn-solid" : ""}`}
                  aria-pressed={theme === t}
                  onClick={() => {
                    setTheme(t);
                    setThemeState(t);
                  }}
                  data-testid={`theme-${t}`}
                >
                  {t === "auto" ? "Match device" : t === "dark" ? "Dark" : "Light"}
                </button>
              ))}
            </div>
            <div className="key-row" style={{ alignItems: "center" }}>
              <button
                className="btn"
                onClick={async () => {
                  await backend.logout();
                  setMe(null);
                  navigate("/signin", true);
                }}
                data-testid="signout"
              >
                Sign out
              </button>
              <span className="small muted">{MOCK ? "Demo mode: nothing here is saved to a server." : `Server: ${API_URL}`}</span>
            </div>
          </section>
        </div>
      </main>
    </div>
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
  if (!s) return <p className="small muted">Looking for Claude Code on this computer…</p>;
  if (!s.available)
    return (
      <div className="panel" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }} data-testid="bridge-status">
        <span className="small">Not available here. {s.error}</span>
        <ol className="steps-list">
          <li>
            Install Claude Code (<a href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer">code.claude.com</a>) and Node.js 20 or newer.
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
    <p className="small" data-testid="bridge-status">
      Claude Code {s.claude} found on this computer{how}
    </p>
  );
}
