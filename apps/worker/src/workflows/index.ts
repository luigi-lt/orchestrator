/**
 * Temporal workflows. Deterministic code only: all I/O and LLM work happens in activities.
 * Imports from @orch/* are type-only so nothing with Node built-ins enters the workflow bundle.
 */
import {
  ApplicationFailure,
  CancellationScope,
  condition,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";
import type {
  AnswerSignal,
  ApprovalSignal,
  CancelSignal,
  DeliveryRunInput,
  Plan,
  QuestionRound,
  RunState,
  StepKind,
  StepResult,
  WorkspaceActivities,
} from "@orch/contracts";
import type * as Orchestration from "../activities/orchestration.js";
import type * as Integration from "../activities/integration.js";
import type * as Steps from "../activities/steps.js";

export const approvalSignal = defineSignal<[ApprovalSignal]>("approval");
export const answerSignal = defineSignal<[AnswerSignal]>("answer");
export const cancelSignal = defineSignal<[CancelSignal]>("cancel");

const orch = proxyActivities<typeof Orchestration>({
  taskQueue: "orchestration",
  startToCloseTimeout: "1 minute",
  retry: { initialInterval: "1s", maximumAttempts: 20 },
});
const integ = proxyActivities<typeof Integration>({
  taskQueue: "integration",
  startToCloseTimeout: "10 minutes",
  retry: { initialInterval: "5s", backoffCoefficient: 2, maximumInterval: "2 minutes", maximumAttempts: 15 },
});
const steps = proxyActivities<typeof Steps>({
  taskQueue: "agent-steps",
  startToCloseTimeout: "15 minutes",
  retry: { initialInterval: "2s", maximumAttempts: 5 },
});
const stepWait = proxyActivities<typeof Steps>({
  taskQueue: "agent-steps",
  startToCloseTimeout: "5 hours",
  heartbeatTimeout: "1 minute",
  retry: { maximumAttempts: 3 },
});
const workspaces = proxyActivities<WorkspaceActivities>({
  taskQueue: "workspaces",
  startToCloseTimeout: "10 minutes",
  retry: { initialInterval: "2s", maximumAttempts: 5 },
});

const MAX_RUN_MS = 30 * 24 * 60 * 60 * 1000;
const REMINDER_MS = 24 * 60 * 60 * 1000;
const TICKET_POLL = "2 minutes";
const PR_POLL = "1 minute";

type ProgressStatus = "pending" | "running" | "done" | "failed";

export async function deliveryRunWorkflow(input: DeliveryRunInput): Promise<RunState> {
  const { runId, workItem } = input;
  const repo = workItem.repo;
  const startedAt = Date.now();

  let seq = 0;
  let stepCounter = 0;
  let conversationId = input.conversationId ?? "";
  let state: RunState = "intake";
  const cancel: { reason: string | null } = { reason: null };
  const approvals = new Map<string, ApprovalSignal>();
  const answers = new Map<string, AnswerSignal>();

  const main = new CancellationScope();
  setHandler(approvalSignal, (s) => void approvals.set(s.approvalId, s));
  setHandler(answerSignal, (s) => void answers.set(s.approvalId, s));
  setHandler(cancelSignal, (s) => {
    if (cancel.reason) return;
    cancel.reason = s.reason || "Cancelled";
    main.cancel();
  });

  // Progress card model --------------------------------------------------------
  const progress: { title: string; status: ProgressStatus }[] = [
    { title: "Plan", status: "pending" },
    { title: "Plan approval", status: "pending" },
    { title: "Pull request", status: "pending" },
    { title: "Review and merge", status: "pending" },
  ];
  const setProgress = (title: string, status: ProgressStatus) => {
    const item = progress.find((p) => p.title === title);
    if (item) item.status = status;
  };
  const pushProgress = (headline: string) =>
    orch.updateProgress({ runId, conversationId, state, headline, steps: progress.map((p) => ({ ...p })) });

  const emit = (type: string, payload: Record<string, unknown> = {}, patch: Record<string, unknown> = {}) =>
    orch.recordEvent({ runId, seq: ++seq, type, actor: "orchestrator", payload, patch });

  const setState = async (next: RunState, headline: string) => {
    state = next;
    await emit("run.state_changed", { state: next }, { state: next });
    await pushProgress(headline);
  };

  const expired = () => Date.now() - startedAt > MAX_RUN_MS;

  // Steps ---------------------------------------------------------------------
  let ctxInfo: { defaultBranch: string; branch: string; commitAuthor: { name: string; email: string } };

  const runStep = async (
    kind: StepKind,
    title: string,
    extra: { questionRounds?: QuestionRound[]; feedback?: string; plan?: Plan; subtaskIndex?: number },
  ): Promise<{ stepId: string; result: StepResult }> => {
    const stepId = `${runId}-s${++stepCounter}`;
    await steps.prepareStep({
      runId,
      stepId,
      kind,
      title,
      branch: ctxInfo.branch,
      workItem,
      commitAuthor: ctxInfo.commitAuthor,
      ...extra,
    });
    await emit("step.started", { stepId, kind, title });
    try {
      await workspaces.createWorkspace({ stepId, runId });
      const result = await stepWait.awaitStep({ stepId });
      await emit(result.status === "succeeded" ? "step.completed" : "step.failed", { stepId, kind, summary: result.summary });
      return { stepId, result };
    } finally {
      await CancellationScope.nonCancellable(() => workspaces.destroyWorkspace({ stepId }));
    }
  };

  // Waiting for people ----------------------------------------------------------
  const waitForApproval = async (approvalId: string): Promise<ApprovalSignal> => {
    let lastReminder = Date.now();
    for (;;) {
      if (await condition(() => approvals.has(approvalId), "1 hour")) return approvals.get(approvalId)!;
      if (expired()) throw ApplicationFailure.nonRetryable("The run waited too long for an approval");
      if (Date.now() - lastReminder >= REMINDER_MS) {
        lastReminder = Date.now();
        await orch.postNotice({ runId, conversationId, noticeKey: `reminder-${approvalId}`, level: "warning", text: "Reminder: this run is waiting for your decision." });
      }
    }
  };

  const waitForAnswer = async (approvalId: string, askedAt: string): Promise<AnswerSignal> => {
    let lastReminder = Date.now();
    for (;;) {
      if (await condition(() => answers.has(approvalId), TICKET_POLL)) return answers.get(approvalId)!;
      const reply = await integ.findRequesterReply({ repo, number: workItem.number, since: askedAt, requester: workItem.requester.login });
      if (reply) {
        await orch.recordTicketAnswer({ runId, conversationId, approvalId, answer: reply });
        return { approvalId, answer: reply, source: "ticket" };
      }
      if (expired()) throw ApplicationFailure.nonRetryable("The run waited too long for answers");
      if (Date.now() - lastReminder >= REMINDER_MS) {
        lastReminder = Date.now();
        await orch.postNotice({ runId, conversationId, noticeKey: `reminder-${approvalId}`, level: "warning", text: "Reminder: the agent is waiting for your answers." });
      }
    }
  };

  // Endings ---------------------------------------------------------------------
  // Ticket write-back happens before the final state is recorded, so "completed" means everything is done.
  // A write-back failure is reported but never prevents the run from reaching its final state.
  const finish = async (final: "completed" | "closed" | "cancelled" | "failed", text: string, level: "success" | "info" | "warning" | "error") => {
    state = final;
    let writeBackError: string | null = null;
    try {
      await integ.finalizeIssue({ repo, number: workItem.number, outcome: final });
      if (final !== "completed") {
        await integ.commentOnIssue({ repo, number: workItem.number, key: `run=${runId}:${final}`, body: `🤖 Run \`${runId}\` ended: ${text}` });
      }
    } catch (err) {
      writeBackError = err instanceof Error ? err.message : String(err);
    }
    if (conversationId) await orch.closeOutApprovals({ runId, conversationId });
    await emit(`run.${final}`, { text, writeBackError }, { state: final, ...(final === "failed" ? { error: text } : {}) });
    if (conversationId) {
      await pushProgress(text);
      await orch.postNotice({ runId, conversationId, noticeKey: "final", level, text });
      if (writeBackError) {
        await orch.postNotice({ runId, conversationId, noticeKey: "writeback", level: "warning", text: `Could not update the GitHub issue: ${writeBackError}` });
      }
    }
  };

  // The delivery skeleton ------------------------------------------------------
  const deliver = async (): Promise<void> => {
    const init = await orch.initRun({ runId, workItem, conversationId: input.conversationId });
    conversationId = init.conversationId;
    await emit("run.created", { repo: `${repo.owner}/${repo.name}`, issue: workItem.number }, { state: "intake", conversationId });
    await pushProgress("Picked up");

    ctxInfo = await integ.lookupContext({ runId, workItem });
    await integ.claimIssue({ repo, number: workItem.number, runId });
    await emit("intake.claimed", { branch: ctxInfo.branch }, { branch: ctxInfo.branch });
    await steps.prepareRunRepo({ runId, repo, defaultBranch: ctxInfo.defaultBranch, branch: ctxInfo.branch });

    // Readiness check and planning, with clarifying questions and plan feedback.
    let questionRounds: QuestionRound[] = [];
    let feedback: string | undefined;
    let plan: Plan | undefined;
    for (let attempt = 1; !plan; attempt++) {
      if (attempt > 6) throw ApplicationFailure.nonRetryable("Planning did not converge after 6 attempts");
      setProgress("Plan", "running");
      await setState("planning", attempt === 1 ? "Planning" : "Re-planning");
      const { result } = await runStep("plan", attempt === 1 ? "Plan" : `Re-plan (attempt ${attempt})`, { questionRounds, feedback });
      if (result.status !== "succeeded" || !result.assessment) {
        setProgress("Plan", "failed");
        throw ApplicationFailure.nonRetryable(`Planning failed: ${result.error ?? result.summary}`);
      }
      const assessment = result.assessment;
      if (!assessment.ready || !assessment.plan) {
        if (!assessment.questions.length) throw ApplicationFailure.nonRetryable("The planner returned neither a plan nor questions");
        if (questionRounds.length >= 3) throw ApplicationFailure.nonRetryable("The issue is still unclear after three rounds of questions");
        const askedAt = new Date().toISOString();
        const { approvalId } = await orch.askQuestions({ runId, conversationId, questions: assessment.questions });
        await integ.commentOnIssue({
          repo,
          number: workItem.number,
          key: `run=${runId}:questions=${approvalId}`,
          body: `🤖 Before planning, the agent needs a few answers. Reply here or in the orchestrator web app:\n\n${assessment.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
        });
        await emit("readiness.question_asked", { approvalId, questions: assessment.questions });
        await setState("awaiting_answers", "Waiting for your answers");
        const answer = await waitForAnswer(approvalId, askedAt);
        questionRounds = [...questionRounds, { questions: assessment.questions, answer: answer.answer }];
        await emit("readiness.answered", { approvalId, source: answer.source });
        feedback = undefined;
        continue;
      }

      setProgress("Plan", "done");
      setProgress("Plan approval", "running");
      const { approvalId } = await orch.requestPlanApproval({ runId, conversationId, plan: assessment.plan });
      await integ.commentOnIssue({
        repo,
        number: workItem.number,
        key: `run=${runId}:plan=${approvalId}`,
        body: `🤖 Proposed plan (waiting for approval in the orchestrator web app):\n\n${assessment.plan.summary}\n\n${assessment.plan.subtasks.map((s) => `- [ ] ${s.title}`).join("\n")}`,
      });
      await emit("plan.proposed", { approvalId, subtasks: assessment.plan.subtasks.length }, { plan: assessment.plan });
      await setState("awaiting_approval", "Waiting for plan approval");
      const decision = await waitForApproval(approvalId);
      if (decision.decision === "approve") {
        plan = assessment.plan;
        await emit("plan.approved", { approvalId });
      } else if (decision.decision === "changes") {
        feedback = decision.feedback ?? "";
        await emit("plan.changes_requested", { approvalId, feedback });
        setProgress("Plan approval", "pending");
      } else {
        await emit("plan.rejected", { approvalId });
        setProgress("Plan approval", "failed");
        await finish("cancelled", "Plan rejected; nothing was changed.", "warning");
        return;
      }
    }
    setProgress("Plan approval", "done");

    // Implementation, one sandboxed step per sub-task.
    const subtaskTitles = plan.subtasks.map((s, i) => `${i + 1}. ${s.title}`);
    progress.splice(2, 0, ...subtaskTitles.map((title) => ({ title, status: "pending" as ProgressStatus })));
    await setState("executing", "Implementing");
    for (let i = 0; i < plan.subtasks.length; i++) {
      const title = subtaskTitles[i]!;
      setProgress(title, "running");
      await pushProgress(`Implementing sub-task ${i + 1} of ${plan.subtasks.length}`);
      let attempt = await runStep("implement", `Sub-task ${title}`, { plan, subtaskIndex: i });
      if (attempt.result.status !== "succeeded") {
        await pushProgress(`Retrying sub-task ${i + 1}`);
        attempt = await runStep("implement", `Sub-task ${title} (retry)`, { plan, subtaskIndex: i });
      }
      if (attempt.result.status !== "succeeded") {
        setProgress(title, "failed");
        throw ApplicationFailure.nonRetryable(`Sub-task ${i + 1} failed: ${attempt.result.error ?? attempt.result.summary}`);
      }
      const applied = await steps.applyStepResult({ runId, stepId: attempt.stepId, branch: ctxInfo.branch });
      await emit("subtask.completed", { index: i, commits: applied.commits });
      setProgress(title, "done");
    }

    // Checks before anything leaves the orchestrator.
    setProgress("Pull request", "running");
    await setState("publishing", "Checking and publishing the changes");
    const inspection = await steps.inspectChanges({ runId, branch: ctxInfo.branch, defaultBranch: ctxInfo.defaultBranch });
    if (inspection.changedFiles.length === 0) throw ApplicationFailure.nonRetryable("The agents produced no changes");
    if (inspection.secrets.length) {
      const where = inspection.secrets.map((s) => `${s.kind} in ${s.file}:${s.line}`).join("; ");
      throw ApplicationFailure.nonRetryable(`Possible secrets in the changes (${where}); nothing was pushed`);
    }
    if (inspection.risk.reasons.length) {
      const { approvalId } = await orch.requestRiskApproval({ runId, conversationId, reasons: inspection.risk.reasons, files: inspection.risk.files });
      await emit("approval.requested", { kind: "risk", approvalId, reasons: inspection.risk.reasons });
      await setState("awaiting_approval", "Waiting for approval of a high-risk change");
      const decision = await waitForApproval(approvalId);
      if (decision.decision !== "approve") {
        await emit("risk.rejected", { approvalId });
        setProgress("Pull request", "failed");
        await finish("cancelled", "High-risk change rejected; nothing was pushed.", "warning");
        return;
      }
      await emit("risk.approved", { approvalId });
      await setState("publishing", "Publishing the changes");
    }

    const body = [
      plan.summary,
      "",
      "### Sub-tasks",
      ...plan.subtasks.map((s) => `- ${s.title}`),
      "",
      `Closes #${workItem.number}`,
      "",
      `---`,
      `🤖 Generated by the orchestrator (run \`${runId}\`) on behalf of @${workItem.requester.login}.`,
    ].join("\n");
    const pr = await integ.publishBranch({
      runId,
      repo,
      branch: ctxInfo.branch,
      defaultBranch: ctxInfo.defaultBranch,
      title: `[agent] ${workItem.title}`,
      body,
    });
    await emit("scm.pr_opened", { number: pr.number, url: pr.url }, { prNumber: pr.number, prUrl: pr.url });
    await orch.postPullRequestCard({ runId, conversationId, number: pr.number, url: pr.url, title: pr.title, state: "open" });
    await integ.commentOnIssue({ repo, number: workItem.number, key: `run=${runId}:pr`, body: `🤖 Pull request opened: ${pr.url}` });
    setProgress("Pull request", "done");
    setProgress("Review and merge", "running");
    await setState("awaiting_merge", "Waiting for review and merge on GitHub");

    // Human review and merge happen on GitHub; poll until the pull request is merged or closed.
    for (;;) {
      await sleep(PR_POLL);
      const prState = await integ.getPullRequestState({ repo, number: pr.number });
      if (prState === "open") {
        if (expired()) throw ApplicationFailure.nonRetryable("The pull request was not merged within 30 days");
        continue;
      }
      await orch.postPullRequestCard({ runId, conversationId, number: pr.number, url: pr.url, title: pr.title, state: prState });
      await emit(prState === "merged" ? "scm.pr_merged" : "scm.pr_closed", { number: pr.number });
      setProgress("Review and merge", prState === "merged" ? "done" : "failed");
      if (prState === "merged") await finish("completed", "Pull request merged. Done.", "success");
      else await finish("closed", "Pull request closed without merging.", "info");
      return;
    }
  };

  try {
    await main.run(deliver);
  } catch (err) {
    if (isCancellation(err) && cancel.reason) {
      const reason = cancel.reason;
      await CancellationScope.nonCancellable(() => finish("cancelled", `Cancelled: ${reason}`, "warning"));
    } else {
      const message = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      await CancellationScope.nonCancellable(() => finish("failed", `Failed: ${message}`, "error"));
    }
  }
  return state;
}

/** Started every minute by a Temporal Schedule: discovers labelled issues and starts runs. */
export async function discoveryWorkflow(): Promise<number> {
  const discovery = proxyActivities<typeof Integration>({
    taskQueue: "integration",
    startToCloseTimeout: "5 minutes",
    heartbeatTimeout: "1 minute",
    retry: { maximumAttempts: 2 },
  });
  return discovery.discoverAndStart();
}
