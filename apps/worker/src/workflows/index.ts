/**
 * Temporal workflows. Deterministic code only: all I/O and LLM work happens in activities.
 * Imports from @orch/* are type-only so nothing with Node built-ins enters the workflow bundle.
 *
 * - deliveryRunWorkflow: one run of a ticket. Analysis, track, then the change (fast track) or the
 *   design session, the approved plan and its sub-tasks (guided track).
 * - designSessionWorkflow: the design session of a guided run, as a child of its run: turns of the
 *   architect agent with the requester, plan versions, the plan's approval.
 * - subTaskWorkflow: one sub-task, as a child of its run: implement, AI review with fix rounds,
 *   the requester's check of the change (guided track), checks, pull request, merge. A sub-task that
 *   depends on another starts once that one's pull request is open: stacked on its branch in the same
 *   repository, with its change readable in another one (AD-41).
 */
import {
  ApplicationFailure,
  CancellationScope,
  condition,
  defineSignal,
  executeChild,
  getExternalWorkflowHandle,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
  startChild,
  workflowInfo,
} from "@temporalio/workflow";
import type {
  Analysis,
  AnswerSignal,
  ApprovalSignal,
  CancelSignal,
  CriterionEvidence,
  DeliveryRunInput,
  DependencyRef,
  FreshSessionSignal,
  PlanSubtask,
  DesignTurnInput,
  DesignTurnResult,
  HandoffPlan,
  Plan,
  QuestionRound,
  RepoRef,
  RequesterMessageSignal,
  RunState,
  StepKind,
  StepResult,
  Subtask,
  SubtaskPublishedSignal,
  SubtaskReview,
  SubtaskState,
  Track,
  TrackRequest,
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
export const requesterMessageSignal = defineSignal<[RequesterMessageSignal]>("requesterMessage");
export const subtaskPublishedSignal = defineSignal<[SubtaskPublishedSignal]>("subtaskPublished");
/** The requester switches the track (FR-A3): sent to the run, which passes it to the change or the design session going on. */
export const changeTrackSignal = defineSignal<[TrackRequest]>("changeTrack");
export const switchTrackSignal = defineSignal<[TrackRequest]>("switchTrack");
/** The requester starts the design session again from the current plan (R-14). */
export const freshSessionSignal = defineSignal<[FreshSessionSignal]>("freshSession");

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

type ProgressStatus = "pending" | "running" | "done" | "failed" | "skipped";
interface ProgressItem {
  title: string;
  status: ProgressStatus;
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
/** "Title:" and one "- item" line per item; nothing when there are no items. */
const bullets = (title: string, items: string[]) => (items.length ? [`${title}:`, ...items.map((i) => `- ${i}`)] : []);
const slug = (r: RepoRef) => `${r.owner}/${r.name}`;

/** The message of the failure at the bottom of a chain of workflow, activity and application failures. */
function rootMessage(err: unknown): string {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current instanceof Error && current.cause instanceof Error; depth++) current = current.cause;
  return current instanceof Error ? current.message : String(current);
}

/** The type of the application failure at the bottom of a chain of workflow, activity and application failures. */
function failureType(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof ApplicationFailure && current.type) return current.type;
    current = current.cause;
  }
  return undefined;
}

/** A step that failed because of the model provider (rate limit, overload, outage, network) is worth waiting out (§18). */
const PROVIDER_TROUBLE =
  /\b(429|5\d\d)\b|rate.?limit|overloaded|too many requests|temporarily unavailable|service unavailable|timed? ?out|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|fetch failed|network error/i;
const describeWait = (seconds: number) => (seconds < 90 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`);

/**
 * Runs an agent step until it succeeds or its chances are used up. Trouble with the model provider is waited out
 * with growing pauses (`waits`, in seconds); any other failure gets one more try when `retryOnce` is set.
 */
async function stepWithRetries(
  run: (attempt: number) => Promise<{ stepId: string; result: StepResult }>,
  opts: { waits: number[]; retryOnce: boolean; onWait: (seconds: number, n: number) => Promise<void>; onRetry: () => Promise<void> },
): Promise<{ stepId: string; result: StepResult }> {
  let waited = 0;
  let retried = false;
  for (let attempt = 1; ; attempt++) {
    const outcome = await run(attempt);
    if (outcome.result.status === "succeeded") return outcome;
    const error = `${outcome.result.error ?? ""} ${outcome.result.summary}`;
    if (PROVIDER_TROUBLE.test(error) && waited < opts.waits.length) {
      const seconds = opts.waits[waited++]!;
      await opts.onWait(seconds, waited);
      await sleep(seconds * 1000);
      continue;
    }
    if (opts.retryOnce && !retried) {
      retried = true;
      await opts.onRetry();
      continue;
    }
    return outcome;
  }
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
  /** The sub-issue that mirrors this sub-task on the ticket (FR-P5). */
  ticket?: { repo: RepoRef; number: number; url: string };
  /** Guided track: the requester checks the change before its pull request opens (FR-R4). */
  diffCheck: boolean;
  /** Same repository: the sub-task whose approved change this one's branch starts from (AD-41). */
  stackedOn?: DependencyRef;
  /** Other repositories: approved changes this sub-task builds on, readable in its workspaces. */
  references: DependencyRef[];
  /** Every sub-task this one depends on whose pull request is still open: the merge order (FR-M5). */
  mergeAfter: DependencyRef[];
  maxFixRounds: number;
  prPollSeconds: number;
  /** Pauses, in seconds, before a step that failed because of the model provider is tried again. */
  modelRetrySeconds: number[];
}

export interface SubTaskResult {
  status: "merged" | "closed" | "handed_over" | "dropped" | "cancelled_by_requester" | "switch_to_guided" | "failed";
  /** Why, in words for the requester. */
  note?: string;
  progress: ProgressItem[];
  /** For a switch to the guided track: who asked for it and why (FR-A3). */
  switch?: { by: string; reason: string };
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

  // A switch to the guided track stops the work at once, as long as nothing has been pushed (FR-A3).
  const building = new CancellationScope();
  let publishing = false;
  let switched: TrackRequest | null = null;
  setHandler(switchTrackSignal, async (request) => {
    if (switched) return;
    if (publishing || request.track !== "guided") {
      await orch.postNotice({
        runId,
        conversationId,
        noticeKey: `track-refused-${key}`,
        level: "warning",
        text: "The change is already being published: the track can no longer be switched.",
      });
      return;
    }
    switched = request;
    building.cancel();
  });
  /** The commit the sub-task's own change starts from, and the commit that holds it. */
  let baseCommit = "";
  let headCommit = "";

  const progress: ProgressItem[] = [
    ...input.progressPrefix.map((p) => ({ ...p })),
    { title: "Implementation", status: "pending" },
    { title: "AI review", status: "pending" },
    ...(input.diffCheck ? [{ title: "Your check", status: "pending" as ProgressStatus }] : []),
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
      changeBase: baseCommit,
      references: input.references,
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

  /** An agent step with the retries of §18: the model provider waited out, any other failure tried once more. */
  const attemptStep = (kind: StepKind, title: string, extra: Parameters<typeof runStep>[2]) =>
    stepWithRetries((n) => runStep(kind, n === 1 ? title : `${title} (attempt ${n})`, extra), {
      waits: input.modelRetrySeconds,
      retryOnce: true,
      onWait: async (seconds, n) => {
        await emit("step.retry_scheduled", { subtask: key, kind, reason: "model provider", waitSeconds: seconds, retry: n });
        await pushProgress(`Waiting for the model provider: trying again in ${describeWait(seconds)}`);
      },
      onRetry: () => pushProgress(kind === "review" ? "Retrying the review" : "Retrying the implementation"),
    });

  /**
   * The token cannot reach the repository (AD-42): the sub-task waits for the requester, who fixes the access and
   * retries, or cancels. Nothing that needs the access has happened yet.
   */
  const askBlocked = async (what: string, problems: string[]): Promise<"retry" | "cancel"> => {
    await setState("awaiting_decision", "awaiting_approval", `Blocked: cannot ${what}`);
    const { approvalId } = await orch.requestBlockedDecision({ runId, key, conversationId, what, problems });
    await emit("access.blocked", { subtask: key, approvalId, what, problems });
    const decision = await waitForApproval(approvalId);
    await emit("access.decided", { subtask: key, approvalId, decision: decision.decision });
    return decision.decision === "cancel" ? "cancel" : "retry";
  };

  /** A publishing step that the token may be refused: the sub-task then waits for the requester instead of failing. */
  const withAccess = async <T>(what: string, fn: () => Promise<T>): Promise<T | "cancel"> => {
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (failureType(err) !== "AccessDenied") throw err;
        if ((await askBlocked(what, [rootMessage(err)])) === "cancel") return "cancel";
        await setState("publishing", "publishing", "Publishing the change");
      }
    }
  };

  /** Ends the sub-task without a merged pull request: its state, its open decisions and the steps still running. */
  const end = async (status: SubTaskResult["status"], state: SubtaskState, note: string): Promise<SubTaskResult> => {
    for (const p of progress) if (p.status === "running") p.status = state === "dropped" ? "skipped" : "failed";
    // The sub-task's own progress card shows how the sub-task ended; the run's card is finished by the run workflow.
    if (input.ownConversation) runState = state === "failed" ? "failed" : state === "cancelled" ? "cancelled" : "closed";
    await orch.patchSubtask({ runId, key, patch: { state } });
    await orch.closeOutApprovals({ runId, subtaskKey: key });
    await emit(`subtask.${state}`, { subtask: key, note });
    await pushProgress(note);
    return { status, note, progress };
  };

  const findingText = (f: TrackedFinding) => `- **${f.severity}**: ${f.title}${f.file ? ` (\`${f.file}${f.line ? `:${f.line}` : ""}\`)` : ""}`;
  /** A pull request of this story as it is written in another pull request or on the ticket. */
  const prRef = (d: DependencyRef) => `${slug(d.repo).toLowerCase() === slug(repo).toLowerCase() ? "" : slug(d.repo)}#${d.prNumber}`;

  /** The pull request description: the change, the AI review and what the product's commands reported (FR-R3, FR-M5). */
  const pullRequestBody = (review: SubtaskReview, verification: Verification | undefined, fixRounds: number, unresolved: boolean, stacked: DependencyRef | null): string => {
    const sameRepo = slug(repo).toLowerCase() === slug(workItem.repo).toLowerCase();
    const issue = `${sameRepo ? "" : slug(workItem.repo)}#${workItem.number}`;
    const blocking = review.open.filter((f) => f.severity !== "minor");
    const minor = review.open.filter((f) => f.severity === "minor");
    return [
      subtask.description,
      "",
      input.closesIssue ? `Closes ${issue}` : `Part of ${issue}`,
      ...(input.ticket ? [`Closes ${slug(input.ticket.repo).toLowerCase() === slug(repo).toLowerCase() ? "" : slug(input.ticket.repo)}#${input.ticket.number}`] : []),
      ...(total > 1 ? [`Sub-task ${input.index + 1} of ${total}: ${subtask.title}`] : []),
      ...(input.mergeAfter.length
        ? ["", "### Merge order", ...input.mergeAfter.map((d) => `- Merge after ${prRef(d)} (${d.title}).`)]
        : []),
      ...(stacked
        ? [`This pull request builds on ${prRef(stacked)} and targets its branch \`${stacked.branch}\`, so it shows only its own change. When ${prRef(stacked)} is merged, it moves to \`${input.defaultBranch}\`.`]
        : []),
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
      input.diffCheck
        ? `@${workItem.requester.login} checked this change in the orchestrator before it was opened. The review above was written by an AI reviewer agent; this pull request still needs a person's review of the code.`
        : "The review above was written by an AI reviewer agent; this pull request still needs a person's review.",
    ].join("\n");
  };

  /** A warning for the story view and the sub-task's conversation. */
  const warn = async (noticeKey: string, text: string) => {
    await orch.addStoryWarning({ runId, key, text });
    await orch.postNotice({ runId, conversationId, noticeKey: `${noticeKey}-${key}`, level: "warning", text });
    await emit("story.warning", { subtask: key, text });
  };

  /** Merges the default branch into the sub-task's branch, once the pull request it was stacked on has merged (AD-41). */
  const bringUpToDate = async (push: boolean) => {
    const updated = await steps.updateBranchFromDefault({ runId, subtaskKey: key, repo, defaultBranch: input.defaultBranch, branch, commitAuthor: input.commitAuthor });
    if (updated.status === "conflict") {
      await warn("uptodate", `The branch ${branch} could not be brought up to date with ${input.defaultBranch}: the merge conflicts. Resolve the conflict in the pull request.`);
    } else if (updated.status === "merged") {
      headCommit = updated.headCommit;
      await orch.patchSubtask({ runId, key, patch: { headCommit } });
      if (push) {
        try {
          await integ.pushBranch({ runId, subtaskKey: key, repo, branch });
        } catch (err) {
          if (failureType(err) !== "AccessDenied") throw err;
          await warn("uptodate-push", `The branch ${branch} was brought up to date, but it could not be pushed: ${rootMessage(err)}`);
        }
      }
    }
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
      ticket: input.ticket ? { number: input.ticket.number, url: input.ticket.url } : undefined,
      stackedOn: input.stackedOn?.key,
    });
    conversationId = init.conversationId;
    await emit("subtask.started", { subtask: key, title: subtask.title, repository: slug(repo), branch, stackedOn: input.stackedOn?.key ?? null }, { branch });
    const prepared = await steps.prepareSubtaskRepo({
      runId,
      subtaskKey: key,
      repo,
      defaultBranch: input.defaultBranch,
      branch,
      stackedOn: input.stackedOn ? { branch: input.stackedOn.branch, commit: input.stackedOn.headCommit } : undefined,
    });
    baseCommit = prepared.baseCommit;
    await orch.patchSubtask({ runId, key, patch: { baseCommit } });

    // Before any agent works on it: the token must be able to push to the repository (AD-42).
    for (;;) {
      const access = await integ.checkAccess({ repositories: [slug(repo)] });
      if (!access.problems.length) break;
      await emit("access.checked", { subtask: key, problems: access.problems.length });
      if ((await askBlocked(`push to ${slug(repo)}`, access.problems.map((p) => p.problem))) === "cancel") {
        return end("cancelled_by_requester", "cancelled", `Cancelled by your decision: the token cannot push to ${slug(repo)}; nothing was built.`);
      }
    }

    // Implementation in a sandbox, on the sub-task's own branch.
    setProgress("Implementation", "running");
    await setState("implementing", "executing", "Implementing");
    const attempt = await attemptStep("implement", `Implement: ${subtask.title}`, { round: 0 });
    if (attempt.result.status !== "succeeded") throw ApplicationFailure.nonRetryable(`The implementation failed: ${attempt.result.error ?? attempt.result.summary}`);
    await steps.applyStepResult({ runId, subtaskKey: key, stepId: attempt.stepId, branch });
    let summary = attempt.result.summary;
    let verification = attempt.result.verification;
    let evidence: CriterionEvidence[] = attempt.result.evidence ?? [];
    setProgress("Implementation", "done");

    /** Implementation rounds after the first: fix rounds of the AI review, and changes the requester asked for. */
    let round = 0;
    let fixRounds = 0;
    let checkRounds = 0;
    let budget = input.maxFixRounds;
    let earlier: TrackedFinding[] = [];
    let guidance: string | undefined;
    let review: SubtaskReview;
    let unresolved = false;
    let openPullRequest = true;
    let risk: { reasons: string[]; files: string[] } = { reasons: [], files: [] };

    // One pass per version of the change: AI review with its fix rounds, the checks, then on the guided
    // track the requester's own check. Changes the requester asks for start another pass.
    for (;;) {
      // AI review of every change, with bounded fix rounds (FR-R1, FR-R2). The reviewer starts from a clean workspace.
      for (;;) {
        setProgress("AI review", "running");
        await setState("reviewing", "reviewing", round ? `AI review (round ${round + 1})` : "AI review");
        const reviewed = await attemptStep("review", round ? `Review (round ${round + 1})` : "Review", {
          round,
          findings: earlier,
          implementerSummary: summary,
          verification,
        });
        if (reviewed.result.status !== "succeeded" || !reviewed.result.review) {
          throw ApplicationFailure.nonRetryable(`The AI review failed: ${reviewed.result.error ?? reviewed.result.summary}`);
        }
        const outcome = await orch.recordReview({ runId, key, conversationId, report: reviewed.result.review, verification: verification ?? null, fixRounds, budget });
        review = outcome.review;
        await emit("review.completed", { subtask: key, round, open: review.open.length, toFix: outcome.toFix.length });
        if (outcome.toFix.length === 0) {
          unresolved = false;
          break;
        }

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
        round++;
        setProgress("Implementation", "running");
        await setState("implementing", "executing", `Fixing the review findings (round ${fixRounds})`);
        await emit("review.fix_requested", { subtask: key, round: fixRounds, findings: outcome.toFix.length });
        const fix = await attemptStep("implement", `Fix round ${fixRounds}: ${subtask.title}`, { round, findings: outcome.toFix, guidance });
        if (fix.result.status !== "succeeded") throw ApplicationFailure.nonRetryable(`Fix round ${fixRounds} failed: ${fix.result.error ?? fix.result.summary}`);
        await steps.applyStepResult({ runId, subtaskKey: key, stepId: fix.stepId, branch });
        await orch.patchSubtask({ runId, key, patch: { fixRounds } });
        summary = fix.result.summary;
        verification = fix.result.verification ?? verification;
        evidence = fix.result.evidence ?? evidence;
        earlier = outcome.toFix;
        guidance = undefined;
        setProgress("Implementation", "done");
      }
      setProgress("AI review", "done");

      // Checks before anything leaves the orchestrator. They do not depend on what any agent said.
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
      headCommit = squashed.headCommit;
      await orch.patchSubtask({ runId, key, patch: { headCommit } });
      const inspection = await steps.inspectChanges({ runId, subtaskKey: key, repo, branch, baseCommit, checkLimits: input.track === "fast" && openPullRequest });
      if (inspection.changedFiles.length === 0) throw ApplicationFailure.nonRetryable("The agents produced no changes");
      if (inspection.secrets.length) {
        const where = inspection.secrets.map((s) => `${s.kind} in ${s.file}:${s.line}`).join("; ");
        throw ApplicationFailure.nonRetryable(`Possible secrets in the changes (${where}); nothing was pushed`);
      }
      risk = inspection.risk;
      if (inspection.limits.length) {
        // The analysis was an estimate: the change is bigger than the fast track allows (FR-A2).
        await setState("awaiting_decision", "awaiting_approval", "The change is bigger than the fast track allows; waiting for your decision");
        const { approvalId } = await orch.requestLimitsDecision({ runId, key, conversationId, reasons: inspection.limits, files: inspection.changedFiles });
        await emit("track.limits_exceeded", { subtask: key, approvalId, reasons: inspection.limits });
        const decision = await waitForApproval(approvalId);
        await emit("track.limits_decided", { subtask: key, approvalId, decision: decision.decision });
        if (decision.decision === "guided") {
          const ended = await end("switch_to_guided", "cancelled", "Switched to the guided track; the fast-track change was set aside and nothing was pushed.");
          return { ...ended, switch: { by: workItem.requester.login, reason: "The change exceeded the fast-track limits" } };
        }
        if (decision.decision === "cancel") return end("cancelled_by_requester", "cancelled", "Cancelled by your decision; nothing was pushed.");
      }
      // A branch the requester takes over is theirs to judge: no check of the change here.
      if (!input.diffCheck || !openPullRequest) break;

      // The requester's check of the change, bound to its commit (FR-R4, AD-40).
      setProgress("Your check", "running");
      await setState("awaiting_check", "awaiting_approval", "Waiting for your check of the change");
      const { approvalId } = await orch.requestChangeCheck({
        runId,
        key,
        conversationId,
        commit: headCommit,
        repository: slug(repo),
        branch,
        round: checkRounds,
        summary,
        acceptanceCriteria: subtask.acceptanceCriteria,
        evidence,
        files: inspection.files,
        verification: verification ?? null,
        review,
        fixRounds,
        buildsOn: [...(input.stackedOn ? [input.stackedOn.title] : []), ...input.references.map((d) => d.title)],
      });
      await emit("change.check_requested", { subtask: key, approvalId, commit: headCommit, round: checkRounds });
      const decision = await waitForApproval(approvalId);
      await emit("change.decided", { subtask: key, approvalId, decision: decision.decision, commit: headCommit });
      if (decision.decision === "approve") {
        setProgress("Your check", "done");
        break;
      }
      if (decision.decision === "drop") {
        // Closed as not done: nothing was pushed; the run decides about the sub-tasks that depend on it.
        if (input.ticket) await integ.closeSubIssue({ repo: input.ticket.repo, number: input.ticket.number, dropped: true });
        await integ.commentOnIssue({
          repo: workItem.repo,
          number: workItem.number,
          key: `run=${runId}:dropped:${key}`,
          body: `🤖 Sub-task ${input.index + 1} of ${total} (${subtask.title}) was dropped by @${workItem.requester.login}; nothing was pushed for it.`,
        });
        return end("dropped", "dropped", "Dropped by your decision; nothing was pushed.");
      }

      // Changes requested: another implementation round with the requester's words, reviewed again.
      checkRounds++;
      round++;
      setProgress("Your check", "pending");
      setProgress("AI review", "pending");
      setProgress("Implementation", "running");
      await setState("implementing", "executing", "Making the changes you asked for");
      const changed = await attemptStep("implement", `Changes requested (${checkRounds}): ${subtask.title}`, { round, findings: [], guidance: decision.feedback });
      if (changed.result.status !== "succeeded") throw ApplicationFailure.nonRetryable(`The requested changes failed: ${changed.result.error ?? changed.result.summary}`);
      await steps.applyStepResult({ runId, subtaskKey: key, stepId: changed.stepId, branch });
      summary = changed.result.summary;
      verification = changed.result.verification ?? verification;
      evidence = changed.result.evidence ?? evidence;
      // The reviewer looks again at what was still open, and the new version gets its own fix rounds.
      earlier = review.open;
      budget = fixRounds + input.maxFixRounds;
      setProgress("Implementation", "done");
    }

    setProgress("Pull request", "running");
    if (risk.reasons.length) {
      const { approvalId } = await orch.requestRiskApproval({ runId, conversationId, subtaskKey: key, reasons: risk.reasons, files: risk.files });
      await emit("approval.requested", { kind: "risk", approvalId, reasons: risk.reasons, subtask: key });
      await setState("awaiting_decision", "awaiting_approval", "Waiting for approval of a high-risk change");
      const decision = await waitForApproval(approvalId);
      if (decision.decision !== "approve") {
        await emit("risk.rejected", { approvalId, subtask: key });
        return end("cancelled_by_requester", "cancelled", "High-risk change rejected; nothing was pushed.");
      }
      await emit("risk.approved", { approvalId, subtask: key });
    }

    // Where the pull request goes: the default branch, or the branch this one is stacked on while that one is open (AD-41).
    await setState("publishing", "publishing", "Publishing the change");
    let stacked: DependencyRef | null = null;
    if (input.stackedOn && openPullRequest) {
      if ((await integ.getPullRequestState({ repo, number: input.stackedOn.prNumber })) === "merged") await bringUpToDate(false);
      else stacked = input.stackedOn;
    }
    // From here on the change leaves the orchestrator: the track can no longer be switched.
    publishing = true;
    if ((await withAccess(`push the branch to ${slug(repo)}`, () => integ.pushBranch({ runId, subtaskKey: key, repo, branch }))) === "cancel") {
      return end("cancelled_by_requester", "cancelled", "Cancelled by your decision: the branch could not be pushed.");
    }
    await emit("scm.branch_pushed", { subtask: key, repository: slug(repo), branch });
    if (!openPullRequest) {
      // Take over: the branch is the requester's to continue; no pull request is opened.
      return end("handed_over", "handed_over", `The branch ${branch} was pushed to ${slug(repo)} without a pull request; it is yours to continue.`);
    }

    const title = total > 1 ? `[agent] ${workItem.title} (${input.index + 1}/${total}): ${subtask.title}` : `[agent] ${workItem.title}`;
    const pr = await withAccess(`open the pull request in ${slug(repo)}`, () =>
      integ.openPullRequest({
        repo,
        branch,
        base: stacked ? stacked.branch : input.defaultBranch,
        title: clip(title, 250),
        body: pullRequestBody(review, verification, fixRounds, unresolved, stacked),
      }),
    );
    if (pr === "cancel") return end("cancelled_by_requester", "cancelled", `Cancelled by your decision: the branch ${branch} was pushed, but no pull request was opened.`);
    await orch.patchSubtask({ runId, key, patch: { prNumber: pr.number, prUrl: pr.url } });
    await emit(
      "scm.pr_opened",
      { subtask: key, number: pr.number, url: pr.url, repository: slug(repo), unresolved, base: stacked ? stacked.branch : input.defaultBranch },
      { prNumber: pr.number, prUrl: pr.url },
    );
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
    // The run can start the sub-tasks that build on this one: its change is approved and its branch is pushed.
    const parent = workflowInfo().parent;
    if (parent) await getExternalWorkflowHandle(parent.workflowId).signal(subtaskPublishedSignal, { key, branch, headCommit, prNumber: pr.number, prUrl: pr.url });

    // Human review and merge happen on GitHub; poll until the pull request is merged or closed.
    for (;;) {
      await sleep(input.prPollSeconds * 1000);
      const prState = await integ.getPullRequestState({ repo, number: pr.number });
      if (prState === "open") {
        if (expired()) throw ApplicationFailure.nonRetryable("The pull request was not merged within 30 days");
        if (stacked) {
          const below = await integ.getPullRequestState({ repo, number: stacked.prNumber });
          if (below === "merged") {
            // The pull request below merged: this one moves to the default branch and is brought up to date.
            const moved = await integ.retargetPullRequest({ repo, number: pr.number, base: input.defaultBranch });
            if (moved) {
              await emit("scm.pr_retargeted", { subtask: key, number: pr.number, base: input.defaultBranch });
              await bringUpToDate(true);
            }
            stacked = null;
          } else if (below === "closed") {
            await warn("below", `The pull request this one builds on (${prRef(stacked)}, ${stacked.title}) was closed without merging; this pull request still targets its branch.`);
            stacked = null;
          }
        }
        continue;
      }
      await orch.postPullRequestCard({ runId, conversationId, subtaskKey: key, number: pr.number, url: pr.url, title: pr.title, state: prState });
      await emit(prState === "merged" ? "scm.pr_merged" : "scm.pr_closed", { subtask: key, number: pr.number });
      if (prState !== "merged") return end("closed", "closed", "Pull request closed without merging.");

      // Merge order (FR-M5): advice the orchestrator watches. Merged before a pull request it depends on is flagged.
      const early: DependencyRef[] = [];
      for (const dep of input.mergeAfter) {
        if ((await integ.getPullRequestState({ repo: dep.repo, number: dep.prNumber })) !== "merged") early.push(dep);
      }
      if (early.length) {
        const below = stacked && early.find((d) => d.key === stacked!.key);
        const text = below
          ? `Pull request #${pr.number} (${subtask.title}) was merged into the branch of ${prRef(below)} (${below.title}), which is not merged yet: the change reaches ${input.defaultBranch} when that pull request is merged.`
          : `Pull request #${pr.number} (${subtask.title}) was merged before ${early.map((d) => `${prRef(d)} (${d.title})`).join(" and ")}, which it depends on.`;
        await orch.addStoryWarning({ runId, key, text });
        await emit("story.merged_out_of_order", { subtask: key, before: early.map((d) => d.key) });
        await integ.commentOnIssue({ repo: workItem.repo, number: workItem.number, key: `run=${runId}:order:${key}`, body: `🤖 ⚠️ Merge order: ${text}` });
      }

      setProgress("Review and merge", "done");
      if (input.ownConversation) runState = "completed";
      await orch.patchSubtask({ runId, key, patch: { state: "merged" } });
      if (input.ticket) await integ.closeSubIssue({ repo: input.ticket.repo, number: input.ticket.number });
      await emit("subtask.merged", { subtask: key });
      await pushProgress("Pull request merged.");
      return { status: "merged", progress };
    }
  };

  try {
    return await building.run(body);
  } catch (err) {
    // Set by the signal handler, which the compiler cannot see from here.
    const request = switched as TrackRequest | null;
    if (isCancellation(err) && request && !CancellationScope.current().consideredCancelled) {
      // The requester switched to the guided track before anything was pushed (FR-A3).
      return CancellationScope.nonCancellable(async () => {
        const ended = await end("switch_to_guided", "cancelled", `Switched to the guided track by @${request.by}; the change was set aside and nothing was pushed.`);
        return { ...ended, switch: { by: request.by, reason: request.reason ?? "" } };
      });
    }
    if (isCancellation(err)) {
      // The run was cancelled or stopped: record it, then let the cancellation reach the run workflow.
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
// Design session workflow (FR-P1 to FR-P4, AD-34 to AD-36)
// ---------------------------------------------------------------------------

export interface DesignSessionInput {
  runId: string;
  workItem: WorkItem;
  analysis: Analysis;
  /** The repositories the analysis named: what the architect's workspace starts with. */
  repositories: string[];
  conversationId: string;
  /** Silence after which the session workspace is saved and shut down. */
  idleSeconds: number;
}

export type DesignSessionResult =
  | {
      kind: "approved";
      plan: HandoffPlan;
      version: number;
      /** Keys of the sub-tasks in the order they are built. */
      order: string[];
    }
  | {
      /** The requester switched to the fast track before approving a plan (FR-A3). */
      kind: "switched";
      by: string;
      reason: string;
      /** The latest plan version, collapsed into one change by the run; null when the architect had not written one. */
      plan: HandoffPlan | null;
      version: number | null;
      /** The one repository the work stays in. */
      repository: string;
    };

/** The repositories a plan changes, each once. */
const planRepositories = (plan: HandoffPlan) => {
  const seen = new Map<string, string>();
  for (const st of plan.subtasks) if (!seen.has(st.repository.toLowerCase())) seen.set(st.repository.toLowerCase(), st.repository);
  return [...seen.values()];
};

export async function designSessionWorkflow(input: DesignSessionInput): Promise<DesignSessionResult> {
  const { runId, conversationId } = input;
  const startedAt = Date.now();
  // A run can come back to the design session (guided, fast, guided again): turns and events of each session are its own.
  // The random end of the run ID: its start is a timestamp, the same for sessions started close together.
  const session_ = workflowInfo().runId.replace(/-/g, "").slice(-12);
  const emit = eventWriter(runId, `design-${session_}`);
  const queue: RequesterMessageSignal[] = [];
  const approvals = new Map<string, ApprovalSignal>();
  const switches: TrackRequest[] = [];
  const freshStarts: FreshSessionSignal[] = [];
  setHandler(requesterMessageSignal, (m) => void queue.push(m));
  setHandler(approvalSignal, (s) => void approvals.set(s.approvalId, s));
  setHandler(switchTrackSignal, (r) => void switches.push(r));
  setHandler(freshSessionSignal, (r) => void freshStarts.push(r));
  let noticeCounter = 0;
  const notice = (level: "info" | "warning", text: string) => orch.postNotice({ runId, conversationId, noticeKey: `design-${session_}-${++noticeCounter}`, level, text });

  let turnCounter = 0;
  let workspaceUp = false;
  let everUp = false;
  let version: number | null = null;
  let pendingApproval: string | null = null;

  /** Saves the session and shuts its workspace down (idle, or too old), or ends the session for good. */
  const release = async (how: "suspend" | "close") => {
    const released = how === "suspend" ? await steps.suspendDesignWorkspace({ runId }) : await steps.closeDesignSession({ runId });
    if (released.stepId) await workspaces.destroyWorkspace({ stepId: released.stepId });
    workspaceUp = false;
  };

  /**
   * One turn: make sure the session has a workspace, hand it the requester's messages, wait for the reply,
   * then record the reply and what it did to the plan. A lost workspace is replaced and gets the same turn.
   */
  const turn = async (messages: RequesterMessageSignal[]) => {
    const turnInput: DesignTurnInput = { turnId: `${runId}-${session_}-t${++turnCounter}`, opening: messages.length === 0, messages: messages.map((m) => m.text) };
    let result: DesignTurnResult | undefined;
    let lost = "";
    for (let attempt = 1; attempt <= 3 && !result; attempt++) {
      let workspace = await steps.prepareDesignWorkspace({ runId, workItem: input.workItem, analysis: input.analysis, repositories: input.repositories });
      if (workspace.expired) {
        await release("suspend");
        workspace = await steps.prepareDesignWorkspace({ runId, workItem: input.workItem, analysis: input.analysis, repositories: input.repositories });
      }
      if (workspace.fresh) {
        await emit(everUp ? "design.resumed" : "design.opened", { stepId: workspace.stepId });
        await workspaces.createWorkspace({ stepId: workspace.stepId, runId, session: true });
      }
      workspaceUp = true;
      everUp = true;
      try {
        result = await stepWait.awaitDesignTurn({ runId, stepId: workspace.stepId, turn: turnInput });
      } catch (err) {
        if (isCancellation(err)) throw err;
        lost = rootMessage(err);
        await workspaces.destroyWorkspace({ stepId: workspace.stepId });
        workspaceUp = false;
      }
    }
    result ??= { turnId: turnInput.turnId, status: "failed", text: "", components: [], proposed: false, session: "continued", error: lost || "The design session workspace was lost" };

    // A plan is put up for approval only when the token can push to every repository in it (AD-42).
    let accessProblems: string[] = [];
    if (result.status === "succeeded" && result.proposed) {
      const plan = result.plan ?? (await orch.latestPlan({ runId }))?.plan;
      if (plan) {
        const access = await integ.checkAccess({ repositories: planRepositories(plan) });
        accessProblems = access.problems.map((p) => p.problem);
        if (accessProblems.length) {
          result = { ...result, proposed: false };
          await emit("access.plan_refused", { problems: accessProblems });
        }
      }
    }

    const recorded = await orch.recordDesignTurn({ runId, conversationId, turn: turnInput, result, accessProblems });
    await emit("design.turn_completed", { turn: turnCounter, status: result.status, session: result.session });
    if (recorded.created) {
      version = recorded.version;
      await emit("plan.version_created", { version: recorded.version, changes: recorded.changes });
      if (recorded.voidedApproval) {
        pendingApproval = null;
        await emit("plan.approval_voided", { version: recorded.version });
      }
    }
    if (recorded.proposedApprovalId) {
      version = recorded.version;
      pendingApproval = recorded.proposedApprovalId;
      await emit("plan.proposed", { version: recorded.version, approvalId: recorded.proposedApprovalId }, { state: "awaiting_approval" });
    } else if (recorded.created) {
      await emit("run.state_changed", { state: "designing" }, { state: "designing" });
    }
  };

  const session = async (): Promise<DesignSessionResult> => {
    await emit("run.state_changed", { state: "designing" }, { state: "designing" });
    // The session opens by itself: the architect's first message and draft plan are there when the requester arrives.
    await turn([]);
    let lastTurnAt = Date.now();
    for (;;) {
      const approved = () => pendingApproval !== null && approvals.get(pendingApproval)?.decision === "approve";
      const idleLeft = Math.max(1000, lastTurnAt + input.idleSeconds * 1000 - Date.now());
      const woke = await condition(() => queue.length > 0 || approved() || switches.length > 0 || freshStarts.length > 0, workspaceUp ? idleLeft : "1 day");
      if (!woke) {
        if (workspaceUp) {
          // Silence: the session is saved and its workspace shut down; the next message restores it (AD-34).
          await release("suspend");
          await emit("design.suspended", {});
        } else if (Date.now() - startedAt > MAX_RUN_MS) {
          throw ApplicationFailure.nonRetryable("The design session waited too long for the requester");
        }
        continue;
      }
      if (switches.length) {
        // The requester switches to the fast track (FR-A3): only before the approval, and with one repository.
        const request = switches.shift()!;
        if (request.track !== "fast") {
          await notice("info", "The run is already on the guided track.");
          continue;
        }
        const latest = await orch.latestPlan({ runId });
        const repositories = latest ? planRepositories(latest.plan) : input.repositories;
        if (repositories.length !== 1) {
          await emit("track.switch_refused", { to: "fast", repositories });
          await notice(
            "warning",
            `The fast track needs the work to stay in one repository, and ${latest ? `the current plan (version ${latest.version})` : "the analysis"} involves ${repositories.length}: ${repositories.join(", ")}. Ask the architect to keep it to one repository, or stay on the guided track.`,
          );
          continue;
        }
        await release("close");
        // A plan that was put up for approval is not approved now; its card says so.
        await orch.closeOutApprovals({ runId });
        await emit("design.closed", { switchedTo: "fast", by: request.by });
        return { kind: "switched", by: request.by, reason: request.reason ?? "", plan: latest?.plan ?? null, version: latest?.version ?? null, repository: repositories[0]! };
      }
      if (freshStarts.length) {
        // The session starts again from the current plan, without the conversation before it (R-14 fallback).
        const request = freshStarts.splice(0, freshStarts.length)[0]!;
        const restarted = await steps.restartDesignSession({ runId });
        if (restarted.stepId) await workspaces.destroyWorkspace({ stepId: restarted.stepId });
        workspaceUp = false;
        await emit("design.restarted", { by: request.by });
        await notice(
          "info",
          "The design session starts afresh with your next message: the architect gets the analysis and the current plan, not the conversation before this point.",
        );
        continue;
      }
      if (approved() && queue.length === 0) {
        const approvedVersion = version!;
        await release("close");
        const final = await orch.finalizePlan({ runId, conversationId, version: approvedVersion });
        await emit("design.closed", { version: approvedVersion });
        if (final.productsChanged) await emit("products.identified", { products: final.products, source: "plan" }, { products: final.products });
        return { kind: "approved", plan: final.plan, version: approvedVersion, order: final.order };
      }
      // Messages that arrived while the architect was busy are answered together, as one turn.
      await turn(queue.splice(0, queue.length));
      lastTurnAt = Date.now();
    }
  };

  try {
    return await session();
  } catch (err) {
    // Cancelled or failed: the session ends and its workspace goes away, whatever happened.
    await CancellationScope.nonCancellable(() => release("close"));
    throw err;
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
  // The sub-task workflows of the run. Several can be alive at once: one being built, others waiting for their merge.
  let kids: CancellationScope | undefined;
  const children: Promise<unknown>[] = [];
  const published = new Map<string, SubtaskPublishedSignal>();
  setHandler(subtaskPublishedSignal, (p) => void published.set(p.key, p));
  // Requests to switch the track (FR-A3): the run passes each one to the change or the design session going on.
  const trackRequests: TrackRequest[] = [];
  setHandler(changeTrackSignal, (r) => void trackRequests.push(r));
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
    extra: { primaryRepo: RepoRef; questionRounds?: QuestionRound[] },
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
  const finish = async (final: "completed" | "closed" | "cancelled" | "failed", text: string, level: "success" | "info" | "warning" | "error", closeTicket = false) => {
    state = final;
    let writeBackError: string | null = null;
    try {
      await integ.finalizeIssue({ repo, number: workItem.number, outcome: final, close: closeTicket });
      if (final !== "completed") {
        await integ.commentOnIssue({ repo, number: workItem.number, key: `run=${runId}:${final}`, body: `🤖 Run \`${runId}\` ended: ${text}` });
      }
    } catch (err) {
      writeBackError = err instanceof Error ? err.message : String(err);
    }
    if (conversationId) await orch.closeOutApprovals({ runId });
    await emit(`run.${final}`, { text, writeBackError }, { state: final, ...(final === "failed" ? { error: text } : {}) });
    if (conversationId) {
      for (const p of progress) if (p.status === "running" || (p.status === "pending" && final !== "completed")) p.status = final === "completed" ? "done" : p.status === "pending" ? "skipped" : "failed";
      await pushProgress(text);
      await orch.postNotice({ runId, conversationId, noticeKey: "final", level, text });
      if (writeBackError) {
        await orch.postNotice({ runId, conversationId, noticeKey: "writeback", level: "warning", text: `Could not update the GitHub issue: ${writeBackError}` });
      }
    }
  };

  /** Posts questions in the conversation and on the ticket, and waits for the requester's answer from either. */
  const askRequester = async (questions: string[], intro: string, eventPrefix: "analysis"): Promise<AnswerSignal> => {
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
      const title = attempt === 1 ? "Analysis" : `Analysis (round ${attempt})`;
      const { result } = await stepWithRetries((n) => runStep("analyse", n === 1 ? title : `${title} (attempt ${n})`, { primaryRepo: repo, questionRounds }), {
        waits: init.settings.modelRetrySeconds,
        retryOnce: true,
        onWait: async (seconds, n) => {
          await emit("step.retry_scheduled", { kind: "analyse", reason: "model provider", waitSeconds: seconds, retry: n });
          await pushProgress(`Waiting for the model provider: trying again in ${describeWait(seconds)}`);
        },
        onRetry: () => pushProgress("Retrying the analysis"),
      });
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

    const repoOf = (text: string): RepoRef => {
      const [owner, name] = text.split("/") as [string, string];
      return { owner, name };
    };

    /** Starts one sub-task as a child workflow, in the repository it changes; resolves with how it ended. */
    kids = new CancellationScope();
    const startSubtask = async (
      plan: Plan,
      index: number,
      opts: {
        key: string;
        repo: RepoRef;
        branchSuffix: string;
        ownConversation: boolean;
        closesIssue: boolean;
        prefix: ProgressItem[];
        ticket?: { repo: RepoRef; number: number; url: string };
        diffCheck: boolean;
        stackedOn?: DependencyRef;
        references?: DependencyRef[];
        mergeAfter?: DependencyRef[];
      },
    ): Promise<{ result: Promise<SubTaskResult> }> => {
      const context = await integ.lookupContext({ runId, workItem, repo: opts.repo });
      const handle = await kids!.run(() =>
        startChild(subTaskWorkflow, {
          workflowId: `subtask:${runId}:${opts.key}`,
          args: [
            {
              runId,
              workItem,
              track,
              key: opts.key,
              index,
              plan,
              repo: opts.repo,
              defaultBranch: context.defaultBranch,
              branch: `${context.branch}${opts.branchSuffix}`,
              commitAuthor: context.commitAuthor,
              runConversationId: conversationId,
              ownConversation: opts.ownConversation,
              progressPrefix: opts.prefix,
              closesIssue: opts.closesIssue,
              ticket: opts.ticket,
              diffCheck: opts.diffCheck,
              stackedOn: opts.stackedOn,
              references: opts.references ?? [],
              mergeAfter: opts.mergeAfter ?? [],
              maxFixRounds: init.settings.maxFixRounds,
              prPollSeconds,
              modelRetrySeconds: init.settings.modelRetrySeconds,
            },
          ],
        }),
      );
      // Wrapped: an async function that returned the promise itself would wait for the sub-task to end.
      const result = handle.result();
      children.push(result.catch(() => undefined));
      return { result };
    };

    /** Waits for a child's result; requests to switch the track are passed on to it meanwhile, and it decides. */
    const awaitPassingSwitches = async <T>(result: Promise<T>, passOn: (request: TrackRequest) => Promise<void>): Promise<T> => {
      let done = false;
      let failed = false;
      let value: T | undefined;
      let error: unknown;
      void result.then(
        (v) => {
          done = true;
          value = v;
        },
        (e: unknown) => {
          done = true;
          failed = true;
          error = e;
        },
      );
      for (;;) {
        await condition(() => done || trackRequests.length > 0);
        while (!done && trackRequests.length) await passOn(trackRequests.shift()!);
        if (done) {
          if (failed) throw error;
          return value as T;
        }
      }
    };

    let trackChanges = 0;
    /** Records a switch of the track: who asked for it and why, in the timeline, on the ticket and in the conversation (FR-A3). */
    const changeTrack = async (to: Track, by: string, reason: string) => {
      const from = track;
      track = to;
      trackChanges++;
      await emit("track.changed", { track: to, from, by, reason }, { track: to });
      await integ.setTrackLabel({ repo, number: workItem.number, track: to });
      await integ.commentOnIssue({
        repo,
        number: workItem.number,
        key: `run=${runId}:track=${trackChanges}`,
        body: `🤖 Track changed to **${to}** by @${by}${reason ? `: ${reason}` : "."}`,
      });
      await orch.postNotice({
        runId,
        conversationId,
        noticeKey: `track-${trackChanges}`,
        level: "info",
        text: `Switched to the ${to} track by @${by}${reason ? ` (${reason})` : ""}. ${
          to === "guided"
            ? "A design session with the architect agent starts from the analysis."
            : "The plan becomes one change, built and reviewed with no stops before the pull request."
        }`,
      });
    };
    const notOnTrack = (current: Track) =>
      orch.postNotice({ runId, conversationId, noticeKey: `track-same-${trackChanges}-${trackRequests.length}`, level: "info", text: `The run is already on the ${current} track.` });

    /** Fast track: the analyst's approach is the plan and nobody has to approve it (FR-P6, FR-R5). */
    const fromAnalysis = (): Plan => ({
      summary: clip(analysis.approach || analysis.understanding, 2000),
      subtasks: [
        {
          title: clip(workItem.title.length >= 3 ? workItem.title : `Change for #${workItem.number}`, 200),
          description: [analysis.understanding, analysis.approach ? `Approach: ${analysis.approach}` : ""].filter(Boolean).join("\n\n"),
          acceptanceCriteria: analysis.acceptanceCriteria,
        },
      ],
    });
    /** A hand-off plan made into one change, when the requester switches it to the fast track (FR-A3). */
    const collapse = (handoff: HandoffPlan): Plan => ({
      summary: clip(
        [`Goal: ${handoff.goal}`, `Approach: ${handoff.approach}`, ...bullets("Constraints", handoff.constraints), ...bullets("Out of scope", handoff.outOfScope)].join("\n"),
        8000,
      ),
      subtasks: [
        {
          title: clip(workItem.title.length >= 3 ? workItem.title : `Change for #${workItem.number}`, 200),
          description: clip(
            [
              handoff.goal,
              "",
              "Make these changes, as one change:",
              ...handoff.subtasks.map((st, i) => `${i + 1}. ${st.title}: ${st.description}`),
              ...bullets("Likely files", [...new Set(handoff.subtasks.flatMap((st) => st.likelyFiles))]),
            ].join("\n"),
            8000,
          ),
          acceptanceCriteria: [...new Set(handoff.subtasks.flatMap((st) => st.acceptanceCriteria))],
        },
      ],
    });

    // The rules allow the fast track only for one repository; anything else is designed first. The requester can
    // switch the track while it is allowed (FR-A3): the run goes back and forth until a plan is approved, or ends.
    let fastPlan: Plan | null = null;
    let fastRepository: string | null = repositories.length === 1 ? repositories[0]! : null;
    let fastAttempts = 0;
    if (track === "fast" && !fastRepository) track = "guided";
    let design: Extract<DesignSessionResult, { kind: "approved" }> | null = null;
    while (!design) {
      if (track === "fast") {
        // One change: implemented, reviewed by the reviewer agent, checked against the fast-track limits, published.
        fastAttempts++;
        const key = fastAttempts === 1 ? "change" : `change-${fastAttempts}`;
        const plan = fastPlan ?? fromAnalysis();
        await emit("plan.derived", { subtasks: 1, from: fastPlan ? "plan" : "analysis" }, { plan });
        state = "executing";
        const change = await startSubtask(plan, 0, {
          key,
          repo: repoOf(fastRepository!),
          branchSuffix: fastAttempts === 1 ? "" : `-${fastAttempts}`,
          ownConversation: false,
          closesIssue: true,
          prefix: progress,
          diffCheck: false,
        });
        const result = await awaitPassingSwitches(change.result, async (request) => {
          if (request.track !== "guided") return void (await notOnTrack("fast"));
          await getExternalWorkflowHandle(`subtask:${runId}:${key}`).signal(switchTrackSignal, request);
        });
        progress = result.progress;
        if (result.status === "merged") return finish("completed", "Pull request merged. Done.", "success");
        if (result.status === "closed") return finish("closed", result.note ?? "Pull request closed without merging.", "info");
        if (result.status === "handed_over") return finish("closed", result.note ?? "The branch was pushed without a pull request.", "info");
        if (result.status === "cancelled_by_requester") return finish("cancelled", result.note ?? "Cancelled by your decision.", "warning");
        if (result.status === "failed") throw ApplicationFailure.nonRetryable(result.note ?? "The change failed");
        // To the guided track: asked by the requester, or chosen when the change exceeded the fast-track limits (FR-A2, FR-A3).
        progress = [{ title: "Analysis", status: "done" }];
        await changeTrack("guided", result.switch?.by ?? workItem.requester.login, result.switch?.reason ?? "");
        continue;
      }

      // Guided track (FR-P1 to FR-P4): the architect agent and the requester shape the hand-off plan in the
      // run's conversation; nothing is built until the requester approves a plan version.
      progress.push({ title: "Design session", status: "running" }, { title: "Plan approval", status: "pending" });
      await setState("designing", "Design session with the architect agent");
      const session = await startChild(designSessionWorkflow, {
        workflowId: `design:${runId}`,
        args: [{ runId, workItem, analysis, repositories, conversationId, idleSeconds: init.settings.designIdleSeconds }],
      });
      const outcome = await awaitPassingSwitches(session.result(), async (request) => {
        if (request.track !== "fast") return void (await notOnTrack("guided"));
        await session.signal(switchTrackSignal, request);
      });
      if (outcome.kind === "approved") {
        design = outcome;
        break;
      }
      // To the fast track: the latest plan version, if any, becomes the one change (FR-A3).
      fastPlan = outcome.plan ? collapse(outcome.plan) : null;
      fastRepository = outcome.repository;
      progress = progress.filter((p) => p.title !== "Design session" && p.title !== "Plan approval");
      await changeTrack("fast", outcome.by, outcome.reason);
    }
    setProgress("Design session", "done");
    setProgress("Plan approval", "done");

    // What the agents build from: the plan's sub-tasks in build order, each with the context that concerns everyone.
    const handoff = design.plan;
    const ordered = design.order.map((k) => handoff.subtasks.find((st) => st.key === k)!);
    const titleOf = (k: string) => handoff.subtasks.find((st) => st.key === k)?.title ?? k;
    const plan: Plan = {
      summary: clip(
        [
          `Goal: ${handoff.goal}`,
          `Approach: ${handoff.approach}`,
          ...bullets("Constraints", handoff.constraints),
          ...bullets("Out of scope", handoff.outOfScope),
          ...bullets(
            "Contracts between products",
            handoff.contracts.map((c) => `${c.name}: ${c.description} (provided by: ${c.providers.map(titleOf).join(", ")}; used by: ${c.consumers.map(titleOf).join(", ")})`),
          ),
          ...(handoff.rollout ? [`Rollout: ${handoff.rollout}`] : []),
        ].join("\n"),
        8000,
      ),
      subtasks: ordered.map((st) => ({
        title: st.title,
        description: [st.description, `Repository: ${st.repository}`, ...(st.likelyFiles.length ? [`Likely files: ${st.likelyFiles.join(", ")}`] : [])].join("\n"),
        acceptanceCriteria: st.acceptanceCriteria,
      })),
    };
    await emit("plan.approved", { version: design.version, subtasks: ordered.length }, { plan });

    // The plan on the ticket: a summary and one sub-issue per sub-task, in the repository it changes (FR-P5).
    const mirrored = await integ.mirrorPlanOnTicket({ runId, workItem, plan: handoff, version: design.version, order: design.order });
    await emit("ticket.subtasks_created", { count: mirrored.subIssues.length, attached: mirrored.attached });
    // The story view: every sub-task is there from the start, as planned (FR-R7).
    await orch.planSubtasks({
      runId,
      items: ordered.map((st, i) => ({
        key: st.key,
        title: st.title,
        description: plan.subtasks[i]!.description,
        acceptanceCriteria: st.acceptanceCriteria,
        repository: st.repository,
        dependsOn: st.dependsOn,
        ticket: mirrored.subIssues.find((si) => si.key === st.key),
      })),
    });

    // Sub-tasks are built one at a time, in build order, each on its own branch in its repository, with its
    // own pull request and conversation (FR-B1, FR-C2, FR-M4). The next one starts when the one before has
    // passed the requester's check and its pull request is open, not when it is merged (AD-41): its pull
    // request then waits for its merge while the others are built.
    interface Slot {
      st: PlanSubtask;
      index: number;
      title: string;
      phase: "planned" | "building" | "ended";
      /** How it ended. */
      result?: SubTaskResult;
      /** The sub-task its branch is stacked on. */
      stackedOn?: string;
    }
    const count = ordered.length;
    const slots = ordered.map((st, index): Slot => ({ st, index, title: `${index + 1}. ${st.title}`, phase: "planned" }));
    const slotOf = (k: string) => slots.find((s) => s.st.key === k);
    progress.push(...slots.map((s) => ({ title: s.title, status: "pending" as ProgressStatus })));

    const isOpen = (s: Slot) => s.phase === "building" && published.has(s.st.key);
    const merged = (s: Slot) => s.result?.status === "merged";
    /** Ended without its change being merged: dropped, declined on GitHub, or taken over by the requester. */
    const notDelivered = (s: Slot) => s.phase === "ended" && !merged(s);
    /** A failure or a cancellation by the requester ends the whole run. */
    const stopper = () => slots.find((s) => s.result?.status === "failed" || s.result?.status === "cancelled_by_requester");
    const sameRepo = (a: Slot, b: Slot) => a.st.repository.toLowerCase() === b.st.repository.toLowerCase();
    const refOf = (s: Slot): DependencyRef => {
      const p = published.get(s.st.key)!;
      return { key: s.st.key, title: s.st.title, repo: repoOf(s.st.repository), branch: p.branch, headCommit: p.headCommit, prNumber: p.prNumber, prUrl: p.prUrl };
    };
    const dependencies = (s: Slot) => s.st.dependsOn.map(slotOf).filter((d): d is Slot => !!d).sort((a, b) => a.index - b.index);
    /** The sub-tasks whose approved changes a branch contains, by the way of the branches it is stacked on. */
    const stack = (s: Slot): Set<string> => {
      const keys = new Set<string>();
      for (let below = s.stackedOn ? slotOf(s.stackedOn) : undefined; below && !keys.has(below.st.key); below = below.stackedOn ? slotOf(below.stackedOn) : undefined) keys.add(below.st.key);
      return keys;
    };

    const stopAll = async () => {
      kids!.cancel();
      await Promise.allSettled(children);
    };
    const reflected = new Set<string>();
    /** Shows on the run's progress card how sub-tasks ended. */
    const reflect = async () => {
      let changed = false;
      for (const s of slots) {
        if (s.phase !== "ended" || reflected.has(s.st.key)) continue;
        reflected.add(s.st.key);
        setProgress(s.title, merged(s) ? "done" : s.result?.status === "dropped" ? "skipped" : "failed");
        changed = true;
      }
      if (changed) await pushProgress(`${slots.filter(merged).length} of ${count} sub-tasks merged`);
    };

    const decided = new Set<string>();
    const undecided = () => slots.some((s) => notDelivered(s) && !decided.has(s.st.key));
    const STATE_OF: Record<string, SubtaskState> = { dropped: "dropped", closed: "closed", handed_over: "handed_over" };
    /**
     * A sub-task that was not delivered, with sub-tasks that depend on it and have not started: the requester
     * decides whether those are dropped too, built without it, or the run is cancelled (FR-R4).
     */
    const settle = async (): Promise<"continue" | "cancel"> => {
      for (const s of slots) {
        if (!notDelivered(s) || decided.has(s.st.key)) continue;
        decided.add(s.st.key);
        const waiting: Slot[] = [];
        for (const candidate of slots) {
          if (candidate.phase === "planned" && candidate.st.dependsOn.some((k) => k === s.st.key || waiting.some((w) => w.st.key === k))) waiting.push(candidate);
        }
        if (!waiting.length) continue;
        const { approvalId } = await orch.requestDependentsDecision({
          runId,
          conversationId,
          subtask: { key: s.st.key, title: s.st.title, state: STATE_OF[s.result!.status] ?? "closed" },
          dependents: waiting.map((w) => ({ key: w.st.key, title: w.st.title })),
        });
        await emit("story.dependents_asked", { approvalId, subtask: s.st.key, dependents: waiting.map((w) => w.st.key) });
        await setState("awaiting_approval", "Waiting for your decision on the sub-tasks that depend on one that was not delivered");
        const decision = await waitForApproval(approvalId);
        await emit("story.dependents_decided", { approvalId, decision: decision.decision });
        if (decision.decision === "cancel") return "cancel";
        if (decision.decision === "drop") {
          for (const w of waiting) {
            w.phase = "ended";
            w.result = { status: "dropped", note: `Dropped with "${s.st.title}", which it depends on.`, progress: [] };
            decided.add(w.st.key);
            const ticket = mirrored.subIssues.find((si) => si.key === w.st.key);
            if (ticket) await integ.closeSubIssue({ repo: ticket.repo, number: ticket.number, dropped: true });
          }
          await orch.dropSubtasks({ runId, keys: waiting.map((w) => w.st.key) });
        }
        // Build anyway: they start as planned, and are told that the change they depended on is not there.
      }
      return "continue";
    };

    /** Waits until something happened, then deals with a run-ending result or a sub-task that was not delivered. */
    const waitUntil = async (ready: () => boolean): Promise<"ready" | "stopped"> => {
      for (;;) {
        await condition(() => ready() || !!stopper() || undecided());
        const stopped = stopper();
        if (stopped) {
          await CancellationScope.nonCancellable(stopAll);
          if (stopped.result!.status === "failed") throw ApplicationFailure.nonRetryable(`Sub-task ${stopped.index + 1} failed: ${stopped.result!.note ?? "unknown error"}`);
          await finish("cancelled", `Sub-task ${stopped.index + 1}: ${stopped.result!.note ?? "cancelled by your decision"}`, "warning");
          return "stopped";
        }
        await reflect();
        if ((await settle()) === "cancel") {
          await CancellationScope.nonCancellable(stopAll);
          await finish("cancelled", "Cancelled by your decision on the sub-tasks that depend on one that was not delivered.", "warning");
          return "stopped";
        }
        await reflect();
        if (ready()) return "ready";
      }
    };

    for (const slot of slots) {
      if (slot.phase === "ended") continue; // dropped together with a sub-task it depends on
      const deps = dependencies(slot);
      // In the same repository the branch is stacked on the latest dependency that is still open. When that one
      // does not contain the other open ones, the sub-task waits for their merges and starts from the default branch.
      let stackedOn: Slot | undefined;
      for (;;) {
        const open = deps.filter((d) => isOpen(d) && sameRepo(d, slot));
        const top = open[open.length - 1];
        if (!top || open.every((d) => d === top || stack(top).has(d.st.key))) {
          stackedOn = top;
          break;
        }
        await setState("awaiting_merge", `Sub-task ${slot.index + 1} waits for the merge of the pull requests it builds on`);
        if ((await waitUntil(() => open.some((d) => d.phase === "ended"))) === "stopped") return;
      }
      // While it waited, the requester may have dropped it with a sub-task it depends on.
      if ((slot.phase as Slot["phase"]) === "ended") continue;

      const builds = deps.map((d) => {
        const where = sameRepo(d, slot) ? "" : ` (in ${d.st.repository})`;
        if (merged(d)) return `- "${d.st.title}"${where} is merged${where ? ": the repository is checked out read-only in your workspace" : ": your branch starts from it"}.`;
        if (isOpen(d) && sameRepo(d, slot)) return `- "${d.st.title}" is approved but not merged yet: your branch starts from its change.`;
        if (isOpen(d)) return `- "${d.st.title}"${where} is approved but not merged yet: its change is checked out read-only in your workspace.`;
        return `- "${d.st.title}"${where} was not delivered: its change is not available, build without it.`;
      });
      const own: Plan = {
        ...plan,
        subtasks: plan.subtasks.map((p, i) => (i === slot.index && builds.length ? { ...p, description: [p.description, "", "Builds on:", ...builds].join("\n") } : p)),
      };
      slot.stackedOn = stackedOn?.st.key;
      slot.phase = "building";
      setProgress(slot.title, "running");
      await setState("executing", `Sub-task ${slot.index + 1} of ${count}`);
      const started = await startSubtask(own, slot.index, {
        key: slot.st.key,
        repo: repoOf(slot.st.repository),
        branchSuffix: `-${slot.st.key}`,
        ownConversation: true,
        // A story with several sub-tasks is closed by the run when the last pull request merges, whichever that is.
        closesIssue: count === 1,
        prefix: [],
        ticket: mirrored.subIssues.find((si) => si.key === slot.st.key),
        diffCheck: true,
        stackedOn: stackedOn ? refOf(stackedOn) : undefined,
        references: deps.filter((d) => !sameRepo(d, slot) && published.has(d.st.key) && (isOpen(d) || merged(d))).map(refOf),
        mergeAfter: deps.filter(isOpen).map(refOf),
      });
      void started.result.then(
        (r) => {
          slot.result = r;
          slot.phase = "ended";
        },
        (err: unknown) => {
          slot.result = { status: "failed", note: rootMessage(err), progress: [] };
          slot.phase = "ended";
        },
      );
      // One at a time: the next sub-task starts when this one's pull request is open, or when it ended.
      if ((await waitUntil(() => slot.phase === "ended" || published.has(slot.st.key))) === "stopped") return;
    }

    // Everything is started: the story is complete when every sub-task that was not dropped is merged (FR-R7).
    if ((await waitUntil(() => slots.every((s) => s.phase === "ended"))) === "stopped") return;
    const done = slots.filter(merged).length;
    const dropped = slots.filter((s) => s.result?.status === "dropped").length;
    const others = slots.filter((s) => !merged(s) && s.result?.status !== "dropped");
    if (!others.length && done > 0) {
      const text = done === count ? (count > 1 ? `All ${count} sub-tasks are merged. Done.` : "Pull request merged. Done.") : `${done} sub-task(s) merged, ${dropped} dropped. Done.`;
      return finish("completed", text, "success", count > 1);
    }
    if (!others.length) return finish("closed", "Every sub-task was dropped; nothing was built.", "info");
    const why = others.map((s) => `${s.index + 1}. ${s.st.title}: ${s.result?.note ?? s.result?.status}`).join(" ");
    await finish("closed", `${done} of ${count} sub-tasks merged. Not delivered: ${why}`, "info");
  };

  try {
    await main.run(deliver);
  } catch (err) {
    // The sub-tasks still alive end with the run: each records that it was cancelled before the run reports its end.
    await CancellationScope.nonCancellable(async () => {
      kids?.cancel();
      await Promise.allSettled(children);
    });
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
