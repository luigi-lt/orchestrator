/**
 * workspace-manager: the only service allowed to talk to the container engine.
 * Serves createWorkspace/destroyWorkspace on the `workspaces` task queue and reaps orphaned sandboxes.
 */
import { ApplicationFailure } from "@temporalio/activity";
import { NativeConnection, Worker } from "@temporalio/worker";
import Docker from "dockerode";
import { config, log, signWorkspaceToken, sleep, tokenHash } from "@orch/common";
import { TASK_QUEUES, type WorkspaceActivities } from "@orch/contracts";
import { connectStore, getStep, setStepToken, type Db } from "@orch/store";

const docker = new Docker(process.env.DOCKER_SOCKET ? { socketPath: process.env.DOCKER_SOCKET } : undefined);
let db: Db;

const containerName = (stepId: string) => `orch-ws-${stepId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
const isNotFound = (err: unknown) => (err as { statusCode?: number }).statusCode === 404;

async function removeContainer(name: string): Promise<void> {
  const c = docker.getContainer(name);
  try {
    await c.stop({ t: 5 });
  } catch {
    // already stopped or gone
  }
  try {
    await c.remove({ force: true, v: true });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

const activities: WorkspaceActivities = {
  async createWorkspace({ stepId, runId }) {
    const ttlSeconds = (config.stepTimeoutMinutes() + 30) * 60;
    const token = signWorkspaceToken(stepId, ttlSeconds, config.workspaceTokenSecret());
    await setStepToken(db, stepId, tokenHash(token));

    const name = containerName(stepId);
    // A retry replaces any earlier container for the step; the new token supersedes the old one.
    await removeContainer(name);

    const image = config.workspaceImage();
    try {
      await docker.getImage(image).inspect();
    } catch (err) {
      if (isNotFound(err)) {
        throw ApplicationFailure.nonRetryable(`Workspace image ${image} not found. Build it with: ./bin/orchestrator up`);
      }
      throw err;
    }

    const proxy = config.egressHttpProxy();
    const container = (await docker.createContainer({
      name,
      Image: image,
      User: "1000:1000",
      WorkingDir: "/workspace",
      Env: [
        `GATEWAY_URL=${config.gatewayUrlForSandbox()}`,
        `WORKSPACE_TOKEN=${token}`,
        `ANTHROPIC_BASE_URL=${config.egressAnthropicUrl()}`,
        `HTTPS_PROXY=${proxy}`,
        `HTTP_PROXY=${proxy}`,
        `https_proxy=${proxy}`,
        `http_proxy=${proxy}`,
        "NO_PROXY=sandbox-gateway,egress-proxy,localhost,127.0.0.1",
        "no_proxy=sandbox-gateway,egress-proxy,localhost,127.0.0.1",
        "HOME=/workspace/home",
        "COPILOT_GITHUB_TELEMETRY_DISABLED=true",
      ],
      Labels: { "orch.workspace": "1", "orch.step": stepId, "orch.run": runId },
      // Anonymous volume for the checkout and build output; removed together with the container.
      Volumes: { "/workspace": {} },
      HostConfig: {
        NetworkMode: config.sandboxNetwork(),
        Memory: config.workspaceMemoryMb() * 1024 * 1024,
        NanoCpus: config.workspaceCpus() * 1e9,
        PidsLimit: 2048,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "rw,exec,nosuid,size=1g" },
      },
    })) as Docker.Container;
    await container.start();
    log("workspace-manager", `started ${name} for step ${stepId}`);
    return { containerId: container.id };
  },

  async destroyWorkspace({ stepId }) {
    await removeContainer(containerName(stepId));
    log("workspace-manager", `removed ${containerName(stepId)}`);
  },
};

/** Removes sandboxes whose step is finished, unknown, or older than the maximum lifetime. */
async function reap(): Promise<void> {
  const maxAgeMs = (config.stepTimeoutMinutes() + 60) * 60 * 1000;
  const containers = await docker.listContainers({ all: true, filters: { label: ["orch.workspace=1"] } });
  for (const info of containers) {
    const stepId = info.Labels["orch.step"];
    const ageMs = Date.now() - info.Created * 1000;
    const step = stepId ? await getStep(db, stepId) : null;
    const finished = !step || step.state === "succeeded" || step.state === "failed";
    if (ageMs > maxAgeMs || (finished && ageMs > 2 * 60 * 1000)) {
      log("workspace-manager", `reaping ${info.Names[0] ?? info.Id}`);
      await removeContainer(info.Id).catch((err) => log("workspace-manager", `reap failed: ${(err as Error).message}`));
    }
  }
}

async function main(): Promise<void> {
  db = await connectStore();
  await docker.ping();
  const address = config.temporalAddress();
  let connection: NativeConnection | undefined;
  for (let i = 0; !connection; i++) {
    try {
      connection = await NativeConnection.connect({ address });
    } catch (err) {
      if (i > 60) throw err;
      log("workspace-manager", `waiting for Temporal: ${(err as Error).message}`);
      await sleep(2000);
    }
  }
  const worker = await Worker.create({
    connection,
    namespace: config.temporalNamespace(),
    taskQueue: TASK_QUEUES.workspaces,
    activities,
    maxConcurrentActivityTaskExecutions: 10,
  });
  setInterval(() => void reap().catch((err) => log("workspace-manager", `reaper error: ${(err as Error).message}`)), 5 * 60 * 1000);
  void reap().catch(() => undefined);
  process.once("SIGTERM", () => worker.shutdown());
  process.once("SIGINT", () => worker.shutdown());
  log("workspace-manager", "ready");
  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
