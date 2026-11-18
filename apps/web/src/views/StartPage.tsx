import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { ConversationDto, TicketDto } from "@orch/contracts";
import { pageOfApproval, useApp } from "../App";
import { HideLabel, narrow, useSheet } from "../components/Page";
import { runLabel, runPath } from "../components/TicketTree";
import { Conversation, NewChat } from "./ChatView";
import { useUserNav } from "./UserLayout";

const PANEL_KEY = "orch.assistantPanel";

/**
 * The start page (FR-C5, AD-44): the requester's tickets that need them or are active, and the assistant in the
 * agent panel, with their earlier chats. The one place the assistant lives; a run's page links here with the run named.
 */
export function StartPage() {
  const { me, pending, setToggleTarget } = useApp();
  const { tickets, conversations, loaded } = useUserNav();
  const [params, setParams] = useSearchParams();
  const chatId = params.get("chat");
  const about = params.get("about");

  useEffect(() => {
    setToggleTarget("/ops/runs");
    return () => setToggleTarget(null);
  }, [setToggleTarget]);

  const waiting = tickets.filter((t) => t.pending > 0);
  const active = tickets.filter((t) => t.active && t.pending === 0);
  const chats = conversations.filter((c) => c.kind === "general");

  return (
    <div className="page-layout">
      <section className="page start" aria-label="Start">
        <header className="record-head">
          <h1>Your work</h1>
          <p className="muted small">
            Tickets that need you or are being worked on. Every ticket, run and sub-task is in the side panel; label an issue{" "}
            <code>{me?.triggerLabel ?? "ai-ready"}</code> on GitHub, or ask the assistant beside this page, to start work.
          </p>
        </header>
        <section id="needs-you" className={`page-section needs-you ${pending.length ? "has" : ""}`} aria-labelledby="start-needs-title">
          <h2 id="start-needs-title">Needs you{pending.length ? ` · ${pending.length}` : ""}</h2>
          {pending.length === 0 && <p className="muted small">Nothing waits for you.</p>}
          {pending.map((a) => (
            <div key={a.id} className="needs-row">
              <span>
                {a.label} <span className="muted">· {a.title.slice(a.label.length + 3)}</span>
              </span>
              <Link className="small" to={pageOfApproval(a)}>
                Open
              </Link>
            </div>
          ))}
        </section>
        <section className="page-section" aria-labelledby="start-active-title">
          <h2 id="start-active-title">In progress{active.length ? ` · ${active.length}` : ""}</h2>
          {loaded && active.length === 0 && <p className="muted small">{waiting.length ? "Everything else is waiting for you, above." : "Nothing is in progress."}</p>}
          {active.map((t) => (
            <TicketRow key={t.key} ticket={t} />
          ))}
        </section>
      </section>
      <AssistantPanel
        chats={chats}
        chatId={chatId}
        about={about}
        open={(id) => setParams(id ? { chat: id } : {})}
      />
    </div>
  );
}

function TicketRow({ ticket }: { ticket: TicketDto }) {
  const newest = ticket.runs[0];
  return (
    <Link className="ticket-card" to={newest ? runPath(newest.runId) : "#"}>
      <span className="ticket-ref">
        {ticket.repo}#{ticket.issueNumber}
      </span>
      <span className="ticket-card-title">{ticket.title}</span>
      {newest && <span className="muted small">{runLabel(newest)}</span>}
    </Link>
  );
}

/**
 * The agent panel of the start page: the assistant only (AD-38). Its earlier chats are listed inside it; a new
 * chat is started here, also from a run's page with the run named.
 */
function AssistantPanel({ chats, chatId, about, open }: { chats: ConversationDto[]; chatId: string | null; about: string | null; open: (id: string | null) => void }) {
  const navigate = useNavigate();
  const [shown, setShown] = useState(() => {
    if (about || chatId) return true;
    if (narrow()) return false;
    try {
      return window.localStorage.getItem(PANEL_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const toggle = (next: boolean) => {
    setShown(next);
    try {
      window.localStorage.setItem(PANEL_KEY, next ? "open" : "closed");
    } catch {
      // the choice is only kept for this page
    }
  };
  // A link from a run's page, or a chat chosen, opens the panel also at phone width.
  useEffect(() => {
    if (about || chatId) setShown(true);
  }, [about, chatId]);

  const { panel, opener } = useSheet(shown, () => toggle(false));
  const current = chats.find((c) => c.id === chatId);
  if (!shown) {
    return (
      <button ref={opener} className="panel-reopen" onClick={() => toggle(true)} aria-label="Show the assistant">
        Assistant
      </button>
    );
  }
  return (
    <aside ref={panel} className="agent-panel assistant-panel" aria-label="Assistant">
      <div className="agent-panel-head">
        <div className="agent-switch">
          {chatId ? (
            <button className="ghost small" onClick={() => open(null)} aria-label="Back to your chats">
              ‹ Chats
            </button>
          ) : null}
          <span className="agent-tab selected" aria-current="true">
            <span className="agent-state available" aria-hidden />
            Assistant
          </span>
        </div>
        <div className="agent-panel-actions">
          {chatId && (
            <button className="ghost small" onClick={() => open(null)}>
              New chat
            </button>
          )}
          <button className="ghost small" onClick={() => toggle(false)} aria-label="Hide the assistant">
            <HideLabel />
          </button>
        </div>
      </div>
      {chatId ? (
        <>
          {current && <div className="chat-title small muted">{current.title}</div>}
          <Conversation key={chatId} id={chatId} kind="general" />
        </>
      ) : (
        <NewChat key={about ?? "new"} about={about} onCreated={(id) => navigate(`/start?chat=${encodeURIComponent(id)}`, { replace: true })}>
          {chats.length > 0 && (
            <nav className="chat-list" aria-label="Your chats with the assistant">
              <div className="section-label">Your chats</div>
              {chats.map((c) => (
                <button key={c.id} className="conversation-item" onClick={() => open(c.id)}>
                  <span className="title">{c.title}</span>
                  <span className="muted small">{new Date(c.updatedAt).toLocaleDateString()}</span>
                </button>
              ))}
            </nav>
          )}
        </NewChat>
      )}
    </aside>
  );
}
