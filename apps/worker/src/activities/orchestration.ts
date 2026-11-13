import { ApplicationFailure, Context } from "@temporalio/activity";
import { CatalogError, currentCatalog, decideTrack, validateAnalysis } from "@orch/catalog";
import { config, hashOf, newId } from "@orch/common";
import { architect } from "@orch/agent-profiles";
import {
  buildOrder,
  diffPlans,
  findCatalogProduct,
  findCatalogRepository,
  findingsToFix,
  mergeReview,
  repoSlug,
  sanitizeAgentComponents,
  type Analysis,
  type ChangedFile,
  type CriterionEvidence,
  type DesignTurnInput,
  type DesignTurnResult,
  type HandoffPlan,
  type OrchestratorCard,
  type PlanVersionDto,
  type RepoRef,
  type ReviewReport,
  type RunState,
  type SubtaskReview,
  type SubtaskState,
  type TrackDecision,
  type TrackedFinding,
  type Verification,
  type WorkItem,
} from "@orch/contracts";
import {
  addPlanVersion,
  addSubtaskWarning,
  appendRunEvent,
  createApproval,
  createConversation,
  expireApprovalsForRun,
  getCard,
  getLatestPlanVersion,
  getRun,
  getSubtask,
  insertMessage,
  notify,
  insertRun,
  insertSubtask,
  listSubtasks,
  resolveApproval,
  saveCatalogVersion,
  setPlanVersionStatus,
  updateRun,
  updateSubtask,
  upsertCard,
  voidApprovals,
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
}): Promise<{
  conversationId: string;
  homeProduct: string;
  catalogHash: string;
  settings: { maxFixRounds: number; prPollSeconds: number; designIdleSeconds: number };
}> {
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
  return { conversationId, homeProduct, catalogHash, settings: { maxFixRounds: config.maxFixRounds(), prPollSeconds: config.prPollSeconds(), designIdleSeconds: config.designIdleSeconds() } };
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
  steps: { title: string; status: "pending" | "running" | "done" | "failed" | "skipped" }[];
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

// ---------------------------------------------------------------------------
// Design session: the architect's replies, plan versions and the plan's approval (FR-P1 to FR-P4, AD-36)
// ---------------------------------------------------------------------------

const planCardKey = (runId: string) => key(runId, "plan");

/** The plan card shows the latest version: read-only, with what changed since the version before. */
/**
 * Shows a plan version on the run's one plan card. With `toEnd` the card moves below the architect's reply, so
 * a new version, or the Approve button, is where the requester is reading.
 */
async function showPlan(db: Db, runId: string, conversationId: string, version: PlanVersionDto, approvalId: string | null, toEnd: boolean): Promise<void> {
  const catalog = await runCatalog(runId);
  const card: OrchestratorCard = {
    type: "plan",
    runId,
    version: version.version,
    hash: version.hash,
    plan: version.plan,
    status: version.status === "approved" ? "approved" : version.status === "proposed" ? "proposed" : "draft",
    ...(approvalId ? { approvalId } : {}),
    changes: version.changes,
    promptedBy: version.promptedBy,
    products: Object.fromEntries(catalog.products.map((p) => [p.id, p.name])),
  };
  await upsertCard(db, conversationId, planCardKey(runId), card, { toEnd });
}

/**
 * Records one turn of the design session, after it ended: the architect's reply in the conversation, a new plan
 * version when the architect submitted one, and the approval request when it put the plan up for approval.
 * The workflow is the only writer of plan versions (AD-13, AD-36); the plan was validated by the gateway.
 */
export async function recordDesignTurn(input: {
  runId: string;
  conversationId: string;
  turn: DesignTurnInput;
  result: DesignTurnResult;
}): Promise<{ version: number | null; created: boolean; changes: number; voidedApproval: boolean; proposedApprovalId: string | null }> {
  const { db } = ctx();
  const { runId, conversationId, result } = input;
  const failed = result.status !== "succeeded";
  const text = failed ? `I could not reply (${result.error ?? "unknown error"}). Send your message again to retry.` : result.text.trim();
  const components = failed ? [] : sanitizeAgentComponents(result.components);
  if (text || components.length) {
    await insertMessage(db, { conversationId, role: "agent", author: "architect", text: text || null, components, key: key(runId, "turn", input.turn.turnId) });
  }
  // The turn is over, however it ended (a lost workspace never reports its own end).
  await notify(db, { t: "typing", c: conversationId, on: false });
  if (failed) return { version: null, created: false, changes: 0, voidedApproval: false, proposedApprovalId: null };

  let latest = await getLatestPlanVersion(db, runId);
  let created = false;
  let voidedApproval = false;
  if (result.plan) {
    const promptedBy = input.turn.messages.length ? input.turn.messages.join("\n").slice(0, 2000) : null;
    const added = await addPlanVersion(db, {
      runId,
      hash: hashOf({ runId, plan: result.plan }),
      plan: result.plan,
      changes: diffPlans(latest?.plan ?? null, result.plan),
      author: `${architect.id}@${architect.version}`,
      promptedBy,
    });
    created = added.created;
    latest = added.version;
    // A newer version voids the approval asked for an older one: what is approved is exactly what was shown (FR-P4).
    if (created) voidedApproval = (await voidApprovals(db, runId, "plan")).length > 0;
  }
  if (!latest) return { version: null, created: false, changes: 0, voidedApproval, proposedApprovalId: null };

  let proposedApprovalId: string | null = null;
  if (result.proposed && latest.status !== "proposed" && latest.status !== "approved") {
    proposedApprovalId = newId("apr");
    await createApproval(db, {
      id: proposedApprovalId,
      runId,
      kind: "plan",
      payload: { version: latest.version },
      hash: latest.hash,
      workflowId: callingWorkflow(),
      conversationId,
    });
    await setPlanVersionStatus(db, runId, latest.version, "proposed");
    latest = { ...latest, status: "proposed" };
  }
  if (created || proposedApprovalId) await showPlan(db, runId, conversationId, latest, proposedApprovalId, true);
  return { version: latest.version, created, changes: latest.changes.length, voidedApproval, proposedApprovalId };
}

/**
 * The requester approved a plan version. It becomes the plan of the run; returns the order in which
 * its sub-tasks are built (each after the ones it depends on).
 */
export async function finalizePlan(input: { runId: string; conversationId: string; version: number }): Promise<{ plan: HandoffPlan; order: string[] }> {
  const { db } = ctx();
  const latest = await getLatestPlanVersion(db, input.runId);
  if (!latest || latest.version !== input.version) throw ApplicationFailure.nonRetryable(`Plan version ${input.version} is not the latest version of the run`);
  const order = buildOrder(latest.plan);
  if (!order) throw ApplicationFailure.nonRetryable("The approved plan has a dependency cycle");
  await setPlanVersionStatus(db, input.runId, latest.version, "approved");
  await showPlan(db, input.runId, input.conversationId, { ...latest, status: "approved" }, null, false);
  return { plan: latest.plan, order: order.map((st) => st.key) };
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

/** The key of the single change of the fast track; a plan cannot use it for a sub-task. */
const FAST_TRACK_KEY = "change";

/**
 * The story view in the run's conversation (FR-R7): every sub-task of the approved plan in build order,
 * with its product, state, links, what it builds on and its warnings.
 */
async function refreshStory(db: Db, runId: string): Promise<void> {
  const run = await getRun(db, runId);
  if (!run?.conversationId) return;
  const subtasks = (await listSubtasks(db, runId)).filter((st) => st.key !== FAST_TRACK_KEY);
  if (!subtasks.length) return;
  const catalog = await runCatalog(runId);
  await upsertCard(db, run.conversationId, key(runId, "story"), {
    type: "story",
    runId,
    products: Object.fromEntries(catalog.products.map((p) => [p.id, p.name])),
    subtasks: subtasks.map((st) => ({
      key: st.key,
      index: st.index,
      title: st.title,
      state: st.state,
      product: st.product,
      repository: st.repository,
      conversationId: st.conversationId,
      prNumber: st.prNumber,
      prUrl: st.prUrl,
      ticketNumber: st.ticketNumber,
      ticketUrl: st.ticketUrl,
      dependsOn: st.dependsOn,
      stackedOn: st.stackedOn,
      warnings: st.warnings,
    })),
  });
}

/** Records every sub-task of the approved plan as planned, in build order, and shows the story view. */
export async function planSubtasks(input: {
  runId: string;
  items: { key: string; title: string; description: string; acceptanceCriteria: string[]; repository: string; dependsOn: string[]; ticket?: { number: number; url: string } }[];
}): Promise<void> {
  const { db } = ctx();
  const catalog = await runCatalog(input.runId);
  for (const [index, item] of input.items.entries()) {
    await insertSubtask(db, {
      runId: input.runId,
      key: item.key,
      index,
      title: item.title,
      description: item.description,
      acceptanceCriteria: item.acceptanceCriteria,
      state: "planned",
      product: findCatalogRepository(catalog, item.repository)?.product ?? null,
      repository: item.repository,
      dependsOn: item.dependsOn,
      ticketNumber: item.ticket?.number ?? null,
      ticketUrl: item.ticket?.url ?? null,
    });
  }
  await refreshStory(db, input.runId);
}

/** Closes sub-tasks that never started as not done: the requester dropped them with one they depend on (FR-R4). */
export async function dropSubtasks(input: { runId: string; keys: string[] }): Promise<void> {
  const { db } = ctx();
  for (const subtaskKey of input.keys) await updateSubtask(db, input.runId, subtaskKey, { state: "dropped" });
  await refreshStory(db, input.runId);
}

/** A warning on a sub-task in the story view, e.g. a pull request merged before one it depends on (FR-M5). */
export async function addStoryWarning(input: { runId: string; key: string; text: string }): Promise<void> {
  const { db } = ctx();
  await addSubtaskWarning(db, input.runId, input.key, input.text);
  await refreshStory(db, input.runId);
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
  /** The sub-issue that mirrors the sub-task on the ticket, when the plan was mirrored (FR-P5). */
  ticket?: { number: number; url: string };
  /** The sub-task whose approved change this one's branch is stacked on (AD-41). */
  stackedOn?: string;
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
  // A sub-task of an approved plan is already recorded as planned; what is known only now is added.
  await updateSubtask(db, input.runId, input.key, {
    branch: input.branch,
    description: input.description,
    stackedOn: input.stackedOn,
    ...(input.ticket ? { ticketNumber: input.ticket.number, ticketUrl: input.ticket.url } : {}),
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

/**
 * The requester's check of a change before its pull request opens (FR-R4). The decision is bound to the
 * commit (AD-40). The card describes the change: what the implementer says, the evidence per acceptance
 * criterion with the reviewer's judgment, the files with their line counts, the checks and the review.
 */
export async function requestChangeCheck(input: {
  runId: string;
  key: string;
  conversationId: string;
  commit: string;
  repository: string;
  branch: string;
  /** How many times the requester asked for changes before this check. */
  round: number;
  summary: string;
  acceptanceCriteria: string[];
  evidence: CriterionEvidence[];
  files: ChangedFile[];
  verification: Verification | null;
  review: SubtaskReview;
  fixRounds: number;
  buildsOn: string[];
}): Promise<{ approvalId: string; hash: string }> {
  const { db } = ctx();
  const approvalId = newId("apr");
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const byPosition = <T>(list: T[], i: number) => (list.length === input.acceptanceCriteria.length ? list[i] : undefined);
  const criteria = input.acceptanceCriteria.map((criterion, i) => {
    const claimed = input.evidence.find((e) => same(e.criterion, criterion)) ?? byPosition(input.evidence, i);
    const judged = input.review.criteria.find((c) => same(c.criterion, criterion)) ?? byPosition(input.review.criteria, i);
    return { criterion, evidence: claimed?.evidence ?? null, met: judged?.met ?? null, note: judged?.note ?? null };
  });
  await updateSubtask(db, input.runId, input.key, { evidence: input.evidence, changedFiles: input.files, checkRounds: input.round });
  await createApproval(db, {
    id: approvalId,
    runId: input.runId,
    kind: "change",
    payload: { commit: input.commit, files: input.files.map((f) => f.path), round: input.round },
    hash: input.commit,
    workflowId: callingWorkflow(),
    conversationId: input.conversationId,
    subtaskKey: input.key,
  });
  await upsertCard(db, input.conversationId, key(input.runId, "change", approvalId), {
    type: "change",
    runId: input.runId,
    subtaskKey: input.key,
    approvalId,
    hash: input.commit,
    repository: input.repository,
    branch: input.branch,
    round: input.round,
    summary: input.summary,
    criteria,
    files: input.files,
    verification: input.verification,
    review: {
      summary: input.review.summary,
      rounds: input.review.rounds,
      fixRounds: input.fixRounds,
      blocking: input.review.open.filter((f) => f.severity !== "minor").length,
      minor: input.review.open.filter((f) => f.severity === "minor").length,
      resolved: input.review.resolved.length,
    },
    buildsOn: input.buildsOn,
    status: "pending",
  });
  await refreshStory(db, input.runId);
  return { approvalId, hash: input.commit };
}

/** A sub-task was not delivered and others that have not started depend on it: the requester decides (FR-R4). */
export async function requestDependentsDecision(input: {
  runId: string;
  conversationId: string;
  subtask: { key: string; title: string; state: SubtaskState };
  dependents: { key: string; title: string }[];
}): Promise<{ approvalId: string; hash: string }> {
  const { db } = ctx();
  const approvalId = newId("apr");
  const hash = hashOf({ runId: input.runId, subtask: input.subtask.key, dependents: input.dependents.map((d) => d.key) });
  await createApproval(db, {
    id: approvalId,
    runId: input.runId,
    kind: "dependents",
    payload: { subtask: input.subtask.key, dependents: input.dependents.map((d) => d.key) },
    hash,
    workflowId: callingWorkflow(),
    conversationId: input.conversationId,
  });
  await upsertCard(db, input.conversationId, key(input.runId, "dependents", approvalId), {
    type: "dependents",
    runId: input.runId,
    approvalId,
    hash,
    subtask: input.subtask,
    dependents: input.dependents,
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

const DECISION_CARDS = new Set(["plan", "questions", "risk", "findings", "limits", "change", "dependents"]);

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
