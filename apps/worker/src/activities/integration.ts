import { ApplicationFailure, Context } from "@temporalio/activity";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { config, log, newId, slugify } from "@orch/common";
import { TASK_QUEUES, workflowIdForIssue, type DeliveryRunInput, type RepoRef, type WorkItem } from "@orch/contracts";
import { GitHubError, type GitHubClient } from "@orch/github";
import { getPollEtag, setPollEtag } from "@orch/store";
import { ctx } from "../context.js";
import { git, remoteFor, runRepoDir } from "../git.js";

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

/** Branch, base branch and commit identity for a run. */
export async function lookupContext(input: { runId: string; workItem: WorkItem }): Promise<{
  defaultBranch: string;
  branch: string;
  commitAuthor: { name: string; email: string };
}> {
  const { owner } = ctx();
  const defaultBranch = await gh((c) => c.getDefaultBranch(input.workItem.repo));
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

export async function finalizeIssue(input: { repo: RepoRef; number: number; outcome: "completed" | "closed" | "cancelled" | "failed" }): Promise<void> {
  await gh((c) => c.removeLabel(input.repo, input.number, LABEL_IN_PROGRESS));
  // Never leave the trigger label behind, or the issue would be picked up again in a loop.
  await gh((c) => c.removeLabel(input.repo, input.number, config.triggerLabel()));
  if (input.outcome === "completed") await gh((c) => c.addLabels(input.repo, input.number, [LABEL_DONE]));
}

/** Pushes the run branch and opens the pull request (or returns the one that already exists). */
export async function publishBranch(input: {
  runId: string;
  repo: RepoRef;
  branch: string;
  defaultBranch: string;
  title: string;
  body: string;
}): Promise<{ number: number; url: string; title: string }> {
  const { url, env } = remoteFor(input.repo);
  const dir = runRepoDir(input.runId);
  if (!input.branch.startsWith("agent/")) throw ApplicationFailure.nonRetryable(`Refusing to push non-agent branch ${input.branch}`);
  await git(["push", url, `refs/heads/${input.branch}:refs/heads/${input.branch}`], { cwd: dir, env });
  const existing = await gh((c) => c.findPullRequestByHead(input.repo, input.branch));
  if (existing) return { number: existing.number, url: existing.url, title: existing.title };
  const pr = await gh((c) => c.createPullRequest(input.repo, { title: input.title, head: input.branch, base: input.defaultBranch, body: input.body }));
  return { number: pr.number, url: pr.url, title: pr.title };
}

export async function getPullRequestState(input: { repo: RepoRef; number: number }): Promise<"open" | "merged" | "closed"> {
  const pr = await gh((c) => c.getPullRequest(input.repo, input.number));
  return pr.merged ? "merged" : pr.state;
}

/** Discovery poller: finds issues labelled by the owner and starts a run for each (claiming via workflow ID). */
export async function discoverAndStart(): Promise<number> {
  const { db, github, temporal, owner } = ctx();
  const label = config.triggerLabel();
  let started = 0;
  for (const slug of config.githubRepos()) {
    const [repoOwner, repoName] = slug.split("/");
    if (!repoOwner || !repoName) continue;
    const repo = { owner: repoOwner, name: repoName };
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
          requester: { login: owner.login, id: owner.id },
        },
      };
      try {
        await temporal.workflow.start("deliveryRunWorkflow", {
          taskQueue: TASK_QUEUES.orchestration,
          workflowId: workflowIdForIssue(repo, issue.number),
          args: [input],
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
