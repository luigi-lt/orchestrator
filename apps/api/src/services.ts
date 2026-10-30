import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { config, log, newId, sleep } from "@orch/common";
import { TASK_QUEUES, parseRepoSlug, repoSlug, workflowIdForIssue, type DeliveryRunInput, type RepoRef } from "@orch/contracts";
import { GitHubClient, type GitHubUser } from "@orch/github";
import { findLatestRunByWorkflowId, type Db } from "@orch/store";
import type { StreamHub } from "./hub.js";

export interface Services {
  db: Db;
  github: GitHubClient;
  owner: GitHubUser;
  hub: StreamHub;
  temporal(): Promise<Client>;
}

let temporalClient: Promise<Client> | undefined;

/** Lazily connects to Temporal, retrying while it starts up. */
export function temporal(): Promise<Client> {
  temporalClient ??= (async () => {
    for (let i = 1; ; i++) {
      try {
        const connection = await Connection.connect({ address: config.temporalAddress() });
        return new Client({ connection, namespace: config.temporalNamespace() });
      } catch (err) {
        if (i >= 60) {
          temporalClient = undefined;
          throw err;
        }
        log("api", `waiting for Temporal: ${(err as Error).message}`);
        await sleep(2000);
      }
    }
  })();
  return temporalClient;
}

export function allowedRepo(slug: string): RepoRef {
  const repo = parseRepoSlug(slug);
  const allowed = config.githubRepos().map((s) => s.toLowerCase());
  if (!allowed.includes(repoSlug(repo).toLowerCase())) {
    throw new UserError(`Repository ${repoSlug(repo)} is not configured. Configured: ${config.githubRepos().join(", ") || "none"}`);
  }
  return repo;
}

export class UserError extends Error {}

/** Starts a delivery run for an issue (or returns the run already working on it). */
export async function startRunForIssue(
  s: Services,
  repoSlugText: string,
  issueNumber: number,
  conversationId: string | null,
): Promise<{ runId: string; started: boolean }> {
  const repo = allowedRepo(repoSlugText);
  const issue = await s.github.getIssue(repo, issueNumber);
  if (issue.state !== "open") throw new UserError(`Issue ${repoSlug(repo)}#${issueNumber} is closed`);
  const input: DeliveryRunInput = {
    runId: newId("run"),
    conversationId,
    workItem: {
      source: "github",
      repo,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      url: issue.url,
      requester: { login: s.owner.login, id: s.owner.id },
    },
  };
  const workflowId = workflowIdForIssue(repo, issueNumber);
  try {
    const client = await s.temporal();
    await client.workflow.start("deliveryRunWorkflow", {
      taskQueue: TASK_QUEUES.orchestration,
      workflowId,
      args: [input],
      workflowIdConflictPolicy: "FAIL",
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
    });
    return { runId: input.runId, started: true };
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
    for (let i = 0; i < 10; i++) {
      const existing = await findLatestRunByWorkflowId(s.db, workflowId);
      if (existing) return { runId: existing.id, started: false };
      await sleep(500);
    }
    throw new UserError(`A run for ${repoSlug(repo)}#${issueNumber} is already starting`);
  }
}

export async function signalRun(s: Services, workflowId: string, signal: "approval" | "answer" | "cancel", payload: unknown): Promise<void> {
  const client = await s.temporal();
  await client.workflow.getHandle(workflowId).signal(signal, payload);
}
