import { useEffect, useState, type FormEvent } from "react";
import type { AuthStatus } from "@hardhub/protocol";
import { Lockup } from "../components/brand";
import { useApp } from "../lib/app";
import { ApiError } from "../lib/backend";
import { navigate, takeNext } from "../lib/router";
import { Screen } from "../components/topbar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
    <Screen>
      <header className="flex min-h-14 items-center border-b px-4">
        <Lockup />
      </header>
      <main className="grid flex-1 place-items-center px-4 py-12">
        <div className="grid w-full max-w-4xl items-center gap-10 md:grid-cols-2 md:gap-16">
          <div className="flex flex-col gap-4">
            <Badge tone="ember" className="self-start">
              Hardware, designed with you
            </Badge>
            <h1 className="text-4xl font-semibold leading-[1.05] tracking-tight text-balance sm:text-5xl">Describe it. Check it. Build it.</h1>
            <p className="max-w-[46ch] text-lg text-soft">HardHub designs the circuit board with you, checks every connection, and hands you files a fab can build.</p>
            <p className="text-sm text-muted-foreground">The AI proposes. You decide.</p>
          </div>
          <Card className="gap-0 py-0">
            <form onSubmit={submit} className="flex flex-col gap-4 p-6" data-testid="signin-form" aria-busy={!status}>
              <div className="flex flex-col gap-1">
                <h2 className="text-lg font-semibold">{signup ? "Create your account" : "Sign in"}</h2>
                {first && (
                  <p className="text-sm text-muted-foreground" data-testid="signin-first">
                    Nobody has an account here yet. Create yours: it becomes this HardHub's owner, and new accounts close after it.
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  required
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid="signin-email"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete={signup ? "new-password" : "current-password"}
                  required
                  minLength={signup ? 8 : undefined}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  data-testid="signin-password"
                />
              </div>
              {signup && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="password-again">Password again</Label>
                  <Input
                    id="password-again"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={again}
                    onChange={(e) => setAgain(e.target.value)}
                    data-testid="signin-password-again"
                  />
                </div>
              )}
              <Button size="lg" type="submit" disabled={busy || !status} data-testid="signin-submit" className="mt-1">
                {busy ? (signup ? "Creating your account…" : "Signing in…") : signup ? "Create account" : "Sign in"}
              </Button>
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              {status?.has_account && status.signup_open && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="self-start px-0"
                  onClick={() => switchTo(signup ? "signin" : "signup")}
                  data-testid="signin-switch"
                >
                  {signup ? "I have an account: sign in" : "Create an account"}
                </Button>
              )}
            </form>
          </Card>
        </div>
      </main>
    </Screen>
  );
}
