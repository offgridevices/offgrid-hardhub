// The page an AI app (Claude, ChatGPT, Codex...) sends the person to when it
// asks to use HardHub over MCP: who is asking, what it can do, Allow or
// Cancel. The server checks the request again when the answer comes back.
import { useEffect, useState } from "react";
import type { OAuthClientInfo } from "@hardhub/protocol";
import { Lockup } from "../components/brand";
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
    <div className="screen">
      <header className="topbar">
        <Lockup />
      </header>
      <main className="signin">
        <div className="signin-box" data-testid="connect">
          {error ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }} role="alert">
              <h1 className="d3">This connection didn't work</h1>
              <p className="secondary">{error}</p>
              <a className="btn" href="/" style={{ alignSelf: "flex-start" }}>
                Your boards
              </a>
            </div>
          ) : !client ? (
            <div className="spinner-line" aria-busy="true" />
          ) : state === "done" || state === "refused" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }} role="status" data-testid="connect-done">
              <h1 className="d3">{state === "done" ? `${name} is connected` : "Not connected"}</h1>
              <p className="secondary">
                {state === "done" ? `Going back to ${client.redirect_host}. If nothing happens, switch back to ${name} yourself; you can close this tab.` : `${name} was told no. You can close this tab.`}
              </p>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <h1 className="d3" data-testid="connect-title">
                  Let {name} use HardHub?
                </h1>
                <p className="lead">
                  {name} will design boards with you in its own chat. It does the thinking on your own plan there: no API key, and HardHub never sees that account.
                </p>
                <p className="small muted" data-testid="connect-who">
                  {client.client_host
                    ? `Identified by ${client.client_host}.`
                    : "The app chose this name itself. Allow it only if you just asked your AI app to connect to HardHub."}
                </p>
              </div>
              <div className="panel" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
                <strong className="small">It will be able to</strong>
                <ul className="steps-list">
                  {CAN.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                <strong className="small" style={{ marginTop: 4 }}>
                  It won't be able to
                </strong>
                <ul className="steps-list">
                  {CANNOT.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
              <div className="key-row">
                <button className="btn btn-primary btn-lg" onClick={() => answer(true)} disabled={state !== "ask"} data-testid="connect-allow">
                  {state === "sending" ? "Connecting…" : "Allow"}
                </button>
                <button className="btn btn-lg" onClick={() => answer(false)} disabled={state !== "ask"} data-testid="connect-cancel">
                  Cancel
                </button>
              </div>
              <p className="small muted">
                Signed in as {me?.email}.{" "}
                <button
                  className="btn-link"
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
    </div>
  );
}
