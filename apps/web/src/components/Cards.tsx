import { useState } from "react";
import { Link } from "react-router-dom";
import type { OrchestratorCard } from "@orch/contracts";
import { post } from "../api";

type CardOf<T extends OrchestratorCard["type"]> = Extract<OrchestratorCard, { type: T }>;

export function OrchestratorCardView({ card }: { card: OrchestratorCard }) {
  switch (card.type) {
    case "work_item":
      return <WorkItemCard card={card} />;
    case "run_link":
      return <RunLinkCard card={card} />;
    case "analysis":
      return <AnalysisCard card={card} />;
    case "progress":
      return <ProgressCard card={card} />;
    case "plan":
      return <PlanCard card={card} />;
    case "questions":
      return <QuestionsCard card={card} />;
    case "risk":
      return <RiskCard card={card} />;
    case "pull_request":
      return <PullRequestCard card={card} />;
    case "notice":
      return <div className={`card notice ${card.level}`}>{card.text}</div>;
  }
}

function useDecision() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{status.replace(/_/g, " ")}</span>;
}

function WorkItemCard({ card }: { card: CardOf<"work_item"> }) {
  return (
    <div className="card">
      <div className="card-head">
        <span className="kicker">Work item</span>
        <Link className="small" to={`/ops/runs/${card.runId}`}>
          Run details
        </Link>
      </div>
      <a href={card.url} target="_blank" rel="noreferrer" className="card-title">
        {card.repo}#{card.number} · {card.title}
      </a>
    </div>
  );
}

function RunLinkCard({ card }: { card: CardOf<"run_link"> }) {
  return (
    <div className="card">
      <div className="card-head">
        <span className="kicker">Run started · it has its own conversation</span>
        <Link className="small" to={`/ops/runs/${card.runId}`}>
          Run details
        </Link>
      </div>
      <Link to={`/chat/${card.conversationId}`} className="card-title">
        Open the conversation of {card.repo}#{card.number} · {card.title}
      </Link>
      <p className="muted small">The analysis, questions and approvals for this work appear there.</p>
    </div>
  );
}

const TRACK_HELP = {
  fast: "Fast track: the change is built and a pull request opens, with no stops before it.",
  guided: "Guided track: the plan is agreed with you before anything is built.",
} as const;

/** Text in this card was written by the analyst agent and validated by the orchestrator; the track was decided by the orchestrator's rules. */
function AnalysisCard({ card }: { card: CardOf<"analysis"> }) {
  const overruled = card.proposedTrack !== card.track;
  return (
    <div className="card analysis">
      <div className="card-head">
        <span className="kicker">Analysis · written by the analyst agent</span>
        <span className="badges">
          <span className="badge size">Size {card.size}</span>
          <span className={`badge track ${card.track}`}>{card.track} track</span>
        </span>
      </div>
      <p className="card-title plain">{card.understanding}</p>
      <div className="section-label">Products involved</div>
      <ul className="products">
        {card.products.map((p) => (
          <li key={p.id}>
            <strong>{p.name}</strong> <span className="muted small">{p.repositories.join(", ")}</span>
            <div>{p.changes}</div>
            <div className="muted small">Why: {p.reason}</div>
          </li>
        ))}
      </ul>
      <div className="section-label">Why the {card.track} track</div>
      <p className="muted small">
        {TRACK_HELP[card.track]}
        {overruled && ` The analyst proposed ${card.proposedTrack}; the orchestrator's rules chose ${card.track}.`}
      </p>
      <ul>
        {card.trackReasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
      {card.track === "fast" && card.approach && (
        <>
          <div className="section-label">Intended approach</div>
          <p>{card.approach}</p>
        </>
      )}
      <details>
        <summary className="muted small">Acceptance criteria, risks and assumptions</summary>
        <ListBlock title="Acceptance criteria" items={card.acceptanceCriteria} />
        <ListBlock title="Risks" items={card.risks} />
        <ListBlock title="Assumptions" items={card.assumptions} />
        {card.track === "guided" && card.approach && (
          <>
            <div className="section-label">Analyst's suggested approach</div>
            <p>{card.approach}</p>
          </>
        )}
      </details>
    </div>
  );
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <>
      <div className="section-label">{title}</div>
      <ul>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </>
  );
}

const ICON = { pending: "○", running: "◐", done: "●", failed: "✕" } as const;

function ProgressCard({ card }: { card: CardOf<"progress"> }) {
  return (
    <div className="card">
      <div className="card-head">
        <span className="kicker">Progress</span>
        <StatusBadge status={card.state} />
      </div>
      <div className="card-title">{card.headline}</div>
      <ol className="progress-steps">
        {card.steps.map((s) => (
          <li key={s.title} className={s.status}>
            <span className="icon" aria-hidden>
              {ICON[s.status]}
            </span>
            {s.title}
          </li>
        ))}
      </ol>
    </div>
  );
}

function PlanCard({ card }: { card: CardOf<"plan"> }) {
  const { busy, error, run } = useDecision();
  const [mode, setMode] = useState<"view" | "changes">("view");
  const [feedback, setFeedback] = useState("");
  const decide = (decision: "approve" | "changes" | "reject") =>
    run(() => post(`/api/approvals/${card.approvalId}/plan`, { decision, feedback: decision === "changes" ? feedback : undefined, hash: card.hash }));
  const pending = card.status === "pending";
  return (
    <div className={`card plan ${pending ? "needs-action" : ""}`}>
      <div className="card-head">
        <span className="kicker">Plan {pending ? "· your approval is needed" : ""}</span>
        <StatusBadge status={card.status} />
      </div>
      <p className="card-title">{card.plan.summary}</p>
      <ol className="subtasks">
        {card.plan.subtasks.map((s, i) => (
          <li key={i}>
            <details>
              <summary>{s.title}</summary>
              <p>{s.description}</p>
              {s.acceptanceCriteria.length > 0 && (
                <ul className="criteria">
                  {s.acceptanceCriteria.map((c, j) => (
                    <li key={j}>{c}</li>
                  ))}
                </ul>
              )}
            </details>
          </li>
        ))}
      </ol>
      {card.feedback && card.status === "changes_requested" && <p className="muted small">Requested changes: {card.feedback}</p>}
      {pending && mode === "view" && (
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => void decide("approve")}>
            Approve
          </button>
          <button disabled={busy} onClick={() => setMode("changes")}>
            Request changes
          </button>
          <button className="danger ghost" disabled={busy} onClick={() => void decide("reject")}>
            Reject
          </button>
        </div>
      )}
      {pending && mode === "changes" && (
        <div className="actions column">
          <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3} placeholder="What should the plan do differently?" />
          <div className="actions">
            <button className="primary" disabled={busy || !feedback.trim()} onClick={() => void decide("changes")}>
              Send feedback
            </button>
            <button className="ghost" onClick={() => setMode("view")}>
              Back
            </button>
          </div>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function QuestionsCard({ card }: { card: CardOf<"questions"> }) {
  const { busy, error, run } = useDecision();
  const [answer, setAnswer] = useState("");
  const pending = card.status === "pending";
  return (
    <div className={`card ${pending ? "needs-action" : ""}`}>
      <div className="card-head">
        <span className="kicker">Questions from the agent</span>
        <StatusBadge status={card.status} />
      </div>
      <ol>
        {card.questions.map((q, i) => (
          <li key={i}>{q}</li>
        ))}
      </ol>
      {card.answer && <blockquote className="answer">{card.answer}</blockquote>}
      {pending && (
        <div className="actions column">
          <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={4} placeholder="Answer here, or reply on the GitHub issue" />
          <button className="primary" disabled={busy || !answer.trim()} onClick={() => void run(() => post(`/api/approvals/${card.approvalId}/answer`, { answer }))}>
            Send answers
          </button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function RiskCard({ card }: { card: CardOf<"risk"> }) {
  const { busy, error, run } = useDecision();
  const pending = card.status === "pending";
  const decide = (decision: "approve" | "reject") => run(() => post(`/api/approvals/${card.approvalId}/risk`, { decision, hash: card.hash }));
  return (
    <div className={`card risk ${pending ? "needs-action" : ""}`}>
      <div className="card-head">
        <span className="kicker">High-risk change · approval needed before pushing</span>
        <StatusBadge status={card.status} />
      </div>
      <ul>
        {card.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <div className="muted small">Files: {card.files.join(", ")}</div>
      {pending && (
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => void decide("approve")}>
            Approve and push
          </button>
          <button className="danger ghost" disabled={busy} onClick={() => void decide("reject")}>
            Reject
          </button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function PullRequestCard({ card }: { card: CardOf<"pull_request"> }) {
  return (
    <div className="card">
      <div className="card-head">
        <span className="kicker">Pull request</span>
        <StatusBadge status={card.state} />
      </div>
      <a href={card.url} target="_blank" rel="noreferrer" className="card-title">
        #{card.number} · {card.title}
      </a>
      {card.state === "open" && <p className="muted small">Review and merge it on GitHub; the run finishes when it is merged.</p>}
    </div>
  );
}
