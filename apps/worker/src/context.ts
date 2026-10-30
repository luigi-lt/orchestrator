import type { Client } from "@temporalio/client";
import type { Db } from "@orch/store";
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
