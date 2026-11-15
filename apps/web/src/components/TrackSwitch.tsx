import { useState } from "react";
import type { Track, TrackSwitchDto } from "@orch/contracts";
import { post } from "../api";

export const TRACK_TEXT: Record<Track, string> = {
  fast: "Fast track: the change is built, reviewed by an agent and opened as a pull request, with no stops before it.",
  guided: "Guided track: you agree the plan with the architect agent, and check each change before its pull request opens.",
};

/**
 * Switching the track of a run (FR-A3), in the header of the run's page while it is allowed. The orchestrator
 * checks again when the request arrives: the work may have moved on meanwhile.
 */
export function TrackSwitch({ runId, track }: { runId: string; track: TrackSwitchDto }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const to = track.to;
  if (!to) return null;
  if (state === "sent") return <div className="track-switch muted small">Switching to the {to} track…</div>;
  const label = to === "guided" ? "Switch to the guided track" : "Switch to the fast track";
  const submit = async () => {
    setState("busy");
    setError(null);
    try {
      await post(`/api/runs/${runId}/track`, { track: to, reason: reason.trim() || undefined });
      setState("sent");
    } catch (e) {
      setError((e as Error).message);
      setState("idle");
    }
  };
  return (
    <div className="track-switch" role="group" aria-label="Track">
      {!open ? (
        <>
          <span className="muted small">{TRACK_TEXT[track.current ?? (to === "guided" ? "fast" : "guided")]}</span>
          <button className="ghost small" onClick={() => setOpen(true)}>
            {label}
          </button>
        </>
      ) : (
        <>
          <span className="small">
            {to === "guided"
              ? "The change being built is set aside, nothing is pushed, and a design session with the architect agent starts from the analysis."
              : "The design session ends; the current plan, if there is one, becomes a single change built with no stops before the pull request."}
          </span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? (optional, recorded on the ticket)" maxLength={500} aria-label="Why" />
          <button className="primary small" disabled={state === "busy"} onClick={() => void submit()}>
            {label}
          </button>
          <button className="ghost small" onClick={() => setOpen(false)}>
            Keep the {track.current} track
          </button>
        </>
      )}
      {error && <span className="error small">{error}</span>}
    </div>
  );
}
