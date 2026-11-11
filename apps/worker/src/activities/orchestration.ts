import { ApplicationFailure, Context } from "@temporalio/activity";
import { CatalogError, currentCatalog, decideTrack, validateAnalysis } from "@orch/catalog";
import { config, hashOf, newId } from "@orch/common";
import {
  findCatalogProduct,
  findCatalogRepository,
  findingsToFix,
  mergeReview,
  repoSlug,
  type Analysis,
  type OrchestratorCard,
  type Plan,
  type RepoRef,
  type ReviewReport,
  type RunState,
  type SubtaskReview,
  type TrackDecision,
  type TrackedFinding,
  type Verification,
  type WorkItem,
} from "@orch/contracts";
import {
  appendRunEvent,
  createApproval,
  createConversation,
  expireApprovalsForRun,
  getCard,
  getRun,
  getSubtask,
  insertRun,
  insertSubtask,
  listSubtasks,
  resolveApproval,
  saveCatalogVersion,
  updateRun,
  updateSubtask,
  upsertCard,
  type Db,
  type NewRunEvent,
  type SubtaskPatch,
} from "@orch/store";
import { ctx, runCatalog } from "../context.js";

const key = (runId: string, ...parts: string[]) => ["run", runId, ...parts].join(":");

/** The workflow that called this activity: the run's, or one of its sub-task workflows. Decisions are signalled back to it. */
const callingWorkflow = (): string | null => Context.current().info.workflowExecution?.workflowId ?? null;

/** Appends a run event and applies its projection patch (idempotent per run and sequence number). */
export async function recordEvent(e: NewRunEvent): Promise<void> {
  await appendRunEvent(ctx().db, e);
}

/**
 * Creates the run record, pins the product catalog, and opens the run's own conversation (AD-30, AD-38).
 * A chat that started the run gets a link to that conversation.
 */
export async function initRun(input: {
  runId: string;
  workItem: WorkItem;
  originConversationId: string | null;
}): Promise<{ conversationId: string; homeProduct: string; catalogHash: string; settings: { maxFixRounds: number; prPollSeconds: number } }> {
  const { db } = ctx();
  const { runId, workItem } = input;
  const slug = repoSlug(workItem.repo);
  const workflowId = Context.current().info.workflowExecution?.workflowId ?? runId;
  await insertRun(db, {
    id: runId,
    workflowId,
    repoOwner: workItem.repo.owner,
    repoName: workItem.repo.name,
    issueNumber: workItem.number,
    title: workItem.title,
    url: workItem.url,
    requester: workItem.requester.login,
    labels: workItem.labels ?? [],
  });

  let run = await getRun(db, runId);
  let catalogHash = run?.catalogHash ?? null;
  let homeProduct = run?.homeProduct ?? null;
  if (!catalogHash || !homeProduct) {
    let catalog;
    try {
      catalog = currentCatalog();
    } catch (err) {
      if (err instanceof CatalogError) throw ApplicationFailure.nonRetryable(err.message, "CatalogError");
      throw err;
    }
    const home = findCatalogRepository(catalog, slug);
    if (!home) throw ApplicationFailure.nonRetryable(`Repository ${slug} is not in the product catalog`, "CatalogError");
    await saveCatalogVersion(db, catalog);
    catalogHash = catalog.hash;
    homeProduct = home.product;
    await updateRun(db, runId, { catalogHash, homeProduct });
  }

  run = await getRun(db, runId);
  let conversationId = run?.conversationId ?? null;
  if (!conversationId) {
    conversationId = await createConversation(db, `#${workItem.number} ${workItem.title}`.slice(0, 120), runId);
    await updateRun(db, runId, { conversationId });
  }
  await upsertCard(db, conversationId, key(runId, "work_item"), {
    type: "work_item",
    runId,
    repo: slug,
    number: workItem.number,
    title: workItem.title,
    url: workItem.url,
  });
  if (input.originConversationId && input.originConversationId !== conversationId) {
    await upsertCard(db, input.originConversationId, key(runId, "link"), {
      type: "run_link",
      runId,
      conversationId,
      repo: slug,
      number: workItem.number,
      title: workItem.title,
    });
  }
  return { conversationId, homeProduct, catalogHash, settings: { maxFixRounds: config.maxFixRounds(), prPollSeconds: config.prPollSeconds() } };
}

/**
 * Applies the track rules to a validated analysis and posts the analysis card (FR-A1, FR-A2, AD-32).
 * The analyst proposes a track; the rules decide which one is allowed.
 */
export async function recordAnalysis(input: {
  runId: string;
  conversationId: string;
  analysis: Analysis;
  labels: string[];
}): Promise<{ decision: TrackDecision; products: string[]; repositories: string[] }> {
  const { db } = ctx();
  const catalog = await runCatalog(input.runId);
  const problems = validateAnalysis(input.analysis, catalog);
  if (problems.length) throw ApplicationFailure.nonRetryable(`The analysis does not match the product catalog: ${problems.join(" ")}`);
  const decision = decideTrack({ analysis: input.analysis, labels: input.labels, catalog, maxFiles: config.fastTrackMaxFiles() });
  const products = input.analysis.products.map((p) => findCatalogProduct(catalog, p.product)!.id);
  const repositories = [
    ...new Set(input.analysis.products.flatMap((p) => p.repositories.map((slug) => findCatalogRepository(catalog, slug)!.id))),
  ];
  await upsertCard(db, input.conversationId, key(input.runId, "analysis"), {
    type: "analysis",
    runId: input.runId,
    understanding: input.analysis.understanding,
    products: input.analysis.products.map((p) => {
      const product = findCatalogProduct(catalog, p.product)!;
      return {
        id: product.id,
        name: product.name,
        repositories: p.repositories.map((slug) => findCatalogRepository(catalog, slug)!.id),
        reason: p.reason,
        changes: p.changes,
      };
    }),
    size: input.analysis.size,
    track: decision.track,
    proposedTrack: decision.proposed,
    trackReasons: decision.reasons,
    approach: input.analysis.approach,
    acceptanceCriteria: input.analysis.acceptanceCriteria,
    risks: input.analysis.risks,
    assumptions: input.analysis.assumptions,
  });
  return { decision, products, repositories };
}

/** Updates a progress card: the run's, or (with a sub-task) the one in that sub-task's own conversation. */
export async function updateProgress(input: {
  runId: string;
  conversationId: string;
  subtaskKey?: string;
  state: RunState;
  headline: string;
  steps: { title: string; status: "pending" | "running" | "done" | "failed" }[];
}): Promise<void> {
  const cardKey = input.subtaskKey ? key(input.runId, "st", input.subtaskKey, "progress") : key(input.runId, "progress");
  await upsertCard(ctx().db, input.conversationId, cardKey, {
    type: "progress",
    runId: input.runId,
    state: input.state,
    headline: input.headline,
    steps: input.steps,
  });
}

export async function askQuestions(input: { runId: string; conversationId: string; questions: string[] }): Promise<{ approvalId: string }> {
  const { db } = ctx();
  const approvalId = newId("apr");
  await createApproval(db, { id: approvalId, runId: input.runId, kind: "questions", payload: { questions: input.questions }, hash: hashOf(input.questions) });
  await upsertCard(db, input.conversationId, key(input.runId, "questions", approvalId), {
    type: "questions",
    runId: input.runId,
    approvalId,
    questions: input.questions,
    status: "pending",
  });
  return { approvalId };
}

/** Records an answer that arrived as a ticket comment (chat answers are recorded by the api). */
export async function recordTicketAnswer(input: { runId: string; conversationId: string; approvalId: string; answer: string }): Promise<void> {
  const { db } = ctx();
  await resolveApproval(db, input.approvalId, { answer: input.answer, source: "ticket" });
  const cardKey = key(input.runId, "questions", input.approvalId);
  const card = await getCard(db, cardKey);
  if (card?.type === "questions") await upsertCard(db, input.conversationId, cardKey, { ...card, status: "answered", answer: input.answer });
}

export async function requestPlanApproval(input: { runId: string; conversationId: string; plan: Plan }): Promise<{ approvalId: string; hash: string }> {
  const { db } = ctx();
  const approvalId = newId("apr");
  const hash = hashOf({ runId: input.runId, plan: input.plan });
  await createApproval(db, { id: approvalId, runId: input.runId, kind: "plan", payload: { plan: input.plan }, hash });
  await upsertCard(db, input.conversationId, key(input.runId, "plan", approvalId), {
    type: "plan",
    runId: input.runId,
    approvalId,
    hash,
    plan: input.plan,
    status: "pending",
  });
  return { approvalId, hash };
}

export async function requestRiskApproval(input: {
  runId: string;
  conversationId: string;
  subtaskKey: string;
  reasons: string[];
  files: string[];
}): Promise<{ approvalId: string; hash: string }> {
  const { db } = ctx();
  const approvalId = newId("apr");
  const hash = hashOf({ runId: input.runId, files: input.files, reasons: input.reasons });
  await createApproval(db, {
    id: approvalId,
    runId: input.runId,
    kind: "risk",
    payload: { reasons: input.reasons, files: input.files },
    hash,
    workflowId: callingWorkflow(),
    conversationId: input.conversationId,
    subtaskKey: input.subtaskKey,
  });
  await upsertCard(db, input.conversationId, key(input.runId, "risk", approvalId), {
    type: "risk",
    runId: input.runId,
    subtaskKey: input.subtaskKey,
    approvalId,
    hash,
    reasons: input.reasons,
    files: input.files,
    status: "pending",
  });
  return { approvalId, hash };
}

// ---------------------------------------------------------------------------
// Sub-tasks: their own conversation, review and decisions (FR-B1, FR-C2, FR-R1, FR-R2)
// ---------------------------------------------------------------------------

/** The sub-tasks of a guided run with their state, in the run's conversation (first form of the story view). */
async function refreshStory(db: Db, runId: string): Promise<void> {
  const run = await getRun(db, runId);
  if (!run?.conversationId) return;
  const subtasks = (await listSubtasks(db, runId)).filter((st) => st.conversationId);
  if (!subtasks.length) return;
  await upsertCard(db, run.conversationId, key(runId, "story"), {
    type: "story",
    runId,
    subtasks: subtasks.map((st) => ({
      key: st.key,
      index: st.index,
      title: st.title,
      state: st.state,
      repository: st.repository,
      conversationId: st.conversationId,
      prNumber: st.prNumber,
      prUrl: st.prUrl,
    })),
  });
}

/**
 * Records a sub-task when its workflow starts. On the guided track the sub-task gets its own conversation
 * under the run (AD-43); on the fast track its cards go to the run's conversation.
 */
export async function initSubtask(input: {
  runId: string;
  key: string;
  index: number;
  total: number;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  repo: RepoRef;
  branch: string;
  ownConversation: boolean;
  runConversationId: string;
}): Promise<{ conversationId: string }> {
  const { db } = ctx();
  const slug = repoSlug(input.repo);
  const entry = findCatalogRepository(await runCatalog(input.runId), slug);
  await insertSubtask(db, {
    runId: input.runId,
    key: input.key,
    index: input.index,
    title: input.title,
    description: input.description,
    acceptanceCriteria: input.acceptanceCriteria,
    state: "planned",
    product: entry?.product ?? null,
    repository: slug,
    branch: input.branch,
  });
  if (!input.ownConversation) return { conversationId: input.runConversationId };
  let conversationId = (await getSubtask(db, input.runId, input.key))?.conversationId ?? null;
  if (!conversationId) {
    conversationId = await createConversation(db, `${input.index + 1}. ${input.title}`.slice(0, 120), input.runId, input.key);
    await updateSubtask(db, input.runId, input.key, { conversationId });
  }
  await upsertCard(db, conversationId, key(input.runId, "st", input.key, "subtask"), {
    type: "subtask",
    runId: input.runId,
    subtaskKey: input.key,
    index: input.index,
    total: input.total,
    title: input.title,
    description: input.description,
    acceptanceCriteria: input.acceptanceCriteria,
    repository: slug,
    branch: input.branch,
  });
  await refreshStory(db, input.runId);
  return { conversationId };
}

export async function patchSubtask(input: { runId: string; key: string; patch: SubtaskPatch }): Promise<void> {
  const { db } = ctx();
  await updateSubtask(db, input.runId, input.key, input.patch);
  await refreshStory(db, input.runId);
}

const reviewCardKey = (runId: string, subtaskKey: string) => key(runId, "st", subtaskKey, "review");

/**
 * Folds a review round into the sub-task's review and shows it. What must be fixed follows from the
 * severities of the findings, never from the reviewer's verdict word (AD-39).
 */
export async function recordReview(input: {
  runId: string;
  key: string;
  conversationId: string;
  report: ReviewReport;
  verification: Verification | null;
  /** Fix rounds done so far, and how many are allowed before the requester decides. */
  fixRounds: number;
  budget: number;
}): Promise<{ review: SubtaskReview; toFix: TrackedFinding[] }> {
  const { db } = ctx();
  const previous = (await getSubtask(db, input.runId, input.key))?.review ?? null;
  // A retried activity must not count the same round twice: a round is new only when it follows the fix rounds done.
  const review = previous && previous.rounds > input.fixRounds ? previous : mergeReview(previous, input.report);
  const toFix = findingsToFix(review);
  await updateSubtask(db, input.runId, input.key, { review, ...(input.verification ? { verification: input.verification } : {}) });
  await upsertCard(db, input.conversationId, reviewCardKey(input.runId, input.key), {
    type: "review",
    runId: input.runId,
    subtaskKey: input.key,
    review,
    verification: input.verification,
    status: toFix.length === 0 ? "clean" : input.fixRounds < input.budget ? "fixing" : "needs_decision",
  });
  return { review, toFix };
}

export async function setReviewStatus(input: {
  runId: string;
  key: string;
  conversationId: string;
  status: "clean" | "fixing" | "needs_decision" | "accepted_with_findings";
}): Promise<void> {
  const { db } = ctx();
  const cardKey = reviewCardKey(input.runId, input.key);
  const card = await getCard(db, cardKey);
  if (card?.type === "review") await upsertCard(db, input.conversationId, cardKey, { ...card, status: input.status });
}

/** Findings are still blocking after the fix rounds: the requester decides what happens (FR-R2). */
export async function requestFindingsDecision(input: {
  runId: string;
  key: string;
  conversationId: string;
  findings: TrackedFinding[];
  fixRounds: number;
}): Promise<{ approvalId: string; hash: string }> {
  const { db } = ctx();
  const approvalId = newId("apr");
  const hash = hashOf({ runId: input.runId, subtask: input.key, findings: input.findings.map((f) => f.id), fixRounds: input.fixRounds });
  await createApproval(db, {
    id: approvalId,
    runId: input.runId,
    kind: "findings",
    payload: { findings: input.findings, fixRounds: input.fixRounds },
    hash,
    workflowId: callingWorkflow(),
    conversationId: input.conversationId,
    subtaskKey: input.key,
  });
  await upsertCard(db, input.conversationId, key(input.runId, "findings", approvalId), {
    type: "findings",
    runId: input.runId,
    subtaskKey: input.key,
    approvalId,
    hash,
    findings: input.findings,
    fixRounds: input.fixRounds,
    status: "pending",
  });
  return { approvalId, hash };
}

/** A fast-track change turned out bigger than the fast track allows: the requester decides (FR-A2). */
export async function requestLimitsDecision(input: {
  runId: string;
  key: string;
  conversationId: string;
  reasons: string[];
  files: string[];
}): Promise<{ approvalId: string; hash: string }> {
  const { db } = ctx();
  const approvalId = newId("apr");
  const hash = hashOf({ runId: input.runId, subtask: input.key, reasons: input.reasons, files: input.files });
  await createApproval(db, {
    id: approvalId,
    runId: input.runId,
    kind: "limits",
    payload: { reasons: input.reasons, files: input.files },
    hash,
    workflowId: callingWorkflow(),
    conversationId: input.conversationId,
    subtaskKey: input.key,
  });
  await upsertCard(db, input.conversationId, key(input.runId, "limits", approvalId), {
    type: "limits",
    runId: input.runId,
    subtaskKey: input.key,
    approvalId,
    hash,
    reasons: input.reasons,
    files: input.files,
    status: "pending",
  });
  return { approvalId, hash };
}

export async function postPullRequestCard(input: {
  runId: string;
  conversationId: string;
  subtaskKey: string;
  number: number;
  url: string;
  title: string;
  state: "open" | "merged" | "closed";
}): Promise<void> {
  await upsertCard(ctx().db, input.conversationId, key(input.runId, "st", input.subtaskKey, "pr"), {
    type: "pull_request",
    runId: input.runId,
    subtaskKey: input.subtaskKey,
    number: input.number,
    url: input.url,
    title: input.title,
    state: input.state,
  });
}

export async function postNotice(input: {
  runId: string;
  conversationId: string;
  noticeKey: string;
  level: "info" | "success" | "warning" | "error";
  text: string;
}): Promise<void> {
  await upsertCard(ctx().db, input.conversationId, key(input.runId, "notice", input.noticeKey), {
    type: "notice",
    runId: input.runId,
    level: input.level,
    text: input.text,
  });
}

const DECISION_CARDS = new Set(["plan", "questions", "risk", "findings", "limits"]);

/**
 * Expires the pending decisions of a run (or of one sub-task) and marks their cards as expired,
 * each in the conversation that holds it.
 */
export async function closeOutApprovals(input: { runId: string; subtaskKey?: string }): Promise<void> {
  const { db } = ctx();
  await expireApprovalsForRun(db, input.runId, input.subtaskKey);
  const { rows } = await db.query<{ card_key: string; conversation_id: string; components: OrchestratorCard[] }>(
    "select card_key, conversation_id, components from messages where card_key like $1",
    [`${key(input.runId)}:%`],
  );
  for (const row of rows) {
    const card = row.components[0];
    if (!card || !DECISION_CARDS.has(card.type) || !("status" in card) || card.status !== "pending") continue;
    if (input.subtaskKey && (!("subtaskKey" in card) || card.subtaskKey !== input.subtaskKey)) continue;
    await upsertCard(db, row.conversation_id, row.card_key, { ...card, status: "expired" } as OrchestratorCard);
  }
}
