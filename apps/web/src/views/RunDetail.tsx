import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ApprovalDto, ProgressDto, RunDto, RunEventDto, StepDto } from "@orch/contracts";
import { api, post, subscribe } from "../api";
import { useApp } from "../App";

interface RunDetailData {
  run: RunDto;
  steps: StepDto[];
  events: RunEventDto[];
  pending: ApprovalDto[];
}

const FINAL = new Set(["completed", "closed", "cancelled", "failed"]);

export function RunDetail() {
  const { runId } = useParams();
  const { setToggleTarget } = useApp();
  const [data, setData] = useState<RunDetailData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!runId) return;
    try {
      setData(await api<RunDetailData>(`/api/runs/${runId}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [runId]);

  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return subscribe((n) => {
      if (n.t === "run" && n.r === runId) {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 250);
      }
    });
  }, [load, runId]);

  useEffect(() => {
    setToggleTarget(data?.run.conversationId ? `/chat/${data.run.conversationId}` : "/chat");
    return () => setToggleTarget(null);
  }, [data?.run.conversationId, setToggleTarget]);

  // Follow the latest step unless the operator picked one.
  const steps = data?.steps ?? [];
  const latest = steps[steps.length - 1]?.id ?? null;
  const shown = selected ?? latest;

  if (error) return <div className="page error-banner">{error}</div>;
  if (!data) return <div className="page muted">Loading…</div>;
  const { run, events, pending } = data;

  const cancel = async () => {
    if (!confirm("Cancel this run?")) return;
    await post(`/api/runs/${run.id}/cancel`, { reason: "Cancelled from the operator view" }).catch((e) => setError((e as Error).message));
  };

  return (
    <div className="page run-detail">
      <div className="page-head">
        <div>
          <Link to="/ops/runs" className="small">
            ← Runs
          </Link>
          <h1>
            {run.repo}#{run.issueNumber} · {run.title}
          </h1>
          <div className="meta">
            <span className={`badge ${run.state}`}>{run.state.replace(/_/g, " ")}</span>
            <span>Run {run.id}</span>
            <span>Requested by @{run.requester}</span>
            {run.branch && <code>{run.branch}</code>}
            <a href={run.url} target="_blank" rel="noreferrer">
              Issue
            </a>
            {run.prUrl && (
              <a href={run.prUrl} target="_blank" rel="noreferrer">
                Pull request #{run.prNumber}
              </a>
            )}
          </div>
        </div>
        {!FINAL.has(run.state) && (
          <button className="danger" onClick={() => void cancel()}>
            Cancel run
          </button>
        )}
      </div>
      {run.error && <div className="error-banner">{run.error}</div>}
      {pending.length > 0 && (
        <div className="callout">
          Waiting for: {pending.map((p) => p.title).join(", ")} —{" "}
          {run.conversationId && <Link to={`/chat/${run.conversationId}`}>decide in the conversation</Link>}
        </div>
      )}

      <div className="detail-grid">
        <section className="panel">
          <h2>Plan</h2>
          {run.plan ? (
            <>
              <p>{run.plan.summary}</p>
              <ol>
                {run.plan.subtasks.map((s, i) => (
                  <li key={i}>{s.title}</li>
                ))}
              </ol>
            </>
          ) : (
            <p className="muted">No approved plan yet.</p>
          )}
          <h2>Steps</h2>
          <ul className="step-list">
            {steps.map((s) => (
              <li key={s.id}>
                <button className={`step ${s.id === shown ? "active" : ""}`} onClick={() => setSelected(s.id)}>
                  <span className={`badge ${s.state}`}>{s.state}</span>
                  <span className="step-title">{s.title}</span>
                  {s.startedAt && <span className="muted small">{duration(s.startedAt, s.finishedAt)}</span>}
                </button>
                {s.summary && s.id === shown && <p className="muted small step-summary">{s.summary}</p>}
              </li>
            ))}
            {steps.length === 0 && <li className="muted">No steps yet.</li>}
          </ul>
          <h2>Timeline</h2>
          <ol className="timeline-events">
            {events.map((e) => (
              <li key={e.seq}>
                <span className="muted small">{new Date(e.occurredAt).toLocaleTimeString()}</span> <code>{e.type}</code>
                {describe(e)}
              </li>
            ))}
          </ol>
        </section>
        <section className="panel transcript-panel">
          <h2>Transcript {shown && <span className="muted small">· {steps.find((s) => s.id === shown)?.title}</span>}</h2>
          {shown ? <Transcript key={shown} runId={run.id} stepId={shown} /> : <p className="muted">Select a step.</p>}
        </section>
      </div>
    </div>
  );
}

function Transcript({ runId, stepId }: { runId: string; stepId: string }) {
  const [lines, setLines] = useState<ProgressDto[]>([]);
  const last = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const more = await api<ProgressDto[]>(`/api/steps/${stepId}/progress?after=${last.current}`);
    if (more.length) {
      last.current = more[more.length - 1]!.seq;
      setLines((prev) => [...prev, ...more]);
    }
  }, [stepId]);

  useEffect(() => {
    last.current = 0;
    setLines([]);
    void load();
    return subscribe((n) => {
      if (n.t === "progress" && n.r === runId && n.s === stepId && n.q > last.current) void load();
    });
  }, [load, runId, stepId]);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [lines.length]);

  return (
    <div className="transcript" ref={box}>
      {lines.map((l) => (
        <div key={l.seq} className={`line ${l.kind}`}>
          <span className="time">{new Date(l.at).toLocaleTimeString()}</span>
          <span className="kind">{LABEL[l.kind]}</span>
          <span className="text">{l.text}</span>
        </div>
      ))}
      {lines.length === 0 && <p className="muted">Waiting for output…</p>}
    </div>
  );
}

const LABEL: Record<ProgressDto["kind"], string> = { status: "status", message: "agent", tool_start: "tool", tool_end: "result", error: "error" };

function duration(start: string, end: string | null): string {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function describe(e: RunEventDto): string {
  const p = e.payload as Record<string, unknown>;
  if (typeof p.title === "string") return ` — ${p.title}`;
  if (typeof p.state === "string") return ` — ${p.state}`;
  if (typeof p.text === "string") return ` — ${p.text}`;
  if (typeof p.url === "string") return ` — ${p.url}`;
  return "";
}
