import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import type { SubtaskPageDto } from "@orch/contracts";
import { useApp } from "../App";
import { SUBTASK_STATE_LABEL } from "../components/Cards";
import { Activity, AgentPanel, NeedsYou, Sections, SUBTASK_SECTIONS, splitCards, useScrollToHash } from "../components/Page";
import { runPath } from "../components/TicketTree";
import { usePage } from "./RunPage";

/**
 * A sub-task's page (FR-C3): what it is, its progress, its review, the check of its change, what blocks it and
 * its pull request, with the decisions waiting on it at the top.
 */
export function SubtaskPage() {
  const { runId, key } = useParams();
  const { setToggleTarget } = useApp();
  const { data: page, error } = usePage<SubtaskPageDto>(runId && key ? `/api/runs/${runId}/subtasks/${encodeURIComponent(key)}/page` : null, (n) =>
    n.t === "pending" || (n.t === "card" && n.r === runId && n.s === key) || (n.t === "run" && n.r === runId),
  );
  useScrollToHash(!!page);

  useEffect(() => {
    setToggleTarget(runId ? `/ops/runs/${runId}` : "/ops/runs");
    return () => setToggleTarget(null);
  }, [runId, setToggleTarget]);

  if (error && !page) return <section className="page empty-state">{error}</section>;
  if (!page) return <section className="page muted pad">Loading…</section>;
  const { run, subtask: st } = page;
  const { pending, notices, rest } = splitCards(page.cards, page.needsYou);

  return (
    <div className="page-layout">
      <section className="page" aria-label={`Sub-task ${st.index + 1}: ${st.title}`}>
        <header className="record-head">
          <div className="crumbs small muted">
            <Link to={runPath(run.id)}>
              {run.repo}#{run.issueNumber} · {run.title}
            </Link>{" "}
            › Sub-task {st.index + 1}
          </div>
          <h1>{st.title}</h1>
          <div className="badges">
            <span className={`badge ${st.state}`}>{SUBTASK_STATE_LABEL[st.state] ?? st.state.replace(/_/g, " ")}</span>
            {st.repository && <span className="muted small">{st.repository}</span>}
            {st.prUrl && (
              <a className="small" href={st.prUrl} target="_blank" rel="noreferrer">
                pull request #{st.prNumber}
              </a>
            )}
            {st.ticketUrl && (
              <a className="small" href={st.ticketUrl} target="_blank" rel="noreferrer">
                sub-issue #{st.ticketNumber}
              </a>
            )}
          </div>
          <p className="subtask-description">{st.description}</p>
          {st.acceptanceCriteria.length > 0 && (
            <>
              <div className="section-label">Acceptance criteria</div>
              <ul className="criteria">
                {st.acceptanceCriteria.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </>
          )}
          <p className="muted small">
            {st.branch && (
              <>
                Branch <code>{st.branch}</code>
              </>
            )}
            {st.stackedOn && <> · builds on sub-task {st.stackedOn}</>}
          </p>
          {st.warnings.map((w) => (
            <div key={w} className="story-warning small">
              ⚠ {w}
            </div>
          ))}
        </header>
        <NeedsYou runId={run.id} pending={pending} approvals={page.needsYou} />
        <Sections cards={rest} sections={SUBTASK_SECTIONS} />
        {rest.length === 0 && notices.length === 0 && pending.length === 0 && <p className="muted small">Nothing has happened on this sub-task yet: it starts in build order.</p>}
        <Activity notices={notices} />
      </section>
      <AgentPanel key={`${run.id}:${st.key}`} agents={page.agents} runId={run.id} />
    </div>
  );
}
