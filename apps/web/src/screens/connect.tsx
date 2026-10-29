// The page an AI app (Claude, ChatGPT, Codex...) sends the person to when it
// asks to use HardHub over MCP: who is asking, what it can do, Allow or
// Cancel. The server checks the request again when the answer comes back.
import { useEffect, useState } from "react";
import type { OAuthClientInfo } from "@hardhub/protocol";
import { Lockup } from "../components/brand";
import { CheckIcon, XIcon } from "lucide-react";
import { Screen } from "../components/topbar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Loader } from "@/components/ui/skeleton";
import { useApp } from "../lib/app";
import { navigate, rememberNext } from "../lib/router";

const CAN = [
  "Create boards and change their designs",
  "Look up parts, run the checks and the KiCad builds",
  "Read the order files and the 3D renders",
];
const CANNOT = ["See your AI keys or change your settings", "Delete boards"];

export default function Connect() {
  const { backend, me, setMe } = useApp();
  const [q] = useState(() => Object.fromEntries(new URLSearchParams(location.search)));
  const [client, setClient] = useState<OAuthClientInfo | null>(null);
  const [error, setError] = useState("");
  const [state, setState] = useState<"ask" | "sending" | "done" | "refused">("ask");

  useEffect(() => {
    if (!q.client_id || !q.redirect_uri || !q.code_challenge) {
      setError("This link is missing what the app needs to connect. Start connecting from the app again.");
      return;
    }
    let live = true;
    backend.oauthClient(q.client_id, q.redirect_uri).then(
      (c) => live && setClient(c),
      (e: Error) => live && setError(e.message || "This request can't be checked."),
    );
    return () => {
      live = false;
    };
  }, [backend, q]);

  const answer = async (allow: boolean) => {
    setState("sending");
    try {
      const { redirect } = await backend.oauthApprove({
        client_id: q.client_id!,
        redirect_uri: q.redirect_uri!,
        code_challenge: q.code_challenge!,
        allow,
        ...(q.state ? { state: q.state } : {}),
        ...(q.resource ? { resource: q.resource } : {}),
        ...(q.scope ? { scope: q.scope } : {}),
      });
      setState(allow ? "done" : "refused");
      // back to the app; an app's own address (claude://, cursor://) opens it and leaves this tab
      window.location.assign(redirect);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send your answer.");
      setState("ask");
    }
  };

  const name = client?.name ?? "This app";

  return (
    <Screen>
      <header className="flex min-h-14 items-center border-b px-4">
        <Lockup />
      </header>
      <main className="grid flex-1 place-items-center px-4 py-12">
        <div className="flex w-full max-w-lg flex-col gap-6" data-testid="connect">
          {error ? (
            <div className="flex flex-col gap-4" role="alert">
              <h1 className="text-3xl font-semibold tracking-tight">This connection didn't work</h1>
              <p className="text-soft">{error}</p>
              <Button variant="outline" asChild className="self-start">
                <a href="/">Your boards</a>
              </Button>
            </div>
          ) : !client ? (
            <Loader className="self-center" />
          ) : state === "done" || state === "refused" ? (
            <div className="flex flex-col gap-4" role="status" data-testid="connect-done">
              <h1 className="text-3xl font-semibold tracking-tight">{state === "done" ? `${name} is connected` : "Not connected"}</h1>
              <p className="text-soft">
                {state === "done" ? `Going back to ${client.redirect_host}. If nothing happens, switch back to ${name} yourself; you can close this tab.` : `${name} was told no. You can close this tab.`}
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                <h1 className="text-3xl font-semibold tracking-tight text-balance" data-testid="connect-title">
                  Let {name} use HardHub?
                </h1>
                <p className="text-lg text-soft">
                  {name} will design boards with you in its own chat. It does the thinking on your own plan there: no API key, and HardHub never sees that account.
                </p>
                <p className="text-sm text-muted-foreground" data-testid="connect-who">
                  {client.client_host
                    ? `Identified by ${client.client_host}.`
                    : "The app chose this name itself. Allow it only if you just asked your AI app to connect to HardHub."}
                </p>
              </div>
              <Card className="gap-4 px-5">
                <div className="flex flex-col gap-2">
                  <strong className="text-sm font-semibold">It will be able to</strong>
                  <ul className="flex flex-col gap-1.5 text-sm text-soft">
                    {CAN.map((c) => (
                      <li key={c} className="flex gap-2">
                        <CheckIcon className="mt-0.5 size-4 shrink-0 text-moss" aria-hidden="true" />
                        {c}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex flex-col gap-2">
                  <strong className="text-sm font-semibold">It won't be able to</strong>
                  <ul className="flex flex-col gap-1.5 text-sm text-soft">
                    {CANNOT.map((c) => (
                      <li key={c} className="flex gap-2">
                        <XIcon className="mt-0.5 size-4 shrink-0 text-clay" aria-hidden="true" />
                        {c}
                      </li>
                    ))}
                  </ul>
                </div>
              </Card>
              <div className="flex flex-wrap gap-2">
                <Button size="lg" onClick={() => answer(true)} disabled={state !== "ask"} data-testid="connect-allow">
                  {state === "sending" ? "Connecting…" : "Allow"}
                </Button>
                <Button size="lg" variant="outline" onClick={() => answer(false)} disabled={state !== "ask"} data-testid="connect-cancel">
                  Cancel
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                Signed in as {me?.email}.{" "}
                <button
                  className="text-ember-text underline-offset-4 hover:underline"
                  onClick={async () => {
                    // sign in as someone else, then come back here
                    rememberNext(location.pathname + location.search);
                    await backend.logout();
                    setMe(null);
                    navigate("/signin", true);
                  }}
                >
                  Not you?
                </button>{" "}
                Afterwards you go back to <span className="num">{client.redirect_host}</span>. Disconnect it any time in Settings.
              </p>
            </>
          )}
        </div>
      </main>
    </Screen>
  );
}
