import { useEffect, useState, type FormEvent } from "react";
import type { AuthStatus } from "@hardhub/protocol";
import { Lockup } from "../components/brand";
import { useApp } from "../lib/app";
import { ApiError } from "../lib/backend";
import { navigate, takeNext } from "../lib/router";

// Email and password. The first account made is the owner's; after that new
// accounts are closed unless the server allows them (ALLOW_SIGNUP).
export default function SignIn() {
  const { backend, setMe } = useApp();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    backend.authStatus().then(
      (s) => {
        if (!live) return;
        setStatus(s);
        if (!s.has_account) setMode("signup");
      },
      // the form still works; it just cannot tell which one to show first
      () => live && setStatus({ has_account: true, signup_open: false }),
    );
    return () => {
      live = false;
    };
  }, [backend]);

  const signup = mode === "signup";
  const first = !!status && !status.has_account;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (signup && password.length < 8) return setError("Use at least 8 characters for the password.");
    if (signup && password !== again) return setError("The two passwords are not the same.");
    setBusy(true);
    try {
      const s = signup ? await backend.signUp(email.trim(), password) : await backend.signIn(email.trim(), password);
      setMe(s.me);
      navigate(takeNext(), true);
    } catch (err) {
      setError(err instanceof ApiError && err.detail ? err.detail : err instanceof Error ? err.message : "Could not sign in");
      setBusy(false);
    }
  };

  const switchTo = (m: "signin" | "signup") => {
    setMode(m);
    setError("");
    setAgain("");
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
          <form onSubmit={submit} className="field" data-testid="signin-form" aria-busy={!status}>
            {first && (
              <p className="small secondary" style={{ marginBottom: 4 }} data-testid="signin-first">
                Nobody has an account here yet. Create yours: it becomes this HardHub's owner, and new accounts close after it.
              </p>
            )}
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
            <label className="label" htmlFor="password" style={{ marginTop: 8 }}>
              Password
            </label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete={signup ? "new-password" : "current-password"}
              required
              minLength={signup ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="signin-password"
            />
            {signup && (
              <>
                <label className="label" htmlFor="password-again" style={{ marginTop: 8 }}>
                  Password again
                </label>
                <input
                  id="password-again"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={again}
                  onChange={(e) => setAgain(e.target.value)}
                  data-testid="signin-password-again"
                />
              </>
            )}
            <button className="btn btn-primary btn-lg" type="submit" disabled={busy || !status} data-testid="signin-submit" style={{ marginTop: 8 }}>
              {busy ? (signup ? "Creating your account…" : "Signing in…") : signup ? "Create account" : "Sign in"}
            </button>
            {error && (
              <p className="small" style={{ color: "var(--destructive)" }} role="alert">
                {error}
              </p>
            )}
            {status?.has_account && status.signup_open && (
              <button
                type="button"
                className="btn btn-sm btn-quiet"
                style={{ alignSelf: "flex-start", paddingLeft: 0 }}
                onClick={() => switchTo(signup ? "signin" : "signup")}
                data-testid="signin-switch"
              >
                {signup ? "I have an account: sign in" : "Create an account"}
              </button>
            )}
          </form>
          <p className="ed secondary" style={{ fontSize: 19 }}>
            The model proposes. You decide.
          </p>
        </div>
      </main>
    </div>
  );
}
