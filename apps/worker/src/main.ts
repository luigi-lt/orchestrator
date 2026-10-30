import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { Client, Connection, ScheduleNotFoundError } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { config, log, sleep } from "@orch/common";
import { TASK_QUEUES } from "@orch/contracts";
import { GitHubClient } from "@orch/github";
import { connectStore } from "@orch/store";
import * as integration from "./activities/integration.js";
import * as orchestration from "./activities/orchestration.js";
import * as steps from "./activities/steps.js";
import { setContext } from "./context.js";

const SCHEDULE_ID = "github-discovery";

async function retry<T>(what: string, fn: () => Promise<T>, attempts = 60): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      log("worker", `waiting for ${what}: ${(err as Error).message}`);
      await sleep(2000);
    }
  }
}

async function ensureDiscoverySchedule(client: Client): Promise<void> {
  const seconds = config.pollIntervalSeconds();
  const every = seconds * 1000;
  const handle = client.schedule.getHandle(SCHEDULE_ID);
  try {
    await handle.describe();
    await handle.update((prev) => ({ ...prev, spec: { intervals: [{ every }] } }));
  } catch (err) {
    if (!(err instanceof ScheduleNotFoundError)) throw err;
    await client.schedule.create({
      scheduleId: SCHEDULE_ID,
      spec: { intervals: [{ every }] },
      action: { type: "startWorkflow", workflowType: "discoveryWorkflow", taskQueue: TASK_QUEUES.orchestration, args: [] },
      policies: { overlap: "SKIP", catchupWindow: "1 minute" },
    });
  }
  log("worker", `discovery schedule polls every ${seconds}s (${config.githubRepos().join(", ") || "no repositories configured"})`);
}

async function main(): Promise<void> {
  await mkdir(config.reposDir(), { recursive: true });
  await mkdir(config.artifactsDir(), { recursive: true });
  const db = await connectStore();
  const github = new GitHubClient(config.githubToken(), config.githubApiUrl());
  const me = await retry("GitHub", () => github.getAuthenticatedUser(), 5);
  const ownerLogin = config.ownerLogin() ?? me.login;
  const owner = ownerLogin === me.login ? me : { login: ownerLogin, id: 0, name: null };

  const address = config.temporalAddress();
  const namespace = config.temporalNamespace();
  const connection = await retry("Temporal", () => NativeConnection.connect({ address }));
  const clientConnection = await retry("Temporal", () => Connection.connect({ address }));
  const temporal = new Client({ connection: clientConnection, namespace });
  setContext({ db, github, temporal, owner });

  await ensureDiscoverySchedule(temporal);

  const workers = await Promise.all([
    Worker.create({
      connection,
      namespace,
      taskQueue: TASK_QUEUES.orchestration,
      workflowsPath: fileURLToPath(new URL("./workflows/index.js", import.meta.url)),
      activities: orchestration,
    }),
    Worker.create({ connection, namespace, taskQueue: TASK_QUEUES.integration, activities: integration, maxConcurrentActivityTaskExecutions: 8 }),
    Worker.create({ connection, namespace, taskQueue: TASK_QUEUES.agentSteps, activities: steps, maxConcurrentActivityTaskExecutions: 20 }),
  ]);
  log("worker", `running as ${owner.login}; task queues: orchestration, integration, agent-steps`);
  const shutdown = () => workers.forEach((w) => w.shutdown());
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await Promise.all(workers.map((w) => w.run()));
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
