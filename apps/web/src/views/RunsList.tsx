import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { TicketDto } from "@orch/contracts";
import { api, post, subscribe } from "../api";
import { useApp } from "../App";
import { OpsNav } from "./Products";

export function RunsList() {
  const { me, setToggleTarget } = useApp();
  const [tickets, setTickets] = useState<TicketDto[]>([]);
  const [repo, setRepo] = useState("");
  const [issue, setIssue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => setTickets(await api<TicketDto[]>("/api/tickets")), []);

  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return subscribe((n) => {
      if (n.t === "run") {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 400);
      }
    });
  }, [load]);

  useEffect(() => {
    setToggleTarget(me?.lastConversationId ? `/chat/${me.lastConversationId}` : "/chat");
    return () => setToggleTarget(null);
  }, [me?.lastConversationId, setToggleTarget]);

  useEffect(() => {
    if (!repo && me?.repos[0]) setRepo(me.repos[0]);
  }, [me, repo]);

  const start = async () => {
    setError(null);
    try {
      await post("/api/runs", { repo, issueNumber: Number(issue) });
      setIssue("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Runs</h1>
          <OpsNav />
        </div>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <select value={repo} onChange={(e) => setRepo(e.target.value)} aria-label="Repository">
            {(me?.repos ?? []).map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <input value={issue} onChange={(e) => setIssue(e.target.value)} placeholder="Issue #" inputMode="numeric" aria-label="Issue number" />
          <button className="primary" disabled={!repo || !Number(issue)}>
            Start run
          </button>
        </form>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <table className="grid tickets">
        <thead>
          <tr>
            <th>Ticket and its runs</th>
            <th>Track</th>
            <th>State</th>
            <th>Requester</th>
            <th>Pull request</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {tickets.flatMap((t) => {
            const newest = t.runs[0]!;
            // A ticket with one run is one row; a ticket that was run again lists every run under it, newest first.
            const single = t.runs.length === 1;
            const ticketRow = (
              <tr key={t.key} className="ticket">
                <td>
                  <Link to={`/ops/runs/${newest.runId}`}>
                    {t.repo}#{t.issueNumber} · {t.title}
                  </Link>
                  {!single && <span className="muted small"> · {t.runs.length} runs</span>}
                  {t.pending > 0 && <span className="badge pending">{t.pending} waiting</span>}
                </td>
                <td>{t.track ? <span className={`badge track ${t.track}`}>{t.track}</span> : <span className="muted">—</span>}</td>
                <td>
                  <span className={`badge ${t.state}`}>{t.state.replace(/_/g, " ")}</span>
                </td>
                <td>@{t.requester}</td>
                <td>{single && newest.prUrl ? <a href={newest.prUrl} target="_blank" rel="noreferrer">#{newest.prNumber}</a> : single ? "—" : ""}</td>
                <td className="muted">{new Date(t.updatedAt).toLocaleString()}</td>
              </tr>
            );
            if (single) return [ticketRow];
            return [
              ticketRow,
              ...t.runs.map((r) => (
                <tr key={r.runId} className="run-of-ticket">
                  <td>
                    <Link to={`/ops/runs/${r.runId}`}>Run {r.ordinal}</Link>
                    <span className="muted small"> · started {new Date(r.createdAt).toLocaleString()}</span>
                  </td>
                  <td>{r.track ? <span className={`badge track ${r.track}`}>{r.track}</span> : <span className="muted">—</span>}</td>
                  <td>
                    <span className={`badge ${r.state}`}>{r.state.replace(/_/g, " ")}</span>
                  </td>
                  <td />
                  <td>{r.prUrl ? <a href={r.prUrl} target="_blank" rel="noreferrer">#{r.prNumber}</a> : "—"}</td>
                  <td className="muted">{new Date(r.updatedAt).toLocaleString()}</td>
                </tr>
              )),
            ];
          })}
          {tickets.length === 0 && (
            <tr>
              <td colSpan={6} className="muted pad">
                No runs yet. Label an issue <code>{me?.triggerLabel ?? "ai-ready"}</code> or start one above.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
