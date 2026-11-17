import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { RunPageDto } from "@orch/contracts";
import { api, put, subscribe } from "../api";
import { useApp } from "../App";
import { Activity, AgentPanel, NeedsYou, RUN_SECTIONS, Sections, splitCards, useScrollToHash } from "../components/Page";
import { TrackSwitch } from "../components/TrackSwitch";

const label = (state: string) => state.replace(/_/g, " ");

/** Loads a page and reloads it when something on it changes; a burst of changes loads it once. */
export function usePage<T>(path: string | null, changed: (n: Parameters<Parameters<typeof subscribe>[0]>[0]) => boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changedRef = useRef(changed);
  changedRef.current = changed;
  const load = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [path]);
  useEffect(() => {
    setData(null);
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe((n) => {
      if (!changedRef.current(n)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 250);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [load]);
  return { data, error };
}

/**
 * The run's page (FR-C2, AD-44): the header with the track, what needs the requester, the analysis, the plan,
 * the story or the fast track's change, and the activity. Only the orchestrator writes here; the conversation
 * is beside it.
 */
export function RunPage() {
  const { runId } = useParams();
  const { setToggleTarget } = useApp();
  const { data: page, error } = usePage<RunPageDto>(runId ? `/api/runs/${runId}/page` : null, (n) =>
    n.t === "pending" || ((n.t === "card" || n.t === "run") && n.r === runId),
  );
  useScrollToHash(!!page);

  useEffect(() => {
    setToggleTarget(runId ? `/ops/runs/${runId}` : "/ops/runs");
    return () => setToggleTarget(null);
  }, [runId, setToggleTarget]);

  // Opening the user view again comes back here.
  const conversationId = page?.run.conversationId ?? null;
  useEffect(() => {
    if (conversationId) void put("/api/preferences", { lastConversationId: conversationId });
  }, [conversationId]);

  if (error && !page) return <section className="page empty-state">{error}</section>;
  if (!page) return <section className="page muted pad">Loading…</section>;
  const { run } = page;
  const { pending, notices, rest } = splitCards(page.cards, page.needsYou);

  return (
    <div className="page-layout">
      <section className="page" aria-label={`Run ${page.ordinal} of ${run.repo}#${run.issueNumber}`}>
        <header className="record-head">
          <div className="crumbs small muted">
            <a href={run.url} target="_blank" rel="noreferrer">
              {run.repo}#{run.issueNumber}
            </a>{" "}
            · Run {page.ordinal}
            {page.runsOfTicket > 1 ? ` of ${page.runsOfTicket}` : ""} ·{" "}
            <Link to={`/ops/runs/${run.id}`}>run details</Link>
          </div>
          <h1>{run.title}</h1>
          <div className="badges">
            {run.track && <span className={`badge track ${run.track}`}>{run.track} track</span>}
            <span className={`badge ${run.state}`}>{label(run.state)}</span>
            {run.prUrl && (
              <a className="small" href={run.prUrl} target="_blank" rel="noreferrer">
                pull request #{run.prNumber}
              </a>
            )}
          </div>
          {page.track?.to ? (
            <TrackSwitch key={`${page.track.current}-${page.track.to}`} runId={run.id} track={page.track} />
          ) : (
            page.track?.why && <p className="muted small">{page.track.why}</p>
          )}
          {page.design && <p className="small design-note">The design session is open: talk with the architect in the agent panel beside this page.</p>}
          {run.error && <p className="error small">{run.error}</p>}
        </header>
        <NeedsYou runId={run.id} pending={pending} approvals={page.needsYou} subtasks={page.subtasks} />
        <Sections cards={rest} sections={RUN_SECTIONS} />
        <Activity notices={notices} />
      </section>
      <AgentPanel key={run.id} agents={page.agents} runId={run.id} />
    </div>
  );
}
