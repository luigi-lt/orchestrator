/**
 * Temporal workflows. Deterministic code only: all I/O and LLM work happens in activities.
 * Imports from @orch/* are type-only so nothing with Node built-ins enters the workflow bundle.
 *
 * - deliveryRunWorkflow: one run of a ticket. Analysis, track, then the change (fast track) or the
 *   plan and its sub-tasks (guided track).
 * - subTaskWorkflow: one sub-task, as a child of its run: implement, AI review with fix rounds,
 *   the requester's decisions, checks, pull request, merge.
 */
import {
  ApplicationFailure,
  CancellationScope,
  condition,
  defineSignal,
  executeChild,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";
import type {
  Analysis,
  AnswerSignal,
  ApprovalSignal,
  CancelSignal,
  DeliveryRunInput,
  Plan,
  QuestionRound,
  RepoRef,
  RunState,
  StepKind,
  StepResult,
  Subtask,
  SubtaskReview,
  SubtaskState,
  Track,
  TrackedFinding,
  Verification,
  WorkItem,
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

type ProgressStatus = "pending" | "running" | "done" | "failed";
interface ProgressItem {
  title: string;
  status: ProgressStatus;
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const slug = (r: RepoRef) => `${r.owner}/${r.name}`;

/** The message of the failure at the bottom of a chain of workflow, activity and application failures. */
function rootMessage(err: unknown): string {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current instanceof Error && current.cause instanceof Error; depth++) current = current.cause;
  return current instanceof Error ? current.message : String(current);
}

/**
 * Run events are written by the run workflow and by its sub-task workflows. The store assigns the
 * sequence; the key (writer and its own counter) makes a retried write a no-op.
 */
function eventWriter(runId: string, writer: string) {
  let n = 0;
  return (type: string, payload: Record<string, unknown> = {}, patch: Record<string, unknown> = {}) =>
    orch.recordEvent({ runId, key: `${writer}:${++n}`, type, actor: "orchestrator", payload, patch });
}

// ---------------------------------------------------------------------------
// Sub-task workflow
// ---------------------------------------------------------------------------

export interface SubTaskInput {
  runId: string;
  workItem: WorkItem;
  track: Track;
  key: string;
  index: number;
  plan: Plan;
  /** The repository this sub-task changes, its default branch, and the sub-task's own branch. */
  repo: RepoRef;
  defaultBranch: string;
  branch: string;
  commitAuthor: { name: string; email: string };
  runConversationId: string;
  /** Guided track: the sub-task has its own conversation under the run (AD-43). Fast track: the run's conversation. */
  ownConversation: boolean;
  /** Steps of the run already done, shown before the sub-task's own steps when it uses the run's progress card. */
  progressPrefix: ProgressItem[];
  /** True when the pull request of this sub-task completes the ticket. */
  closesIssue: boolean;
  maxFixRounds: number;
  prPollSeconds: number;
}

export interface SubTaskResult {
  status: "merged" | "closed" | "handed_over" | "cancelled_by_requester" | "switch_to_guided" | "failed";
  /** Why, in words for the requester. */
  note?: string;
  progress: ProgressItem[];
}

export async function subTaskWorkflow(input: SubTaskInput): Promise<SubTaskResult> {
  const { runId, workItem, key, repo, branch } = input;
  const subtask: Subtask = input.plan.subtasks[input.index]!;
  const total = input.plan.subtasks.length;
  const startedAt = Date.now();
  const emit = eventWriter(runId, key);
  const approvals = new Map<string, ApprovalSignal>();
  setHandler(approvalSignal, (s) => void approvals.set(s.approvalId, s));

  let conversationId = input.runConversationId;
  let runState: RunState = "executing";
  let stepCounter = 0;

  const progress: ProgressItem[] = [
    ...input.progressPrefix.map((p) => ({ ...p })),
    { title: "Implementation", status: "pending" },
    { title: "AI review", status: "pending" },
    { title: "Pull request", status: "pending" },
    { title: "Review and merge", status: "pending" },
  ];
  const setProgress = (title: string, status: ProgressStatus) => {
    const item = progress.find((p) => p.title === title);
    if (item) item.status = status;
  };
  const pushProgress = (headline: string) =>
    orch.updateProgress({
      runId,
      conversationId,
      subtaskKey: input.ownConversation ? key : undefined,
      state: runState,
      headline,
      steps: progress.map((p) => ({ ...p })),
    });

  /** A sub-task state shows as a state of the run too, so both views say what the run is doing or waiting for. */
  const setState = async (state: SubtaskState, run: RunState, headline: string) => {
    runState = run;
    await orch.patchSubtask({ runId, key, patch: { state } });
    await emit("subtask.state_changed", { subtask: key, state }, { state: run });
    await pushProgress(headline);
  };

  const expired = () => Date.now() - startedAt > MAX_RUN_MS;

  const waitForApproval = async (approvalId: string): Promise<ApprovalSignal> => {
    let lastReminder = Date.now();
    for (;;) {
      if (await condition(() => approvals.has(approvalId), "1 hour")) return approvals.get(approvalId)!;
      if (expired()) throw ApplicationFailure.nonRetryable("The sub-task waited too long for a decision");
      if (Date.now() - lastReminder >= REMINDER_MS) {
        lastReminder = Date.now();
        await orch.postNotice({ runId, conversationId, noticeKey: `reminder-${approvalId}`, level: "warning", text: "Reminder: this work is waiting for your decision." });
      }
    }
  };

  const runStep = async (
    kind: StepKind,
    title: string,
    extra: { round: number; findings?: TrackedFinding[]; guidance?: string; implementerSummary?: string; verification?: Verification },
  ): Promise<{ stepId: string; result: StepResult }> => {
    const stepId = `${runId}-${key}-s${++stepCounter}`;
    await steps.prepareStep({
      runId,
      stepId,
      kind,
      title,
      primaryRepo: repo,
      branch,
      subtaskKey: key,
      workItem,
      commitAuthor: input.commitAuthor,
      plan: input.plan,
      subtaskIndex: input.index,
      ...extra,
    });
    await emit("step.started", { stepId, kind, title, subtask: key });
    try {
      await workspaces.createWorkspace({ stepId, runId });
      const result = await stepWait.awaitStep({ stepId });
      await emit(result.status === "succeeded" ? "step.completed" : "step.failed", { stepId, kind, summary: result.summary, subtask: key });
      return { stepId, result };
    } finally {
      await CancellationScope.nonCancellable(() => workspaces.destroyWorkspace({ stepId }));
    }
  };

  /** Ends the sub-task without a merged pull request: its state, its open decisions and the steps still running. */
  const end = async (status: SubTaskResult["status"], state: SubtaskState, note: string): Promise<SubTaskResult> => {
    for (const p of progress) if (p.status === "running") p.status = "failed";
    // The sub-task's own progress card shows how the sub-task ended; the run's card is finished by the run workflow.
    if (input.ownConversation) runState = state === "failed" ? "failed" : state === "cancelled" ? "cancelled" : "closed";
    await orch.patchSubtask({ runId, key, patch: { state } });
    await orch.closeOutApprovals({ runId, subtaskKey: key });
    await emit(`subtask.${state}`, { subtask: key, note });
    await pushProgress(note);
    return { status, note, progress };
  };

  const findingText = (f: TrackedFinding) => `- **${f.severity}**: ${f.title}${f.file ? ` (\`${f.file}${f.line ? `:${f.line}` : ""}\`)` : ""}`;

  /** The pull request description: the change, the AI review and what the product's commands reported (FR-R3). */
  const pullRequestBody = (review: SubtaskReview, verification: Verification | undefined, fixRounds: number, unresolved: boolean): string => {
    const sameRepo = slug(repo).toLowerCase() === slug(workItem.repo).toLowerCase();
    const issue = `${sameRepo ? "" : slug(workItem.repo)}#${workItem.number}`;
    const blocking = review.open.filter((f) => f.severity !== "minor");
    const minor = review.open.filter((f) => f.severity === "minor");
    return [
      subtask.description,
      "",
      input.closesIssue ? `Closes ${issue}` : `Part of ${issue}`,
      ...(total > 1 ? [`Sub-task ${input.index + 1} of ${total}: ${subtask.title}`] : []),
      "",
      "### AI review",
      review.summary,
      "",
      unresolved
        ? `**Opened with ${blocking.length} unresolved finding(s), by the requester's decision,** after ${fixRounds} fix round(s).`
        : `No blocking or major finding is open after ${review.rounds} review round(s) and ${fixRounds} fix round(s).`,
      ...(blocking.length ? ["", "**Unresolved findings**", ...blocking.map((f) => `${findingText(f)}: ${f.explanation}`)] : []),
      ...(review.resolved.length ? ["", "**Fixed during the review**", ...review.resolved.map(findingText)] : []),
      ...(minor.length ? ["", "**Minor notes**", ...minor.map((f) => `${findingText(f)}: ${f.explanation}`)] : []),
      ...(review.criteria.length
        ? ["", "**Acceptance criteria, as judged by the reviewer agent**", ...review.criteria.map((c) => `- [${c.met ? "x" : " "}] ${c.criterion}${c.note ? ` (${c.note})` : ""}`)]
        : []),
      "",
      "### Checks run on the change",
      ...(verification?.commands.length
        ? verification.commands.map((c) => `- ${c.name} (\`${c.command}\`): ${c.exitCode === 0 ? "passed" : `**failed** with exit code ${c.exitCode}`}`)
        : ["- No build or test command is configured for this repository."]),
      "",
      "---",
      `🤖 Generated by the orchestrator (run \`${runId}\`, ${input.track} track) on behalf of @${workItem.requester.login}.`,
      "The review above was written by an AI reviewer agent; this pull request still needs a person's review.",
    ].join("\n");
  };

  const body = async (): Promise<SubTaskResult> => {
    const init = await orch.initSubtask({
      runId,
      key,
      index: input.index,
      total,
      title: subtask.title,
      description: subtask.description,
      acceptanceCriteria: subtask.acceptanceCriteria,
      repo,
      branch,
      ownConversation: input.ownConversation,
      runConversationId: input.runConversationId,
    });
    conversationId = init.conversationId;
    await emit("subtask.started", { subtask: key, title: subtask.title, repository: slug(repo), branch }, { branch });
    const { baseCommit } = await steps.prepareSubtaskRepo({ runId, subtaskKey: key, repo, defaultBranch: input.defaultBranch, branch });
    await orch.patchSubtask({ runId, key, patch: { baseCommit } });

    // Implementation in a sandbox, on the sub-task's own branch.
    setProgress("Implementation", "running");
    await setState("implementing", "executing", "Implementing");
    let attempt = await runStep("implement", `Implement: ${subtask.title}`, { round: 0 });
    if (attempt.result.status !== "succeeded") {
      await pushProgress("Retrying the implementation");
      attempt = await runStep("implement", `Implement: ${subtask.title} (retry)`, { round: 0 });
    }
    if (attempt.result.status !== "succeeded") throw ApplicationFailure.nonRetryable(`The implementation failed: ${attempt.result.error ?? attempt.result.summary}`);
    await steps.applyStepResult({ runId, subtaskKey: key, stepId: attempt.stepId, branch });
    let summary = attempt.result.summary;
    let verification = attempt.result.verification;
    setProgress("Implementation", "done");

    // AI review of every change, with bounded fix rounds (FR-R1, FR-R2). The reviewer starts from a clean workspace.
    let fixRounds = 0;
    let budget = input.maxFixRounds;
    let earlier: TrackedFinding[] = [];
    let guidance: string | undefined;
    let review: SubtaskReview;
    let unresolved = false;
    let openPullRequest = true;
    for (;;) {
      setProgress("AI review", "running");
      await setState("reviewing", "reviewing", fixRounds ? `AI review after fix round ${fixRounds}` : "AI review");
      const reviewed = await runStep("review", fixRounds ? `Review after fix round ${fixRounds}` : "Review", {
        round: fixRounds,
        findings: earlier,
        implementerSummary: summary,
        verification,
      });
      if (reviewed.result.status !== "succeeded" || !reviewed.result.review) {
        throw ApplicationFailure.nonRetryable(`The AI review failed: ${reviewed.result.error ?? reviewed.result.summary}`);
      }
      const outcome = await orch.recordReview({ runId, key, conversationId, report: reviewed.result.review, verification: verification ?? null, fixRounds, budget });
      review = outcome.review;
      await emit("review.completed", { subtask: key, round: fixRounds, open: review.open.length, toFix: outcome.toFix.length });
      if (outcome.toFix.length === 0) break;

      if (fixRounds >= budget) {
        // Still blocking after the fix rounds: the requester decides (FR-R2).
        await setState("awaiting_decision", "awaiting_approval", "Waiting for your decision on the review findings");
        const { approvalId } = await orch.requestFindingsDecision({ runId, key, conversationId, findings: outcome.toFix, fixRounds });
        await emit("review.unresolved", { subtask: key, approvalId, findings: outcome.toFix.length, fixRounds });
        const decision = await waitForApproval(approvalId);
        await emit("review.decided", { subtask: key, approvalId, decision: decision.decision });
        if (decision.decision === "cancel") return end("cancelled_by_requester", "cancelled", "Cancelled by your decision on the review findings; nothing was pushed.");
        if (decision.decision === "open" || decision.decision === "take_over") {
          unresolved = true;
          openPullRequest = decision.decision === "open";
          await orch.setReviewStatus({ runId, key, conversationId, status: "accepted_with_findings" });
          break;
        }
        // Guide and retry: one more fix round with the requester's guidance.
        guidance = decision.feedback;
        budget += 1;
        await orch.setReviewStatus({ runId, key, conversationId, status: "fixing" });
      }

      fixRounds++;
      setProgress("Implementation", "running");
      await setState("implementing", "executing", `Fixing the review findings (round ${fixRounds})`);
      await emit("review.fix_requested", { subtask: key, round: fixRounds, findings: outcome.toFix.length });
      const fix = await runStep("implement", `Fix round ${fixRounds}: ${subtask.title}`, { round: fixRounds, findings: outcome.toFix, guidance });
      if (fix.result.status !== "succeeded") throw ApplicationFailure.nonRetryable(`Fix round ${fixRounds} failed: ${fix.result.error ?? fix.result.summary}`);
      await steps.applyStepResult({ runId, subtaskKey: key, stepId: fix.stepId, branch });
      await orch.patchSubtask({ runId, key, patch: { fixRounds } });
      summary = fix.result.summary;
      verification = fix.result.verification ?? verification;
      earlier = outcome.toFix;
      guidance = undefined;
      setProgress("Implementation", "done");
    }
    setProgress("AI review", "done");

    // Checks before anything leaves the orchestrator. They do not depend on what any agent said.
    setProgress("Pull request", "running");
    await setState("publishing", "publishing", "Checking the change");
    const squashed = await steps.squashSubtask({
      runId,
      subtaskKey: key,
      branch,
      baseCommit,
      title: subtask.title,
      summary,
      requester: workItem.requester.login,
      commitAuthor: input.commitAuthor,
    });
    await orch.patchSubtask({ runId, key, patch: { headCommit: squashed.headCommit } });
    const inspection = await steps.inspectChanges({ runId, subtaskKey: key, repo, branch, baseCommit, checkLimits: input.track === "fast" && openPullRequest });
    if (inspection.changedFiles.length === 0) throw ApplicationFailure.nonRetryable("The agents produced no changes");
    if (inspection.secrets.length) {
      const where = inspection.secrets.map((s) => `${s.kind} in ${s.file}:${s.line}`).join("; ");
      throw ApplicationFailure.nonRetryable(`Possible secrets in the changes (${where}); nothing was pushed`);
    }
    if (inspection.limits.length) {
      // The analysis was an estimate: the change is bigger than the fast track allows (FR-A2).
      await setState("awaiting_decision", "awaiting_approval", "The change is bigger than the fast track allows; waiting for your decision");
      const { approvalId } = await orch.requestLimitsDecision({ runId, key, conversationId, reasons: inspection.limits, files: inspection.changedFiles });
      await emit("track.limits_exceeded", { subtask: key, approvalId, reasons: inspection.limits });
      const decision = await waitForApproval(approvalId);
      await emit("track.limits_decided", { subtask: key, approvalId, decision: decision.decision });
      if (decision.decision === "guided") return end("switch_to_guided", "cancelled", "Switched to the guided track; the fast-track change was set aside and nothing was pushed.");
      if (decision.decision === "cancel") return end("cancelled_by_requester", "cancelled", "Cancelled by your decision; nothing was pushed.");
    }
    if (inspection.risk.reasons.length) {
      const { approvalId } = await orch.requestRiskApproval({ runId, conversationId, subtaskKey: key, reasons: inspection.risk.reasons, files: inspection.risk.files });
      await emit("approval.requested", { kind: "risk", approvalId, reasons: inspection.risk.reasons, subtask: key });
      await setState("awaiting_decision", "awaiting_approval", "Waiting for approval of a high-risk change");
      const decision = await waitForApproval(approvalId);
      if (decision.decision !== "approve") {
        await emit("risk.rejected", { approvalId, subtask: key });
        return end("cancelled_by_requester", "cancelled", "High-risk change rejected; nothing was pushed.");
      }
      await emit("risk.approved", { approvalId, subtask: key });
    }

    await setState("publishing", "publishing", "Publishing the change");
    await integ.pushBranch({ runId, subtaskKey: key, repo, branch });
    await emit("scm.branch_pushed", { subtask: key, repository: slug(repo), branch });
    if (!openPullRequest) {
      // Take over: the branch is the requester's to continue; no pull request is opened.
      return end("handed_over", "handed_over", `The branch ${branch} was pushed to ${slug(repo)} without a pull request; it is yours to continue.`);
    }

    const title = total > 1 ? `[agent] ${workItem.title} (${input.index + 1}/${total}): ${subtask.title}` : `[agent] ${workItem.title}`;
    const pr = await integ.openPullRequest({
      repo,
      branch,
      base: input.defaultBranch,
      title: clip(title, 250),
      body: pullRequestBody(review, verification, fixRounds, unresolved),
    });
    await orch.patchSubtask({ runId, key, patch: { prNumber: pr.number, prUrl: pr.url } });
    await emit("scm.pr_opened", { subtask: key, number: pr.number, url: pr.url, repository: slug(repo), unresolved }, { prNumber: pr.number, prUrl: pr.url });
    await orch.postPullRequestCard({ runId, conversationId, subtaskKey: key, number: pr.number, url: pr.url, title: pr.title, state: "open" });
    await integ.commentOnIssue({
      repo: workItem.repo,
      number: workItem.number,
      key: `run=${runId}:pr:${key}`,
      body: `🤖 Pull request opened${total > 1 ? ` for sub-task ${input.index + 1} of ${total}` : ""}: ${pr.url}`,
    });
    setProgress("Pull request", "done");
    setProgress("Review and merge", "running");
    await setState("pr_open", "awaiting_merge", "Waiting for review and merge on GitHub");

    // Human review and merge happen on GitHub; poll until the pull request is merged or closed.
    for (;;) {
      await sleep(input.prPollSeconds * 1000);
      const prState = await integ.getPullRequestState({ repo, number: pr.number });
      if (prState === "open") {
        if (expired()) throw ApplicationFailure.nonRetryable("The pull request was not merged within 30 days");
        continue;
      }
      await orch.postPullRequestCard({ runId, conversationId, subtaskKey: key, number: pr.number, url: pr.url, title: pr.title, state: prState });
      await emit(prState === "merged" ? "scm.pr_merged" : "scm.pr_closed", { subtask: key, number: pr.number });
      if (prState !== "merged") return end("closed", "closed", "Pull request closed without merging.");
      setProgress("Review and merge", "done");
      if (input.ownConversation) runState = "completed";
      await orch.patchSubtask({ runId, key, patch: { state: "merged" } });
      await emit("subtask.merged", { subtask: key });
      await pushProgress("Pull request merged.");
      return { status: "merged", progress };
    }
  };

  try {
    return await body();
  } catch (err) {
    if (isCancellation(err)) {
      // The run was cancelled: record it, then let the cancellation reach the run workflow.
      await CancellationScope.nonCancellable(async () => {
        await orch.patchSubtask({ runId, key, patch: { state: "cancelled" } });
        await orch.closeOutApprovals({ runId, subtaskKey: key });
      });
      throw err;
    }
    const message = rootMessage(err);
    return CancellationScope.nonCancellable(async () => ({ ...(await end("failed", "failed", `Failed: ${message}`)), note: message }));
  }
}

// ---------------------------------------------------------------------------
// Run workflow
// ---------------------------------------------------------------------------

export async function deliveryRunWorkflow(input: DeliveryRunInput): Promise<RunState> {
  const { runId, workItem } = input;
  const repo = workItem.repo;
  const startedAt = Date.now();
  const emit = eventWriter(runId, "run");

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

  // Progress card of the run. On the fast track the single change continues it; on the guided track
  // each sub-task is one line here and has its own card in its own conversation.
  let progress: ProgressItem[] = [{ title: "Analysis", status: "pending" }];
  const setProgress = (title: string, status: ProgressStatus) => {
    const item = progress.find((p) => p.title === title);
    if (item) item.status = status;
  };
  const pushProgress = (headline: string) => orch.updateProgress({ runId, conversationId, state, headline, steps: progress.map((p) => ({ ...p })) });

  const setState = async (next: RunState, headline: string) => {
    state = next;
    await emit("run.state_changed", { state: next }, { state: next });
    await pushProgress(headline);
  };

  const expired = () => Date.now() - startedAt > MAX_RUN_MS;

  const runStep = async (
    kind: StepKind,
    title: string,
    extra: { primaryRepo: RepoRef; analysis?: Analysis; questionRounds?: QuestionRound[]; feedback?: string },
  ): Promise<{ stepId: string; result: StepResult }> => {
    const stepId = `${runId}-s${++stepCounter}`;
    await steps.prepareStep({
      runId,
      stepId,
      kind,
      title,
      branch: "",
      workItem,
      commitAuthor: { name: workItem.requester.login, email: `${workItem.requester.login}@users.noreply.github.com` },
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
    if (conversationId) await orch.closeOutApprovals({ runId });
    await emit(`run.${final}`, { text, writeBackError }, { state: final, ...(final === "failed" ? { error: text } : {}) });
    if (conversationId) {
      for (const p of progress) if (p.status === "running") p.status = final === "completed" ? "done" : "failed";
      await pushProgress(text);
      await orch.postNotice({ runId, conversationId, noticeKey: "final", level, text });
      if (writeBackError) {
        await orch.postNotice({ runId, conversationId, noticeKey: "writeback", level: "warning", text: `Could not update the GitHub issue: ${writeBackError}` });
      }
    }
  };

  /** Posts questions in the conversation and on the ticket, and waits for the requester's answer from either. */
  const askRequester = async (questions: string[], intro: string, eventPrefix: "analysis" | "planning"): Promise<AnswerSignal> => {
    const askedAt = new Date().toISOString();
    const { approvalId } = await orch.askQuestions({ runId, conversationId, questions });
    await integ.commentOnIssue({
      repo,
      number: workItem.number,
      key: `run=${runId}:questions=${approvalId}`,
      body: `🤖 ${intro} Reply here or in the orchestrator web app:\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
    });
    await emit(`${eventPrefix}.question_asked`, { approvalId, questions });
    await setState("awaiting_answers", "Waiting for your answers");
    const answer = await waitForAnswer(approvalId, askedAt);
    await emit(`${eventPrefix}.answered`, { approvalId, source: answer.source });
    return answer;
  };

  // The delivery skeleton ------------------------------------------------------
  const deliver = async (): Promise<void> => {
    const init = await orch.initRun({ runId, workItem, originConversationId: input.conversationId });
    conversationId = init.conversationId;
    const prPollSeconds = input.prPollSeconds ?? init.settings.prPollSeconds;
    await emit(
      "run.created",
      { repo: slug(repo), issue: workItem.number, homeProduct: init.homeProduct, catalog: init.catalogHash },
      { state: "intake", conversationId },
    );
    await pushProgress("Picked up");
    await integ.claimIssue({ repo, number: workItem.number, runId });
    await emit("intake.claimed", {});

    // Preliminary analysis by the analyst agent (FR-A1), with clarifying questions (FR-A4).
    let questionRounds: QuestionRound[] = [];
    let analysis: Analysis | undefined;
    for (let attempt = 1; !analysis; attempt++) {
      if (attempt > 5) throw ApplicationFailure.nonRetryable("The analysis did not converge after 5 attempts");
      setProgress("Analysis", "running");
      await setState("analysing", attempt === 1 ? "Analysing the work item" : "Analysing again with your answers");
      const { result } = await runStep("analyse", attempt === 1 ? "Analysis" : `Analysis (round ${attempt})`, { primaryRepo: repo, questionRounds });
      if (result.status !== "succeeded" || !result.analysis) throw ApplicationFailure.nonRetryable(`The analysis failed: ${result.error ?? result.summary}`);
      if (!result.analysis.ready) {
        const questions = result.analysis.questions;
        if (!questions.length) throw ApplicationFailure.nonRetryable("The analyst returned neither an analysis nor questions");
        if (questionRounds.length >= 3) throw ApplicationFailure.nonRetryable("The work item is still unclear after three rounds of questions");
        const answer = await askRequester(questions, "Before the work can start, the analyst agent needs a few answers.", "analysis");
        questionRounds = [...questionRounds, { questions, answer: answer.answer }];
        continue;
      }
      analysis = result.analysis;
    }
    setProgress("Analysis", "done");

    // The analyst proposes a track; the rules decide which one is allowed (AD-32).
    const { decision, products, repositories } = await orch.recordAnalysis({ runId, conversationId, analysis, labels: workItem.labels ?? [] });
    let track: Track = decision.track;
    await emit("analysis.completed", { size: analysis.size, proposedTrack: decision.proposed }, { analysis });
    await emit("products.identified", { products, repositories }, { products });
    await emit("track.set", { track, proposed: decision.proposed, reasons: decision.reasons }, { track, trackReasons: decision.reasons });
    await integ.setTrackLabel({ repo, number: workItem.number, track });
    await integ.commentOnIssue({
      repo,
      number: workItem.number,
      key: `run=${runId}:analysis`,
      body: [
        `🤖 **Analysis** — track: **${track}**`,
        "",
        analysis.understanding,
        "",
        "**Products involved**",
        ...analysis.products.map((p) => `- **${p.product}** (${p.repositories.join(", ")}): ${p.changes}`),
        "",
        `**Size:** ${analysis.size}`,
        "",
        "**Why this track**",
        ...decision.reasons.map((r) => `- ${r}`),
        ...(track === "fast" && analysis.approach ? ["", `**Approach:** ${analysis.approach}`] : []),
      ].join("\n"),
    });

    // Until the design session and sub-tasks per repository arrive (increments 3 and 4), work across repositories stops here.
    if (repositories.length !== 1) {
      await finish(
        "closed",
        `This work needs changes in ${repositories.length} repositories (${repositories.join(", ")}). ` +
          "Designing and building across products arrive with the next increments of iteration 2; nothing was changed.",
        "info",
      );
      return;
    }
    const [buildOwner, buildName] = repositories[0]!.split("/") as [string, string];
    const buildRepo: RepoRef = { owner: buildOwner, name: buildName };
    const context = await integ.lookupContext({ runId, workItem, repo: buildRepo });

    /** Runs one sub-task of a plan as a child workflow and waits for how it ended. */
    const runSubtask = (plan: Plan, index: number, opts: { key: string; branch: string; ownConversation: boolean; closesIssue: boolean; prefix: ProgressItem[] }) =>
      executeChild(subTaskWorkflow, {
        workflowId: `subtask:${runId}:${opts.key}`,
        args: [
          {
            runId,
            workItem,
            track,
            key: opts.key,
            index,
            plan,
            repo: buildRepo,
            defaultBranch: context.defaultBranch,
            branch: opts.branch,
            commitAuthor: context.commitAuthor,
            runConversationId: conversationId,
            ownConversation: opts.ownConversation,
            progressPrefix: opts.prefix,
            closesIssue: opts.closesIssue,
            maxFixRounds: init.settings.maxFixRounds,
            prPollSeconds,
          },
        ],
      });

    if (track === "fast") {
      // Fast track (FR-P6, FR-R5): the analyst's approach is the plan and nobody has to approve it.
      // One change: implemented, reviewed by the reviewer agent, checked against the fast-track limits, published.
      const plan: Plan = {
        summary: clip(analysis.approach || analysis.understanding, 2000),
        subtasks: [
          {
            title: clip(workItem.title.length >= 3 ? workItem.title : `Change for #${workItem.number}`, 200),
            description: [analysis.understanding, analysis.approach ? `Approach: ${analysis.approach}` : ""].filter(Boolean).join("\n\n"),
            acceptanceCriteria: analysis.acceptanceCriteria,
          },
        ],
      };
      await emit("plan.derived", { subtasks: 1 }, { plan });
      state = "executing";
      const result = await runSubtask(plan, 0, { key: "change", branch: context.branch, ownConversation: false, closesIssue: true, prefix: progress });
      progress = result.progress;
      if (result.status === "merged") return finish("completed", "Pull request merged. Done.", "success");
      if (result.status === "closed") return finish("closed", result.note ?? "Pull request closed without merging.", "info");
      if (result.status === "handed_over") return finish("closed", result.note ?? "The branch was pushed without a pull request.", "info");
      if (result.status === "cancelled_by_requester") return finish("cancelled", result.note ?? "Cancelled by your decision.", "warning");
      if (result.status === "failed") throw ApplicationFailure.nonRetryable(result.note ?? "The change failed");
      // The change turned out bigger than the fast track allows and the requester chose the guided track (FR-A2).
      track = "guided";
      progress = [{ title: "Analysis", status: "done" }];
      await emit("track.changed", { track, reason: "The requester switched after the change exceeded the fast-track limits" }, { track });
      await integ.setTrackLabel({ repo, number: workItem.number, track });
    }

    // Guided track. Bridge until the design session with the architect agent exists (increment 3):
    // a planning agent proposes the plan and the requester approves it.
    progress.push({ title: "Plan", status: "pending" }, { title: "Plan approval", status: "pending" });
    await orch.postNotice({
      runId,
      conversationId,
      noticeKey: "guided-bridge",
      level: "info",
      text: "Guided track: the design session with the architect agent arrives in a later increment. Until then a planning agent proposes the plan for your approval.",
    });
    let plan: Plan | undefined;
    let feedback: string | undefined;
    for (let attempt = 1; !plan; attempt++) {
      if (attempt > 6) throw ApplicationFailure.nonRetryable("Planning did not converge after 6 attempts");
      setProgress("Plan", "running");
      await setState("planning", attempt === 1 ? "Planning" : "Re-planning");
      const { result } = await runStep("plan", attempt === 1 ? "Plan" : `Re-plan (attempt ${attempt})`, { primaryRepo: buildRepo, analysis, questionRounds, feedback });
      if (result.status !== "succeeded" || !result.assessment) throw ApplicationFailure.nonRetryable(`Planning failed: ${result.error ?? result.summary}`);
      const assessment = result.assessment;
      if (!assessment.ready || !assessment.plan) {
        if (!assessment.questions.length) throw ApplicationFailure.nonRetryable("The planner returned neither a plan nor questions");
        if (questionRounds.length >= 3) throw ApplicationFailure.nonRetryable("The work item is still unclear after three rounds of questions");
        const answer = await askRequester(assessment.questions, "Before planning, the agent needs a few answers.", "planning");
        questionRounds = [...questionRounds, { questions: assessment.questions, answer: answer.answer }];
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
      const planDecision = await waitForApproval(approvalId);
      if (planDecision.decision === "approve") {
        plan = assessment.plan;
        await emit("plan.approved", { approvalId });
      } else if (planDecision.decision === "changes") {
        feedback = planDecision.feedback ?? "";
        await emit("plan.changes_requested", { approvalId, feedback });
        setProgress("Plan approval", "pending");
      } else {
        await emit("plan.rejected", { approvalId });
        return finish("cancelled", "Plan rejected; nothing was changed.", "warning");
      }
    }
    setProgress("Plan approval", "done");

    // Sub-tasks, one at a time, each on its own branch with its own pull request and conversation (FR-B1, FR-C2).
    // Until sub-tasks can build on each other's approved changes (increment 4), the next one starts
    // from the default branch once the previous pull request is merged.
    const count = plan.subtasks.length;
    const titles = plan.subtasks.map((s, i) => `${i + 1}. ${s.title}`);
    progress.push(...titles.map((title) => ({ title, status: "pending" as ProgressStatus })));
    for (let i = 0; i < count; i++) {
      setProgress(titles[i]!, "running");
      await setState("executing", `Sub-task ${i + 1} of ${count}`);
      const result = await runSubtask(plan, i, {
        key: `s${i + 1}`,
        branch: count > 1 ? `${context.branch}-s${i + 1}` : context.branch,
        ownConversation: true,
        closesIssue: i === count - 1,
        prefix: [],
      });
      if (result.status === "merged") {
        setProgress(titles[i]!, "done");
        continue;
      }
      setProgress(titles[i]!, "failed");
      const rest = count - i - 1;
      const notStarted = rest ? ` The remaining ${rest} sub-task(s) were not started.` : "";
      if (result.status === "failed") throw ApplicationFailure.nonRetryable(`Sub-task ${i + 1} failed: ${result.note ?? "unknown error"}`);
      const text = `Sub-task ${i + 1}: ${result.note ?? result.status}${notStarted}`;
      if (result.status === "cancelled_by_requester") return finish("cancelled", text, "warning");
      return finish("closed", text, "info");
    }
    await finish("completed", count > 1 ? `All ${count} sub-tasks are merged. Done.` : "Pull request merged. Done.", "success");
  };

  try {
    await main.run(deliver);
  } catch (err) {
    if (isCancellation(err) && cancel.reason) {
      const reason = cancel.reason;
      await CancellationScope.nonCancellable(() => finish("cancelled", `Cancelled: ${reason}`, "warning"));
    } else {
      const message = rootMessage(err);
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
