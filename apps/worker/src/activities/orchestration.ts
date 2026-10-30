import { Context } from "@temporalio/activity";
import { hashOf, newId } from "@orch/common";
import type { OrchestratorCard, Plan, RunState, WorkItem } from "@orch/contracts";
import {
  appendRunEvent,
  createApproval,
  createConversation,
  expireApprovalsForRun,
  getCard,
  getRun,
  insertRun,
  resolveApproval,
  setFocusedRun,
  updateRun,
  upsertCard,
  type NewRunEvent,
} from "@orch/store";
import { ctx } from "../context.js";

const key = (runId: string, ...parts: string[]) => ["run", runId, ...parts].join(":");

/** Appends a run event and applies its projection patch (idempotent per run and sequence number). */
export async function recordEvent(e: NewRunEvent): Promise<void> {
  await appendRunEvent(ctx().db, e);
}

/** Creates the run record and its home conversation, and posts the work item card. */
export async function initRun(input: { runId: string; workItem: WorkItem; conversationId: string | null }): Promise<{ conversationId: string }> {
  const { db } = ctx();
  const { runId, workItem } = input;
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
    conversationId: input.conversationId,
  });
  const run = await getRun(db, runId);
  let conversationId = run?.conversationId ?? input.conversationId;
  if (!conversationId) conversationId = await createConversation(db, `#${workItem.number} ${workItem.title}`, runId);
  await updateRun(db, runId, { conversationId });
  await setFocusedRun(db, conversationId, runId);
  await upsertCard(db, conversationId, key(runId, "work_item"), {
    type: "work_item",
    runId,
    repo: `${workItem.repo.owner}/${workItem.repo.name}`,
    number: workItem.number,
    title: workItem.title,
    url: workItem.url,
  });
  return { conversationId };
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
