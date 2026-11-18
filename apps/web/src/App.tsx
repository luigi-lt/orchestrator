import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { ApprovalDto, RunDto } from "@orch/contracts";
import { api, put, subscribe } from "./api";
import { runPath, subtaskPath } from "./components/TicketTree";
import { LegacyChat } from "./views/ChatView";
import { RunDetail } from "./views/RunDetail";
import { RunPage } from "./views/RunPage";
import { Products } from "./views/Products";
import { RunsList } from "./views/RunsList";
import { StartPage } from "./views/StartPage";
import { SubtaskPage } from "./views/SubtaskPage";
import { UserLayout } from "./views/UserLayout";

export interface Me {
  login: string;
  name: string | null;
  repos: string[];
  /** Set when the product catalog on disk cannot be used; no new work starts until it is fixed. */
  catalogError: string | null;
  triggerLabel: string;
  model: string;
  landingView: "user" | "operator";
  lastConversationId: string | null;
}

interface AppState {
  me: Me | null;
  pending: ApprovalDto[];
  /** Where the toggle should go from the current page, set by each view (context-preserving switch). */
  setToggleTarget: (target: string | null) => void;
  /** At phone width the side panel is a drawer, opened from the header (FR-C6). */
  navOpen: boolean;
  setNavOpen: (open: boolean) => void;
}

const AppContext = createContext<AppState>({ me: null, pending: [], setToggleTarget: () => undefined, navOpen: false, setNavOpen: () => undefined });
export const useApp = () => useContext(AppContext);

const FINAL = new Set(["completed", "closed", "cancelled", "failed"]);

/** The page where a decision is taken: the run's, or one of its sub-tasks' (AD-44). */
export const pageOfApproval = (a: ApprovalDto) => `${a.subtaskKey ? subtaskPath(a.runId, a.subtaskKey) : runPath(a.runId)}#needs-you`;

/** A browser notification while the app is in the background; clicking it opens the page it is about. */
function notify(title: string, body: string, open: () => void) {
  if ("Notification" in window && Notification.permission === "granted" && document.visibilityState !== "visible") {
    const n = new Notification(title, { body });
    n.onclick = () => {
      window.focus();
      open();
      n.close();
    };
  }
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [pending, setPending] = useState<ApprovalDto[]>([]);
  const [toggleTarget, setToggleTarget] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [notifPermission, setNotifPermission] = useState<string>("Notification" in window ? Notification.permission : "unsupported");
  const location = useLocation();
  const navigate = useNavigate();
  const knownPending = useRef<Set<string> | null>(null);
  // Notifications open pages; the latest navigate is used without subscribing again on every move.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const runStates = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    void api<Me>("/api/me").then(setMe);
    void api<RunDto[]>("/api/runs").then((runs) => runs.forEach((r) => runStates.current.set(r.id, r.state)));
  }, []);

  const loadPending = useCallback(async () => {
    const list = await api<ApprovalDto[]>("/api/pending");
    if (knownPending.current) {
      for (const p of list) if (!knownPending.current.has(p.id)) notify("Action needed", p.title, () => navigateRef.current(pageOfApproval(p)));
    }
    knownPending.current = new Set(list.map((p) => p.id));
    setPending(list);
  }, []);

  useEffect(() => {
    void loadPending();
    return subscribe((n) => {
      if (n.t === "pending") void loadPending();
      if (n.t === "run") {
        void api<{ run: RunDto }>(`/api/runs/${n.r}`).then(({ run }) => {
          const before = runStates.current.get(run.id);
          runStates.current.set(run.id, run.state);
          if (before && !FINAL.has(before) && FINAL.has(run.state)) notify(`Run ${run.state}`, `#${run.issueNumber} ${run.title}`, () => navigateRef.current(runPath(run.id)));
        });
      }
    });
  }, [loadPending]);

  const isOps = location.pathname.startsWith("/ops");
  const switchView = () => {
    const next = isOps ? "user" : "operator";
    void put("/api/preferences", { landingView: next });
    navigate(toggleTarget ?? (isOps ? "/start" : "/ops/runs"));
  };

  const firstPending = pending[0];

  return (
    <AppContext.Provider value={{ me, pending, setToggleTarget, navOpen, setNavOpen }}>
      <div className="app">
        <a className="skip-link" href="#main">
          Skip to the page
        </a>
        <header className="topbar">
          {!isOps && (
            <button
              className="menu-button narrow-only"
              aria-expanded={navOpen}
              aria-controls="work-nav"
              onClick={() => setNavOpen(!navOpen)}
            >
              <span aria-hidden>☰</span> Work
            </button>
          )}
          <div className="brand">
            <span className="logo">◆</span> Orchestrator
          </div>
          <div className="view-toggle" role="group" aria-label="Switch view">
            <button className={!isOps ? "active" : ""} onClick={() => isOps && switchView()} aria-pressed={!isOps}>
              User<span className="wide-only"> view</span>
            </button>
            <button className={isOps ? "active" : ""} onClick={() => !isOps && switchView()} aria-pressed={isOps}>
              Operator<span className="wide-only"> view</span>
            </button>
          </div>
          <div className="topbar-right">
            {notifPermission === "default" && (
              <button className="ghost small" onClick={() => void Notification.requestPermission().then(setNotifPermission)}>
                Enable notifications
              </button>
            )}
            <button
              className={`pending-badge ${pending.length ? "has" : ""}`}
              title={pending.map((p) => p.title).join("\n") || "Nothing waiting for you"}
              onClick={() => firstPending && navigate(pageOfApproval(firstPending))}
              aria-label={pending.length ? `${pending.length} decision${pending.length === 1 ? "" : "s"} waiting for you: open the first` : "Nothing waiting for you"}
            >
              {pending.length}
              <span className="wide-only"> pending</span>
            </button>
            <span className="me">@{me?.login ?? "…"}</span>
          </div>
        </header>
        {me?.catalogError && <div className="error-banner">Product catalog problem: {me.catalogError}</div>}
        <main className="content" id="main" tabIndex={-1}>
          <Routes>
            <Route path="/" element={me ? <Navigate to={me.landingView === "operator" ? "/ops/runs" : "/start"} replace /> : null} />
            <Route element={<UserLayout />}>
              <Route path="/start" element={<StartPage />} />
              <Route path="/chat" element={<LegacyChat />} />
              <Route path="/chat/:conversationId" element={<LegacyChat />} />
              <Route path="/runs/:runId" element={<RunPage />} />
              <Route path="/runs/:runId/subtasks/:key" element={<SubtaskPage />} />
            </Route>
            <Route path="/ops/runs" element={<RunsList />} />
            <Route path="/ops/runs/:runId" element={<RunDetail />} />
            <Route path="/ops/products" element={<Products />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </AppContext.Provider>
  );
}
