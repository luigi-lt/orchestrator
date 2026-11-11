import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { fastTrackLimitsExceeded } from "@orch/catalog";
import { classifyRisk, config, errorMessage, log, scanDiffForSecrets, sleep, type RiskAssessment, type SecretFinding } from "@orch/common";
import {
  StepBrief,
  catalogExtract,
  findCatalogRepository,
  repoSlug,
  workspaceRepoPath,
  type Analysis,
  type BriefRepository,
  type Catalog,
  type Plan,
  type QuestionRound,
  type RepoRef,
  type RepositoryRequestDto,
  type StepKind,
  type StepResult,
  type TrackedFinding,
  type Verification,
  type WorkItem,
} from "@orch/contracts";
import { GitHubError } from "@orch/github";
import { failStepIfActive, getStep, listRepositoryRequests, resolveRepositoryRequest, upsertStep } from "@orch/store";
import { ctx, runCatalog } from "../context.js";
import { bundleReadOnly, ensureWorkRepo, git, stepArtifactsDir, workRepoDir } from "../git.js";

/** Clones the repository a sub-task changes and creates its branch; returns the commit the sub-task starts from. */
export async function prepareSubtaskRepo(input: {
  runId: string;
  subtaskKey: string;
  repo: RepoRef;
  defaultBranch: string;
  branch: string;
}): Promise<{ baseCommit: string }> {
  const { baseCommit } = await ensureWorkRepo(input.runId, input.subtaskKey, input.repo, input.defaultBranch, input.branch);
  return { baseCommit };
}

export interface PrepareStepInput {
  runId: string;
  stepId: string;
  kind: StepKind;
  title: string;
  /** The repository the agent starts in: the ticket's for analysis, the one being changed for planning, implementation and review. */
  primaryRepo: RepoRef;
  /** The sub-task's branch; implementation steps get it writable, review steps read-only. */
  branch: string;
  /** The sub-task an implementation or review step belongs to. */
  subtaskKey?: string;
  /** 0 for the first implementation or review; fix and re-review rounds count up. */
  round?: number;
  /** Implementation: the findings to fix. Review: the earlier findings to check again. */
  findings?: TrackedFinding[];
  guidance?: string;
  implementerSummary?: string;
  verification?: Verification;
  workItem: WorkItem;
  commitAuthor: { name: string; email: string };
  analysis?: Analysis;
  questionRounds?: QuestionRound[];
  feedback?: string;
  plan?: Plan;
  subtaskIndex?: number;
}

const bundleName = (index: number) => `repo-${index}.bundle`;
const briefPath = (stepId: string) => join(stepArtifactsDir(stepId), "brief.json");

const defaultBranches = new Map<string, { branch: string; at: number }>();
async function defaultBranchOf(repo: RepoRef): Promise<string> {
  const key = repoSlug(repo).toLowerCase();
  const hit = defaultBranches.get(key);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.branch;
  const branch = await ctx().github.getDefaultBranch(repo);
  defaultBranches.set(key, { branch, at: Date.now() });
  return branch;
}

/** Bundles a catalog repository at its default branch for a read-only checkout. */
async function readOnlyRepository(stepId: string, catalog: Catalog, slug: string, index: number, primary: boolean): Promise<BriefRepository> {
  const entry = findCatalogRepository(catalog, slug);
  if (!entry) throw ApplicationFailure.nonRetryable(`Repository ${slug} is not in the product catalog`);
  const repo = { owner: entry.owner, name: entry.name };
  const branch = await defaultBranchOf(repo);
  const commit = await bundleReadOnly(repo, branch, join(stepArtifactsDir(stepId), bundleName(index)));
  return { index, product: entry.product, repo, role: entry.role, branch, commit, mode: "readonly", path: workspaceRepoPath(entry.product, repo), primary };
}

/** Records the step and writes its brief and one git bundle per repository for the workspace (AD-24, AD-37). */
export async function prepareStep(input: PrepareStepInput): Promise<void> {
  const { db } = ctx();
  await upsertStep(db, {
    id: input.stepId,
    runId: input.runId,
    kind: input.kind,
    title: input.title,
    subtaskIndex: input.subtaskIndex ?? null,
    subtaskKey: input.subtaskKey ?? null,
    round: input.round ?? 0,
  });
  const dir = stepArtifactsDir(input.stepId);
  await mkdir(dir, { recursive: true });
  const catalog = await runCatalog(input.runId);
  const primarySlug = repoSlug(input.primaryRepo);
  const primaryEntry = findCatalogRepository(catalog, primarySlug);
  if (!primaryEntry) throw ApplicationFailure.nonRetryable(`Repository ${primarySlug} is not in the product catalog`);

  const repositories: BriefRepository[] = [];
  if (input.kind === "implement" || input.kind === "review") {
    // The sub-task's own clone, on its branch: writable for the implementer, read-only for the reviewer,
    // whose workspace can hand nothing back (AD-37, AD-39).
    if (!input.subtaskKey) throw ApplicationFailure.nonRetryable(`A ${input.kind} step needs a sub-task`);
    const cwd = workRepoDir(input.runId, input.subtaskKey);
    await git(["bundle", "create", join(dir, bundleName(0)), input.branch], { cwd });
    const commit = (await git(["rev-parse", input.branch], { cwd })).trim();
    const baseCommit = (await git(["merge-base", input.branch, "origin/HEAD"], { cwd }).catch(() => commit)).trim();
    repositories.push({
      index: 0,
      product: primaryEntry.product,
      repo: input.primaryRepo,
      role: primaryEntry.role,
      branch: input.branch,
      commit,
      baseCommit,
      mode: input.kind === "implement" ? "writable" : "readonly",
      path: workspaceRepoPath(primaryEntry.product, input.primaryRepo),
      primary: true,
    });
  } else {
    repositories.push(await readOnlyRepository(input.stepId, catalog, primarySlug, 0, true));
    if (input.kind === "analyse") {
      // The analyst starts with every repository of the ticket's product and asks for others on demand.
      const product = catalog.products.find((p) => p.id === primaryEntry.product);
      const siblings = (product?.repositories ?? []).filter((r) => r.id.toLowerCase() !== primarySlug.toLowerCase());
      for (const sibling of siblings.slice(0, config.maxStepRepositories() - 1)) {
        repositories.push(await readOnlyRepository(input.stepId, catalog, sibling.id, repositories.length, false));
      }
    }
  }

  const brief: StepBrief = {
    stepId: input.stepId,
    runId: input.runId,
    kind: input.kind,
    model: input.kind === "review" ? config.reviewerModel() : config.model(),
    branch: repositories[0]!.branch,
    workItem: input.workItem,
    repositories,
    maxRepositories: config.maxStepRepositories(),
    catalog: catalogExtract(catalog),
    analysis: input.analysis,
    questionRounds: input.questionRounds ?? [],
    feedback: input.feedback,
    plan: input.plan,
    subtaskIndex: input.subtaskIndex,
    round: input.round ?? 0,
    // The product's commands come from the catalog, so nothing in the repository can replace them (FR-M4, FR-M6).
    commands: input.kind === "implement" ? primaryEntry.commands : {},
    findings: input.findings ?? [],
    guidance: input.guidance,
    implementerSummary: input.implementerSummary,
    verification: input.verification,
    commitAuthor: input.commitAuthor,
    timeoutMinutes: config.stepTimeoutMinutes(),
  };
  await writeFile(briefPath(input.stepId), JSON.stringify(brief, null, 2));
}

/** Prepares the bundle for a repository an agent asked for through the gateway (request_repository). */
async function fulfilRepositoryRequest(runId: string, request: RepositoryRequestDto): Promise<void> {
  const { db } = ctx();
  try {
    const catalog = await runCatalog(runId);
    const brief = StepBrief.parse(JSON.parse(await readFile(briefPath(request.stepId), "utf8")));
    const ready = await listRepositoryRequests(db, request.stepId, "ready");
    const taken = brief.repositories.length + ready.length;
    if (taken >= brief.maxRepositories) {
      await resolveRepositoryRequest(db, request.id, { state: "denied", error: `This step already holds ${taken} repositories, the limit` });
      return;
    }
    const entry = await readOnlyRepository(request.stepId, catalog, request.repository, taken, false);
    await resolveRepositoryRequest(db, request.id, { state: "ready", entry });
    log("worker", `step ${request.stepId}: added repository ${request.repository}`);
  } catch (err) {
    // No read access for the requester's token shows up here (AD-42): the agent is told, the step continues.
    const noAccess = err instanceof GitHubError && (err.status === 404 || err.status === 403);
    const error = noAccess ? `The requester cannot read ${request.repository}` : `Could not prepare ${request.repository}: ${errorMessage(err)}`;
    await resolveRepositoryRequest(db, request.id, { state: noAccess ? "denied" : "failed", error: error.slice(0, 500) });
  }
}

const STALE_AFTER_MS = 3 * 60 * 1000;
const START_TIMEOUT_MS = 5 * 60 * 1000;

/** Supervises a step: serves repository requests and waits for the result, heartbeating to Temporal meanwhile. */
export async function awaitStep(input: { stepId: string }): Promise<StepResult> {
  const { db } = ctx();
  const activity = Context.current();
  const startedWaiting = Date.now();
  for (;;) {
    activity.heartbeat();
    const step = await getStep(db, input.stepId);
    if (!step) throw ApplicationFailure.nonRetryable(`Unknown step ${input.stepId}`);
    if ((step.state === "succeeded" || step.state === "failed") && step.result) return step.result;
    for (const request of await listRepositoryRequests(db, input.stepId, "pending")) {
      await fulfilRepositoryRequest(step.runId, request);
      activity.heartbeat();
    }
    const now = Date.now();
    if (step.state === "pending" && now - startedWaiting > START_TIMEOUT_MS) {
      await failStepIfActive(db, input.stepId, "The workspace did not start in time");
    } else if (step.state === "running" && step.lastSeenAt && now - new Date(step.lastSeenAt).getTime() > STALE_AFTER_MS) {
      await failStepIfActive(db, input.stepId, "The workspace stopped responding");
    }
    await Promise.race([sleep(1500), activity.cancelled.catch(() => undefined)]);
    if (activity.cancellationSignal.aborted) {
      await failStepIfActive(db, input.stepId, "Cancelled");
      throw activity.cancellationSignal.reason ?? new Error("Cancelled");
    }
  }
}

/** Fast-forwards the sub-task's branch with the commits produced by the step. Returns the number of new commits. */
export async function applyStepResult(input: { runId: string; subtaskKey: string; stepId: string; branch: string }): Promise<{ commits: number }> {
  const bundle = join(stepArtifactsDir(input.stepId), "out.bundle");
  if (!existsSync(bundle)) return { commits: 0 };
  const cwd = workRepoDir(input.runId, input.subtaskKey);
  await git(["checkout", input.branch], { cwd });
  const before = (await git(["rev-parse", "HEAD"], { cwd })).trim();
  try {
    await git(["bundle", "verify", bundle], { cwd });
  } catch (err) {
    throw ApplicationFailure.nonRetryable(`The step's changes do not build on the sub-task's branch: ${(err as Error).message}`);
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

/**
 * Turns the sub-task's commits (the implementation and its fix rounds) into one commit on top of the base.
 * What is pushed then contains exactly the change that was inspected: nothing from an earlier round
 * survives in the history, such as a secret that a fix round removed.
 */
export async function squashSubtask(input: {
  runId: string;
  subtaskKey: string;
  branch: string;
  baseCommit: string;
  title: string;
  summary: string;
  requester: string;
  commitAuthor: { name: string; email: string };
}): Promise<{ headCommit: string }> {
  const cwd = workRepoDir(input.runId, input.subtaskKey);
  await git(["checkout", input.branch], { cwd });
  await git(["reset", "--soft", input.baseCommit], { cwd });
  const staged = (await git(["diff", "--cached", "--name-only"], { cwd })).trim();
  if (staged) {
    const message = `${input.title.slice(0, 200)}\n\n${input.summary}\n\nAgent-Run: ${input.runId}\nRequested-By: ${input.requester}`;
    const identity = ["-c", `user.name=${input.commitAuthor.name}`, "-c", `user.email=${input.commitAuthor.email}`];
    await git([...identity, "commit", "--quiet", "--no-verify", "-m", message], { cwd });
  }
  return { headCommit: (await git(["rev-parse", "HEAD"], { cwd })).trim() };
}

export interface ChangeInspection {
  changedFiles: string[];
  secrets: SecretFinding[];
  risk: RiskAssessment;
  /** Why the change is beyond the fast track; empty when it is within the limits or the limits were not asked for. */
  limits: string[];
}

/** Secret scan, risk classification and fast-track limits of a sub-task's change, before anything is pushed. */
export async function inspectChanges(input: {
  runId: string;
  subtaskKey: string;
  repo: RepoRef;
  branch: string;
  baseCommit: string;
  checkLimits: boolean;
}): Promise<ChangeInspection> {
  const cwd = workRepoDir(input.runId, input.subtaskKey);
  const range = `${input.baseCommit}..${input.branch}`;
  const names = (await git(["diff", "--name-only", range], { cwd })).split("\n").filter(Boolean);
  const diff = await git(["diff", "--unified=0", range], { cwd });
  // The product's own high-risk paths add to the baseline rules; they can never relax them (D15).
  const entry = findCatalogRepository(await runCatalog(input.runId), repoSlug(input.repo));
  return {
    changedFiles: names,
    secrets: scanDiffForSecrets(diff),
    risk: classifyRisk(names, entry?.highRiskPaths ?? []),
    // The analysis was an estimate; the fast track is checked again on what was really changed (FR-A2).
    limits: input.checkLimits ? fastTrackLimitsExceeded(names, entry, config.fastTrackMaxFiles()) : [],
  };
}
