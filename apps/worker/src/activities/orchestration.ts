import { ApplicationFailure, Context } from "@temporalio/activity";
import { CatalogError, currentCatalog, decideTrack, validateAnalysis } from "@orch/catalog";
import { config, hashOf, newId } from "@orch/common";
import {
  findCatalogProduct,
  findCatalogRepository,
  repoSlug,
  type Analysis,
  type OrchestratorCard,
  type Plan,
  type RunState,
  type TrackDecision,
  type WorkItem,
} from "@orch/contracts";
import {
  appendRunEvent,
  createApproval,
  createConversation,
  expireApprovalsForRun,
  getCard,
  getRun,
  insertRun,
  resolveApproval,
  saveCatalogVersion,
  updateRun,
  upsertCard,
  type NewRunEvent,
} from "@orch/store";
import { ctx, runCatalog } from "../context.js";

const key = (runId: string, ...parts: string[]) => ["run", runId, ...parts].join(":");

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
}): Promise<{ conversationId: string; homeProduct: string; catalogHash: string }> {
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
  return { conversationId, homeProduct, catalogHash };
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

export async function updateProgress(input: {
  runId: string;
  conversationId: string;
  state: RunState;
  headline: string;
  steps: { title: string; status: "pending" | "running" | "done" | "failed" }[];
}): Promise<void> {
  await upsertCard(ctx().db, input.conversationId, key(input.runId, "progress"), {
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
  reasons: string[];
  files: string[];
}): Promise<{ approvalId: string; hash: string }> {
  const { db } = ctx();
  const approvalId = newId("apr");
  const hash = hashOf({ runId: input.runId, files: input.files, reasons: input.reasons });
  await createApproval(db, { id: approvalId, runId: input.runId, kind: "risk", payload: { reasons: input.reasons, files: input.files }, hash });
  await upsertCard(db, input.conversationId, key(input.runId, "risk", approvalId), {
    type: "risk",
    runId: input.runId,
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
  number: number;
  url: string;
  title: string;
  state: "open" | "merged" | "closed";
}): Promise<void> {
  await upsertCard(ctx().db, input.conversationId, key(input.runId, "pr"), {
    type: "pull_request",
    runId: input.runId,
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

/** Expires every pending approval of a run and marks its pending cards as expired. */
export async function closeOutApprovals(input: { runId: string; conversationId: string }): Promise<void> {
  const { db } = ctx();
  await expireApprovalsForRun(db, input.runId);
  const { rows } = await db.query<{ card_key: string; components: OrchestratorCard[] }>(
    "select card_key, components from messages where card_key like $1",
    [`${key(input.runId)}:%`],
  );
  for (const row of rows) {
    const card = row.components[0];
    if (!card || !("status" in card) || card.status !== "pending") continue;
    if (card.type === "plan" || card.type === "questions" || card.type === "risk") {
      await upsertCard(db, input.conversationId, row.card_key, { ...card, status: "expired" } as OrchestratorCard);
    }
  }
}
