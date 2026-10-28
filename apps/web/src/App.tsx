import { lazy, Suspense, useEffect } from "react";
import { useApp, API_URL } from "./lib/app";
import { navigate, parse, usePath, onLink, rememberNext } from "./lib/router";
import { Lockup } from "./components/brand";

// each screen is its own chunk: sign-in never downloads the workspace
const SignIn = lazy(() => import("./screens/signin"));
const Verify = lazy(() => import("./screens/signin").then((m) => ({ default: m.Verify })));
const Projects = lazy(() => import("./screens/projects"));
const Workspace = lazy(() => import("./screens/workspace"));
const Settings = lazy(() => import("./screens/settings"));
const Connect = lazy(() => import("./screens/connect"));

// the frame paints at once, before the server has answered
function Loading() {
  return (
    <div className="screen" aria-busy="true">
      <header className="topbar">
        <Lockup />
      </header>
      <div className="center-state">
        <div style={{ alignItems: "center" }}>
          <div className="spinner-line" />
        </div>
      </div>
    </div>
  );
}

function Offline() {
  const { recheck } = useApp();
  return (
    <div className="screen">
      <header className="topbar">
        <Lockup />
      </header>
      <div className="center-state" data-testid="offline">
        <div>
          <h1 className="d3">Can't reach the HardHub server</h1>
          <p className="secondary">
            The app tried <span className="num">{API_URL}</span> and got no answer. If you are running HardHub on this computer, start it
            with <span className="num">./hardhub</span> and try again.
          </p>
          <div>
            <button className="btn btn-solid" onClick={recheck} data-testid="retry">
              Try again
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { reach, me, ready } = useApp();
  const path = usePath();
  const route = parse(path);

  // signed-out people go to sign-in; signed-in people never see it
  useEffect(() => {
    if (!ready || reach !== "online") return;
    if (!me && route.name !== "signin" && route.name !== "verify") {
      // an AI app's consent page comes back after sign-in
      if (route.name === "connect") rememberNext(location.pathname + location.search);
      navigate("/signin", true);
    }
    if (me && route.name === "signin") navigate("/", true);
  }, [ready, reach, me, route.name]);

  if (reach === "offline") return <Offline />;
  if (!ready || reach === "checking") return <Loading />;
  if (!me && route.name !== "signin" && route.name !== "verify") return <Loading />;

  return (
    <Suspense fallback={<Loading />}>
      {route.name === "signin" && <SignIn />}
      {route.name === "verify" && <Verify />}
      {route.name === "projects" && <Projects />}
      {route.name === "project" && <Workspace key={route.id} id={route.id} />}
      {route.name === "settings" && <Settings />}
      {route.name === "connect" && <Connect />}
      {route.name === "notfound" && (
        <div className="center-state">
          <div>
            <h1 className="d3">Nothing here</h1>
            <a className="btn" href="/" onClick={onLink} style={{ alignSelf: "flex-start" }}>
              All boards
            </a>
          </div>
        </div>
      )}
    </Suspense>
  );
}
