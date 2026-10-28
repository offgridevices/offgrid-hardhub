import { useState, type FormEvent } from "react";
import { Lockup } from "../components/brand";
import { useApp } from "../lib/app";
import { navigate } from "../lib/router";

export default function SignIn() {
  const { backend, setMe } = useApp();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");
  const [local, setLocal] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState("sending");
    try {
      const r = await backend.authStart(email.trim());
      if (r.token) {
        // local mode: no email to send; the server hands back the one-time
        // sign-in token the email would have carried, redeemed here
        setLocal(true);
        const session = await backend.authVerify(r.token);
        setMe(session.me);
        navigate("/", true);
        return;
      }
      setState("sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the link");
      setState("error");
    }
  };

  return (
    <div className="screen">
      <header className="topbar">
        <Lockup />
      </header>
      <main className="signin">
        <div className="signin-box">
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <h1 className="d3">Describe it. Check it. Build it.</h1>
            <p className="lead">HardHub designs the circuit board with you, checks every connection, and hands you files a fab can build.</p>
          </div>
          {state === "sent" ? (
            <div className="panel" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 8 }} role="status">
              <strong>Check your email</strong>
              <span className="secondary small">
                A sign-in link is on its way to {email}. It works once, for 15 minutes.
              </span>
              <button className="btn btn-sm btn-quiet" style={{ alignSelf: "flex-start", paddingLeft: 0 }} onClick={() => setState("idle")}>
                Use a different email
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="field" data-testid="signin-form">
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                className="input"
                type="email"
                autoComplete="email"
                inputMode="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="signin-email"
              />
              <button className="btn btn-primary btn-lg" type="submit" disabled={state === "sending"} data-testid="signin-submit" style={{ marginTop: 8 }}>
                {state === "sending" ? "Signing in…" : "Continue with email"}
              </button>
              {state === "error" && (
                <p className="small" style={{ color: "var(--destructive)" }} role="alert">
                  {error}
                </p>
              )}
              <p className="small muted" style={{ marginTop: 4 }}>
                {local ? "Local mode: signed in without email." : "No password. We email you a link to sign in."}
              </p>
            </form>
          )}
          <p className="ed secondary" style={{ fontSize: 19 }}>
            The model proposes. You decide.
          </p>
        </div>
      </main>
    </div>
  );
}
