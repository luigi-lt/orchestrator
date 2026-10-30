import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { classifyRisk, config, scanDiffForSecrets, sleep, type RiskAssessment, type SecretFinding } from "@orch/common";
import type { Plan, QuestionRound, RepoRef, StepBrief, StepKind, StepResult, WorkItem } from "@orch/contracts";
import { failStepIfActive, getStep, upsertStep } from "@orch/store";
import { ctx } from "../context.js";
import { ensureRunRepo, git, runRepoDir, stepArtifactsDir } from "../git.js";

export async function prepareRunRepo(input: { runId: string; repo: RepoRef; defaultBranch: string; branch: string }): Promise<void> {
  await ensureRunRepo(input.runId, input.repo, input.defaultBranch, input.branch);
}

export interface PrepareStepInput {
  runId: string;
  stepId: string;
  kind: StepKind;
  title: string;
  branch: string;
  workItem: WorkItem;
  commitAuthor: { name: string; email: string };
  questionRounds?: QuestionRound[];
  feedback?: string;
  plan?: Plan;
  subtaskIndex?: number;
}

/** Records the step, writes the brief and a git bundle of the run branch for the workspace. */
export async function prepareStep(input: PrepareStepInput): Promise<void> {
  const { db } = ctx();
  await upsertStep(db, {
    id: input.stepId,
    runId: input.runId,
    kind: input.kind,
    title: input.title,
    subtaskIndex: input.subtaskIndex ?? null,
  });
  const dir = stepArtifactsDir(input.stepId);
  await mkdir(dir, { recursive: true });
  await git(["bundle", "create", join(dir, "in.bundle"), input.branch], { cwd: runRepoDir(input.runId) });
  const brief: StepBrief = {
    stepId: input.stepId,
    runId: input.runId,
    kind: input.kind,
    model: config.model(),
    branch: input.branch,
    workItem: input.workItem,
    questionRounds: input.questionRounds ?? [],
    feedback: input.feedback,
    plan: input.plan,
    subtaskIndex: input.subtaskIndex,
    commitAuthor: input.commitAuthor,
    timeoutMinutes: config.stepTimeoutMinutes(),
  };
  await writeFile(join(dir, "brief.json"), JSON.stringify(brief, null, 2));
}

const STALE_AFTER_MS = 3 * 60 * 1000;
const START_TIMEOUT_MS = 5 * 60 * 1000;

/** Waits for the workspace to report the step result, heartbeating to Temporal meanwhile. */
export async function awaitStep(input: { stepId: string }): Promise<StepResult> {
  const { db } = ctx();
  const activity = Context.current();
  const startedWaiting = Date.now();
  for (;;) {
    activity.heartbeat();
    const step = await getStep(db, input.stepId);
    if (!step) throw ApplicationFailure.nonRetryable(`Unknown step ${input.stepId}`);
    if ((step.state === "succeeded" || step.state === "failed") && step.result) return step.result;
    const now = Date.now();
    if (step.state === "pending" && now - startedWaiting > START_TIMEOUT_MS) {
      await failStepIfActive(db, input.stepId, "The workspace did not start in time");
    } else if (step.state === "running" && step.lastSeenAt && now - new Date(step.lastSeenAt).getTime() > STALE_AFTER_MS) {
      await failStepIfActive(db, input.stepId, "The workspace stopped responding");
    }
    await Promise.race([sleep(3000), activity.cancelled.catch(() => undefined)]);
    if (activity.cancellationSignal.aborted) {
      await failStepIfActive(db, input.stepId, "Cancelled");
      throw activity.cancellationSignal.reason ?? new Error("Cancelled");
    }
  }
}

/** Fast-forwards the run branch with the commits produced by the step. Returns the number of new commits. */
export async function applyStepResult(input: { runId: string; stepId: string; branch: string }): Promise<{ commits: number }> {
  const bundle = join(stepArtifactsDir(input.stepId), "out.bundle");
  if (!existsSync(bundle)) return { commits: 0 };
  const cwd = runRepoDir(input.runId);
  await git(["checkout", input.branch], { cwd });
  const before = (await git(["rev-parse", "HEAD"], { cwd })).trim();
  try {
    await git(["bundle", "verify", bundle], { cwd });
  } catch (err) {
    throw ApplicationFailure.nonRetryable(`The step's changes do not build on the run branch: ${(err as Error).message}`);
  }
  const ref = `refs/orch/${input.stepId}`;
  await git(["fetch", bundle, `refs/heads/${input.branch}:${ref}`], { cwd });
  try {
    await git(["merge", "--ff-only", ref], { cwd });
  } catch (err) {
    throw ApplicationFailure.nonRetryable(`The step rewrote earlier history; refusing to apply: ${(err as Error).message}`);
  }
  const count = (await git(["rev-list", "--count", `${before}..HEAD`], { cwd })).trim();
  return { commits: Number.parseInt(count, 10) || 0 };
}

export interface ChangeInspection {
  changedFiles: string[];
  secrets: SecretFinding[];
  risk: RiskAssessment;
}

/** Secret scan and risk classification of everything the run changed, before anything is pushed. */
export async function inspectChanges(input: { runId: string; branch: string; defaultBranch: string }): Promise<ChangeInspection> {
  const cwd = runRepoDir(input.runId);
  const range = `origin/${input.defaultBranch}...${input.branch}`;
  const names = (await git(["diff", "--name-only", range], { cwd })).split("\n").filter(Boolean);
  const diff = await git(["diff", "--unified=0", range], { cwd });
  return { changedFiles: names, secrets: scanDiffForSecrets(diff), risk: classifyRisk(names) };
}
