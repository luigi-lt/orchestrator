import { existsSync } from "node:fs";
import { join as joinPath } from "node:path";
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
  type ChangedFile,
  type DependencyRef,
  type DesignTurnInput,
  type DesignTurnResult,
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
import {
  completeStep,
  enqueueDesignTurn,
  failStepIfActive,
  getDesignSession,
  getDesignTurn,
  getLatestPlanVersion,
  getRun,
  getStep,
  listMessages,
  listRepositoryRequests,
  listSteps,
  resolveRepositoryRequest,
  saveDesignSession,
  upsertStep,
  type StepRecord,
} from "@orch/store";
import { ctx, runCatalog } from "../context.js";
import { bundleReadOnly, ensureWorkRepo, git, mergeDefaultBranch, stepArtifactsDir, workRepoDir } from "../git.js";

/**
 * Clones the repository a sub-task changes and creates its branch; returns the commit the sub-task's own change
 * starts from: the head of the default branch, or the approved commit of the sub-task it is stacked on (AD-41).
 */
export async function prepareSubtaskRepo(input: {
  runId: string;
  subtaskKey: string;
  repo: RepoRef;
  defaultBranch: string;
  branch: string;
  stackedOn?: { branch: string; commit: string };
}): Promise<{ baseCommit: string }> {
  try {
    const { baseCommit } = await ensureWorkRepo(input.runId, input.subtaskKey, input.repo, input.defaultBranch, input.branch, input.stackedOn);
    return { baseCommit };
  } catch (err) {
    if (input.stackedOn && /is-ancestor|merge-base/.test(errorMessage(err))) {
      throw ApplicationFailure.nonRetryable(`The approved change this sub-task builds on is no longer on the branch ${input.stackedOn.branch}`);
    }
    throw err;
  }
}

/** Merges the default branch into a sub-task's branch, once the pull request it was stacked on has merged (AD-41). */
export async function updateBranchFromDefault(input: {
  runId: string;
  subtaskKey: string;
  repo: RepoRef;
  defaultBranch: string;
  branch: string;
  commitAuthor: { name: string; email: string };
}): Promise<{ status: "up_to_date" | "merged" | "conflict"; headCommit: string }> {
  return mergeDefaultBranch(input.runId, input.subtaskKey, input.repo, input.defaultBranch, input.branch, input.commitAuthor);
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
  /** The commit the sub-task's own change starts from; the reviewer's diff starts there. */
  changeBase?: string;
  /** Approved changes in other repositories that this sub-task builds on: checked out read-only (AD-41). */
  references?: DependencyRef[];
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

/** Bundles a catalog repository at its default branch (or at a pinned commit) for a read-only checkout. */
async function readOnlyRepository(stepId: string, catalog: Catalog, slug: string, index: number, primary: boolean, pin?: string): Promise<BriefRepository> {
  const entry = findCatalogRepository(catalog, slug);
  if (!entry) throw ApplicationFailure.nonRetryable(`Repository ${slug} is not in the product catalog`);
  const repo = { owner: entry.owner, name: entry.name };
  const branch = await defaultBranchOf(repo);
  const { commit, ref } = await bundleReadOnly(repo, branch, join(stepArtifactsDir(stepId), bundleName(index)), pin);
  return { index, product: entry.product, repo, role: entry.role, branch: ref, commit, mode: "readonly", path: workspaceRepoPath(entry.product, repo), primary };
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
      changeBase: input.changeBase ?? baseCommit,
      mode: input.kind === "implement" ? "writable" : "readonly",
      path: workspaceRepoPath(primaryEntry.product, input.primaryRepo),
      primary: true,
    });
    for (const ref of input.references ?? []) {
      if (repositories.length >= config.maxStepRepositories()) break;
      const entry = findCatalogRepository(catalog, repoSlug(ref.repo));
      if (!entry || repoSlug(ref.repo).toLowerCase() === primarySlug.toLowerCase()) continue;
      const target = join(dir, bundleName(repositories.length));
      // The approved commit on its pushed branch; once that branch is merged and gone, the default branch holds the change.
      const bundled = await bundleReadOnly(ref.repo, ref.branch, target, ref.headCommit).then(
        (b) => ({ ...b, note: `The approved change of the sub-task "${ref.title}" (pull request #${ref.prNumber}, not merged yet). Read it; you cannot change it.` }),
        async () => ({ ...(await bundleReadOnly(ref.repo, await defaultBranchOf(ref.repo), target)), note: `Holds the merged change of the sub-task "${ref.title}". Read it; you cannot change it.` }),
      );
      repositories.push({
        index: repositories.length,
        product: entry.product,
        repo: ref.repo,
        role: entry.role,
        branch: bundled.ref,
        commit: bundled.commit,
        mode: "readonly",
        path: workspaceRepoPath(entry.product, ref.repo),
        primary: false,
        note: bundled.note,
      });
    }
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
    // A repository opened in a design session stays part of it: a restored workspace gets it again.
    const session = await getDesignSession(db, runId);
    if (session?.stepId === request.stepId) await saveDesignSession(db, runId, { repositories: [...session.repositories, entry] });
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

// ---------------------------------------------------------------------------
// Design session (AD-34, AD-35): the architect's session workspace and its turns
// ---------------------------------------------------------------------------

const stepAlive = (step: StepRecord | null): step is StepRecord => {
  if (!step || (step.state !== "pending" && step.state !== "running")) return false;
  const now = Date.now();
  if (step.state === "pending") return now - new Date(step.createdAt).getTime() < START_TIMEOUT_MS;
  return !step.lastSeenAt || now - new Date(step.lastSeenAt).getTime() < STALE_AFTER_MS;
};

const designCheckpoint = (runId: string) => joinPath(config.artifactsDir(), `design-${runId}`, "checkpoint.tgz");

/**
 * Makes sure the design session has a workspace to run its next turn in. Returns the step of a live
 * workspace, or prepares a new one (brief and bundles) for the workflow to start: on the first turn,
 * after the session was saved when idle, or after its workspace was lost.
 */
export async function prepareDesignWorkspace(input: {
  runId: string;
  workItem: WorkItem;
  analysis: Analysis;
  /** The repositories the analysis named: what a new session starts with. */
  repositories: string[];
}): Promise<{ stepId: string; fresh: boolean; expired: boolean; resumed: boolean }> {
  const { db } = ctx();
  const session = await getDesignSession(db, input.runId);
  const current = session?.stepId ? await getStep(db, session.stepId) : null;
  if (session?.state === "active" && stepAlive(current)) {
    // A workspace that has lived too long is saved and replaced before it runs another turn.
    const expired = Date.now() - new Date(current.createdAt).getTime() > config.designMaxMinutes() * 60 * 1000;
    return { stepId: current.id, fresh: false, expired, resumed: false };
  }
  if (current) await failStepIfActive(db, current.id, "The design session workspace was replaced");

  const earlier = (await listSteps(db, input.runId)).filter((st) => st.kind === "design").length;
  const stepId = `${input.runId}-d${earlier + 1}`;
  await upsertStep(db, { id: stepId, runId: input.runId, kind: "design", title: earlier ? `Design session (resumed ${earlier})` : "Design session", subtaskIndex: null });
  await mkdir(stepArtifactsDir(stepId), { recursive: true });
  const catalog = await runCatalog(input.runId);

  // The same repositories at the same commits as before; a new session starts with what the analysis named.
  const wanted = session?.repositories.length
    ? session.repositories.map((r) => ({ slug: repoSlug(r.repo), pin: r.commit as string | undefined }))
    : input.repositories.map((slug) => ({ slug, pin: undefined as string | undefined }));
  const home = repoSlug(input.workItem.repo).toLowerCase();
  const primaryIndex = Math.max(0, wanted.findIndex((w) => w.slug.toLowerCase() === home));
  const repositories: BriefRepository[] = [];
  for (const [index, w] of wanted.entries()) repositories.push(await readOnlyRepository(stepId, catalog, w.slug, index, index === primaryIndex, w.pin));

  // The record of the session: what it is rebuilt from when its checkpoint cannot be restored (R-13).
  const run = await getRun(db, input.runId);
  const messages = run?.conversationId ? await listMessages(db, run.conversationId) : [];
  const history = messages
    .filter((m) => m.text && (m.role === "user" || (m.role === "agent" && m.author === "architect")))
    .slice(-60)
    .map((m) => ({ role: m.role === "user" ? ("requester" as const) : ("architect" as const), text: m.text!.slice(0, 6000) }));
  const latest = await getLatestPlanVersion(db, input.runId);

  const brief: StepBrief = {
    stepId,
    runId: input.runId,
    kind: "design",
    model: config.model(),
    branch: repositories[primaryIndex]!.branch,
    workItem: input.workItem,
    repositories,
    maxRepositories: config.maxStepRepositories(),
    catalog: catalogExtract(catalog),
    analysis: input.analysis,
    questionRounds: [],
    round: 0,
    commands: {},
    findings: [],
    design: {
      sessionId: `design-${input.runId}`,
      hasCheckpoint: !!session?.hasCheckpoint && existsSync(designCheckpoint(input.runId)),
      history,
      latestPlan: latest?.plan,
      latestVersion: latest?.version,
    },
    commitAuthor: { name: input.workItem.requester.login, email: `${input.workItem.requester.login}@users.noreply.github.com` },
    timeoutMinutes: config.designMaxMinutes(),
  };
  await writeFile(briefPath(stepId), JSON.stringify(brief, null, 2));
  await saveDesignSession(db, input.runId, { state: "active", stepId, repositories });
  return { stepId, fresh: true, expired: false, resumed: earlier > 0 };
}

/**
 * Hands a turn to the session workspace and waits for the architect's reply, heartbeating meanwhile.
 * The turn is queued once; when the workspace is lost the activity fails, and the workflow delivers the
 * same turn to a new workspace.
 */
export async function awaitDesignTurn(input: { runId: string; stepId: string; turn: DesignTurnInput }): Promise<DesignTurnResult> {
  const { db } = ctx();
  const activity = Context.current();
  await enqueueDesignTurn(db, input.runId, input.turn);
  for (;;) {
    activity.heartbeat();
    const turn = await getDesignTurn(db, input.turn.turnId);
    if (turn?.state === "done" && turn.result) return turn.result;
    for (const request of await listRepositoryRequests(db, input.stepId, "pending")) {
      await fulfilRepositoryRequest(input.runId, request);
      activity.heartbeat();
    }
    if (!stepAlive(await getStep(db, input.stepId))) {
      await failStepIfActive(db, input.stepId, "The design session workspace stopped responding");
      throw ApplicationFailure.nonRetryable("The design session workspace was lost", "WorkspaceLost");
    }
    await Promise.race([sleep(700), activity.cancelled.catch(() => undefined)]);
    if (activity.cancellationSignal.aborted) throw activity.cancellationSignal.reason ?? new Error("Cancelled");
  }
}

/** Waits for a step to end by itself; returns false when it did not within the time given. */
async function stepEnded(stepId: string, withinMs: number): Promise<boolean> {
  const { db } = ctx();
  for (const deadline = Date.now() + withinMs; Date.now() < deadline; ) {
    const step = await getStep(db, stepId);
    if (!step || step.state === "succeeded" || step.state === "failed") return true;
    Context.current().heartbeat();
    await sleep(500);
  }
  return false;
}

/**
 * Asks the session workspace to save the architect's session and stop (it was idle, or lived too long).
 * Returns the step whose workspace the workflow then destroys.
 */
export async function suspendDesignWorkspace(input: { runId: string }): Promise<{ stepId: string | null; saved: boolean }> {
  const { db } = ctx();
  const session = await getDesignSession(db, input.runId);
  if (!session?.stepId || session.state === "closed") return { stepId: null, saved: false };
  await saveDesignSession(db, input.runId, { state: "suspending" });
  const saved = (await stepEnded(session.stepId, 120_000)) && (await getStep(db, session.stepId))?.state === "succeeded";
  if (!saved) await failStepIfActive(db, session.stepId, "The design session workspace did not save its session in time");
  await saveDesignSession(db, input.runId, { state: "suspended", stepId: null });
  return { stepId: session.stepId, saved };
}

/** Ends the design session for good: the plan is approved, or the run is cancelled. */
export async function closeDesignSession(input: { runId: string }): Promise<{ stepId: string | null }> {
  const { db } = ctx();
  const session = await getDesignSession(db, input.runId);
  if (!session) return { stepId: null };
  await saveDesignSession(db, input.runId, { state: "closed" });
  if (session.stepId && !(await stepEnded(session.stepId, 30_000))) {
    await completeStep(db, session.stepId, { status: "succeeded", summary: "Design session closed" });
  }
  await saveDesignSession(db, input.runId, { stepId: null });
  return { stepId: session.stepId };
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
  /** The same files with their line counts, for the requester's check of the change. */
  files: ChangedFile[];
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
  const count = (text: string) => (text === "-" ? null : Number.parseInt(text, 10) || 0);
  const files: ChangedFile[] = (await git(["diff", "--numstat", "--no-renames", range], { cwd }))
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .map(([added, removed, ...path]) => ({ path: path.join("\t"), added: count(added ?? "0"), removed: count(removed ?? "0") }));
  // The product's own high-risk paths add to the baseline rules; they can never relax them (D15).
  const entry = findCatalogRepository(await runCatalog(input.runId), repoSlug(input.repo));
  return {
    changedFiles: names,
    files,
    secrets: scanDiffForSecrets(diff),
    risk: classifyRisk(names, entry?.highRiskPaths ?? []),
    // The analysis was an estimate; the fast track is checked again on what was really changed (FR-A2).
    limits: input.checkLimits ? fastTrackLimitsExceeded(names, entry, config.fastTrackMaxFiles()) : [],
  };
}
