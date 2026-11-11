import { ApplicationFailure, Context } from "@temporalio/activity";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { CatalogError, currentCatalog } from "@orch/catalog";
import { config, log, newId, slugify } from "@orch/common";
import {
  RUN_WORKFLOW_GENERATION,
  TASK_QUEUES,
  catalogRepositories,
  workflowIdForIssue,
  type DeliveryRunInput,
  type RepoRef,
  type Track,
  type WorkItem,
} from "@orch/contracts";
import { GitHubError, type GitHubClient } from "@orch/github";
import { getPollEtag, setPollEtag } from "@orch/store";
import { ctx } from "../context.js";
import { git, remoteFor, workRepoDir } from "../git.js";

const LABEL_IN_PROGRESS = "ai-in-progress";
const LABEL_DONE = "ai-done";
const MARKER = (key: string) => `<!-- orchestrator:${key} -->`;
const isOrchestratorComment = (body: string) => body.includes("<!-- orchestrator:");

/** Turns non-retryable GitHub errors into non-retryable activity failures. */
async function gh<T>(fn: (client: GitHubClient) => Promise<T>): Promise<T> {
  try {
    return await fn(ctx().github);
  } catch (err) {
    if (err instanceof GitHubError && !err.retryable) throw ApplicationFailure.nonRetryable(err.message, "GitHubError");
    throw err;
  }
}

/** Branch, base branch and commit identity for the repository a run changes (not always the ticket's own). */
export async function lookupContext(input: { runId: string; workItem: WorkItem; repo: RepoRef }): Promise<{
  defaultBranch: string;
  branch: string;
  commitAuthor: { name: string; email: string };
}> {
  const { owner } = ctx();
  const defaultBranch = await gh((c) => c.getDefaultBranch(input.repo));
  const branch = `agent/${input.workItem.number}-${slugify(input.workItem.title, 32)}-${input.runId.slice(-6)}`;
  const requester = input.workItem.requester;
  const id = requester.id ?? (requester.login === owner.login ? owner.id : undefined);
  const email = id ? `${id}+${requester.login}@users.noreply.github.com` : `${requester.login}@users.noreply.github.com`;
  const name = requester.login === owner.login && owner.name ? owner.name : requester.login;
  return { defaultBranch, branch, commitAuthor: { name, email } };
}

/** Posts a comment unless one with the same idempotency key already exists. */
export async function commentOnIssue(input: { repo: RepoRef; number: number; key: string; body: string }): Promise<void> {
  const marker = MARKER(input.key);
  const existing = await gh((c) => c.listComments(input.repo, input.number));
  if (existing.some((c) => c.body.includes(marker))) return;
  await gh((c) => c.createComment(input.repo, input.number, `${input.body}\n\n${marker}`));
}

/** Removes the trigger label (so the issue is not picked up again) and marks it in progress. */
export async function claimIssue(input: { repo: RepoRef; number: number; runId: string }): Promise<void> {
  await gh((c) => c.ensureLabel(input.repo, LABEL_IN_PROGRESS, "fbca04", "The orchestrator is working on this issue"));
  await gh((c) => c.ensureLabel(input.repo, LABEL_DONE, "0e8a16", "The orchestrator finished this issue"));
  await gh((c) => c.removeLabel(input.repo, input.number, config.triggerLabel()));
  await gh((c) => c.removeLabel(input.repo, input.number, LABEL_DONE));
  await gh((c) => c.addLabels(input.repo, input.number, [LABEL_IN_PROGRESS]));
  await commentOnIssue({
    repo: input.repo,
    number: input.number,
    key: `run=${input.runId}:claimed`,
    body: `🤖 The orchestrator picked up this issue (run \`${input.runId}\`). Follow it in the orchestrator web app.`,
  });
}

/** Returns the requester's reply posted after `since`, ignoring the orchestrator's own comments. */
export async function findRequesterReply(input: { repo: RepoRef; number: number; since: string; requester: string }): Promise<string | null> {
  const comments = await gh((c) => c.listComments(input.repo, input.number, input.since));
  const replies = comments.filter(
    (c) => c.author === input.requester && !isOrchestratorComment(c.body) && new Date(c.createdAt) > new Date(input.since),
  );
  return replies.length ? replies.map((r) => r.body.trim()).join("\n\n") : null;
}

const TRACK_LABELS: Record<Track, { name: string; color: string; description: string }> = {
  fast: { name: "track:fast", color: "1d76db", description: "Small change: straight to a reviewed pull request" },
  guided: { name: "track:guided", color: "5319e7", description: "Designed with the requester before it is built" },
};

/** Mirrors the track on the ticket; the label follows when the track changes (FR-A3, work model §4). */
export async function setTrackLabel(input: { repo: RepoRef; number: number; track: Track }): Promise<void> {
  const other: Track = input.track === "fast" ? "guided" : "fast";
  for (const t of Object.values(TRACK_LABELS)) await gh((c) => c.ensureLabel(input.repo, t.name, t.color, t.description));
  await gh((c) => c.removeLabel(input.repo, input.number, TRACK_LABELS[other].name));
  await gh((c) => c.addLabels(input.repo, input.number, [TRACK_LABELS[input.track].name]));
}

export async function finalizeIssue(input: { repo: RepoRef; number: number; outcome: "completed" | "closed" | "cancelled" | "failed" }): Promise<void> {
  await gh((c) => c.removeLabel(input.repo, input.number, LABEL_IN_PROGRESS));
  // Never leave the trigger label behind, or the issue would be picked up again in a loop.
  await gh((c) => c.removeLabel(input.repo, input.number, config.triggerLabel()));
  if (input.outcome === "completed") await gh((c) => c.addLabels(input.repo, input.number, [LABEL_DONE]));
}

/** Pushes a sub-task's branch. Only agent branches ever leave the orchestrator. */
export async function pushBranch(input: { runId: string; subtaskKey: string; repo: RepoRef; branch: string }): Promise<void> {
  const { url, env } = remoteFor(input.repo);
  if (!input.branch.startsWith("agent/")) throw ApplicationFailure.nonRetryable(`Refusing to push non-agent branch ${input.branch}`);
  const cwd = workRepoDir(input.runId, input.subtaskKey);
  // The branch was squashed locally; on a retry or a re-publish the remote copy is replaced by exactly the inspected commit.
  await git(["push", "--force", url, `refs/heads/${input.branch}:refs/heads/${input.branch}`], { cwd, env });
}

/** Opens the pull request of a pushed branch (or returns the one that already exists). */
export async function openPullRequest(input: {
  repo: RepoRef;
  branch: string;
  base: string;
  title: string;
  body: string;
}): Promise<{ number: number; url: string; title: string }> {
  const existing = await gh((c) => c.findPullRequestByHead(input.repo, input.branch));
  if (existing) return { number: existing.number, url: existing.url, title: existing.title };
  const pr = await gh((c) => c.createPullRequest(input.repo, { title: input.title, head: input.branch, base: input.base, body: input.body }));
  return { number: pr.number, url: pr.url, title: pr.title };
}

export async function getPullRequestState(input: { repo: RepoRef; number: number }): Promise<"open" | "merged" | "closed"> {
  const pr = await gh((c) => c.getPullRequest(input.repo, input.number));
  return pr.merged ? "merged" : pr.state;
}

/** Discovery poller: finds issues labelled by the owner in every catalog repository and starts a run for each. */
export async function discoverAndStart(): Promise<number> {
  const { db, github, temporal, owner } = ctx();
  const label = config.triggerLabel();
  let catalog;
  try {
    catalog = currentCatalog();
  } catch (err) {
    // An invalid catalog stops new runs; runs in flight keep the version they pinned (AD-30).
    if (err instanceof CatalogError) {
      log("worker", `discovery skipped, the product catalog is invalid: ${err.message}`);
      return 0;
    }
    throw err;
  }
  let started = 0;
  for (const entry of catalogRepositories(catalog)) {
    const slug = entry.id;
    const repo = { owner: entry.owner, name: entry.name };
    const pollKey = `github:${slug}:${label}`;
    let listing;
    try {
      listing = await github.listLabelledIssues(repo, label, await getPollEtag(db, pollKey));
    } catch (err) {
      log("worker", `discovery failed for ${slug}: ${(err as Error).message}`);
      continue;
    }
    if (listing.notModified) continue;
    for (const issue of listing.issues) {
      Context.current().heartbeat();
      const labeler = await github.findLabeler(repo, issue.number, label);
      if (labeler !== owner.login) {
        log("worker", `ignoring ${slug}#${issue.number}: labelled by ${labeler ?? "unknown"}, not the owner ${owner.login}`);
        continue;
      }
      const input: DeliveryRunInput = {
        runId: newId("run"),
        conversationId: null,
        workItem: {
          source: "github",
          repo,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          url: issue.url,
          labels: issue.labels.filter((l) => l !== label),
          requester: { login: owner.login, id: owner.id },
        },
      };
      try {
        await temporal.workflow.start("deliveryRunWorkflow", {
          taskQueue: TASK_QUEUES.orchestration,
          workflowId: workflowIdForIssue(repo, issue.number),
          args: [input],
          memo: { generation: RUN_WORKFLOW_GENERATION },
          workflowIdConflictPolicy: "FAIL",
          workflowIdReusePolicy: "ALLOW_DUPLICATE",
        });
        started++;
        log("worker", `started run ${input.runId} for ${slug}#${issue.number}`);
      } catch (err) {
        if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
      }
    }
    await setPollEtag(db, pollKey, listing.etag);
  }
  return started;
}
