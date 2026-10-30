import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { RunDto } from "@orch/contracts";
import { api, post, subscribe } from "../api";
import { useApp } from "../App";

export function RunsList() {
  const { me, setToggleTarget } = useApp();
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [repo, setRepo] = useState("");
  const [issue, setIssue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => setRuns(await api<RunDto[]>("/api/runs")), []);

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
        <h1>Runs</h1>
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
      <table className="grid">
        <thead>
          <tr>
            <th>Issue</th>
            <th>State</th>
            <th>Requester</th>
            <th>Pull request</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>
                <Link to={`/ops/runs/${r.id}`}>
                  {r.repo}#{r.issueNumber} · {r.title}
                </Link>
              </td>
              <td>
                <span className={`badge ${r.state}`}>{r.state.replace(/_/g, " ")}</span>
              </td>
              <td>@{r.requester}</td>
              <td>{r.prUrl ? <a href={r.prUrl} target="_blank" rel="noreferrer">#{r.prNumber}</a> : "—"}</td>
              <td className="muted">{new Date(r.updatedAt).toLocaleString()}</td>
            </tr>
          ))}
          {runs.length === 0 && (
            <tr>
              <td colSpan={5} className="muted pad">
                No runs yet. Label an issue <code>{me?.triggerLabel ?? "ai-ready"}</code> or start one above.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
