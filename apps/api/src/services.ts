import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { CatalogError, currentCatalog } from "@orch/catalog";
import { config, log, newId, sleep } from "@orch/common";
import {
  RUN_WORKFLOW_GENERATION,
  TASK_QUEUES,
  catalogRepositories,
  findCatalogRepository,
  parseRepoSlug,
  repoSlug,
  workflowIdForIssue,
  type Catalog,
  type DeliveryRunInput,
  type RepoRef,
} from "@orch/contracts";
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

export class UserError extends Error {}

/** The product catalog as it is on disk now; an invalid catalog is reported to the person, not thrown as a server error. */
export function catalog(): Catalog {
  try {
    return currentCatalog();
  } catch (err) {
    if (err instanceof CatalogError) throw new UserError(`The product catalog is invalid, so no work can start: ${err.message}`);
    throw err;
  }
}

/** Work can only start from a repository of the product catalog (FR-M1). */
export function allowedRepo(slug: string): RepoRef {
  const repo = parseRepoSlug(slug);
  const c = catalog();
  const entry = findCatalogRepository(c, repoSlug(repo));
  if (!entry) {
    throw new UserError(`Repository ${repoSlug(repo)} is not in the product catalog. Repositories: ${catalogRepositories(c).map((r) => r.id).join(", ")}`);
  }
  return { owner: entry.owner, name: entry.name };
}

/**
 * Starts a delivery run for an issue (or returns the run already working on it).
 * `conversationId` is the chat the request came from: it gets a link to the run's own conversation.
 */
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
      labels: issue.labels.filter((l) => l !== config.triggerLabel()),
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
      memo: { generation: RUN_WORKFLOW_GENERATION },
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

export async function signalRun(
  s: Services,
  workflowId: string,
  signal: "approval" | "answer" | "cancel" | "changeTrack" | "freshSession",
  payload: unknown,
): Promise<void> {
  const client = await s.temporal();
  await client.workflow.getHandle(workflowId).signal(signal, payload);
}
