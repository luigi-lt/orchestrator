import type { Client } from "@temporalio/client";
import type { Catalog } from "@orch/contracts";
import type { Db } from "@orch/store";
import { getCatalogForRun } from "@orch/store";
import type { GitHubClient, GitHubUser } from "@orch/github";

export interface WorkerContext {
  db: Db;
  github: GitHubClient;
  temporal: Client;
  owner: GitHubUser;
}

let current: WorkerContext | undefined;

export function setContext(ctx: WorkerContext): void {
  current = ctx;
}

export function ctx(): WorkerContext {
  if (!current) throw new Error("Worker context not initialized");
  return current;
}

/** The catalog version a run pinned when it started (AD-30). */
export async function runCatalog(runId: string): Promise<Catalog> {
  const catalog = await getCatalogForRun(ctx().db, runId);
  if (!catalog) throw new Error(`Run ${runId} has no pinned product catalog`);
  return catalog;
}
