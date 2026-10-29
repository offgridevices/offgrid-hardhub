// Settings: connect the AI app the person already pays for (Claude, ChatGPT,
// Codex...) to HardHub over MCP, and see or end the connections.
import { useEffect, useState } from "react";
import type { Connections } from "@hardhub/protocol";
import { useApp } from "../lib/app";
import { date } from "../lib/format";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const STEPS = "flex list-decimal flex-col gap-2 pl-5 text-sm text-soft marker:text-muted-foreground";

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
      <ol className={STEPS}>
        <li>In Claude (website, desktop or phone app), open Settings → Connectors.</li>
        <li>Choose Add custom connector, name it HardHub, and paste the address above.</li>
        <li>Choose Connect, then Allow on the HardHub page that opens.</li>
        <li>In a chat, turn on HardHub from the tools menu and describe your board.</li>
      </ol>
    );
  if (app === "chatgpt")
    return (
      <ol className={STEPS}>
        <li>In ChatGPT, open Settings → Apps → Advanced settings and turn on Developer mode (Plus, Pro, Business and Enterprise plans).</li>
        <li>Choose Create app, name it HardHub, paste the address above, and pick OAuth.</li>
        <li>Allow it on the HardHub page that opens, then pick HardHub in the chat's tools.</li>
      </ol>
    );
  const cmd = app === "claude-code" ? `claude mcp add --transport http hardhub ${url}` : `codex mcp add hardhub --url ${url}`;
  return (
    <ol className={STEPS}>
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
    <div className="mt-1.5 flex items-center gap-2 rounded-lg border bg-sunken py-1.5 pl-3 pr-1.5">
      <code className="num min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[13px] text-foreground" data-testid={testId}>
        {text}
      </code>
      <Button
        type="button"
        variant="outline"
        size="xs"
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
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "Copied" : "Copy"}
      </Button>
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
    <Card className="gap-5" aria-labelledby="mcp-h" data-testid="connect-ai">
      <CardHeader>
        <CardTitle id="mcp-h" className="text-base">
          Use your own Claude or ChatGPT
        </CardTitle>
        <CardDescription>
          Connect the AI app you already pay for. It does the thinking on your own plan, with no API key; HardHub finds the parts, checks the circuit and builds the board in KiCad. Your boards
          show up here as it works.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {data && (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">HardHub's address for AI apps</span>
              <CopyRow text={data.mcp_url} label="Copy address" testId="mcp-url" />
            </div>

            <ToggleGroup type="single" value={app} onValueChange={(v) => v && setApp(v as AppId)} aria-label="Your AI app" className="flex-wrap">
              {APPS.map((a) => (
                <ToggleGroupItem key={a.id} value={a.id} data-testid={`app-${a.id}`}>
                  {a.name}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {local && chosen.online ? (
              <p className="text-sm text-muted-foreground" data-testid="needs-online">
                {chosen.name} reaches HardHub from its own servers, over the internet, so it can connect once HardHub is on Cloudflare (<span className="num">./hardhub deploy</span>).
                On this computer, use Claude Code or Codex now.
              </p>
            ) : (
              <Steps app={app} url={data.mcp_url} />
            )}

            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Connected apps</span>
              {data.connections.length === 0 ? (
                <p className="text-sm text-muted-foreground">None yet.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {data.connections.map((c) => (
                    <div key={c.client_id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-sunken px-3.5 py-2.5 text-sm" data-testid="connection">
                      <span className="flex items-center gap-2">
                        <span className="size-2 rounded-full bg-moss" aria-hidden="true" />
                        {c.name}
                        <span className="text-muted-foreground"> · connected {date(c.connected_at)}</span>
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={async () => {
                          await backend.disconnect(c.client_id);
                          setData({ ...data, connections: data.connections.filter((x) => x.client_id !== c.client_id) });
                        }}
                        data-testid="disconnect"
                      >
                        Disconnect
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
