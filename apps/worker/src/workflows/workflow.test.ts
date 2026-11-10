import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { Analysis, DeliveryRunInput, Plan, StepResult, Track } from "@orch/contracts";

const workflowsPath = fileURLToPath(new URL("../../dist/workflows/index.js", import.meta.url));
const plan: Plan = { summary: "Add subtract", subtasks: [{ title: "Add subtract function", description: "d", acceptanceCriteria: ["works"] }] };

const analysis: Analysis = {
  ready: true,
  questions: [],
  understanding: "Add a subtract function next to add",
  products: [{ product: "calc", repositories: ["acme/demo"], reason: "owns arithmetic", changes: "new function" }],
  likelyFiles: ["acme/demo:subtract.js"],
  risks: [],
  assumptions: [],
  acceptanceCriteria: ["subtract(5, 3) returns 2"],
  size: "S",
  clearBehavior: true,
  singleArea: true,
  changesContracts: false,
  proposedTrack: "fast",
  trackReasons: ["One small function"],
  approach: "Create subtract.js",
};
const analysed: StepResult = { status: "succeeded", summary: "analysis", analysis };
const planned: StepResult = { status: "succeeded", summary: "plan", assessment: { ready: true, questions: [], plan } };

interface Scenario {
  analysisResults?: StepResult[];
  /** What the track rules decide; the workflow must follow it, whatever the analyst proposed. */
  track?: Track;
  repositories?: string[];
  planResults?: StepResult[];
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
  const analysisResults = s.analysisResults ?? [analysed];
  const planResults = s.planResults ?? [planned];
  let analysisIndex = 0;
  let planIndex = 0;
  let prIndex = 0;
  const activities = {
    recordEvent: async (a: unknown) => record("recordEvent", a),
    initRun: async (a: unknown) => (record("initRun", a), { conversationId: "conv_run", homeProduct: "calc", catalogHash: "cat1" }),
    recordAnalysis: async (a: unknown) => {
      record("recordAnalysis", a);
      const track = s.track ?? "fast";
      return {
        decision: { track, proposed: "fast" as Track, reasons: [track === "fast" ? "Small and clear" : "The ticket is a story"] },
        products: ["calc"],
        repositories: s.repositories ?? ["acme/demo"],
      };
    },
    updateProgress: async (a: unknown) => record("updateProgress", a),
    askQuestions: async (a: unknown) => (record("askQuestions", a), { approvalId: "apr_q1" }),
    recordTicketAnswer: async (a: unknown) => record("recordTicketAnswer", a),
    requestPlanApproval: async (a: unknown) => (record("requestPlanApproval", a), { approvalId: "apr_plan", hash: "h" }),
    requestRiskApproval: async (a: unknown) => (record("requestRiskApproval", a), { approvalId: "apr_risk", hash: "h" }),
    postPullRequestCard: async (a: unknown) => record("postPullRequestCard", a),
    postNotice: async (a: unknown) => record("postNotice", a),
    closeOutApprovals: async (a: unknown) => record("closeOutApprovals", a),
    lookupContext: async (a: unknown) => (
      record("lookupContext", a), { defaultBranch: "main", branch: "agent/1-add-subtract-abc123", commitAuthor: { name: "T", email: "t@x" } }
    ),
    commentOnIssue: async (a: unknown) => record("commentOnIssue", a),
    claimIssue: async (a: unknown) => record("claimIssue", a),
    setTrackLabel: async (a: unknown) => record("setTrackLabel", a),
    findRequesterReply: async () => null,
    finalizeIssue: async (a: unknown) => record("finalizeIssue", a),
    publishBranch: async (a: unknown) => (record("publishBranch", a), { number: 7, url: "https://example/pr/7", title: "[agent] x" }),
    getPullRequestState: async () => s.prStates?.[Math.min(prIndex++, (s.prStates?.length ?? 1) - 1)] ?? "merged",
    discoverAndStart: async () => 0,
    prepareRunRepo: async (a: unknown) => record("prepareRunRepo", a),
    prepareStep: async (a: unknown) => record("prepareStep", a),
    awaitStep: async ({ stepId }: { stepId: string }): Promise<StepResult> => {
      const kind = (calls.filter((c) => c.name === "prepareStep").pop()?.args as { kind: string }).kind;
      record("awaitStep", { stepId });
      if (kind === "analyse") return analysisResults[Math.min(analysisIndex++, analysisResults.length - 1)]!;
      if (kind === "plan") return planResults[Math.min(planIndex++, planResults.length - 1)]!;
      return { status: "succeeded", summary: "done", commits: 1 };
    },
    applyStepResult: async () => ({ commits: 1 }),
    inspectChanges: async (a: unknown) => (
      record("inspectChanges", a),
      {
        changedFiles: ["subtract.js", ...(s.risk ? [".github/workflows/ci.yml"] : [])],
        secrets: [],
        risk: s.risk ? { reasons: ["Changes CI/CD configuration"], files: [".github/workflows/ci.yml"] } : { reasons: [], files: [] },
      }
    ),
    createWorkspace: async (a: unknown) => (record("createWorkspace", a), { containerId: "c1" }),
    destroyWorkspace: async (a: unknown) => record("destroyWorkspace", a),
  };
  const of = <T>(name: string) => calls.filter((c) => c.name === name).map((c) => c.args as T);
  return { activities, calls, reached, of };
}

const input: DeliveryRunInput = {
  runId: "run_test1",
  conversationId: "conv_chat",
  workItem: {
    source: "github",
    repo: { owner: "acme", name: "demo" },
    number: 1,
    title: "Add subtract",
    body: "please",
    url: "https://example/issues/1",
    labels: ["bug"],
    requester: { login: "tester", id: 1 },
  },
};

type StepPrep = { kind: string; primaryRepo: { owner: string; name: string }; plan?: Plan; analysis?: Analysis; questionRounds?: { answer: string }[] };

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

  async function runScenario(s: Scenario, drive: (h: { signal: (name: string, arg: unknown) => Promise<void> }, m: ReturnType<typeof mockActivities>) => Promise<void> = async () => undefined) {
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

  it("fast track: from analysis straight to a merged pull request, with no approval", async () => {
    const { state, m } = await runScenario({ prStates: ["merged"] });
    expect(state).toBe("completed");
    expect(m.of("requestPlanApproval")).toHaveLength(0);
    expect(m.of<{ track: string }>("setTrackLabel")[0]!.track).toBe("fast");
    expect(m.of<{ originConversationId: string }>("initRun")[0]!.originConversationId).toBe("conv_chat");
    const steps = m.of<StepPrep>("prepareStep");
    expect(steps.map((p) => p.kind)).toEqual(["analyse", "implement"]);
    // The analyst's approach and acceptance criteria become the single change that is built.
    expect(steps[1]!.plan!.subtasks).toHaveLength(1);
    expect(steps[1]!.plan!.subtasks[0]!.acceptanceCriteria).toEqual(["subtract(5, 3) returns 2"]);
    expect(m.of("publishBranch")).toHaveLength(1);
    expect(m.of("createWorkspace")).toHaveLength(m.of("destroyWorkspace").length);
    expect(m.of<{ outcome: string }>("finalizeIssue")[0]!.outcome).toBe("completed");
    const events = m.of<{ type: string }>("recordEvent").map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(["analysis.completed", "products.identified", "track.set", "scm.pr_opened", "run.completed"]));
  });

  it("asks the analyst's questions, waits for the answer, then analyses again", async () => {
    const unclear: StepResult = { status: "succeeded", summary: "q", analysis: { ...analysis, ready: false, questions: ["Strings too?"], products: [] } };
    const { state, m } = await runScenario({ analysisResults: [unclear, analysed] }, async (h, mock) => {
      await mock.reached("askQuestions");
      await h.signal("answer", { approvalId: "apr_q1", answer: "Numbers only", source: "chat" });
    });
    expect(state).toBe("completed");
    const second = m.of<StepPrep>("prepareStep")[1]!;
    expect(second.kind).toBe("analyse");
    expect(second.questionRounds![0]!.answer).toBe("Numbers only");
  });

  it("guided track: a plan is proposed and built only after the requester approves it", async () => {
    const { state, m } = await runScenario({ track: "guided" }, async (h, mock) => {
      await mock.reached("requestPlanApproval");
      expect(mock.of("prepareRunRepo")).toHaveLength(0);
      await h.signal("approval", { approvalId: "apr_plan", decision: "approve" });
    });
    expect(state).toBe("completed");
    const steps = m.of<StepPrep>("prepareStep");
    expect(steps.map((p) => p.kind)).toEqual(["analyse", "plan", "implement"]);
    expect(steps[1]!.analysis!.understanding).toBe(analysis.understanding);
    expect(m.of<{ track: string }>("setTrackLabel")[0]!.track).toBe("guided");
  });

  it("guided track: cancels without pushing when the plan is rejected", async () => {
    const { state, m } = await runScenario({ track: "guided" }, async (h, mock) => {
      await mock.reached("requestPlanApproval");
      await h.signal("approval", { approvalId: "apr_plan", decision: "reject" });
    });
    expect(state).toBe("cancelled");
    expect(m.of("publishBranch")).toHaveLength(0);
  });

  it("requires approval for high-risk changes on the fast track too, and pushes nothing when rejected", async () => {
    const { state, m } = await runScenario({ risk: true }, async (h, mock) => {
      await mock.reached("requestRiskApproval");
      await h.signal("approval", { approvalId: "apr_risk", decision: "reject" });
    });
    expect(state).toBe("cancelled");
    expect(m.of("publishBranch")).toHaveLength(0);
  });

  it("handles a cancel signal while waiting for approval", async () => {
    const { state, m } = await runScenario({ track: "guided" }, async (h, mock) => {
      await mock.reached("requestPlanApproval");
      await h.signal("cancel", { reason: "test" });
    });
    expect(state).toBe("cancelled");
    expect(m.of<{ outcome: string }>("finalizeIssue")[0]!.outcome).toBe("cancelled");
  });

  it("fails the run when the analysis fails", async () => {
    const { state, m } = await runScenario({ analysisResults: [{ status: "failed", summary: "boom", error: "model error" }] });
    expect(state).toBe("failed");
    expect(m.of("recordAnalysis")).toHaveLength(0);
  });

  it("stops after the analysis when the work spans several repositories, changing nothing", async () => {
    const { state, m } = await runScenario({ track: "guided", repositories: ["acme/demo", "acme/web"] });
    expect(state).toBe("closed");
    expect(m.of("prepareRunRepo")).toHaveLength(0);
    expect(m.of("publishBranch")).toHaveLength(0);
    expect(m.of<{ track: string }>("setTrackLabel")[0]!.track).toBe("guided");
    const notice = m.of<{ noticeKey: string; text: string }>("postNotice").find((n) => n.noticeKey === "final")!;
    expect(notice.text).toMatch(/2 repositories \(acme\/demo, acme\/web\)/);
  });

  it("builds in the repository the analysis found, even when the ticket was filed elsewhere", async () => {
    const { state, m } = await runScenario({ repositories: ["acme/web"] });
    expect(state).toBe("completed");
    const web = { owner: "acme", name: "web" };
    expect(m.of<{ repo: unknown }>("lookupContext")[0]!.repo).toEqual(web);
    expect(m.of<{ repo: unknown }>("prepareRunRepo")[0]!.repo).toEqual(web);
    const published = m.of<{ repo: unknown; body: string }>("publishBranch")[0]!;
    expect(published.repo).toEqual(web);
    expect(published.body).toContain("Closes acme/demo#1");
    // The analysis still starts in the ticket's own repository; the ticket stays where it was filed.
    expect(m.of<StepPrep>("prepareStep")[0]!.primaryRepo).toEqual({ owner: "acme", name: "demo" });
    expect(m.of<{ repo: unknown }>("claimIssue")[0]!.repo).toEqual({ owner: "acme", name: "demo" });
  });
});
