import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import type { ApprovalDto, OrchestratorCard, PageCardDto, TicketSubtaskDto } from "@orch/contracts";
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
const NOT_A_SECTION = new Set<CardType>(["work_item", "subtask", "run_link", "notice"]);

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

const PANEL_KEY = "orch.conversationPanel";
const narrow = () => typeof window !== "undefined" && window.matchMedia?.("(max-width: 860px)").matches;

/**
 * The conversation beside a page. Until the agent panel (U2) it holds the run's conversation as before: the
 * architect answers while the design session is open, the assistant otherwise.
 */
export function ConversationPanel({ conversationId, kind, who, children }: { conversationId: string; kind: "run" | "subtask"; who: string; children?: ReactNode }) {
  const [open, setOpen] = useState(() => {
    if (narrow()) return false;
    try {
      return window.localStorage.getItem(PANEL_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const toggle = (next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(PANEL_KEY, next ? "open" : "closed");
    } catch {
      // the choice is only kept for this page
    }
  };
  if (!open) {
    return (
      <button className="panel-reopen" onClick={() => toggle(true)} aria-label="Show the conversation">
        Conversation · {who}
      </button>
    );
  }
  return (
    <aside className="agent-panel" aria-label="Conversation">
      <div className="agent-panel-head">
        <div>
          <strong>Conversation</strong> <span className="agent-chip">{who}</span>
        </div>
        <button className="ghost small" onClick={() => toggle(false)} aria-label="Hide the conversation">
          Hide
        </button>
      </div>
      {children}
      <Conversation key={conversationId} id={conversationId} kind={kind} />
    </aside>
  );
}
