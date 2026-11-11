import { newId } from "@orch/common";
import type {
  Analysis,
  ApprovalDto,
  ApprovalKind,
  BriefRepository,
  Catalog,
  Component,
  ConversationDto,
  MessageAuthor,
  MessageDto,
  MessageRole,
  OrchestratorCard,
  Plan,
  ProgressDto,
  ProgressEvent,
  RepositoryRequestDto,
  RepositoryRequestState,
  RunDto,
  RunEventDto,
  RunState,
  StepDto,
  StepKind,
  StepResult,
  StepState,
  SubtaskDto,
  SubtaskReview,
  SubtaskState,
  TicketDto,
  TicketSubtaskDto,
  Track,
  Verification,
} from "@orch/contracts";
import { groupTickets } from "@orch/contracts";
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
  track: Track | null;
  track_reasons: string[];
  home_product: string | null;
  products: string[];
  analysis: Analysis | null;
  catalog_hash: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

const toRun = (r: RunRow): RunDto => ({
  id: r.id,
  ticketKey: r.workflow_id,
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
  track: r.track,
  trackReasons: r.track_reasons ?? [],
  homeProduct: r.home_product,
  products: r.products ?? [],
  analysis: r.analysis,
  catalogHash: r.catalog_hash,
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
  labels: string[];
}

export async function insertRun(db: Queryable, run: NewRun): Promise<void> {
  await db.query(
    `insert into runs (id, workflow_id, repo_owner, repo_name, issue_number, title, url, requester, state, labels)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'intake',$9) on conflict (id) do nothing`,
    [run.id, run.workflowId, run.repoOwner, run.repoName, run.issueNumber, run.title, run.url, run.requester, JSON.stringify(run.labels)],
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

/**
 * Tickets with all their runs, most recently active tickets first: the top of the conversation
 * hierarchy (ticket, run, later sub-task). `onlyKey` returns one ticket.
 */
export async function listTickets(db: Queryable, limit = 200, onlyKey?: string): Promise<TicketDto[]> {
  const { rows } = await db.query<RunRow>(
    onlyKey
      ? "select * from runs where workflow_id = $2 and $1::int > 0"
      : `select * from runs where workflow_id in (
           select workflow_id from (select workflow_id, max(updated_at) as latest from runs group by workflow_id order by latest desc limit $1) recent)`,
    onlyKey ? [limit, onlyKey] : [limit],
  );
  const pending = await db.query<{ run_id: string; subtask_key: string | null; n: string }>(
    "select run_id, subtask_key, count(*) as n from approvals where state = 'pending' group by run_id, subtask_key",
  );
  const pendingByRun: Record<string, number> = {};
  const pendingBySubtask: Record<string, number> = {};
  for (const p of pending.rows) {
    pendingByRun[p.run_id] = (pendingByRun[p.run_id] ?? 0) + Number(p.n);
    if (p.subtask_key) pendingBySubtask[`${p.run_id}:${p.subtask_key}`] = Number(p.n);
  }
  // Sub-tasks with their own conversation form the third level of the hierarchy (AD-43).
  const subtasks = await db.query<{ run_id: string; key: string; idx: number; title: string; state: SubtaskState; conversation_id: string }>(
    "select run_id, key, idx, title, state, conversation_id from subtasks where conversation_id is not null and run_id = any($1) order by idx",
    [rows.map((r) => r.id)],
  );
  const subtasksByRun: Record<string, TicketSubtaskDto[]> = {};
  for (const st of subtasks.rows) {
    (subtasksByRun[st.run_id] ??= []).push({
      key: st.key,
      index: st.idx,
      title: st.title,
      state: st.state,
      conversationId: st.conversation_id,
      pending: pendingBySubtask[`${st.run_id}:${st.key}`] ?? 0,
    });
  }
  return groupTickets(rows.map(toRun), pendingByRun, subtasksByRun);
}

export interface RunPatch {
  state?: RunState;
  conversationId?: string;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  plan?: Plan;
  track?: Track;
  trackReasons?: string[];
  homeProduct?: string;
  products?: string[];
  analysis?: Analysis;
  catalogHash?: string;
  error?: string | null;
}

const JSON_RUN_COLUMNS = new Set<keyof RunPatch>(["plan", "trackReasons", "products", "analysis"]);

const RUN_PATCH_COLUMNS: Record<keyof RunPatch, string> = {
  state: "state",
  conversationId: "conversation_id",
  branch: "branch",
  prNumber: "pr_number",
  prUrl: "pr_url",
  plan: "plan",
  track: "track",
  trackReasons: "track_reasons",
  homeProduct: "home_product",
  products: "products",
  analysis: "analysis",
  catalogHash: "catalog_hash",
  error: "error",
};

export async function updateRun(db: Queryable, id: string, patch: RunPatch): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const [key, column] of Object.entries(RUN_PATCH_COLUMNS) as [keyof RunPatch, string][]) {
    if (patch[key] === undefined) continue;
    values.push(JSON_RUN_COLUMNS.has(key) ? JSON.stringify(patch[key]) : patch[key]);
    sets.push(`${column} = $${values.length}`);
  }
  if (!sets.length) return;
  await db.query(`update runs set ${sets.join(", ")}, updated_at = now() where id = $1`, values);
}

/** Marks runs of a workflow that can no longer continue (e.g. after an upgrade) as failed. Returns the affected runs. */
export async function failActiveRunsOfWorkflow(db: Queryable, workflowId: string, error: string): Promise<RunDto[]> {
  const { rows } = await db.query<RunRow>(
    `update runs set state = 'failed', error = $2, updated_at = now()
     where workflow_id = $1 and state not in ('completed','closed','cancelled','failed') returning *`,
    [workflowId, error],
  );
  for (const r of rows) await notify(db, { t: "run", r: r.id });
  return rows.map(toRun);
}

// ---------------------------------------------------------------------------
// Product catalog versions (a run pins the version it started with, AD-30)
// ---------------------------------------------------------------------------

export async function saveCatalogVersion(db: Queryable, catalog: Catalog): Promise<void> {
  await db.query("insert into catalog_versions (hash, content) values ($1,$2) on conflict (hash) do nothing", [catalog.hash, JSON.stringify(catalog)]);
}

export async function getCatalogVersion(db: Queryable, hash: string): Promise<Catalog | null> {
  const { rows } = await db.query<{ content: Catalog }>("select content from catalog_versions where hash = $1", [hash]);
  return rows[0]?.content ?? null;
}

/** The catalog a run pinned at start. */
export async function getCatalogForRun(db: Queryable, runId: string): Promise<Catalog | null> {
  const { rows } = await db.query<{ content: Catalog }>(
    "select c.content from runs r join catalog_versions c on c.hash = r.catalog_hash where r.id = $1",
    [runId],
  );
  return rows[0]?.content ?? null;
}

// ---------------------------------------------------------------------------
// Run events (append-only; projection updated in the same transaction)
// ---------------------------------------------------------------------------

export interface NewRunEvent {
  runId: string;
  /** Unique per run and writer (the run workflow or one of its sub-task workflows); a retry with the same key is a no-op. */
  key: string;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
  patch?: RunPatch;
}

/**
 * Appends an event and applies its projection patch in one transaction. The run row is locked, so events
 * of the run workflow and of its sub-task workflows get a gapless sequence in the order they are written.
 */
export async function appendRunEvent(db: Db, e: NewRunEvent): Promise<boolean> {
  return withTx(db, async (tx) => {
    await tx.query("select 1 from runs where id = $1 for update", [e.runId]);
    const res = await tx.query(
      `insert into run_events (run_id, seq, type, actor, payload, event_key)
       select $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5 from run_events where run_id = $1
       on conflict do nothing`,
      [e.runId, e.type, e.actor, JSON.stringify(e.payload), e.key],
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
  s: { id: string; runId: string; kind: StepKind; title: string; subtaskIndex: number | null; subtaskKey?: string | null; round?: number },
): Promise<void> {
  await db.query(
    `insert into steps (id, run_id, kind, title, subtask_index, subtask_key, round, state) values ($1,$2,$3,$4,$5,$6,$7,'pending') on conflict (id) do nothing`,
    [s.id, s.runId, s.kind, s.title, s.subtaskIndex, s.subtaskKey ?? null, s.round ?? 0],
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
// Sub-tasks: one branch, one pull request, one review each (FR-B1)
// ---------------------------------------------------------------------------

interface SubtaskRow {
  run_id: string;
  key: string;
  idx: number;
  title: string;
  description: string;
  acceptance_criteria: string[];
  state: SubtaskState;
  product: string | null;
  repository: string | null;
  branch: string | null;
  base_commit: string | null;
  head_commit: string | null;
  pr_number: number | null;
  pr_url: string | null;
  conversation_id: string | null;
  review: SubtaskReview | null;
  verification: Verification | null;
  fix_rounds: number;
  created_at: Date;
  updated_at: Date;
}

const toSubtask = (r: SubtaskRow): SubtaskDto => ({
  runId: r.run_id,
  key: r.key,
  index: r.idx,
  title: r.title,
  description: r.description,
  acceptanceCriteria: r.acceptance_criteria,
  state: r.state,
  product: r.product,
  repository: r.repository,
  branch: r.branch,
  baseCommit: r.base_commit,
  headCommit: r.head_commit,
  prNumber: r.pr_number,
  prUrl: r.pr_url,
  conversationId: r.conversation_id,
  review: r.review,
  verification: r.verification,
  fixRounds: r.fix_rounds,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

export interface NewSubtask {
  runId: string;
  key: string;
  index: number;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  state: SubtaskState;
  product?: string | null;
  repository?: string | null;
  branch?: string | null;
}

export async function insertSubtask(db: Queryable, st: NewSubtask): Promise<void> {
  await db.query(
    `insert into subtasks (run_id, key, idx, title, description, acceptance_criteria, state, product, repository, branch)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (run_id, key) do nothing`,
    [st.runId, st.key, st.index, st.title, st.description, JSON.stringify(st.acceptanceCriteria), st.state, st.product ?? null, st.repository ?? null, st.branch ?? null],
  );
  await notify(db, { t: "run", r: st.runId });
}

export interface SubtaskPatch {
  state?: SubtaskState;
  branch?: string;
  baseCommit?: string;
  headCommit?: string;
  prNumber?: number;
  prUrl?: string;
  conversationId?: string;
  review?: SubtaskReview;
  verification?: Verification;
  fixRounds?: number;
}

const SUBTASK_PATCH_COLUMNS: Record<keyof SubtaskPatch, string> = {
  state: "state",
  branch: "branch",
  baseCommit: "base_commit",
  headCommit: "head_commit",
  prNumber: "pr_number",
  prUrl: "pr_url",
  conversationId: "conversation_id",
  review: "review",
  verification: "verification",
  fixRounds: "fix_rounds",
};

export async function updateSubtask(db: Queryable, runId: string, key: string, patch: SubtaskPatch): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [runId, key];
  for (const [field, column] of Object.entries(SUBTASK_PATCH_COLUMNS) as [keyof SubtaskPatch, string][]) {
    if (patch[field] === undefined) continue;
    values.push(field === "review" || field === "verification" ? JSON.stringify(patch[field]) : patch[field]);
    sets.push(`${column} = $${values.length}`);
  }
  if (!sets.length) return;
  await db.query(`update subtasks set ${sets.join(", ")}, updated_at = now() where run_id = $1 and key = $2`, values);
  await notify(db, { t: "run", r: runId });
}

export async function getSubtask(db: Queryable, runId: string, key: string): Promise<SubtaskDto | null> {
  const { rows } = await db.query<SubtaskRow>("select * from subtasks where run_id = $1 and key = $2", [runId, key]);
  return rows[0] ? toSubtask(rows[0]) : null;
}

export async function listSubtasks(db: Queryable, runId: string): Promise<SubtaskDto[]> {
  const { rows } = await db.query<SubtaskRow>("select * from subtasks where run_id = $1 order by idx, created_at", [runId]);
  return rows.map(toSubtask);
}

// ---------------------------------------------------------------------------
// Repositories requested by an agent during a step (AD-37)
// ---------------------------------------------------------------------------

interface RepositoryRequestRow {
  id: string;
  step_id: string;
  repository: string;
  state: RepositoryRequestState;
  entry: BriefRepository | null;
  error: string | null;
}

const toRepositoryRequest = (r: RepositoryRequestRow): RepositoryRequestDto => ({
  id: r.id,
  stepId: r.step_id,
  repository: r.repository,
  state: r.state,
  entry: r.entry,
  error: r.error,
});

/** Records a request once per step and repository; asking again returns the existing request. */
export async function createRepositoryRequest(
  db: Queryable,
  req: { stepId: string; repository: string; reason: string | null; state?: RepositoryRequestState; error?: string },
): Promise<RepositoryRequestDto> {
  await db.query(
    `insert into repository_requests (id, step_id, repository, reason, state, error) values ($1,$2,$3,$4,$5,$6)
     on conflict (step_id, repository) do nothing`,
    [newId("rrq"), req.stepId, req.repository, req.reason, req.state ?? "pending", req.error ?? null],
  );
  const { rows } = await db.query<RepositoryRequestRow>("select * from repository_requests where step_id = $1 and repository = $2", [req.stepId, req.repository]);
  return toRepositoryRequest(rows[0]!);
}

export async function getRepositoryRequest(db: Queryable, id: string): Promise<RepositoryRequestDto | null> {
  const { rows } = await db.query<RepositoryRequestRow>("select * from repository_requests where id = $1", [id]);
  return rows[0] ? toRepositoryRequest(rows[0]) : null;
}

export async function listRepositoryRequests(db: Queryable, stepId: string, state?: RepositoryRequestState): Promise<RepositoryRequestDto[]> {
  const { rows } = await db.query<RepositoryRequestRow>(
    `select * from repository_requests where step_id = $1 ${state ? "and state = $2" : ""} order by created_at`,
    state ? [stepId, state] : [stepId],
  );
  return rows.map(toRepositoryRequest);
}

export async function resolveRepositoryRequest(
  db: Queryable,
  id: string,
  outcome: { state: "ready"; entry: BriefRepository } | { state: "denied" | "failed"; error: string },
): Promise<void> {
  await db.query("update repository_requests set state = $2, entry = $3, error = $4 where id = $1 and state = 'pending'", [
    id,
    outcome.state,
    outcome.state === "ready" ? JSON.stringify(outcome.entry) : null,
    outcome.state === "ready" ? null : outcome.error,
  ]);
}

// ---------------------------------------------------------------------------
// Approvals (plan approvals, clarifying questions, high-risk changes)
// ---------------------------------------------------------------------------

export type { ApprovalKind };

export interface ApprovalRecord {
  id: string;
  runId: string;
  kind: ApprovalKind;
  state: "pending" | "resolved" | "expired";
  payload: Record<string, unknown>;
  hash: string;
  decision: Record<string, unknown> | null;
  /** The workflow to signal with the decision: the run's, or a sub-task's. Null means the run's. */
  workflowId: string | null;
  /** The conversation that holds the decision card. Null means the run's. */
  conversationId: string | null;
  subtaskKey: string | null;
  createdAt: string;
}

export async function createApproval(
  db: Queryable,
  a: {
    id: string;
    runId: string;
    kind: ApprovalKind;
    payload: Record<string, unknown>;
    hash: string;
    workflowId?: string | null;
    conversationId?: string | null;
    subtaskKey?: string | null;
  },
): Promise<void> {
  await db.query(
    `insert into approvals (id, run_id, kind, state, payload, hash, workflow_id, conversation_id, subtask_key)
     values ($1,$2,$3,'pending',$4,$5,$6,$7,$8) on conflict (id) do nothing`,
    [a.id, a.runId, a.kind, JSON.stringify(a.payload), a.hash, a.workflowId ?? null, a.conversationId ?? null, a.subtaskKey ?? null],
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
    workflow_id: string | null;
    conversation_id: string | null;
    subtask_key: string | null;
    created_at: Date;
  }>("select * from approvals where id = $1", [id]);
  const r = rows[0];
  return r
    ? {
        id: r.id,
        runId: r.run_id,
        kind: r.kind,
        state: r.state,
        payload: r.payload,
        hash: r.hash,
        decision: r.decision,
        workflowId: r.workflow_id,
        conversationId: r.conversation_id,
        subtaskKey: r.subtask_key,
        createdAt: iso(r.created_at)!,
      }
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

/** Expires the pending decisions of a run, or only those of one of its sub-tasks. */
export async function expireApprovalsForRun(db: Queryable, runId: string, subtaskKey?: string): Promise<void> {
  const res = await db.query(
    `update approvals set state = 'expired', resolved_at = now() where run_id = $1 and state = 'pending' ${subtaskKey ? "and subtask_key = $2" : ""}`,
    subtaskKey ? [runId, subtaskKey] : [runId],
  );
  if ((res.rowCount ?? 0) > 0) await notify(db, { t: "pending" });
}

export async function listPendingApprovals(db: Queryable): Promise<ApprovalDto[]> {
  const { rows } = await db.query<{ id: string; run_id: string; kind: ApprovalDto["kind"]; created_at: Date; conversation_id: string | null; title: string; issue_number: number }>(
    `select a.id, a.run_id, a.kind, a.created_at, coalesce(a.conversation_id, r.conversation_id) as conversation_id, r.title, r.issue_number
     from approvals a join runs r on r.id = a.run_id where a.state = 'pending' order by a.created_at`,
  );
  const label: Record<ApprovalKind, string> = {
    plan: "Approve plan",
    questions: "Answer questions",
    risk: "Approve high-risk change",
    findings: "Decide on review findings",
    limits: "Decide on a change beyond the fast track",
  };
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

/**
 * A general chat, the conversation of a run (every run has its own, AD-38), or the conversation of one
 * sub-task of a run (AD-43).
 */
export async function createConversation(db: Queryable, title: string, runId: string | null = null, subtaskKey: string | null = null): Promise<string> {
  const id = newId("conv");
  await db.query("insert into conversations (id, title, focused_run_id, kind, subtask_key) values ($1,$2,$3,$4,$5)", [
    id,
    title,
    runId,
    !runId ? "general" : subtaskKey ? "subtask" : "run",
    subtaskKey,
  ]);
  return id;
}

export async function getConversation(db: Queryable, id: string): Promise<ConversationDto | null> {
  const list = await listConversations(db, id);
  return list[0] ?? null;
}

export async function listConversations(db: Queryable, onlyId?: string): Promise<ConversationDto[]> {
  const { rows } = await db.query<{
    id: string;
    title: string;
    kind: ConversationDto["kind"];
    focused_run_id: string | null;
    subtask_key: string | null;
    updated_at: Date;
    pending: string;
  }>(
    `select c.id, c.title, c.kind, c.focused_run_id, c.subtask_key, c.updated_at,
       (select count(*) from approvals a join runs r on r.id = a.run_id
         where coalesce(a.conversation_id, r.conversation_id) = c.id and a.state = 'pending') as pending
     from conversations c ${onlyId ? "where c.id = $1" : ""} order by c.updated_at desc limit 200`,
    onlyId ? [onlyId] : [],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    focusedRunId: r.focused_run_id,
    subtaskKey: r.subtask_key,
    updatedAt: iso(r.updated_at)!,
    pending: Number(r.pending),
  }));
}

export async function renameConversation(db: Queryable, conversationId: string, title: string): Promise<void> {
  await db.query("update conversations set title = $2 where id = $1", [conversationId, title]);
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  author: MessageAuthor | null;
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
  author: r.author,
  text: r.text,
  components: r.components,
  version: Number(r.version),
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

export async function insertMessage(
  db: Queryable,
  m: { conversationId: string; role: MessageRole; author?: MessageAuthor; text?: string | null; components?: Component[] },
): Promise<MessageDto> {
  const { rows } = await db.query<MessageRow>(
    `insert into messages (id, conversation_id, role, author, text, components) values ($1,$2,$3,$4,$5,$6) returning *`,
    [newId("msg"), m.conversationId, m.role, m.author ?? null, m.text ?? null, JSON.stringify(m.components ?? [])],
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
