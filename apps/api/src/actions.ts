/**
 * Run actions the requester takes: switching the track (FR-A3) and actions the assistant prepares at the
 * requester's request (AD-45). A prepared action does nothing by itself: it waits on the run's page, names the
 * assistant, quotes the request it acted on, and happens only when the requester confirms it there.
 */
import { newId, sha256 } from "@orch/common";
import { FINAL_RUN_STATES, isFastTrackKey, type OrchestratorCard, type RunDto, type Track, type TrackSwitchDto } from "@orch/contracts";
import {
  createApproval,
  getApproval,
  getRun,
  getRunWorkflowId,
  listPlanVersions,
  listSubtasks,
  patchCard,
  putCard,
  resolveApproval,
  voidApprovals,
  type Db,
} from "@orch/store";
import { signalRun, UserError, type Services } from "./services.js";

/**
 * Whether the requester can switch the track of a run now (FR-A3): fast → guided until the change is published,
 * guided → fast until a plan is approved and only when the work stays in one repository. The workflow checks again.
 */
export async function trackSwitchOf(db: Db, runId: string): Promise<TrackSwitchDto | null> {
  const run = await getRun(db, runId);
  if (!run?.track) return null;
  if (FINAL_RUN_STATES.includes(run.state)) return { current: run.track, to: null, why: "The run has ended." };
  if (run.track === "fast") {
    const change = (await listSubtasks(db, runId)).filter((st) => isFastTrackKey(st.key)).pop();
    const published = !!change && (change.prNumber !== null || ["pr_open", "merged", "closed", "handed_over"].includes(change.state));
    return published ? { current: "fast", to: null, why: "The pull request is open: the track can no longer be switched." } : { current: "fast", to: "guided", why: null };
  }
  const plans = await listPlanVersions(db, runId);
  if (plans.some((v) => v.status === "approved")) return { current: "guided", to: null, why: "The plan is approved: the work stays on the guided track." };
  if (run.state !== "designing" && run.state !== "awaiting_approval") return { current: "guided", to: null, why: null };
  const latest = plans[plans.length - 1];
  const repositories = new Set(
    (latest ? latest.plan.subtasks.map((st) => st.repository) : (run.analysis?.products ?? []).flatMap((p) => p.repositories)).map((r) => r.toLowerCase()),
  );
  if (repositories.size !== 1) {
    return {
      current: "guided",
      to: null,
      why: `The fast track needs the work to stay in one repository; ${latest ? "the current plan" : "the analysis"} involves ${repositories.size}.`,
    };
  }
  return { current: "guided", to: "fast", why: null };
}

export type RunAction = { action: "cancel" } | { action: "switch_track"; track: Track };

const actionCardKey = (runId: string, approvalId: string) => `run:${runId}:action:${approvalId}`;

/** Why an action cannot be taken on a run now, or null when it can. */
async function whyNot(db: Db, run: RunDto, action: RunAction): Promise<string | null> {
  if (FINAL_RUN_STATES.includes(run.state)) return "The run has ended.";
  if (action.action === "cancel") return null;
  const now = await trackSwitchOf(db, run.id);
  if (!now) return "The run has no track yet: the analysis decides it first.";
  if (now.current === action.track) return `The run is already on the ${action.track} track.`;
  if (now.to !== action.track) return now.why ?? "The track cannot be switched now.";
  return null;
}

/**
 * Prepares a cancel or a track switch the requester asked for in a chat with the assistant (AD-45). The request
 * quoted on the card is the requester's own message, taken from the record, not from the model. A newer prepared
 * action of the run replaces an older one that is still waiting.
 */
export async function prepareAction(
  s: Services,
  input: { runId: string; conversationId: string; requested: string; reason?: string } & RunAction,
): Promise<{ approvalId: string } | { error: string }> {
  const run = await getRun(s.db, input.runId);
  if (!run) return { error: `There is no run ${input.runId}.` };
  const action: RunAction = input.action === "cancel" ? { action: "cancel" } : { action: "switch_track", track: input.track };
  const why = await whyNot(s.db, run, action);
  if (why) return { error: why };
  for (const older of await voidApprovals(s.db, run.id, "action")) {
    await patchCard(s.db, actionCardKey(run.id, older), { status: "expired", note: "Replaced by a newer prepared action." });
  }
  const approvalId = newId("apr");
  const hash = sha256(JSON.stringify({ runId: run.id, ...action, track: run.track, approvalId }));
  const requested = input.requested.trim().slice(0, 500);
  await createApproval(s.db, {
    id: approvalId,
    runId: run.id,
    kind: "action",
    payload: { ...action, requested, reason: input.reason ?? null, conversationId: input.conversationId, preparedBy: "assistant" },
    hash,
  });
  const card: OrchestratorCard = {
    type: "prepared_action",
    runId: run.id,
    approvalId,
    hash,
    action: action.action,
    ...(action.action === "switch_track" ? { track: action.track } : {}),
    requested,
    ...(input.reason?.trim() ? { reason: input.reason.trim().slice(0, 500) } : {}),
    conversationId: input.conversationId,
    status: "pending",
  };
  await putCard(s.db, { runId: run.id }, actionCardKey(run.id, approvalId), card);
  return { approvalId };
}

/** The requester confirms or dismisses a prepared action on the run's page; it is checked again before it happens. */
export async function decideAction(s: Services, approvalId: string, decision: "confirm" | "dismiss", hash: string, by: string): Promise<void> {
  const approval = await getApproval(s.db, approvalId);
  if (!approval || approval.kind !== "action") throw new UserError("Unknown action");
  if (approval.state !== "pending") throw new UserError("This action was already confirmed, dismissed or replaced");
  if (hash !== approval.hash) throw new UserError("This action changed since you looked at it; reload and decide again");
  const cardKey = actionCardKey(approval.runId, approval.id);
  if (decision === "dismiss") {
    if (!(await resolveApproval(s.db, approval.id, { decision: "dismiss", by }))) throw new UserError("This action was already decided");
    await patchCard(s.db, cardKey, { status: "dismissed" });
    return;
  }
  const run = await getRun(s.db, approval.runId);
  const workflowId = await getRunWorkflowId(s.db, approval.runId);
  if (!run || !workflowId) throw new UserError("Run not found");
  const payload = approval.payload as { action: "cancel" | "switch_track"; track?: Track; requested: string };
  const action: RunAction = payload.action === "cancel" ? { action: "cancel" } : { action: "switch_track", track: payload.track! };
  const why = await whyNot(s.db, run, action);
  if (why) {
    // The run moved on since the action was prepared: it leaves Needs you, saying why.
    await resolveApproval(s.db, approval.id, { decision: "failed", why, by });
    await patchCard(s.db, cardKey, { status: "failed", note: why });
    throw new UserError(`It can no longer be done: ${why}`);
  }
  if (!(await resolveApproval(s.db, approval.id, { decision: "confirm", by }))) throw new UserError("This action was already decided");
  // The record (the run's timeline and the ticket) says who confirmed it, and that the assistant prepared it.
  const quoted = `prepared by the assistant at their request: "${payload.requested}"`;
  if (action.action === "cancel") await signalRun(s, workflowId, "cancel", { reason: `Cancelled by ${by} (${quoted})` });
  else await signalRun(s, workflowId, "changeTrack", { track: action.track, by, reason: `Confirmed by ${by} (${quoted})` });
  await patchCard(s.db, cardKey, { status: "confirmed" });
}
