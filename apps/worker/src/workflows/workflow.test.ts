import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  findingsToFix,
  mergeReview,
  type Analysis,
  type DeliveryRunInput,
  type Plan,
  type ReviewReport,
  type StepResult,
  type SubtaskReview,
  type Track,
  type TrackedFinding,
} from "@orch/contracts";

const workflowsPath = fileURLToPath(new URL("../../dist/workflows/index.js", import.meta.url));
const onePlan: Plan = { summary: "Add subtract", subtasks: [{ title: "Add subtract function", description: "d", acceptanceCriteria: ["works"] }] };
const twoPlan: Plan = {
  summary: "Add and document subtract",
  subtasks: [
    { title: "Add subtract function", description: "d1", acceptanceCriteria: ["works"] },
    { title: "Document subtract", description: "d2", acceptanceCriteria: ["documented"] },
  ],
};

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
const planned = (plan: Plan): StepResult => ({ status: "succeeded", summary: "plan", assessment: { ready: true, questions: [], plan } });

const clean: ReviewReport = { verdict: "approve", summary: "Looks right", criteria: [{ criterion: "works", met: true }], findings: [], earlier: [] };
const major: ReviewReport = {
  verdict: "changes_needed",
  summary: "One gap",
  criteria: [{ criterion: "works", met: true }],
  findings: [{ severity: "major", title: "No input check", file: "subtract.js", line: 1, explanation: "Strings are accepted" }],
  earlier: [],
};
/** A re-review that confirms the earlier findings as fixed. */
const fixed = (ids: string[]): ReviewReport => ({ ...clean, summary: "Fixed", earlier: ids.map((id) => ({ id, resolved: true })) });
/** A re-review that finds the same problem again. */
const still = (ids: string[]): ReviewReport => ({ ...major, earlier: ids.map((id) => ({ id, resolved: false })) });

interface Scenario {
  analysisResults?: StepResult[];
  /** What the track rules decide; the workflow must follow it, whatever the analyst proposed. */
  track?: Track;
  repositories?: string[];
  plan?: Plan;
  /** One report per review round, in the order the reviews run (across sub-tasks). The last one repeats. */
  reviews?: ReviewReport[];
  /** Why the finished change is beyond the fast track. */
  limits?: string[];
  risk?: boolean;
  implementFails?: boolean;
  prStates?: ("open" | "merged" | "closed")[];
}

function mockActivities(s: Scenario) {
  const calls: { name: string; args: unknown }[] = [];
  const waiters = new Map<string, () => void>();
  const reached = (name: string) => new Promise<void>((resolve) => waiters.set(name, resolve));
  const record = (name: string, args: unknown) => {
    calls.push({ name, args });
    const waiter = waiters.get(name);
    waiters.delete(name);
    waiter?.();
  };
  const analysisResults = s.analysisResults ?? [analysed];
  const reviews = s.reviews ?? [clean];
  const reviewState = new Map<string, SubtaskReview>();
  let analysisIndex = 0;
  let reviewIndex = 0;
  let prIndex = 0;
  let prNumber = 6;
  let decisions = 0;
  const activities = {
    recordEvent: async (a: unknown) => record("recordEvent", a),
    initRun: async (a: unknown) => (
      record("initRun", a), { conversationId: "conv_run", homeProduct: "calc", catalogHash: "cat1", settings: { maxFixRounds: 2, prPollSeconds: 60 } }
    ),
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
    requestFindingsDecision: async (a: unknown) => (record("requestFindingsDecision", a), { approvalId: `apr_findings_${++decisions}`, hash: "h" }),
    requestLimitsDecision: async (a: unknown) => (record("requestLimitsDecision", a), { approvalId: "apr_limits", hash: "h" }),
    initSubtask: async (a: { key: string; ownConversation: boolean }) => (record("initSubtask", a), { conversationId: a.ownConversation ? `conv_${a.key}` : "conv_run" }),
    patchSubtask: async (a: unknown) => record("patchSubtask", a),
    // The real review logic: what must be fixed follows from the severities, across rounds.
    recordReview: async (a: { key: string; report: ReviewReport }) => {
      record("recordReview", a);
      const review = mergeReview(reviewState.get(a.key) ?? null, a.report);
      reviewState.set(a.key, review);
      return { review, toFix: findingsToFix(review) };
    },
    setReviewStatus: async (a: unknown) => record("setReviewStatus", a),
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
    pushBranch: async (a: unknown) => record("pushBranch", a),
    openPullRequest: async (a: unknown) => (record("openPullRequest", a), { number: ++prNumber, url: `https://example/pr/${prNumber}`, title: "[agent] x" }),
    getPullRequestState: async (a: unknown) => (record("getPullRequestState", a), s.prStates?.[Math.min(prIndex++, (s.prStates?.length ?? 1) - 1)] ?? "merged"),
    discoverAndStart: async () => 0,
    prepareSubtaskRepo: async (a: unknown) => (record("prepareSubtaskRepo", a), { baseCommit: "base000" }),
    prepareStep: async (a: unknown) => record("prepareStep", a),
    awaitStep: async ({ stepId }: { stepId: string }): Promise<StepResult> => {
      const kind = (calls.filter((c) => c.name === "prepareStep").pop()?.args as { kind: string }).kind;
      record("awaitStep", { stepId });
      if (kind === "analyse") return analysisResults[Math.min(analysisIndex++, analysisResults.length - 1)]!;
      if (kind === "plan") return planned(s.plan ?? onePlan);
      if (kind === "review") return { status: "succeeded", summary: "review", review: reviews[Math.min(reviewIndex++, reviews.length - 1)]! };
      if (s.implementFails) return { status: "failed", summary: "The workspace failed", error: "model error" };
      return {
        status: "succeeded",
        summary: "Added subtract.js",
        commits: 1,
        verification: { commands: [{ name: "test", command: "npm test", exitCode: 0, durationMs: 10, output: "" }], passed: true },
      };
    },
    applyStepResult: async (a: unknown) => (record("applyStepResult", a), { commits: 1 }),
    squashSubtask: async (a: unknown) => (record("squashSubtask", a), { headCommit: "head111" }),
    inspectChanges: async (a: { checkLimits: boolean }) => (
      record("inspectChanges", a),
      {
        changedFiles: ["subtract.js", ...(s.risk ? [".github/workflows/ci.yml"] : [])],
        secrets: [],
        risk: s.risk ? { reasons: ["Changes CI/CD configuration"], files: [".github/workflows/ci.yml"] } : { reasons: [], files: [] },
        limits: a.checkLimits ? (s.limits ?? []) : [],
      }
    ),
    createWorkspace: async (a: unknown) => (record("createWorkspace", a), { containerId: "c1" }),
    destroyWorkspace: async (a: unknown) => record("destroyWorkspace", a),
  };
  const of = <T>(name: string) => calls.filter((c) => c.name === name).map((c) => c.args as T);
  return { activities, calls, reached, of };
}

type Mock = ReturnType<typeof mockActivities>;
type StepPrep = {
  kind: string;
  primaryRepo: { owner: string; name: string };
  branch: string;
  subtaskKey?: string;
  round?: number;
  plan?: Plan;
  analysis?: Analysis;
  findings?: TrackedFinding[];
  guidance?: string;
  questionRounds?: { answer: string }[];
};
const kinds = (m: Mock) => m.of<StepPrep>("prepareStep").map((p) => p.kind);
const events = (m: Mock) => m.of<{ type: string }>("recordEvent").map((e) => e.type);
const finalNotice = (m: Mock) => m.of<{ noticeKey: string; text: string }>("postNotice").find((n) => n.noticeKey === "final")?.text ?? "";

interface Driver {
  /** Signals the run workflow. */
  signal: (name: string, arg: unknown) => Promise<void>;
  /** Signals the workflow of one sub-task: decisions on its cards go there. */
  signalSubtask: (key: string, name: string, arg: unknown) => Promise<void>;
}

describe("deliveryRunWorkflow", { timeout: 300_000 }, () => {
  let env: TestWorkflowEnvironment;
  let runCounter = 0;
  beforeAll(async () => {
    // TEMPORAL_TEST_ADDRESS runs against an existing server (e.g. the dev server container) when the
    // time-skipping test server cannot be downloaded; timers then run in real time.
    const address = process.env.TEMPORAL_TEST_ADDRESS;
    env = address ? await TestWorkflowEnvironment.createFromExistingServer({ address }) : await TestWorkflowEnvironment.createTimeSkipping();
  });
  afterAll(async () => {
    await env?.teardown();
  });

  async function runScenario(s: Scenario, drive: (h: Driver, m: Mock) => Promise<void> = async () => undefined) {
    const m = mockActivities(s);
    const runId = `run_t${Date.now().toString(36)}${++runCounter}`;
    const input: DeliveryRunInput = {
      runId,
      conversationId: "conv_chat",
      prPollSeconds: 1,
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
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const main = workers[0]!.runUntil(async () => {
      try {
        const handle = await env.client.workflow.start("deliveryRunWorkflow", { taskQueue: "orchestration", workflowId: `wf-${runId}`, args: [input] });
        await drive(
          {
            signal: (name, arg) => handle.signal(name, arg),
            signalSubtask: (key, name, arg) => env.client.workflow.getHandle(`subtask:${runId}:${key}`).signal(name, arg),
          },
          m,
        );
        return await handle.result();
      } finally {
        finish();
      }
    });
    const result = await Promise.all([main, ...workers.slice(1).map((w) => w.runUntil(done))]);
    return { state: result[0] as string, m };
  }

  // --- Fast track -------------------------------------------------------------------

  it("fast track: analysis, implementation, a clean AI review and a pull request, with no approval", async () => {
    const { state, m } = await runScenario({});
    expect(state).toBe("completed");
    expect(kinds(m)).toEqual(["analyse", "implement", "review"]);
    expect(m.of("requestPlanApproval")).toHaveLength(0);
    expect(m.of("requestFindingsDecision")).toHaveLength(0);
    expect(m.of<{ track: string }>("setTrackLabel")[0]!.track).toBe("fast");
    expect(m.of<{ originConversationId: string }>("initRun")[0]!.originConversationId).toBe("conv_chat");
    // The analyst's approach and acceptance criteria are the single change; it uses the run's conversation.
    const steps = m.of<StepPrep>("prepareStep");
    expect(steps[1]!.plan!.subtasks[0]!.acceptanceCriteria).toEqual(["subtract(5, 3) returns 2"]);
    expect(steps[2]).toMatchObject({ kind: "review", subtaskKey: "change", round: 0 });
    expect(m.of<{ ownConversation: boolean; key: string }>("initSubtask")[0]).toMatchObject({ ownConversation: false, key: "change" });
    // One commit is pushed, exactly the inspected one, and the pull request carries the review and the checks.
    expect(m.calls.map((c) => c.name).filter((n) => ["squashSubtask", "inspectChanges", "pushBranch", "openPullRequest"].includes(n))).toEqual([
      "squashSubtask",
      "inspectChanges",
      "pushBranch",
      "openPullRequest",
    ]);
    const pr = m.of<{ body: string; base: string }>("openPullRequest")[0]!;
    expect(pr.base).toBe("main");
    expect(pr.body).toContain("Closes #1");
    expect(pr.body).toContain("### AI review");
    expect(pr.body).toContain("No blocking or major finding is open after 1 review round(s) and 0 fix round(s).");
    expect(pr.body).toContain("- test (`npm test`): passed");
    expect(m.of("createWorkspace")).toHaveLength(m.of("destroyWorkspace").length);
    expect(m.of<{ outcome: string }>("finalizeIssue")[0]!.outcome).toBe("completed");
    expect(events(m)).toEqual(expect.arrayContaining(["analysis.completed", "track.set", "review.completed", "scm.pr_opened", "subtask.merged", "run.completed"]));
  });

  it("fast track: a major finding goes back to the implementer and is re-reviewed before the pull request", async () => {
    const { state, m } = await runScenario({ reviews: [major, fixed(["r1-1"])] });
    expect(state).toBe("completed");
    expect(kinds(m)).toEqual(["analyse", "implement", "review", "implement", "review"]);
    const steps = m.of<StepPrep>("prepareStep");
    expect(steps[3]).toMatchObject({ kind: "implement", round: 1 });
    expect(steps[3]!.findings!.map((f) => f.id)).toEqual(["r1-1"]);
    // The second review is asked to check the earlier finding again.
    expect(steps[4]!.findings!.map((f) => f.id)).toEqual(["r1-1"]);
    expect(m.of("requestFindingsDecision")).toHaveLength(0);
    const body = m.of<{ body: string }>("openPullRequest")[0]!.body;
    expect(body).toContain("after 2 review round(s) and 1 fix round(s)");
    expect(body).toContain("**Fixed during the review**");
    expect(body).toContain("No input check");
    expect(events(m)).toContain("review.fix_requested");
  });

  it("asks the requester when findings are still open after two fix rounds, and opens the pull request anyway on their decision", async () => {
    const { state, m } = await runScenario({ reviews: [major, still(["r1-1"]), still(["r2-1"])] }, async (h, mock) => {
      await mock.reached("requestFindingsDecision");
      expect(mock.of("pushBranch")).toHaveLength(0);
      await h.signalSubtask("change", "approval", { approvalId: "apr_findings_1", decision: "open" });
    });
    expect(state).toBe("completed");
    expect(kinds(m)).toEqual(["analyse", "implement", "review", "implement", "review", "implement", "review"]);
    expect(m.of<{ fixRounds: number }>("requestFindingsDecision")[0]!.fixRounds).toBe(2);
    const body = m.of<{ body: string }>("openPullRequest")[0]!.body;
    expect(body).toContain("**Opened with 1 unresolved finding(s), by the requester's decision,** after 2 fix round(s).");
    expect(body).toContain("**Unresolved findings**");
    expect(m.of<{ status: string }>("setReviewStatus").pop()!.status).toBe("accepted_with_findings");
  });

  it("gives the implementer one more round with the requester's guidance", async () => {
    const { state, m } = await runScenario({ reviews: [major, still(["r1-1"]), still(["r2-1"]), fixed(["r3-1"])] }, async (h, mock) => {
      await mock.reached("requestFindingsDecision");
      await h.signalSubtask("change", "approval", { approvalId: "apr_findings_1", decision: "retry", feedback: "Reject strings with a TypeError" });
    });
    expect(state).toBe("completed");
    const fixes = m.of<StepPrep>("prepareStep").filter((p) => p.kind === "implement" && (p.round ?? 0) > 0);
    expect(fixes.map((f) => f.round)).toEqual([1, 2, 3]);
    expect(fixes[2]!.guidance).toBe("Reject strings with a TypeError");
    expect(fixes[0]!.guidance).toBeUndefined();
    expect(m.of("requestFindingsDecision")).toHaveLength(1);
    expect(m.of<{ body: string }>("openPullRequest")[0]!.body).toContain("No blocking or major finding is open");
  });

  it("pushes the branch without a pull request when the requester takes it over", async () => {
    const { state, m } = await runScenario({ reviews: [major, still(["r1-1"]), still(["r2-1"])] }, async (h, mock) => {
      await mock.reached("requestFindingsDecision");
      await h.signalSubtask("change", "approval", { approvalId: "apr_findings_1", decision: "take_over" });
    });
    expect(state).toBe("closed");
    expect(m.of("pushBranch")).toHaveLength(1);
    expect(m.of("openPullRequest")).toHaveLength(0);
    // A taken-over branch is not held to the fast-track limits, but secrets and risk are still checked.
    expect(m.of<{ checkLimits: boolean }>("inspectChanges")[0]!.checkLimits).toBe(false);
    expect(finalNotice(m)).toMatch(/pushed to acme\/demo without a pull request/);
  });

  it("pushes nothing when the requester cancels on open findings", async () => {
    const { state, m } = await runScenario({ reviews: [major, still(["r1-1"]), still(["r2-1"])] }, async (h, mock) => {
      await mock.reached("requestFindingsDecision");
      await h.signalSubtask("change", "approval", { approvalId: "apr_findings_1", decision: "cancel" });
    });
    expect(state).toBe("cancelled");
    expect(m.of("pushBranch")).toHaveLength(0);
    expect(m.of<{ patch: { state?: string } }>("patchSubtask").some((p) => p.patch.state === "cancelled")).toBe(true);
  });

  it("stops a fast-track change that turned out too big, and continues on the requester's decision", async () => {
    const { state, m } = await runScenario({ limits: ["The change touches 9 files (the fast-track limit is 5)"] }, async (h, mock) => {
      await mock.reached("requestLimitsDecision");
      expect(mock.of("pushBranch")).toHaveLength(0);
      await h.signalSubtask("change", "approval", { approvalId: "apr_limits", decision: "continue" });
    });
    expect(state).toBe("completed");
    expect(m.of("openPullRequest")).toHaveLength(1);
    expect(events(m)).toEqual(expect.arrayContaining(["track.limits_exceeded", "track.limits_decided"]));
  });

  it("switches to the guided track when the requester chooses it for a change that is too big", async () => {
    const { state, m } = await runScenario({ limits: ["The change touches 9 files (the fast-track limit is 5)"] }, async (h, mock) => {
      await mock.reached("requestLimitsDecision");
      await h.signalSubtask("change", "approval", { approvalId: "apr_limits", decision: "guided" });
      await mock.reached("requestPlanApproval");
      // Nothing of the fast-track change was pushed.
      expect(mock.of("pushBranch")).toHaveLength(0);
      await h.signal("approval", { approvalId: "apr_plan", decision: "approve" });
    });
    expect(state).toBe("completed");
    expect(m.of<{ track: string }>("setTrackLabel").map((l) => l.track)).toEqual(["fast", "guided"]);
    expect(events(m)).toContain("track.changed");
    expect(kinds(m)).toEqual(["analyse", "implement", "review", "plan", "implement", "review"]);
    // The guided sub-task gets its own conversation and is not held to the fast-track limits.
    expect(m.of<{ key: string; ownConversation: boolean }>("initSubtask").map((i) => [i.key, i.ownConversation])).toEqual([
      ["change", false],
      ["s1", true],
    ]);
    expect(m.of<{ checkLimits: boolean }>("inspectChanges").map((i) => i.checkLimits)).toEqual([true, false]);
  });

  it("requires approval for high-risk changes on the fast track too, and pushes nothing when rejected", async () => {
    const { state, m } = await runScenario({ risk: true }, async (h, mock) => {
      await mock.reached("requestRiskApproval");
      await h.signalSubtask("change", "approval", { approvalId: "apr_risk", decision: "reject" });
    });
    expect(state).toBe("cancelled");
    expect(m.of("pushBranch")).toHaveLength(0);
    expect(finalNotice(m)).toMatch(/High-risk change rejected/);
  });

  it("fails the run when the implementation fails twice", async () => {
    const { state, m } = await runScenario({ implementFails: true });
    expect(state).toBe("failed");
    expect(kinds(m)).toEqual(["analyse", "implement", "implement"]);
    expect(finalNotice(m)).toMatch(/The implementation failed: model error/);
    expect(m.of("pushBranch")).toHaveLength(0);
  });

  // --- Analysis ---------------------------------------------------------------------

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

  it("fails the run when the analysis fails", async () => {
    const { state, m } = await runScenario({ analysisResults: [{ status: "failed", summary: "boom", error: "model error" }] });
    expect(state).toBe("failed");
    expect(m.of("recordAnalysis")).toHaveLength(0);
  });

  it("stops after the analysis when the work spans several repositories, changing nothing", async () => {
    const { state, m } = await runScenario({ track: "guided", repositories: ["acme/demo", "acme/web"] });
    expect(state).toBe("closed");
    expect(m.of("initSubtask")).toHaveLength(0);
    expect(m.of("pushBranch")).toHaveLength(0);
    expect(finalNotice(m)).toMatch(/2 repositories \(acme\/demo, acme\/web\)/);
  });

  it("builds in the repository the analysis found, even when the ticket was filed elsewhere", async () => {
    const { state, m } = await runScenario({ repositories: ["acme/web"] });
    expect(state).toBe("completed");
    const web = { owner: "acme", name: "web" };
    expect(m.of<{ repo: unknown }>("lookupContext")[0]!.repo).toEqual(web);
    expect(m.of<{ repo: unknown }>("prepareSubtaskRepo")[0]!.repo).toEqual(web);
    expect(m.of<{ repo: unknown }>("pushBranch")[0]!.repo).toEqual(web);
    const pr = m.of<{ repo: unknown; body: string }>("openPullRequest")[0]!;
    expect(pr.repo).toEqual(web);
    expect(pr.body).toContain("Closes acme/demo#1");
    // The analysis still starts in the ticket's own repository; the ticket stays where it was filed.
    expect(m.of<StepPrep>("prepareStep")[0]!.primaryRepo).toEqual({ owner: "acme", name: "demo" });
    expect(m.of<{ repo: unknown }>("claimIssue")[0]!.repo).toEqual({ owner: "acme", name: "demo" });
  });

  // --- Guided track -----------------------------------------------------------------

  it("guided track: each sub-task has its own branch, conversation, review and pull request, one after the other", async () => {
    const { state, m } = await runScenario({ track: "guided", plan: twoPlan }, async (h, mock) => {
      await mock.reached("requestPlanApproval");
      expect(mock.of("initSubtask")).toHaveLength(0);
      await h.signal("approval", { approvalId: "apr_plan", decision: "approve" });
    });
    expect(state).toBe("completed");
    expect(kinds(m)).toEqual(["analyse", "plan", "implement", "review", "implement", "review"]);
    expect(m.of<{ key: string; ownConversation: boolean; branch: string }>("initSubtask").map((i) => [i.key, i.ownConversation, i.branch])).toEqual([
      ["s1", true, "agent/1-add-subtract-abc123-s1"],
      ["s2", true, "agent/1-add-subtract-abc123-s2"],
    ]);
    // The second sub-task starts only after the pull request of the first one is merged.
    const order = m.calls.map((c) => c.name).filter((n) => n === "prepareSubtaskRepo" || n === "getPullRequestState");
    expect(order).toEqual(["prepareSubtaskRepo", "getPullRequestState", "prepareSubtaskRepo", "getPullRequestState"]);
    const prs = m.of<{ title: string; body: string }>("openPullRequest");
    expect(prs[0]!.title).toContain("(1/2): Add subtract function");
    expect(prs[0]!.body).toContain("Part of #1");
    expect(prs[0]!.body).not.toContain("Closes #1");
    expect(prs[1]!.body).toContain("Closes #1");
    // Each sub-task's cards go to its own conversation.
    expect(m.of<{ conversationId: string }>("postPullRequestCard").map((c) => c.conversationId)).toEqual(expect.arrayContaining(["conv_s1", "conv_s2"]));
    expect(finalNotice(m)).toBe("All 2 sub-tasks are merged. Done.");
  });

  it("guided track: stops when a sub-task's pull request is closed, without starting the next one", async () => {
    const { state, m } = await runScenario({ track: "guided", plan: twoPlan, prStates: ["closed"] }, async (h, mock) => {
      await mock.reached("requestPlanApproval");
      await h.signal("approval", { approvalId: "apr_plan", decision: "approve" });
    });
    expect(state).toBe("closed");
    expect(m.of("initSubtask")).toHaveLength(1);
    expect(finalNotice(m)).toMatch(/Sub-task 1: Pull request closed without merging\. The remaining 1 sub-task\(s\) were not started\./);
  });

  it("guided track: cancels without pushing when the plan is rejected", async () => {
    const { state, m } = await runScenario({ track: "guided" }, async (h, mock) => {
      await mock.reached("requestPlanApproval");
      await h.signal("approval", { approvalId: "apr_plan", decision: "reject" });
    });
    expect(state).toBe("cancelled");
    expect(m.of("initSubtask")).toHaveLength(0);
  });

  // --- Cancelling --------------------------------------------------------------------

  it("cancels the run and its sub-task while the sub-task waits for a decision", async () => {
    const { state, m } = await runScenario({ reviews: [major, still(["r1-1"]), still(["r2-1"])] }, async (h, mock) => {
      await mock.reached("requestFindingsDecision");
      await h.signal("cancel", { reason: "test" });
    });
    expect(state).toBe("cancelled");
    expect(m.of("pushBranch")).toHaveLength(0);
    expect(m.of<{ patch: { state?: string } }>("patchSubtask").some((p) => p.patch.state === "cancelled")).toBe(true);
    expect(m.of<{ subtaskKey?: string }>("closeOutApprovals").some((c) => c.subtaskKey === "change")).toBe(true);
    expect(m.of<{ outcome: string }>("finalizeIssue")[0]!.outcome).toBe("cancelled");
    expect(m.of("createWorkspace")).toHaveLength(m.of("destroyWorkspace").length);
  });
});
