import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { DeliveryRunInput, Plan, StepResult } from "@orch/contracts";

const workflowsPath = fileURLToPath(new URL("../../dist/workflows/index.js", import.meta.url));
const plan: Plan = { summary: "Add subtract", subtasks: [{ title: "Add subtract function", description: "d", acceptanceCriteria: ["works"] }] };

interface Scenario {
  planResults: StepResult[];
  risk?: boolean;
  prStates?: ("open" | "merged" | "closed")[];
}

function mockActivities(s: Scenario) {
  const calls: { name: string; args: unknown }[] = [];
  const waiters = new Map<string, () => void>();
  const reached = (name: string) => new Promise<void>((resolve) => waiters.set(name, resolve));
  const record = (name: string, args: unknown) => {
    calls.push({ name, args });
    waiters.get(name)?.();
  };
  let planIndex = 0;
  let prIndex = 0;
  const activities = {
    recordEvent: async (a: unknown) => record("recordEvent", a),
    initRun: async (a: unknown) => (record("initRun", a), { conversationId: "conv_1" }),
    updateProgress: async (a: unknown) => record("updateProgress", a),
    askQuestions: async (a: unknown) => (record("askQuestions", a), { approvalId: "apr_q1" }),
    recordTicketAnswer: async (a: unknown) => record("recordTicketAnswer", a),
    requestPlanApproval: async (a: unknown) => (record("requestPlanApproval", a), { approvalId: "apr_plan", hash: "h" }),
    requestRiskApproval: async (a: unknown) => (record("requestRiskApproval", a), { approvalId: "apr_risk", hash: "h" }),
    postPullRequestCard: async (a: unknown) => record("postPullRequestCard", a),
    postNotice: async (a: unknown) => record("postNotice", a),
    closeOutApprovals: async (a: unknown) => record("closeOutApprovals", a),
    lookupContext: async () => ({ defaultBranch: "main", branch: "agent/1-add-subtract-abc123", commitAuthor: { name: "T", email: "t@x" } }),
    commentOnIssue: async (a: unknown) => record("commentOnIssue", a),
    claimIssue: async (a: unknown) => record("claimIssue", a),
    findRequesterReply: async () => null,
    finalizeIssue: async (a: unknown) => record("finalizeIssue", a),
    publishBranch: async (a: unknown) => (record("publishBranch", a), { number: 7, url: "https://example/pr/7", title: "[agent] x" }),
    getPullRequestState: async () => s.prStates?.[Math.min(prIndex++, (s.prStates?.length ?? 1) - 1)] ?? "merged",
    discoverAndStart: async () => 0,
    prepareRunRepo: async (a: unknown) => record("prepareRunRepo", a),
    prepareStep: async (a: unknown) => record("prepareStep", a),
    awaitStep: async ({ stepId }: { stepId: string }): Promise<StepResult> => {
      const kind = calls.filter((c) => c.name === "prepareStep").pop()?.args as { kind: string };
      record("awaitStep", { stepId });
      if (kind.kind === "plan") return s.planResults[Math.min(planIndex++, s.planResults.length - 1)]!;
      return { status: "succeeded", summary: "done", commits: 1 };
    },
    applyStepResult: async () => ({ commits: 1 }),
    inspectChanges: async () => ({
      changedFiles: ["subtract.js", ...(s.risk ? [".github/workflows/ci.yml"] : [])],
      secrets: [],
      risk: s.risk ? { reasons: ["Changes CI/CD configuration"], files: [".github/workflows/ci.yml"] } : { reasons: [], files: [] },
    }),
    createWorkspace: async (a: unknown) => (record("createWorkspace", a), { containerId: "c1" }),
    destroyWorkspace: async (a: unknown) => record("destroyWorkspace", a),
  };
  return { activities, calls, reached };
}

const input: DeliveryRunInput = {
  runId: "run_test1",
  conversationId: null,
  workItem: {
    source: "github",
    repo: { owner: "acme", name: "demo" },
    number: 1,
    title: "Add subtract",
    body: "please",
    url: "https://example/issues/1",
    requester: { login: "tester", id: 1 },
  },
};

describe("deliveryRunWorkflow", { timeout: 300_000 }, () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => {
    // TEMPORAL_TEST_ADDRESS runs against an existing server (e.g. the dev server container) when the
    // time-skipping test server cannot be downloaded; timers then run in real time.
    const address = process.env.TEMPORAL_TEST_ADDRESS;
    env = address ? await TestWorkflowEnvironment.createFromExistingServer({ address }) : await TestWorkflowEnvironment.createTimeSkipping();
  });
  afterAll(async () => {
    await env?.teardown();
  });

  async function runScenario(s: Scenario, drive: (h: { signal: (name: string, arg: unknown) => Promise<void> }, m: ReturnType<typeof mockActivities>) => Promise<void>) {
    const m = mockActivities(s);
    const queues = ["orchestration", "integration", "agent-steps", "workspaces"];
    const workers = await Promise.all(
      queues.map((taskQueue) =>
        Worker.create({
          connection: env.nativeConnection,
          taskQueue,
          activities: m.activities,
          ...(taskQueue === "orchestration" ? { workflowsPath } : {}),
        }),
      ),
    );
    const id = `wf-${Math.random().toString(36).slice(2)}`;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const main = workers[0]!.runUntil(async () => {
      try {
        const handle = await env.client.workflow.start("deliveryRunWorkflow", { taskQueue: "orchestration", workflowId: id, args: [input] });
        await drive({ signal: (name, arg) => handle.signal(name, arg) }, m);
        return await handle.result();
      } finally {
        finish();
      }
    });
    const result = await Promise.all([main, ...workers.slice(1).map((w) => w.runUntil(done))]);
    return { state: result[0] as string, m };
  }

  it("goes from plan approval to merged pull request", async () => {
    const { state, m } = await runScenario({ planResults: [{ status: "succeeded", summary: "plan", assessment: { ready: true, questions: [], plan } }], prStates: ["merged"] }, async (h, mock) => {
      await mock.reached("requestPlanApproval");
      await h.signal("approval", { approvalId: "apr_plan", decision: "approve" });
    });
    expect(state).toBe("completed");
    const names = m.calls.map((c) => c.name);
    expect(names).toContain("claimIssue");
    expect(names).toContain("publishBranch");
    expect(m.calls.filter((c) => c.name === "createWorkspace").length).toBe(m.calls.filter((c) => c.name === "destroyWorkspace").length);
    const finalize = m.calls.find((c) => c.name === "finalizeIssue")!.args as { outcome: string };
    expect(finalize.outcome).toBe("completed");
  });

  it("asks questions, waits for the answer, then plans", async () => {
    const { state, m } = await runScenario(
      {
        planResults: [
          { status: "succeeded", summary: "q", assessment: { ready: false, questions: ["Strings too?"] } },
          { status: "succeeded", summary: "plan", assessment: { ready: true, questions: [], plan } },
        ],
      },
      async (h, mock) => {
        await mock.reached("askQuestions");
        await h.signal("answer", { approvalId: "apr_q1", answer: "Numbers only", source: "chat" });
        await mock.reached("requestPlanApproval");
        await h.signal("approval", { approvalId: "apr_plan", decision: "approve" });
      },
    );
    expect(state).toBe("completed");
    const secondPlan = m.calls.filter((c) => c.name === "prepareStep")[1]!.args as { questionRounds: { answer: string }[] };
    expect(secondPlan.questionRounds[0]!.answer).toBe("Numbers only");
  });

  it("cancels without pushing when the plan is rejected", async () => {
    const { state, m } = await runScenario({ planResults: [{ status: "succeeded", summary: "plan", assessment: { ready: true, questions: [], plan } }] }, async (h, mock) => {
      await mock.reached("requestPlanApproval");
      await h.signal("approval", { approvalId: "apr_plan", decision: "reject" });
    });
    expect(state).toBe("cancelled");
    expect(m.calls.some((c) => c.name === "publishBranch")).toBe(false);
  });

  it("requires approval for high-risk changes and pushes nothing when rejected", async () => {
    const { state, m } = await runScenario({ planResults: [{ status: "succeeded", summary: "plan", assessment: { ready: true, questions: [], plan } }], risk: true }, async (h, mock) => {
      await mock.reached("requestPlanApproval");
      await h.signal("approval", { approvalId: "apr_plan", decision: "approve" });
      await mock.reached("requestRiskApproval");
      await h.signal("approval", { approvalId: "apr_risk", decision: "reject" });
    });
    expect(state).toBe("cancelled");
    expect(m.calls.some((c) => c.name === "publishBranch")).toBe(false);
  });

  it("handles a cancel signal while waiting for approval", async () => {
    const { state, m } = await runScenario({ planResults: [{ status: "succeeded", summary: "plan", assessment: { ready: true, questions: [], plan } }] }, async (h, mock) => {
      await mock.reached("requestPlanApproval");
      await h.signal("cancel", { reason: "test" });
    });
    expect(state).toBe("cancelled");
    expect((m.calls.find((c) => c.name === "finalizeIssue")!.args as { outcome: string }).outcome).toBe("cancelled");
  });

  it("fails the run when planning fails", async () => {
    const { state } = await runScenario({ planResults: [{ status: "failed", summary: "boom", error: "model error" }] }, async () => undefined);
    expect(state).toBe("failed");
  });
});
