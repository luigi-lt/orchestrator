import { useState } from "react";
import { Link } from "react-router-dom";
import type { HandoffPlan, OrchestratorCard, PlanVersionDto, TrackedFinding, Verification } from "@orch/contracts";
import { api, post } from "../api";

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
    case "subtask":
      return <SubtaskCard card={card} />;
    case "review":
      return <ReviewCard card={card} />;
    case "findings":
      return <FindingsCard card={card} />;
    case "limits":
      return <LimitsCard card={card} />;
    case "change":
      return <ChangeCard card={card} />;
    case "dependents":
      return <DependentsCard card={card} />;
    case "story":
      return <StoryCard card={card} />;
    case "pull_request":
      return <PullRequestCard card={card} />;
    case "notice":
      return <div className={`card notice ${card.level}`}>{card.text}</div>;
    default: {
      // A card type without a view fails the build here; anything that is not an orchestrator card draws nothing.
      const unknown: never = card;
      void unknown;
      return null;
    }
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

const ICON = { pending: "○", running: "◐", done: "●", failed: "✕", skipped: "–" } as const;

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

const CHANGE_WORD = { added: "Added", removed: "Removed", changed: "Changed" } as const;

/** The plan's sub-tasks in the order they are built: each after the ones it depends on (plan order otherwise). */
function inBuildOrder(plan: HandoffPlan): HandoffPlan["subtasks"] {
  const ordered: HandoffPlan["subtasks"] = [];
  const placed = new Set<string>();
  const known = new Set(plan.subtasks.map((st) => st.key));
  while (ordered.length < plan.subtasks.length) {
    const next = plan.subtasks.find((st) => !placed.has(st.key) && st.dependsOn.every((d) => placed.has(d) || !known.has(d))) ?? plan.subtasks.find((st) => !placed.has(st.key))!;
    placed.add(next.key);
    ordered.push(next);
  }
  return ordered;
}

function PlanBody({ plan, products }: { plan: HandoffPlan; products: Record<string, string> }) {
  // Sub-tasks grouped by product and numbered in build order, so "after 1" means what it says.
  const ordered = inBuildOrder(plan);
  const numberOf = (key: string) => ordered.findIndex((st) => st.key === key) + 1;
  const groups = [...new Set(ordered.map((st) => st.product))];
  const titleOf = (key: string) => plan.subtasks.find((st) => st.key === key)?.title ?? key;
  return (
    <>
      <p className="card-title plain">{plan.goal}</p>
      <div className="section-label">Approach</div>
      <p>{plan.approach}</p>
      <ListBlock title="Constraints" items={plan.constraints} />
      {plan.contracts.length > 0 && (
        <>
          <div className="section-label">Contracts between products</div>
          <ul>
            {plan.contracts.map((ct) => (
              <li key={ct.name}>
                <strong>{ct.name}</strong>: {ct.description}
                <div className="muted small">
                  Provided by: {ct.providers.map(titleOf).join("; ")} · used by: {ct.consumers.map(titleOf).join("; ")}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="section-label">Sub-tasks</div>
      {groups.map((product) => (
        <div key={product} className="plan-product">
          {groups.length > 1 && <div className="plan-product-name">{products[product] ?? product}</div>}
          <ol className="subtasks">
            {ordered
              .filter((st) => st.product === product)
              .map((st) => (
                <li key={st.key} value={numberOf(st.key)}>
                  <details>
                    <summary>
                      {st.title} <span className="badge size">{st.size}</span>{" "}
                      <span className="muted small">
                        {st.repository}
                        {st.dependsOn.length > 0 && ` · after ${st.dependsOn.map(numberOf).filter(Boolean).join(", ")}`}
                      </span>
                    </summary>
                    <p>{st.description}</p>
                    <ul className="criteria">
                      {st.acceptanceCriteria.map((ac, j) => (
                        <li key={j}>{ac}</li>
                      ))}
                    </ul>
                    {st.dependsOn.length > 0 && <p className="muted small">After: {st.dependsOn.map(titleOf).join("; ")}</p>}
                    {st.likelyFiles.length > 0 && <p className="muted small">Likely files: {st.likelyFiles.join(", ")}</p>}
                  </details>
                </li>
              ))}
          </ol>
        </div>
      ))}
      <details>
        <summary className="muted small">Out of scope, risks, assumptions, definition of done, rollout</summary>
        <ListBlock title="Out of scope" items={plan.outOfScope} />
        <ListBlock title="Risks" items={plan.risks} />
        <ListBlock title="Assumptions" items={plan.assumptions} />
        <ListBlock title="Definition of done" items={plan.definitionOfDone} />
        {plan.rollout && (
          <>
            <div className="section-label">Rollout</div>
            <p>{plan.rollout}</p>
          </>
        )}
      </details>
    </>
  );
}

const PLAN_STATUS = {
  draft: "The architect is still shaping this plan with you. Ask for changes in the conversation.",
  proposed: "The architect put this version up for your approval. To change it, ask in the conversation; a new version replaces this one.",
  approved: "You approved this version. It is what the agents build.",
  expired: "The run ended before this plan was approved.",
} as const;

/**
 * The hand-off plan: written by the architect agent, validated and rendered by the orchestrator.
 * It is read-only. Changes are asked for in the conversation; approval is this card's button, bound to the version shown.
 */
function PlanCard({ card }: { card: CardOf<"plan"> }) {
  const { busy, error, run } = useDecision();
  const [versions, setVersions] = useState<PlanVersionDto[] | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const older = shown !== null && shown !== card.version ? versions?.find((v) => v.version === shown) : undefined;
  const view = older ?? { version: card.version, plan: card.plan, changes: card.changes, promptedBy: card.promptedBy };
  const browse = async (to: number) => {
    const list = versions ?? (await api<PlanVersionDto[]>(`/api/runs/${card.runId}/plans`));
    setVersions(list);
    setShown(to);
  };
  const canApprove = card.status === "proposed" && card.approvalId && !older;
  return (
    <div className={`card plan ${card.status === "proposed" ? "needs-action" : ""}`}>
      <div className="card-head">
        <span className="kicker">Hand-off plan · written by the architect agent{card.status === "proposed" ? " · your approval is needed" : ""}</span>
        <span className="badges">
          <span className="version-nav">
            <button className="ghost small" disabled={view.version <= 1} onClick={() => void browse(view.version - 1)} aria-label="Earlier version">
              ‹
            </button>
            Version {view.version} of {card.version}
            <button className="ghost small" disabled={view.version >= card.version} onClick={() => void browse(view.version + 1)} aria-label="Later version">
              ›
            </button>
          </span>
          <StatusBadge status={older ? "superseded" : card.status} />
        </span>
      </div>
      <p className="muted small">{older ? "An earlier version, kept for reference." : PLAN_STATUS[card.status]}</p>
      {view.changes.length > 0 && (
        <div className="plan-changes">
          <div className="section-label">What changed since version {view.version - 1}</div>
          {view.promptedBy && <p className="muted small">You asked: "{view.promptedBy}"</p>}
          <ul>
            {view.changes.map((ch, i) => (
              <li key={i} className={`change ${ch.kind}`}>
                {CHANGE_WORD[ch.kind]} {ch.what === "subtask" ? "sub-task" : ch.what === "contract" ? "contract" : ""} <strong>{ch.title}</strong>
                {ch.fields?.length ? <span className="muted small"> ({ch.fields.join(", ")})</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      <PlanBody plan={view.plan} products={card.products} />
      {canApprove && (
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => void run(() => post(`/api/approvals/${card.approvalId}/plan`, { decision: "approve", hash: card.hash }))}>
            Approve version {card.version}
          </button>
          <span className="muted small">Typing "approve" in the conversation approves nothing.</span>
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

function SubtaskCard({ card }: { card: CardOf<"subtask"> }) {
  return (
    <div className="card">
      <div className="card-head">
        <span className="kicker">
          Sub-task {card.index + 1} of {card.total} · {card.repository}
        </span>
        <Link className="small" to={`/ops/runs/${card.runId}`}>
          Run details
        </Link>
      </div>
      <div className="card-title">{card.title}</div>
      <p>{card.description}</p>
      <ListBlock title="Acceptance criteria" items={card.acceptanceCriteria} />
      <p className="muted small">
        Branch <code>{card.branch}</code>
      </p>
    </div>
  );
}

export function FindingList({ findings }: { findings: TrackedFinding[] }) {
  return (
    <ul className="findings">
      {findings.map((f) => (
        <li key={f.id}>
          <span className={`badge severity ${f.severity}`}>{f.severity}</span> <strong>{f.title}</strong>
          {f.file && (
            <code>
              {f.file}
              {f.line ? `:${f.line}` : ""}
            </code>
          )}
          <div>{f.explanation}</div>
          {f.suggestion && <div className="muted small">Suggested fix: {f.suggestion}</div>}
        </li>
      ))}
    </ul>
  );
}

export function Checks({ verification }: { verification: Verification | null }) {
  if (!verification) return null;
  if (!verification.commands.length) return <p className="muted small">The product has no build or test command configured.</p>;
  return (
    <ul className="checks">
      {verification.commands.map((c) => (
        <li key={c.name}>
          <span className={`badge ${c.exitCode === 0 ? "succeeded" : "failed"}`}>{c.exitCode === 0 ? "passed" : "failed"}</span> {c.name} <code>{c.command}</code>{" "}
          <span className="muted small">{Math.max(1, Math.round(c.durationMs / 1000))}s</span>
          {c.exitCode !== 0 && c.output && <pre className="command-output">{c.output}</pre>}
        </li>
      ))}
    </ul>
  );
}

const REVIEW_STATUS = {
  clean: "No blocking or major finding is open.",
  fixing: "The implementer is fixing the blocking and major findings; the change is reviewed again afterwards.",
  needs_decision: "Findings are still open after the fix rounds: your decision is needed below.",
  accepted_with_findings: "You decided to go on with findings open.",
} as const;

/** Written by the reviewer agent and validated by the orchestrator; what happens next follows from the severities. */
function ReviewCard({ card }: { card: CardOf<"review"> }) {
  const { review } = card;
  const blocking = review.open.filter((f) => f.severity !== "minor");
  const minor = review.open.filter((f) => f.severity === "minor");
  return (
    <div className={`card review ${card.status === "needs_decision" ? "needs-action" : ""}`}>
      <div className="card-head">
        <span className="kicker">AI review · written by the reviewer agent · round {review.rounds}</span>
        <span className={`badge ${card.status === "clean" ? "approved" : card.status === "fixing" ? "running" : "pending"}`}>
          {card.status === "clean" ? "clean" : `${blocking.length} to fix`}
        </span>
      </div>
      <p className="card-title plain">{review.summary}</p>
      <p className="muted small">{REVIEW_STATUS[card.status]}</p>
      {blocking.length > 0 && (
        <>
          <div className="section-label">Open findings</div>
          <FindingList findings={blocking} />
        </>
      )}
      {review.resolved.length > 0 && (
        <>
          <div className="section-label">Fixed during the review</div>
          <ul>
            {review.resolved.map((f) => (
              <li key={f.id}>
                <span className={`badge severity ${f.severity}`}>{f.severity}</span> {f.title}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="section-label">Checks run on the change</div>
      <Checks verification={card.verification} />
      {(minor.length > 0 || review.criteria.length > 0) && (
        <details>
          <summary className="muted small">Acceptance criteria and minor notes</summary>
          {review.criteria.length > 0 && (
            <ul className="criteria-check">
              {review.criteria.map((c, i) => (
                <li key={i}>
                  {c.met ? "✓" : "✗"} {c.criterion}
                  {c.note && <span className="muted small"> — {c.note}</span>}
                </li>
              ))}
            </ul>
          )}
          {minor.length > 0 && <FindingList findings={minor} />}
        </details>
      )}
    </div>
  );
}

const FINDINGS_DECISION = { open: "pull request opened anyway", retry: "another fix round", take_over: "branch taken over", cancel: "cancelled" } as const;

function FindingsCard({ card }: { card: CardOf<"findings"> }) {
  const { busy, error, run } = useDecision();
  const [mode, setMode] = useState<"view" | "retry">("view");
  const [guidance, setGuidance] = useState("");
  const pending = card.status === "pending";
  const decide = (decision: "open" | "retry" | "take_over" | "cancel") =>
    run(() => post(`/api/approvals/${card.approvalId}/findings`, { decision, guidance: decision === "retry" ? guidance : undefined, hash: card.hash }));
  return (
    <div className={`card ${pending ? "needs-action" : ""}`}>
      <div className="card-head">
        <span className="kicker">
          Review findings still open after {card.fixRounds} fix round(s){pending ? " · your decision is needed" : ""}
        </span>
        <StatusBadge status={card.status === "pending" || card.status === "expired" ? card.status : FINDINGS_DECISION[card.status]} />
      </div>
      <FindingList findings={card.findings} />
      {card.guidance && card.status === "retry" && <p className="muted small">Your guidance: {card.guidance}</p>}
      {pending && mode === "view" && (
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => setMode("retry")}>
            Guide and retry
          </button>
          <button disabled={busy} onClick={() => void decide("open")} title="The pull request opens with these findings listed in its description">
            Open the pull request anyway
          </button>
          <button disabled={busy} onClick={() => void decide("take_over")} title="The branch is pushed without a pull request, for you to continue">
            Take over the branch
          </button>
          <button className="danger ghost" disabled={busy} onClick={() => void decide("cancel")}>
            Cancel
          </button>
        </div>
      )}
      {pending && mode === "retry" && (
        <div className="actions column">
          <textarea value={guidance} onChange={(e) => setGuidance(e.target.value)} rows={3} placeholder="What should the agent do differently to resolve these findings?" />
          <div className="actions">
            <button className="primary" disabled={busy || !guidance.trim()} onClick={() => void decide("retry")}>
              Send guidance and retry
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

const LIMITS_DECISION = { continue: "continued on the fast track", guided: "switched to the guided track", cancel: "cancelled" } as const;

function LimitsCard({ card }: { card: CardOf<"limits"> }) {
  const { busy, error, run } = useDecision();
  const pending = card.status === "pending";
  const decide = (decision: "continue" | "guided" | "cancel") => run(() => post(`/api/approvals/${card.approvalId}/limits`, { decision, hash: card.hash }));
  return (
    <div className={`card ${pending ? "needs-action" : ""}`}>
      <div className="card-head">
        <span className="kicker">Bigger than the fast track allows{pending ? " · your decision is needed" : ""}</span>
        <StatusBadge status={card.status === "pending" || card.status === "expired" ? card.status : LIMITS_DECISION[card.status]} />
      </div>
      <p className="muted small">The analysis expected a small change. The change that was built is beyond the fast-track limits:</p>
      <ul>
        {card.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <details>
        <summary className="muted small">{card.files.length} file(s) changed</summary>
        <ul>
          {card.files.map((f) => (
            <li key={f}>
              <code>{f}</code>
            </li>
          ))}
        </ul>
      </details>
      {pending && (
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => void decide("continue")} title="Open the pull request with this change">
            Continue on the fast track
          </button>
          <button disabled={busy} onClick={() => void decide("guided")} title="Set this change aside and agree a plan first">
            Switch to the guided track
          </button>
          <button className="danger ghost" disabled={busy} onClick={() => void decide("cancel")}>
            Cancel
          </button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

const CHANGE_DECISION = { approved: "approved", changes: "changes requested", dropped: "dropped" } as const;

/**
 * The requester's check of a sub-task's change before its pull request opens. Everything on the card comes from the
 * orchestrator's records: the implementer's summary and evidence are claims, the reviewer's judgment is an agent's,
 * the files and the checks were computed by the orchestrator. The code itself is read in the pull request.
 */
function ChangeCard({ card }: { card: CardOf<"change"> }) {
  const { busy, error, run } = useDecision();
  const [feedback, setFeedback] = useState("");
  const pending = card.status === "pending";
  const decide = (decision: "approve" | "changes" | "drop") =>
    run(() => post(`/api/approvals/${card.approvalId}/change`, { decision, hash: card.hash, feedback: decision === "changes" ? feedback : undefined }));
  const added = card.files.reduce((n, f) => n + (f.added ?? 0), 0);
  const removed = card.files.reduce((n, f) => n + (f.removed ?? 0), 0);
  return (
    <div className={`card change ${pending ? "needs-action" : ""}`}>
      <div className="card-head">
        <span className="kicker">
          Check of the change{card.round > 0 ? ` · after your request for changes (${card.round})` : ""}
          {pending ? " · your decision is needed" : ""}
        </span>
        <StatusBadge status={card.status === "pending" || card.status === "expired" ? card.status : CHANGE_DECISION[card.status]} />
      </div>
      <p className="muted small">
        Nothing is pushed yet. Your approval opens the pull request with exactly this commit: <code>{card.hash.slice(0, 10)}</code> on <code>{card.branch}</code> in {card.repository}.
      </p>
      <div className="section-label">What the implementer agent says it did</div>
      <p>{card.summary}</p>
      {card.buildsOn.length > 0 && <p className="muted small">Builds on the approved change of: {card.buildsOn.join("; ")}</p>}
      <div className="section-label">Acceptance criteria</div>
      {card.criteria.length === 0 && <p className="muted small">The sub-task has no acceptance criteria.</p>}
      <ul className="criteria-evidence">
        {card.criteria.map((c, i) => (
          <li key={i} className={c.met === false ? "unmet" : c.met ? "met" : ""}>
            <div>
              <span className="mark" aria-hidden>
                {c.met === null ? "?" : c.met ? "✓" : "✕"}
              </span>
              <strong>{c.criterion}</strong>
            </div>
            <div className="small">
              <span className="muted">Implementer's evidence: </span>
              {c.evidence ?? <em className="muted">none given</em>}
            </div>
            <div className="small">
              <span className="muted">Reviewer agent: </span>
              {c.met === null ? <em className="muted">not judged</em> : c.met ? "met" : "not met"}
              {c.note ? ` — ${c.note}` : ""}
            </div>
          </li>
        ))}
      </ul>
      <div className="section-label">
        Files changed: {card.files.length} <span className="lines added">+{added}</span> <span className="lines removed">−{removed}</span>
      </div>
      <ul className="changed-files">
        {card.files.map((f) => (
          <li key={f.path}>
            <code>{f.path}</code>
            {f.added === null ? <span className="muted small">binary</span> : (
              <span className="small">
                <span className="lines added">+{f.added}</span> <span className="lines removed">−{f.removed}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="muted small">The code itself is not shown here. You read it in the pull request, which opens when you approve.</p>
      <Checks verification={card.verification} />
      <div className="section-label">AI review</div>
      <p>{card.review.summary}</p>
      <p className="muted small">
        {card.review.rounds} review round(s), {card.review.fixRounds} fix round(s) · {card.review.resolved} finding(s) fixed ·{" "}
        {card.review.blocking ? <strong className="error">{card.review.blocking} blocking or major finding(s) still open</strong> : "no blocking or major finding open"}
        {card.review.minor ? ` · ${card.review.minor} minor note(s)` : ""}. The review card above has the details.
      </p>
      {card.status === "changes" && card.feedback && <blockquote className="answer">You asked: {card.feedback}</blockquote>}
      {pending && (
        <div className="actions column">
          <div className="actions">
            <button className="primary" disabled={busy} onClick={() => void decide("approve")}>
              Approve and open the pull request
            </button>
            <button className="danger ghost" disabled={busy} onClick={() => void decide("drop")} title="Close this sub-task as not done; nothing is pushed">
              Drop the sub-task
            </button>
          </div>
          <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3} placeholder="Or say what should change; the implementer does another round and the change is reviewed again" />
          <button disabled={busy || !feedback.trim()} onClick={() => void decide("changes")}>
            Request changes
          </button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

const NOT_DELIVERED = { dropped: "was dropped", closed: "had its pull request closed without merging", handed_over: "was taken over by you" } as const;
const DEPENDENTS_DECISION = { drop: "dropped too", build: "built without it", cancel: "run cancelled" } as const;

/** A sub-task was not delivered and sub-tasks that have not started depend on it. */
function DependentsCard({ card }: { card: CardOf<"dependents"> }) {
  const { busy, error, run } = useDecision();
  const pending = card.status === "pending";
  const decide = (decision: "drop" | "build" | "cancel") => run(() => post(`/api/approvals/${card.approvalId}/dependents`, { decision, hash: card.hash }));
  const how = NOT_DELIVERED[card.subtask.state as keyof typeof NOT_DELIVERED] ?? "was not delivered";
  return (
    <div className={`card ${pending ? "needs-action" : ""}`}>
      <div className="card-head">
        <span className="kicker">Sub-tasks that depend on one that was not delivered{pending ? " · your decision is needed" : ""}</span>
        <StatusBadge status={card.status === "pending" || card.status === "expired" ? card.status : DEPENDENTS_DECISION[card.status]} />
      </div>
      <p>
        <strong>{card.subtask.title}</strong> {how}. These sub-tasks build on it and have not started:
      </p>
      <ul>
        {card.dependents.map((d) => (
          <li key={d.key}>{d.title}</li>
        ))}
      </ul>
      {pending && (
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => void decide("drop")} title="Close them as not done">
            Drop them too
          </button>
          <button disabled={busy} onClick={() => void decide("build")} title="They are built without the change they depended on">
            Build them anyway
          </button>
          <button className="danger ghost" disabled={busy} onClick={() => void decide("cancel")}>
            Cancel the run
          </button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** What a sub-task state means for the requester, in the words of the story view (FR-R7). */
export const SUBTASK_STATE_LABEL: Record<string, string> = {
  planned: "planned",
  implementing: "in progress",
  reviewing: "AI review",
  awaiting_decision: "awaiting your decision",
  awaiting_check: "awaiting your check",
  publishing: "publishing",
  pr_open: "pull request open",
  merged: "merged",
  closed: "pull request closed",
  handed_over: "taken over",
  dropped: "dropped",
  cancelled: "cancelled",
  failed: "failed",
};

/** The story view: every sub-task of the plan, grouped by product, in build order, with its state, links and merge order. */
function StoryCard({ card }: { card: CardOf<"story"> }) {
  const groups = [...new Set(card.subtasks.map((st) => st.product ?? ""))];
  const numberOf = (key: string) => (card.subtasks.find((st) => st.key === key)?.index ?? -1) + 1;
  const done = card.subtasks.filter((st) => st.state === "merged").length;
  const dropped = card.subtasks.filter((st) => st.state === "dropped").length;
  return (
    <div className="card story-card">
      <div className="card-head">
        <span className="kicker">
          Story ·{" "}
          {dropped === card.subtasks.length
            ? `all ${dropped} sub-task(s) dropped`
            : `${done} of ${card.subtasks.length - dropped} sub-task(s) merged${dropped ? ` · ${dropped} dropped` : ""}`}
        </span>
        <Link className="small" to={`/ops/runs/${card.runId}`}>
          Run details
        </Link>
      </div>
      {groups.map((product) => (
        <div key={product} className="plan-product">
          {groups.length > 1 && <div className="plan-product-name">{card.products[product] ?? (product || "Other")}</div>}
          <ol className="story">
            {card.subtasks
              .filter((st) => (st.product ?? "") === product)
              .map((st) => (
                <li key={st.key} value={st.index + 1}>
                  <div>
                    <span className={`badge ${st.state}`}>{SUBTASK_STATE_LABEL[st.state] ?? st.state.replace(/_/g, " ")}</span>{" "}
                    {st.conversationId ? <Link to={`/chat/${st.conversationId}`}>{st.title}</Link> : st.title}
                  </div>
                  <div className="muted small story-meta">
                    {st.repository}
                    {st.dependsOn.length > 0 && ` · merge after ${st.dependsOn.map(numberOf).filter(Boolean).join(", ")}`}
                    {st.stackedOn && st.state !== "merged" && ` · its branch builds on ${numberOf(st.stackedOn)}`}
                    {st.prUrl && (
                      <>
                        {" · "}
                        <a href={st.prUrl} target="_blank" rel="noreferrer">
                          pull request #{st.prNumber}
                        </a>
                      </>
                    )}
                    {st.ticketUrl && (
                      <>
                        {" · "}
                        <a href={st.ticketUrl} target="_blank" rel="noreferrer">
                          sub-issue #{st.ticketNumber}
                        </a>
                      </>
                    )}
                  </div>
                  {st.warnings.map((w) => (
                    <div key={w} className="story-warning small">
                      ⚠ {w}
                    </div>
                  ))}
                </li>
              ))}
          </ol>
        </div>
      ))}
      <p className="muted small">
        Sub-tasks are built one at a time. Each starts when the one before it passed your check and its pull request is open. The story is complete when every pull request is merged.
      </p>
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
