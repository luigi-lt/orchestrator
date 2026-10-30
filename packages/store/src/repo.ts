import { newId } from "@orch/common";
import type {
  ApprovalDto,
  Component,
  ConversationDto,
  MessageDto,
  MessageRole,
  OrchestratorCard,
  Plan,
  ProgressDto,
  ProgressEvent,
  RunDto,
  RunEventDto,
  RunState,
  StepDto,
  StepKind,
  StepResult,
  StepState,
} from "@orch/contracts";
import { type Db, type Queryable, notify, withTx } from "./db.js";

const iso = (d: Date | string | null): string | null => (d == null ? null : new Date(d).toISOString());

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

interface RunRow {
  id: string;
  workflow_id: string;
  repo_owner: string;
  repo_name: string;
  issue_number: number;
  title: string;
  url: string;
  requester: string;
  state: RunState;
  conversation_id: string | null;
  branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  plan: Plan | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

const toRun = (r: RunRow): RunDto => ({
  id: r.id,
  repo: `${r.repo_owner}/${r.repo_name}`,
  issueNumber: r.issue_number,
  title: r.title,
  url: r.url,
  requester: r.requester,
  state: r.state,
  conversationId: r.conversation_id,
  branch: r.branch,
  prNumber: r.pr_number,
  prUrl: r.pr_url,
  plan: r.plan,
  error: r.error,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

export interface NewRun {
  id: string;
  workflowId: string;
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  title: string;
  url: string;
  requester: string;
  conversationId: string | null;
}

export async function insertRun(db: Queryable, run: NewRun): Promise<void> {
  await db.query(
    `insert into runs (id, workflow_id, repo_owner, repo_name, issue_number, title, url, requester, state, conversation_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'intake',$9) on conflict (id) do nothing`,
    [run.id, run.workflowId, run.repoOwner, run.repoName, run.issueNumber, run.title, run.url, run.requester, run.conversationId],
  );
}

export async function getRun(db: Queryable, id: string): Promise<RunDto | null> {
  const { rows } = await db.query<RunRow>("select * from runs where id = $1", [id]);
  return rows[0] ? toRun(rows[0]) : null;
}

export async function getRunWorkflowId(db: Queryable, id: string): Promise<string | null> {
  const { rows } = await db.query<{ workflow_id: string }>("select workflow_id from runs where id = $1", [id]);
  return rows[0]?.workflow_id ?? null;
}

/** The most recent run started under a workflow ID (a ticket can have several runs over time). */
export async function findLatestRunByWorkflowId(db: Queryable, workflowId: string): Promise<RunDto | null> {
  const { rows } = await db.query<RunRow>("select * from runs where workflow_id = $1 order by created_at desc limit 1", [workflowId]);
  return rows[0] ? toRun(rows[0]) : null;
}

export async function findLatestCardByPrefix(db: Queryable, prefix: string): Promise<OrchestratorCard | null> {
  const { rows } = await db.query<{ components: OrchestratorCard[] }>(
    "select components from messages where card_key like $1 order by created_at desc limit 1",
    [`${prefix}%`],
  );
  return rows[0]?.components[0] ?? null;
}

export async function listRuns(db: Queryable, limit = 100): Promise<RunDto[]> {
  const { rows } = await db.query<RunRow>("select * from runs order by updated_at desc limit $1", [limit]);
  return rows.map(toRun);
}

export interface RunPatch {
  state?: RunState;
  conversationId?: string;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  plan?: Plan;
  error?: string | null;
}

const RUN_PATCH_COLUMNS: Record<keyof RunPatch, string> = {
  state: "state",
  conversationId: "conversation_id",
  branch: "branch",
  prNumber: "pr_number",
  prUrl: "pr_url",
  plan: "plan",
  error: "error",
};

export async function updateRun(db: Queryable, id: string, patch: RunPatch): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const [key, column] of Object.entries(RUN_PATCH_COLUMNS) as [keyof RunPatch, string][]) {
    if (patch[key] === undefined) continue;
    values.push(key === "plan" ? JSON.stringify(patch[key]) : patch[key]);
    sets.push(`${column} = $${values.length}`);
  }
  if (!sets.length) return;
  await db.query(`update runs set ${sets.join(", ")}, updated_at = now() where id = $1`, values);
}

// ---------------------------------------------------------------------------
// Run events (append-only; projection updated in the same transaction)
// ---------------------------------------------------------------------------

export interface NewRunEvent {
  runId: string;
  seq: number;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
  patch?: RunPatch;
}

/** Idempotent: primary key (run_id, seq) turns retries into no-ops. */
export async function appendRunEvent(db: Db, e: NewRunEvent): Promise<boolean> {
  return withTx(db, async (tx) => {
    const res = await tx.query(
      `insert into run_events (run_id, seq, type, actor, payload) values ($1,$2,$3,$4,$5) on conflict do nothing`,
      [e.runId, e.seq, e.type, e.actor, JSON.stringify(e.payload)],
    );
    const inserted = (res.rowCount ?? 0) > 0;
    if (inserted && e.patch) await updateRun(tx, e.runId, e.patch);
    else if (inserted) await tx.query("update runs set updated_at = now() where id = $1", [e.runId]);
    await notify(tx, { t: "run", r: e.runId });
    return inserted;
  });
}

export async function listRunEvents(db: Queryable, runId: string): Promise<RunEventDto[]> {
  const { rows } = await db.query<{ run_id: string; seq: number; type: string; actor: string; payload: Record<string, unknown>; occurred_at: Date }>(
    "select * from run_events where run_id = $1 order by seq",
    [runId],
  );
  return rows.map((r) => ({ runId: r.run_id, seq: r.seq, type: r.type, actor: r.actor, payload: r.payload, occurredAt: iso(r.occurred_at)! }));
}

// ---------------------------------------------------------------------------
// Steps and progress
// ---------------------------------------------------------------------------

interface StepRow {
  id: string;
  run_id: string;
  kind: StepKind;
  title: string;
  subtask_index: number | null;
  state: StepState;
  token_hash: string | null;
  summary: string | null;
  result: StepResult | null;
  error: string | null;
  last_seen_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

const toStep = (r: StepRow): StepDto => ({
  id: r.id,
  runId: r.run_id,
  kind: r.kind,
  title: r.title,
  subtaskIndex: r.subtask_index,
  state: r.state,
  summary: r.summary,
  error: r.error,
  startedAt: iso(r.started_at),
  finishedAt: iso(r.finished_at),
});

export interface StepRecord extends StepDto {
  tokenHash: string | null;
  result: StepResult | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export async function upsertStep(
  db: Queryable,
  s: { id: string; runId: string; kind: StepKind; title: string; subtaskIndex: number | null },
): Promise<void> {
  await db.query(
    `insert into steps (id, run_id, kind, title, subtask_index, state) values ($1,$2,$3,$4,$5,'pending') on conflict (id) do nothing`,
    [s.id, s.runId, s.kind, s.title, s.subtaskIndex],
  );
  await notify(db, { t: "run", r: s.runId });
}

export async function getStep(db: Queryable, id: string): Promise<StepRecord | null> {
  const { rows } = await db.query<StepRow>("select * from steps where id = $1", [id]);
  const r = rows[0];
  if (!r) return null;
  return { ...toStep(r), tokenHash: r.token_hash, result: r.result, lastSeenAt: iso(r.last_seen_at), createdAt: iso(r.created_at)! };
}

export async function listSteps(db: Queryable, runId: string): Promise<StepDto[]> {
  const { rows } = await db.query<StepRow>("select * from steps where run_id = $1 order by created_at", [runId]);
  return rows.map(toStep);
}

export async function setStepToken(db: Queryable, id: string, hash: string): Promise<void> {
  await db.query("update steps set token_hash = $2 where id = $1", [id, hash]);
}

export async function markStepRunning(db: Queryable, id: string): Promise<void> {
  const { rows } = await db.query<{ run_id: string }>(
    `update steps set state = 'running', started_at = coalesce(started_at, now()), last_seen_at = now()
     where id = $1 and state in ('pending','running') returning run_id`,
    [id],
  );
  if (rows[0]) await notify(db, { t: "run", r: rows[0].run_id });
}

export async function touchStep(db: Queryable, id: string): Promise<void> {
  await db.query("update steps set last_seen_at = now() where id = $1", [id]);
}

/** Records the final result once; later calls are ignored. Returns false if the step was already final. */
export async function completeStep(db: Queryable, id: string, result: StepResult): Promise<boolean> {
  const { rows } = await db.query<{ run_id: string }>(
    `update steps set state = $2, summary = $3, result = $4, error = $5, finished_at = now(), last_seen_at = now()
     where id = $1 and state in ('pending','running') returning run_id`,
    [id, result.status, result.summary, JSON.stringify(result), result.error ?? null],
  );
  if (rows[0]) await notify(db, { t: "run", r: rows[0].run_id });
  return rows.length > 0;
}

export async function failStepIfActive(db: Queryable, id: string, error: string): Promise<void> {
  await completeStep(db, id, { status: "failed", summary: error, error });
}

export async function insertProgress(db: Queryable, stepId: string, runId: string, events: ProgressEvent[]): Promise<number> {
  let last = 0;
  for (const e of events) {
    const { rows } = await db.query<{ seq: string }>(
      "insert into step_progress (step_id, kind, text, data, at) values ($1,$2,$3,$4,coalesce($5::timestamptz, now())) returning seq",
      [stepId, e.kind, e.text, e.data ? JSON.stringify(e.data) : null, e.at ?? null],
    );
    last = Number(rows[0]!.seq);
  }
  if (last) await notify(db, { t: "progress", r: runId, s: stepId, q: last });
  return last;
}

export async function listProgress(db: Queryable, stepId: string, afterSeq = 0, limit = 1000): Promise<ProgressDto[]> {
  const { rows } = await db.query<{ seq: string; step_id: string; kind: ProgressDto["kind"]; text: string; at: Date }>(
    "select seq, step_id, kind, text, at from step_progress where step_id = $1 and seq > $2 order by seq limit $3",
    [stepId, afterSeq, limit],
  );
  return rows.map((r) => ({ seq: Number(r.seq), stepId: r.step_id, kind: r.kind, text: r.text, at: iso(r.at)! }));
}

// ---------------------------------------------------------------------------
// Approvals (plan approvals, clarifying questions, high-risk changes)
// ---------------------------------------------------------------------------

export type ApprovalKind = "plan" | "questions" | "risk";

export interface ApprovalRecord {
  id: string;
  runId: string;
  kind: ApprovalKind;
  state: "pending" | "resolved" | "expired";
  payload: Record<string, unknown>;
  hash: string;
  decision: Record<string, unknown> | null;
  createdAt: string;
}

export async function createApproval(
  db: Queryable,
  a: { id: string; runId: string; kind: ApprovalKind; payload: Record<string, unknown>; hash: string },
): Promise<void> {
  await db.query(
    `insert into approvals (id, run_id, kind, state, payload, hash) values ($1,$2,$3,'pending',$4,$5) on conflict (id) do nothing`,
    [a.id, a.runId, a.kind, JSON.stringify(a.payload), a.hash],
  );
  await notify(db, { t: "pending" });
}

export async function getApproval(db: Queryable, id: string): Promise<ApprovalRecord | null> {
  const { rows } = await db.query<{
    id: string;
    run_id: string;
    kind: ApprovalKind;
    state: ApprovalRecord["state"];
    payload: Record<string, unknown>;
    hash: string;
    decision: Record<string, unknown> | null;
    created_at: Date;
  }>("select * from approvals where id = $1", [id]);
  const r = rows[0];
  return r
    ? { id: r.id, runId: r.run_id, kind: r.kind, state: r.state, payload: r.payload, hash: r.hash, decision: r.decision, createdAt: iso(r.created_at)! }
    : null;
}

/** Atomically resolves a pending approval. Returns false if it was no longer pending. */
export async function resolveApproval(db: Queryable, id: string, decision: Record<string, unknown>): Promise<boolean> {
  const res = await db.query(
    "update approvals set state = 'resolved', decision = $2, resolved_at = now() where id = $1 and state = 'pending'",
    [id, JSON.stringify(decision)],
  );
  if ((res.rowCount ?? 0) > 0) await notify(db, { t: "pending" });
  return (res.rowCount ?? 0) > 0;
}

export async function expireApprovalsForRun(db: Queryable, runId: string): Promise<void> {
  const res = await db.query("update approvals set state = 'expired', resolved_at = now() where run_id = $1 and state = 'pending'", [runId]);
  if ((res.rowCount ?? 0) > 0) await notify(db, { t: "pending" });
}

export async function listPendingApprovals(db: Queryable): Promise<ApprovalDto[]> {
  const { rows } = await db.query<{ id: string; run_id: string; kind: ApprovalDto["kind"]; created_at: Date; conversation_id: string | null; title: string; issue_number: number }>(
    `select a.id, a.run_id, a.kind, a.created_at, r.conversation_id, r.title, r.issue_number
     from approvals a join runs r on r.id = a.run_id where a.state = 'pending' order by a.created_at`,
  );
  const label = { plan: "Approve plan", questions: "Answer questions", risk: "Approve high-risk change" } as const;
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    kind: r.kind,
    state: "pending",
    conversationId: r.conversation_id,
    title: `${label[r.kind]} · #${r.issue_number} ${r.title}`,
    createdAt: iso(r.created_at)!,
  }));
}

// ---------------------------------------------------------------------------
// Conversations and messages
// ---------------------------------------------------------------------------

export async function createConversation(db: Queryable, title: string, focusedRunId: string | null = null): Promise<string> {
  const id = newId("conv");
  await db.query("insert into conversations (id, title, focused_run_id) values ($1,$2,$3)", [id, title, focusedRunId]);
  return id;
}

export async function getConversation(db: Queryable, id: string): Promise<ConversationDto | null> {
  const list = await listConversations(db, id);
  return list[0] ?? null;
}

export async function listConversations(db: Queryable, onlyId?: string): Promise<ConversationDto[]> {
  const { rows } = await db.query<{ id: string; title: string; focused_run_id: string | null; updated_at: Date; pending: string }>(
    `select c.id, c.title, c.focused_run_id, c.updated_at,
       (select count(*) from approvals a join runs r on r.id = a.run_id where r.conversation_id = c.id and a.state = 'pending') as pending
     from conversations c ${onlyId ? "where c.id = $1" : ""} order by c.updated_at desc limit 200`,
    onlyId ? [onlyId] : [],
  );
  return rows.map((r) => ({ id: r.id, title: r.title, focusedRunId: r.focused_run_id, updatedAt: iso(r.updated_at)!, pending: Number(r.pending) }));
}

export async function setFocusedRun(db: Queryable, conversationId: string, runId: string): Promise<void> {
  await db.query("update conversations set focused_run_id = $2, updated_at = now() where id = $1", [conversationId, runId]);
}

export async function renameConversation(db: Queryable, conversationId: string, title: string): Promise<void> {
  await db.query("update conversations set title = $2 where id = $1", [conversationId, title]);
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  text: string | null;
  components: Component[];
  version: string;
  created_at: Date;
  updated_at: Date;
}

const toMessage = (r: MessageRow): MessageDto => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  text: r.text,
  components: r.components,
  version: Number(r.version),
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

export async function insertMessage(
  db: Queryable,
  m: { conversationId: string; role: MessageRole; text?: string | null; components?: Component[] },
): Promise<MessageDto> {
  const { rows } = await db.query<MessageRow>(
    `insert into messages (id, conversation_id, role, text, components) values ($1,$2,$3,$4,$5) returning *`,
    [newId("msg"), m.conversationId, m.role, m.text ?? null, JSON.stringify(m.components ?? [])],
  );
  await db.query("update conversations set updated_at = now() where id = $1", [m.conversationId]);
  const msg = toMessage(rows[0]!);
  await notify(db, { t: "msg", c: msg.conversationId, v: msg.version });
  return msg;
}

/** Posts an orchestrator card, or updates it in place when a card with the same key exists. */
export async function upsertCard(db: Queryable, conversationId: string, cardKey: string, card: OrchestratorCard): Promise<MessageDto> {
  const { rows } = await db.query<MessageRow>(
    `insert into messages (id, conversation_id, role, components, card_key) values ($1,$2,'orchestrator',$3,$4)
     on conflict (card_key) do update set components = excluded.components, version = nextval('message_version_seq'), updated_at = now()
     returning *`,
    [newId("msg"), conversationId, JSON.stringify([card]), cardKey],
  );
  await db.query("update conversations set updated_at = now() where id = $1", [conversationId]);
  const msg = toMessage(rows[0]!);
  await notify(db, { t: "msg", c: msg.conversationId, v: msg.version });
  return msg;
}

export async function getCard(db: Queryable, cardKey: string): Promise<OrchestratorCard | null> {
  const { rows } = await db.query<{ components: OrchestratorCard[] }>("select components from messages where card_key = $1", [cardKey]);
  return rows[0]?.components[0] ?? null;
}

export async function listMessages(db: Queryable, conversationId: string, afterVersion = 0): Promise<MessageDto[]> {
  const { rows } = await db.query<MessageRow>(
    afterVersion > 0
      ? "select * from messages where conversation_id = $1 and version > $2 order by created_at, version"
      : "select * from messages where conversation_id = $1 and $2::bigint >= 0 order by created_at, version",
    [conversationId, afterVersion],
  );
  return rows.map(toMessage);
}

// ---------------------------------------------------------------------------
// Preferences and poll state
// ---------------------------------------------------------------------------

export async function getPreference<T>(db: Queryable, key: string): Promise<T | null> {
  const { rows } = await db.query<{ value: T }>("select value from preferences where key = $1", [key]);
  return rows[0]?.value ?? null;
}

export async function setPreference(db: Queryable, key: string, value: unknown): Promise<void> {
  await db.query(
    "insert into preferences (key, value) values ($1,$2) on conflict (key) do update set value = excluded.value",
    [key, JSON.stringify(value)],
  );
}

export async function getPollEtag(db: Queryable, key: string): Promise<string | null> {
  const { rows } = await db.query<{ etag: string | null }>("select etag from poll_state where key = $1", [key]);
  return rows[0]?.etag ?? null;
}

export async function setPollEtag(db: Queryable, key: string, etag: string | null): Promise<void> {
  await db.query(
    "insert into poll_state (key, etag, updated_at) values ($1,$2,now()) on conflict (key) do update set etag = excluded.etag, updated_at = now()",
    [key, etag],
  );
}
