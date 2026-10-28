// Settings: connect the AI app the person already pays for (Claude, ChatGPT,
// Codex...) to HardHub over MCP, and see or end the connections.
import { useEffect, useState } from "react";
import type { Connections } from "@hardhub/protocol";
import { useApp } from "../lib/app";
import { date } from "../lib/format";

type AppId = "claude" | "claude-code" | "chatgpt" | "codex";

const APPS: { id: AppId; name: string; online: boolean }[] = [
  { id: "claude", name: "Claude", online: true },
  { id: "claude-code", name: "Claude Code", online: false },
  { id: "chatgpt", name: "ChatGPT", online: true },
  { id: "codex", name: "Codex", online: false },
];

function Steps({ app, url }: { app: AppId; url: string }) {
  if (app === "claude")
    return (
      <ol className="steps-list">
        <li>In Claude (website, desktop or phone app), open Settings → Connectors.</li>
        <li>Choose Add custom connector, name it HardHub, and paste the address above.</li>
        <li>Choose Connect, then Allow on the HardHub page that opens.</li>
        <li>In a chat, turn on HardHub from the tools menu and describe your board.</li>
      </ol>
    );
  if (app === "chatgpt")
    return (
      <ol className="steps-list">
        <li>In ChatGPT, open Settings → Apps → Advanced settings and turn on Developer mode (Plus, Pro, Business and Enterprise plans).</li>
        <li>Choose Create app, name it HardHub, paste the address above, and pick OAuth.</li>
        <li>Allow it on the HardHub page that opens, then pick HardHub in the chat's tools.</li>
      </ol>
    );
  const cmd = app === "claude-code" ? `claude mcp add --transport http hardhub ${url}` : `codex mcp add hardhub --url ${url}`;
  return (
    <ol className="steps-list">
      <li>
        In a terminal, run:
        <CopyRow text={cmd} label="Copy command" testId={`cmd-${app}`} />
      </li>
      {app === "claude-code" ? (
        <li>Start Claude Code, type /mcp, pick hardhub and sign in: a HardHub page opens; choose Allow.</li>
      ) : (
        <li>
          Run <span className="num">codex mcp login hardhub</span>: a HardHub page opens; choose Allow.
        </li>
      )}
      <li>Ask it to design your board with HardHub.</li>
    </ol>
  );
}

function CopyRow({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-row" style={{ marginTop: 6 }}>
      <code data-testid={testId}>{text}</code>
      <button
        type="button"
        className="btn btn-sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* no clipboard (an insecure page): the text is there to select */
          }
        }}
        aria-label={label}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function ConnectAi() {
  const { backend } = useApp();
  const [data, setData] = useState<Connections | null>(null);
  const [error, setError] = useState("");
  const [app, setApp] = useState<AppId>("claude");

  useEffect(() => {
    let live = true;
    backend.connections().then(
      (d) => live && setData(d),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [backend]);

  const local = !!data && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(data.mcp_url);
  const chosen = APPS.find((a) => a.id === app)!;

  return (
    <section className="setting" aria-labelledby="mcp-h" data-testid="connect-ai">
      <div>
        <h2 id="mcp-h" className="d4">
          Use your own Claude or ChatGPT
        </h2>
        <p className="secondary" style={{ marginTop: 8 }}>
          Connect the AI app you already pay for. It does the thinking on your own plan, with no API key; HardHub finds the parts, checks the circuit and builds the board in KiCad. Your boards
          show up here as it works.
        </p>
      </div>

      {error && (
        <p className="small" style={{ color: "var(--destructive)" }} role="alert">
          {error}
        </p>
      )}
      {data && (
        <>
          <div className="field">
            <span className="label">HardHub's address for AI apps</span>
            <CopyRow text={data.mcp_url} label="Copy address" testId="mcp-url" />
          </div>

          <div className="key-row" role="radiogroup" aria-label="Your AI app">
            {APPS.map((a) => (
              <button
                key={a.id}
                type="button"
                role="radio"
                className={`btn btn-sm${app === a.id ? " btn-solid" : ""}`}
                aria-checked={app === a.id}
                onClick={() => setApp(a.id)}
                data-testid={`app-${a.id}`}
              >
                {a.name}
              </button>
            ))}
          </div>
          {local && chosen.online ? (
            <p className="small muted" data-testid="needs-online">
              {chosen.name} reaches HardHub from its own servers, over the internet, so it can connect once HardHub is on Cloudflare (<span className="num">./hardhub deploy</span>).
              On this computer, use Claude Code or Codex now.
            </p>
          ) : (
            <Steps app={app} url={data.mcp_url} />
          )}

          <div className="field">
            <span className="label">Connected apps</span>
            {data.connections.length === 0 ? (
              <p className="small muted">None yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {data.connections.map((c) => (
                  <div key={c.client_id} className="panel conn-row" data-testid="connection">
                    <span>
                      {c.name}
                      <span className="muted small"> · connected {date(c.connected_at)}</span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        await backend.disconnect(c.client_id);
                        setData({ ...data, connections: data.connections.filter((x) => x.client_id !== c.client_id) });
                      }}
                      data-testid="disconnect"
                    >
                      Disconnect
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
