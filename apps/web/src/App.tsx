import { lazy, Suspense, useEffect } from "react";
import { useApp, API_URL } from "./lib/app";
import { navigate, parse, usePath, onLink, rememberNext } from "./lib/router";
import { Lockup } from "./components/brand";
import { Screen } from "./components/topbar";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/skeleton";

// each screen is its own chunk: sign-in never downloads the workspace
const SignIn = lazy(() => import("./screens/signin"));
const Projects = lazy(() => import("./screens/projects"));
const Workspace = lazy(() => import("./screens/workspace"));
const Settings = lazy(() => import("./screens/settings"));
const Connect = lazy(() => import("./screens/connect"));

// the frame paints at once, before the server has answered
function Loading() {
  return (
    <Screen>
      <header className="flex min-h-14 items-center border-b px-4">
        <Lockup />
      </header>
      <div className="grid flex-1 place-items-center" aria-busy="true">
        <Loader />
      </div>
    </Screen>
  );
}

function Offline() {
  const { recheck } = useApp();
  return (
    <Screen>
      <header className="flex min-h-14 items-center border-b px-4">
        <Lockup />
      </header>
      <div className="grid flex-1 place-items-center px-4" data-testid="offline">
        <div className="flex max-w-md flex-col gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">Can't reach the HardHub server</h1>
          <p className="text-muted-foreground">
            The app tried <span className="num text-foreground">{API_URL}</span> and got no answer. If you are running HardHub on this computer, start it
            with <span className="num text-foreground">./hardhub</span> and try again.
          </p>
          <div>
            <Button onClick={recheck} data-testid="retry">
              Try again
            </Button>
          </div>
        </div>
      </div>
    </Screen>
  );
}

export default function App() {
  const { reach, me, ready } = useApp();
  const path = usePath();
  const route = parse(path);

  // signed-out people go to sign-in; signed-in people never see it
  useEffect(() => {
    if (!ready || reach !== "online") return;
    if (!me && route.name !== "signin") {
      // an AI app's consent page comes back after sign-in
      if (route.name === "connect") rememberNext(location.pathname + location.search);
      navigate("/signin", true);
    }
    if (me && route.name === "signin") navigate("/", true);
  }, [ready, reach, me, route.name]);

  if (reach === "offline") return <Offline />;
  if (!ready || reach === "checking") return <Loading />;
  if (!me && route.name !== "signin") return <Loading />;

  return (
    <Suspense fallback={<Loading />}>
      {route.name === "signin" && <SignIn />}
      {route.name === "projects" && <Projects />}
      {route.name === "project" && <Workspace key={route.id} id={route.id} />}
      {route.name === "settings" && <Settings />}
      {route.name === "connect" && <Connect />}
      {route.name === "notfound" && (
        <Screen>
          <div className="grid flex-1 place-items-center px-4">
            <div className="flex flex-col items-start gap-4">
              <h1 className="text-2xl font-semibold tracking-tight">Nothing here</h1>
              <Button variant="outline" asChild>
                <a href="/" onClick={onLink}>
                  All boards
                </a>
              </Button>
            </div>
          </div>
        </Screen>
      )}
    </Suspense>
  );
}
