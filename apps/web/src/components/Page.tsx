import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { AgentAvailabilityDto, ApprovalDto, OrchestratorCard, PageCardDto, TicketSubtaskDto } from "@orch/contracts";
import { subscribe } from "../api";
import { Conversation } from "../views/ChatView";
import { OrchestratorCardView } from "./Cards";
import { subtaskPath } from "./TicketTree";

type CardType = OrchestratorCard["type"];

/** A section of a page: the card types it holds, in the order they were written. */
export interface SectionDef {
  id: string;
  title: string;
  types: CardType[];
}

/** The run's page (FR-C2). On the fast track the change, its review and its pull request are here too. */
export const RUN_SECTIONS: SectionDef[] = [
  { id: "progress", title: "Progress", types: ["progress"] },
  { id: "analysis", title: "Analysis", types: ["analysis", "questions"] },
  { id: "plan", title: "Plan", types: ["plan"] },
  { id: "story", title: "Story", types: ["story", "dependents"] },
  { id: "change", title: "The change", types: ["risk", "review", "findings", "limits", "change", "blocked"] },
  { id: "pull_request", title: "Pull request", types: ["pull_request"] },
];

/** A sub-task's page (FR-C3). Its description is the page's header. */
export const SUBTASK_SECTIONS: SectionDef[] = [
  { id: "progress", title: "Progress", types: ["progress"] },
  { id: "review", title: "Review", types: ["review", "findings", "risk", "limits"] },
  { id: "change", title: "Check of the change", types: ["change"] },
  { id: "access", title: "Access", types: ["blocked"] },
  { id: "pull_request", title: "Pull request", types: ["pull_request"] },
];

/** Cards that are not shown as sections: the header shows the work item and the sub-task; links live in chats. */
const NOT_A_SECTION = new Set<CardType>(["work_item", "subtask", "run_link", "page_marker", "notice"]);

const approvalOf = (card: OrchestratorCard): string | null => ("approvalId" in card && typeof card.approvalId === "string" ? card.approvalId : null);

/** Splits a page's cards: the ones waiting for a decision on this page, the notices, and the rest. */
export function splitCards(cards: PageCardDto[], needsYou: ApprovalDto[]) {
  const waiting = new Set(needsYou.map((a) => a.id));
  const pending = cards.filter((c) => {
    const id = approvalOf(c.card);
    return id !== null && waiting.has(id);
  });
  const pendingKeys = new Set(pending.map((c) => c.key));
  return {
    pending,
    notices: cards.filter((c) => c.card.type === "notice"),
    rest: cards.filter((c) => !pendingKeys.has(c.key) && c.card.type !== "notice"),
  };
}

/**
 * Needs you (FR-C2): every decision waiting on this page with its action, and on the run's page a link to each
 * sub-task's page where a decision waits.
 */
export function NeedsYou({
  runId,
  pending,
  approvals,
  subtasks = [],
}: {
  runId: string;
  pending: PageCardDto[];
  approvals: ApprovalDto[];
  subtasks?: TicketSubtaskDto[];
}) {
  const shown = new Set(pending.map((c) => approvalOf(c.card)));
  const elsewhere = approvals.filter((a) => a.subtaskKey && !shown.has(a.id));
  // A decision whose card has not arrived yet still shows, as a line.
  const missing = approvals.filter((a) => !a.subtaskKey && !shown.has(a.id));
  const titleOf = (key: string) => {
    const st = subtasks.find((s) => s.key === key);
    return st ? `${st.index + 1}. ${st.title}` : key;
  };
  const count = pending.length + elsewhere.length + missing.length;
  return (
    <section id="needs-you" className={`page-section needs-you ${count ? "has" : ""}`} aria-labelledby="needs-you-title">
      <h2 id="needs-you-title">Needs you{count ? ` · ${count}` : ""}</h2>
      {count === 0 && <p className="muted small">Nothing waits for you here.</p>}
      {pending.map((c) => (
        <OrchestratorCardView key={c.key} card={c.card} />
      ))}
      {missing.map((a) => (
        <div key={a.id} className="needs-row">
          <span>{a.label}</span>
          <span className="muted small">Loading…</span>
        </div>
      ))}
      {elsewhere.map((a) => (
        <div key={a.id} className="needs-row">
          <span>
            {a.label} <span className="muted">· sub-task {titleOf(a.subtaskKey!)}</span>
          </span>
          <Link className="small" to={`${subtaskPath(runId, a.subtaskKey!)}#needs-you`}>
            Open the sub-task's page
          </Link>
        </div>
      ))}
    </section>
  );
}

/** The sections of a page, each with its cards oldest first; empty sections are left out. */
export function Sections({ cards, sections }: { cards: PageCardDto[]; sections: SectionDef[] }) {
  const known = new Set(sections.flatMap((s) => s.types));
  const other = cards.filter((c) => !known.has(c.card.type) && !NOT_A_SECTION.has(c.card.type));
  return (
    <>
      {sections.map((section) => {
        const inSection = cards.filter((c) => section.types.includes(c.card.type));
        if (!inSection.length) return null;
        return (
          <section key={section.id} id={section.id} className="page-section" aria-labelledby={`${section.id}-title`}>
            <h2 id={`${section.id}-title`}>{section.title}</h2>
            {inSection.map((c) => (
              <OrchestratorCardView key={c.key} card={c.card} />
            ))}
          </section>
        );
      })}
      {other.length > 0 && (
        <section className="page-section">
          <h2>Other records</h2>
          {other.map((c) => (
            <OrchestratorCardView key={c.key} card={c.card} />
          ))}
        </section>
      )}
    </>
  );
}

/** What happened, newest first, folded away until opened (FR-C2). The newest entry shows in the fold. */
export function Activity({ notices }: { notices: PageCardDto[] }) {
  if (!notices.length) return null;
  const newestFirst = [...notices].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.version - a.version);
  const latest = newestFirst[0]!.card;
  return (
    <section id="activity" className="page-section">
      <details className="activity">
        <summary>
          <span className="activity-title">Activity · {notices.length}</span>
          {latest.type === "notice" && <span className={`activity-latest ${latest.level}`}>{latest.text.split("\n")[0]}</span>}
        </summary>
        <div className="activity-list">
          {newestFirst.map((c) => (
            <div key={c.key} className="activity-entry">
              <time className="muted small" dateTime={c.updatedAt}>
                {new Date(c.updatedAt).toLocaleString()}
              </time>
              <OrchestratorCardView card={c.card} />
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}

/** Scrolls to the section named in the address (#plan, #needs-you) once the page has loaded. */
export function useScrollToHash(ready: boolean) {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready || !hash) return;
    const target = document.getElementById(decodeURIComponent(hash.slice(1))) ?? document.getElementById("needs-you");
    target?.scrollIntoView({ block: "start" });
  }, [ready, hash]);
}

const PANEL_KEY = "orch.agentPanel";
const narrow = () => typeof window !== "undefined" && window.matchMedia?.("(max-width: 860px)").matches;

const STATE_WORD: Record<AgentAvailabilityDto["state"], string> = {
  available: "talk now",
  read_only: "read only",
  elsewhere: "in your chats",
  not_yet: "not yet",
  not_available: "not on this run",
};

/** The agent the panel opens on: one that takes messages now, else one whose conversation can be read. */
const firstChoice = (agents: AgentAvailabilityDto[]) =>
  (agents.find((a) => a.state === "available") ?? agents.find((a) => a.state === "read_only") ?? agents[0])?.agent ?? null;

/**
 * The agent panel beside a page (FR-C4, AD-38): the agents of this page, which of them the requester can talk
 * with and why not, and the conversation with the one chosen. Each conversation belongs to one agent; the
 * requester chooses the agent, the orchestrator says which are available.
 */
export function AgentPanel({ agents, runId }: { agents: AgentAvailabilityDto[]; runId: string }) {
  const [open, setOpen] = useState(() => {
    if (narrow()) return false;
    try {
      return window.localStorage.getItem(PANEL_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  // Until the requester chooses, the panel follows the agents: it opens on the architect once its session opens.
  const [chosen, setChosen] = useState<AgentAvailabilityDto["agent"] | null>(null);
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const selected = agents.find((a) => a.agent === (chosen ?? firstChoice(agents))) ?? agents[0];

  // A reply in the conversation of an agent that is not shown marks it in the switch.
  const shownConversation = open ? selected?.conversationId : null;
  const others = agents.filter((a) => a.conversationId && a.conversationId !== shownConversation).map((a) => a.conversationId!);
  const othersKey = others.join();
  useEffect(() => {
    if (!othersKey) return;
    const watched = new Set(othersKey.split(","));
    return subscribe((n) => {
      if (n.t === "msg" && watched.has(n.c)) setUnread((u) => new Set(u).add(n.c));
    });
  }, [othersKey]);

  const toggle = (next: boolean) => {
    setOpen(next);
    // Opening the panel shows the chosen agent's conversation: its reply is seen.
    const shown = selected?.conversationId;
    if (next && shown) setUnread((u) => {
      const rest = new Set(u);
      rest.delete(shown);
      return rest;
    });
    try {
      window.localStorage.setItem(PANEL_KEY, next ? "open" : "closed");
    } catch {
      // the choice is only kept for this page
    }
  };
  const choose = (agent: AgentAvailabilityDto) => {
    setChosen(agent.agent);
    if (agent.conversationId) setUnread((u) => {
      const next = new Set(u);
      next.delete(agent.conversationId!);
      return next;
    });
  };
  if (!selected) return null;
  if (!open) {
    return (
      <button className="panel-reopen" onClick={() => toggle(true)} aria-label={`Show the agent panel: ${selected.name}`}>
        {selected.name} · {STATE_WORD[selected.state]}
        {unread.size > 0 && <span className="reply-dot" aria-label="new reply" />}
      </button>
    );
  }
  return (
    <aside className="agent-panel" aria-label="Agents">
      <div className="agent-panel-head">
        <div className="agent-switch" role="tablist" aria-label="Agent">
          {agents.map((a) => (
            <button
              key={a.agent}
              role="tab"
              aria-selected={a.agent === selected.agent}
              className={`agent-tab ${a.state} ${a.agent === selected.agent ? "selected" : ""}`}
              title={a.why ?? `${a.name}: ${STATE_WORD[a.state]}`}
              onClick={() => choose(a)}
            >
              <span className={`agent-state ${a.state}`} aria-hidden />
              {a.name}
              {a.conversationId && unread.has(a.conversationId) && <span className="reply-dot" aria-label="new reply" />}
            </button>
          ))}
        </div>
        <button className="ghost small" onClick={() => toggle(false)} aria-label="Hide the agent panel">
          Hide
        </button>
      </div>
      {selected.conversationId && (selected.state === "available" || selected.state === "read_only") ? (
        <Conversation key={selected.conversationId} id={selected.conversationId} kind="run" />
      ) : (
        <div className="agent-empty">
          <p>
            <strong>{selected.name}</strong> · <span className="muted">{STATE_WORD[selected.state]}</span>
          </p>
          {selected.why && <p className="muted">{selected.why}</p>}
          {selected.agent === "assistant" && (
            <Link className="primary-link" to={`/chat/new?about=${encodeURIComponent(runId)}`}>
              Ask the assistant about this run
            </Link>
          )}
        </div>
      )}
    </aside>
  );
}
