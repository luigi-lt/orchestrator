import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { ApprovalDto, RunDto } from "@orch/contracts";
import { api, put, subscribe } from "./api";
import { ChatView } from "./views/ChatView";
import { RunDetail } from "./views/RunDetail";
import { RunsList } from "./views/RunsList";

export interface Me {
  login: string;
  name: string | null;
  repos: string[];
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
}

const AppContext = createContext<AppState>({ me: null, pending: [], setToggleTarget: () => undefined });
export const useApp = () => useContext(AppContext);

const FINAL = new Set(["completed", "closed", "cancelled", "failed"]);

function notify(title: string, body: string) {
  if ("Notification" in window && Notification.permission === "granted" && document.visibilityState !== "visible") {
    new Notification(title, { body });
  }
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [pending, setPending] = useState<ApprovalDto[]>([]);
  const [toggleTarget, setToggleTarget] = useState<string | null>(null);
  const [notifPermission, setNotifPermission] = useState<string>("Notification" in window ? Notification.permission : "unsupported");
  const location = useLocation();
  const navigate = useNavigate();
  const knownPending = useRef<Set<string> | null>(null);
  const runStates = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    void api<Me>("/api/me").then(setMe);
    void api<RunDto[]>("/api/runs").then((runs) => runs.forEach((r) => runStates.current.set(r.id, r.state)));
  }, []);

  const loadPending = useCallback(async () => {
    const list = await api<ApprovalDto[]>("/api/pending");
    if (knownPending.current) {
      for (const p of list) if (!knownPending.current.has(p.id)) notify("Action needed", p.title);
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
          if (before && !FINAL.has(before) && FINAL.has(run.state)) notify(`Run ${run.state}`, `#${run.issueNumber} ${run.title}`);
        });
      }
    });
  }, [loadPending]);

  const isOps = location.pathname.startsWith("/ops");
  const switchView = () => {
    const next = isOps ? "user" : "operator";
    void put("/api/preferences", { landingView: next });
    navigate(toggleTarget ?? (isOps ? "/chat" : "/ops/runs"));
  };

  const firstPending = pending[0];

  return (
    <AppContext.Provider value={{ me, pending, setToggleTarget }}>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <span className="logo">◆</span> Orchestrator
          </div>
          <div className="view-toggle" role="group" aria-label="Switch view">
            <button className={!isOps ? "active" : ""} onClick={() => isOps && switchView()} aria-pressed={!isOps}>
              User view
            </button>
            <button className={isOps ? "active" : ""} onClick={() => !isOps && switchView()} aria-pressed={isOps}>
              Operator view
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
              onClick={() => firstPending?.conversationId && navigate(`/chat/${firstPending.conversationId}`)}
            >
              {pending.length} pending
            </button>
            <span className="me">@{me?.login ?? "…"}</span>
          </div>
        </header>
        <main className="content">
          <Routes>
            <Route path="/" element={me ? <Navigate to={me.landingView === "operator" ? "/ops/runs" : "/chat"} replace /> : null} />
            <Route path="/chat" element={<ChatView />} />
            <Route path="/chat/:conversationId" element={<ChatView />} />
            <Route path="/ops/runs" element={<RunsList />} />
            <Route path="/ops/runs/:runId" element={<RunDetail />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </AppContext.Provider>
  );
}
