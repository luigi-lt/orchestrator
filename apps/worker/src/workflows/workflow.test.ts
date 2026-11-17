import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  buildOrder,
  findingsToFix,
  mergeReview,
  type Analysis,
  type DeliveryRunInput,
  type DesignTurnInput,
  type DesignTurnResult,
  type HandoffPlan,
  type Plan,
  type ReviewReport,
  type StepResult,
  type SubtaskReview,
  type Track,
  type TrackedFinding,
} from "@orch/contracts";

const workflowsPath = fileURLToPath(new URL("../../dist/workflows/index.js", import.meta.url));

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

/** A hand-off plan across two products; the page is listed first but depends on the library. */
const handoff: HandoffPlan = {
  goal: "Show subtraction in the shop",
  approach: "Add subtract to the library, then use it on the page",
  outOfScope: [],
  risks: [],
  assumptions: [],
  constraints: ["Do not change add()"],
  definitionOfDone: [],
  contracts: [{ name: "subtract(a, b)", description: "Returns a - b for numbers", providers: ["lib"], consumers: ["page"] }],
  rollout: "Library first",
  subtasks: [
    { key: "page", title: "Use subtract on the page", description: "d2", acceptanceCriteria: ["shown"], product: "shop", repository: "acme/web", likelyFiles: [], dependsOn: ["lib"], size: "S" },
    { key: "lib", title: "Add subtract function", description: "d1", acceptanceCriteria: ["works"], product: "calc", repository: "acme/demo", likelyFiles: ["subtract.js"], dependsOn: [], size: "S" },
  ],
};
const handoffChanged: HandoffPlan = { ...handoff, constraints: [...handoff.constraints, "Numbers only"] };
/** Two sub-tasks in the same repository, the second building on the first, and a third that needs neither. */
const handoffStacked: HandoffPlan = {
  ...handoff,
  contracts: [],
  subtasks: [
    { key: "api", title: "Add subtract function", description: "d1", acceptanceCriteria: ["works"], product: "calc", repository: "acme/demo", likelyFiles: [], dependsOn: [], size: "S" },
    { key: "docs", title: "Document subtract", description: "d2", acceptanceCriteria: ["documented"], product: "calc", repository: "acme/demo", likelyFiles: [], dependsOn: ["api"], size: "S" },
  ],
};

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
  /** One report per review round, in the order the reviews run (across sub-tasks). The last one repeats. */
  reviews?: ReviewReport[];
  /** Why the finished change is beyond the fast track. */
  limits?: string[];
  risk?: boolean;
  implementFails?: boolean;
  /** How many implementation steps fail because of the model provider before one succeeds. */
  providerFailures?: number;
  /** How many access checks find a problem with every repository, before they pass. */
  accessRefusals?: number;
  /** How many pushes are refused, before they pass. */
  pushRefusals?: number;
  /** The sub-task whose implementation fails. */
  failSubtask?: string;
  /** The plan the architect drafts (the plan across two products by default). */
  plan?: HandoffPlan;
  /** The state a pull request is in when it is polled, until the test changes it with pr(). Merged by default. */
  prInitial?: "open" | "merged" | "closed";
  /**
   * The requester's decisions at the check of a change, per sub-task and in order; approve by default.
   * "manual" leaves the decisions to the test.
   */
  changeDecisions?: Record<string, ("approve" | "changes" | "drop")[]> | "manual";
  /** What bringing a branch up to date with the default branch does. */
  branchUpdate?: "up_to_date" | "merged" | "conflict";
  /** Silence after which the design session's workspace is saved and shut down. */
  designIdleSeconds?: number;
  /** How many times the session workspace is lost while a turn runs. */
  loseWorkspace?: number;
}

/**
 * The architect, as the tests play it: the opening turn drafts the plan; a message with "change" submits a
 * changed plan; a message with "approval" puts the plan up for approval; anything else is only answered.
 */
function architectReply(turn: DesignTurnInput, plan: HandoffPlan): Partial<DesignTurnResult> {
  const text = turn.messages.join(" ");
  if (turn.opening) return { text: "Here is a first draft.", plan };
  if (/change/.test(text)) return { text: "Changed.", plan: handoffChanged };
  if (/approval/.test(text)) return { text: "Use the Approve button.", proposed: true };
  return { text: "Answered." };
}

function mockActivities(s: Scenario) {
  const calls: { name: string; args: unknown }[] = [];
  const waiters = new Map<string, { count: number; resolve: () => void }>();
  /** Resolves once the activity has been called `count` more times. */
  const reached = (name: string, count = 1) => new Promise<void>((resolve) => waiters.set(name, { count, resolve }));
  const record = (name: string, args: unknown) => {
    calls.push({ name, args });
    const waiter = waiters.get(name);
    if (waiter && --waiter.count <= 0) {
      waiters.delete(name);
      waiter.resolve();
    }
  };
  const analysisResults = s.analysisResults ?? [analysed];
  const reviews = s.reviews ?? [clean];
  const reviewState = new Map<string, SubtaskReview>();
  let analysisIndex = 0;
  let reviewIndex = 0;
  let prNumber = 6;
  let decisions = 0;
  let commits = 0;
  // Pull requests keep their own state: several are open at once on the guided track.
  const prStates = new Map<number, "open" | "merged" | "closed">();
  const pr = (number: number, state: "open" | "merged" | "closed") => void prStates.set(number, state);
  // The requester's decisions at the check of a change; the run scenario says how they reach the sub-task's workflow.
  const hooks: { decide?: (subtaskKey: string, approvalId: string, decision: string, feedback?: string) => Promise<void> } = {};
  const checks = new Map<string, number>();
  let accessRefusals = s.accessRefusals ?? 0;
  let pushRefusals = s.pushRefusals ?? 0;
  let providerFailures = s.providerFailures ?? 0;
  let blocked = 0;
  // Design session
  let workspaceUp = false;
  let workspaces = 0;
  let losses = s.loseWorkspace ?? 0;
  let planVersion = 0;
  let proposedVersion = 0;
  let currentPlan: HandoffPlan | null = null;

  const activities = {
    recordEvent: async (a: unknown) => record("recordEvent", a),
    initRun: async (a: unknown) => (
      record("initRun", a),
      {
        conversationId: "conv_run",
        homeProduct: "calc",
        catalogHash: "cat1",
        settings: { maxFixRounds: 2, prPollSeconds: 60, designIdleSeconds: s.designIdleSeconds ?? 3600, modelRetrySeconds: [1, 1, 1] },
      }
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
    requestRiskApproval: async (a: unknown) => (record("requestRiskApproval", a), { approvalId: "apr_risk", hash: "h" }),
    requestFindingsDecision: async (a: unknown) => (record("requestFindingsDecision", a), { approvalId: `apr_findings_${++decisions}`, hash: "h" }),
    requestLimitsDecision: async (a: unknown) => (record("requestLimitsDecision", a), { approvalId: "apr_limits", hash: "h" }),
    requestChangeCheck: async (a: { key: string; commit: string }) => {
      const n = (checks.get(a.key) ?? 0) + 1;
      checks.set(a.key, n);
      const approvalId = `apr_change_${a.key}_${n}`;
      if (s.changeDecisions !== "manual") {
        const decision = s.changeDecisions?.[a.key]?.[n - 1] ?? "approve";
        await hooks.decide?.(a.key, approvalId, decision, decision === "changes" ? "Handle zero as well" : undefined);
      }
      record("requestChangeCheck", a);
      return { approvalId, hash: a.commit };
    },
    requestDependentsDecision: async (a: unknown) => (record("requestDependentsDecision", a), { approvalId: `apr_dependents_${++decisions}`, hash: "h" }),
    planSubtasks: async (a: unknown) => record("planSubtasks", a),
    dropSubtasks: async (a: unknown) => record("dropSubtasks", a),
    addStoryWarning: async (a: unknown) => record("addStoryWarning", a),
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

    // --- Design session: a workspace that can be saved, lost and replaced; plan versions; the approval ---
    prepareDesignWorkspace: async (a: unknown) => {
      record("prepareDesignWorkspace", a);
      if (workspaceUp) return { stepId: `d${workspaces}`, fresh: false, expired: false, resumed: false };
      workspaceUp = true;
      return { stepId: `d${++workspaces}`, fresh: true, expired: false, resumed: workspaces > 1 };
    },
    awaitDesignTurn: async (a: { turn: DesignTurnInput; stepId: string }): Promise<DesignTurnResult> => {
      record("awaitDesignTurn", a);
      if (losses > 0) {
        losses--;
        workspaceUp = false;
        throw ApplicationFailure.nonRetryable("The design session workspace was lost", "WorkspaceLost");
      }
      return { turnId: a.turn.turnId, status: "succeeded", text: "", components: [], proposed: false, session: "continued", ...architectReply(a.turn, s.plan ?? handoff) };
    },
    suspendDesignWorkspace: async (a: unknown) => {
      record("suspendDesignWorkspace", a);
      workspaceUp = false;
      return { stepId: `d${workspaces}`, saved: true };
    },
    closeDesignSession: async (a: unknown) => {
      record("closeDesignSession", a);
      const stepId = workspaceUp ? `d${workspaces}` : null;
      workspaceUp = false;
      return { stepId };
    },
    // Plan versions as the store keeps them: a new version voids the approval asked for an older one.
    recordDesignTurn: async (a: { result: DesignTurnResult }) => {
      record("recordDesignTurn", a);
      let created = false;
      let voidedApproval = false;
      if (a.result.plan) {
        planVersion++;
        created = true;
        currentPlan = a.result.plan;
        voidedApproval = proposedVersion > 0;
        proposedVersion = 0;
      }
      let proposedApprovalId: string | null = null;
      if (a.result.proposed && proposedVersion !== planVersion) {
        proposedVersion = planVersion;
        proposedApprovalId = `apr_plan_${planVersion}`;
      }
      return { version: planVersion || null, created, changes: created && planVersion > 1 ? 1 : 0, voidedApproval, proposedApprovalId };
    },
    finalizePlan: async (a: unknown) => {
      record("finalizePlan", a);
      const order = buildOrder(currentPlan!)!;
      return { plan: currentPlan!, order: order.map((st) => st.key), products: [...new Set(order.map((st) => st.product))], productsChanged: true };
    },
    latestPlan: async (a: unknown) => (record("latestPlan", a), currentPlan ? { plan: currentPlan, version: planVersion } : null),
    restartDesignSession: async (a: unknown) => {
      record("restartDesignSession", a);
      const stepId = workspaceUp ? `d${workspaces}` : null;
      workspaceUp = false;
      return { stepId };
    },
    requestBlockedDecision: async (a: unknown) => (record("requestBlockedDecision", a), { approvalId: `apr_blocked_${++blocked}`, hash: "h" }),
    checkAccess: async (a: { repositories: string[] }) => {
      record("checkAccess", a);
      if (accessRefusals <= 0) return { problems: [] };
      accessRefusals--;
      return { problems: a.repositories.map((repository) => ({ repository, problem: `The token cannot push to ${repository}` })) };
    },
    mirrorPlanOnTicket: async (a: { order: string[]; plan: HandoffPlan }) => (
      record("mirrorPlanOnTicket", a),
      {
        subIssues: a.order.map((key, i) => {
          const [owner, name] = a.plan.subtasks.find((st) => st.key === key)!.repository.split("/") as [string, string];
          return { key, repo: { owner, name }, number: 40 + i, url: `https://example/${owner}/${name}/issues/${40 + i}` };
        }),
        attached: a.order.length,
        missing: [],
      }
    ),
    closeSubIssue: async (a: unknown) => record("closeSubIssue", a),

    lookupContext: async (a: unknown) => (
      record("lookupContext", a), { defaultBranch: "main", branch: "agent/1-add-subtract-abc123", commitAuthor: { name: "T", email: "t@x" } }
    ),
    commentOnIssue: async (a: unknown) => record("commentOnIssue", a),
    claimIssue: async (a: unknown) => record("claimIssue", a),
    setTrackLabel: async (a: unknown) => record("setTrackLabel", a),
    findRequesterReply: async () => null,
    finalizeIssue: async (a: unknown) => record("finalizeIssue", a),
    pushBranch: async (a: unknown) => {
      record("pushBranch", a);
      if (pushRefusals > 0) {
        pushRefusals--;
        throw ApplicationFailure.nonRetryable("The push to acme/demo was refused: 403", "AccessDenied");
      }
    },
    openPullRequest: async (a: unknown) => (record("openPullRequest", a), { number: ++prNumber, url: `https://example/pr/${prNumber}`, title: "[agent] x" }),
    getPullRequestState: async (a: { number: number }) => (record("getPullRequestState", a), prStates.get(a.number) ?? s.prInitial ?? "merged"),
    retargetPullRequest: async (a: unknown) => (record("retargetPullRequest", a), true),
    updateBranchFromDefault: async (a: unknown) => (record("updateBranchFromDefault", a), { status: s.branchUpdate ?? "merged", headCommit: "head-updated" }),
    discoverAndStart: async () => 0,
    prepareSubtaskRepo: async (a: unknown) => (record("prepareSubtaskRepo", a), { baseCommit: "base000" }),
    prepareStep: async (a: unknown) => record("prepareStep", a),
    awaitStep: async ({ stepId }: { stepId: string }): Promise<StepResult> => {
      const { kind, subtaskKey } = calls.filter((c) => c.name === "prepareStep").pop()?.args as { kind: string; subtaskKey?: string };
      record("awaitStep", { stepId });
      if (kind === "analyse") return analysisResults[Math.min(analysisIndex++, analysisResults.length - 1)]!;
      if (kind === "review") return { status: "succeeded", summary: "review", review: reviews[Math.min(reviewIndex++, reviews.length - 1)]! };
      if (s.implementFails || (s.failSubtask && s.failSubtask === subtaskKey)) return { status: "failed", summary: "The workspace failed", error: "model error" };
      if (providerFailures > 0) {
        providerFailures--;
        return { status: "failed", summary: "The workspace failed", error: "429 rate_limit_error: Number of requests has exceeded your rate limit" };
      }
      return {
        status: "succeeded",
        summary: "Added subtract.js",
        commits: 1,
        verification: { commands: [{ name: "test", command: "npm test", exitCode: 0, durationMs: 10, output: "" }], passed: true },
      };
    },
    applyStepResult: async (a: unknown) => (record("applyStepResult", a), { commits: 1 }),
    squashSubtask: async (a: unknown) => (record("squashSubtask", a), { headCommit: `head${++commits}` }),
    inspectChanges: async (a: { checkLimits: boolean }) => (
      record("inspectChanges", a),
      {
        changedFiles: ["subtract.js", ...(s.risk ? [".github/workflows/ci.yml"] : [])],
        files: [{ path: "subtract.js", added: 3, removed: 0 }],
        secrets: [],
        risk: s.risk ? { reasons: ["Changes CI/CD configuration"], files: [".github/workflows/ci.yml"] } : { reasons: [], files: [] },
        limits: a.checkLimits ? (s.limits ?? []) : [],
      }
    ),
    createWorkspace: async (a: unknown) => (record("createWorkspace", a), { containerId: "c1" }),
    destroyWorkspace: async (a: unknown) => record("destroyWorkspace", a),
  };
  const of = <T>(name: string) => calls.filter((c) => c.name === name).map((c) => c.args as T);
  return { activities, calls, reached, of, pr, hooks };
}

type Mock = ReturnType<typeof mockActivities>;
type StepPrep = {
  kind: string;
  primaryRepo: { owner: string; name: string };
  branch: string;
  subtaskKey?: string;
  round?: number;
  plan?: Plan;
  findings?: TrackedFinding[];
  guidance?: string;
  questionRounds?: { answer: string }[];
  changeBase?: string;
  references?: { key: string; branch: string; headCommit: string; prNumber: number }[];
};
const kinds = (m: Mock) => m.of<StepPrep>("prepareStep").map((p) => p.kind);
const events = (m: Mock) => m.of<{ type: string }>("recordEvent").map((e) => e.type);
const finalNotice = (m: Mock) => m.of<{ noticeKey: string; text: string }>("postNotice").find((n) => n.noticeKey === "final")?.text ?? "";

interface Driver {
  /** Signals the run workflow. */
  signal: (name: string, arg: unknown) => Promise<void>;
  /** Signals the workflow of one sub-task: decisions on its cards go there. */
  signalSubtask: (key: string, name: string, arg: unknown) => Promise<void>;
  /** A message of the requester in the run's conversation while the design session is open. */
  say: (text: string) => Promise<void>;
  /** The Approve button on the plan card. */
  approvePlan: (approvalId: string) => Promise<void>;
  /** The requester switches the track (FR-A3). */
  changeTrack: (track: "fast" | "guided", reason?: string) => Promise<void>;
  /** Signals the design session workflow. */
  signalDesign: (name: string, arg: unknown) => Promise<void>;
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
        const design = () => env.client.workflow.getHandle(`design:${runId}`);
        let said = 0;
        m.hooks.decide = (key, approvalId, decision, feedback) => env.client.workflow.getHandle(`subtask:${runId}:${key}`).signal("approval", { approvalId, decision, feedback });
        await drive(
          {
            signal: (name, arg) => handle.signal(name, arg),
            signalSubtask: (key, name, arg) => env.client.workflow.getHandle(`subtask:${runId}:${key}`).signal(name, arg),
            say: (text) => design().signal("requesterMessage", { messageId: `msg_${++said}`, text }),
            approvePlan: (approvalId) => design().signal("approval", { approvalId, decision: "approve" }),
            changeTrack: (track, reason) => handle.signal("changeTrack", { track, by: "tester", reason }),
            signalDesign: (name, arg) => design().signal(name, arg),
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

  /** The usual design session: the architect opens with a draft, the requester asks for approval and approves. */
  const designAndApprove = async (h: Driver, mock: Mock) => {
    await mock.reached("recordDesignTurn");
    const proposed = mock.reached("recordDesignTurn");
    await h.say("Put it up for approval");
    await proposed;
    await h.approvePlan("apr_plan_1");
  };

  // --- Fast track -------------------------------------------------------------------

  it("fast track: analysis, implementation, a clean AI review and a pull request, with no approval", async () => {
    const { state, m } = await runScenario({});
    expect(state).toBe("completed");
    expect(kinds(m)).toEqual(["analyse", "implement", "review"]);
    expect(m.of("recordDesignTurn")).toHaveLength(0);
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

  it("starts a design session when the requester switches a too-big fast-track change to the guided track", async () => {
    const { state, m } = await runScenario({ limits: ["The change touches 9 files (the fast-track limit is 5)"] }, async (h, mock) => {
      await mock.reached("requestLimitsDecision");
      const opened = mock.reached("recordDesignTurn");
      await h.signalSubtask("change", "approval", { approvalId: "apr_limits", decision: "guided" });
      await opened;
      // Nothing of the fast-track change was pushed.
      expect(mock.of("pushBranch")).toHaveLength(0);
      const proposed = mock.reached("recordDesignTurn");
      await h.say("Put it up for approval");
      await proposed;
      await h.approvePlan("apr_plan_1");
    });
    expect(state).toBe("completed");
    expect(m.of<{ track: string }>("setTrackLabel").map((l) => l.track)).toEqual(["fast", "guided"]);
    expect(events(m)).toContain("track.changed");
    // The sub-tasks of the plan are not held to the fast-track limits.
    expect(m.of<{ key: string; ownConversation: boolean }>("initSubtask").map((i) => [i.key, i.ownConversation])).toEqual([
      ["change", false],
      ["lib", true],
      ["page", true],
    ]);
    expect(m.of<{ checkLimits: boolean }>("inspectChanges").map((i) => i.checkLimits)).toEqual([true, false, false]);
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

  // --- Guided track: the design session, the plan, sub-tasks across products ------------------

  it("guided track: the architect opens the session, the requester approves a plan version, and each sub-task is built in its repository in dependency order", async () => {
    const { state, m } = await runScenario({ track: "guided", repositories: ["acme/demo", "acme/web"], prInitial: "open" }, async (h, mock) => {
      // The session opens by itself, with a first draft; nothing is built before the approval.
      await mock.reached("recordDesignTurn");
      expect(mock.of<{ turn: DesignTurnInput }>("awaitDesignTurn")[0]!.turn).toMatchObject({ opening: true, messages: [] });
      const proposed = mock.reached("recordDesignTurn");
      await h.say("Put it up for approval");
      await proposed;
      expect(mock.of("initSubtask")).toHaveLength(0);
      const bothOpen = mock.reached("openPullRequest", 2);
      await h.approvePlan("apr_plan_1");
      // The second sub-task is built while the pull request of the first one is still open (AD-41).
      await bothOpen;
      expect(mock.of<{ patch: { state?: string } }>("patchSubtask").some((p) => p.patch.state === "merged")).toBe(false);
      mock.pr(7, "merged");
      mock.pr(8, "merged");
    });
    expect(state).toBe("completed");
    expect(kinds(m)).toEqual(["analyse", "implement", "review", "implement", "review"]);
    // The session workspace gets the repositories the analysis named, is created once as a session and closed on approval.
    expect(m.of<{ repositories: string[] }>("prepareDesignWorkspace")[0]!.repositories).toEqual(["acme/demo", "acme/web"]);
    expect(m.of<{ session?: boolean }>("createWorkspace").filter((w) => w.session)).toHaveLength(1);
    expect(m.of("closeDesignSession")).toHaveLength(1);
    expect(m.of<{ version: number }>("finalizePlan")[0]!.version).toBe(1);
    // The plan is mirrored on the ticket and every sub-task is recorded as planned before anything is built.
    const order = m.calls.map((c) => c.name).filter((n) => n === "mirrorPlanOnTicket" || n === "planSubtasks" || n === "initSubtask");
    expect(order).toEqual(["mirrorPlanOnTicket", "planSubtasks", "initSubtask", "initSubtask"]);
    expect(m.of<{ items: { key: string; dependsOn: string[]; ticket?: { number: number } }[] }>("planSubtasks")[0]!.items.map((i) => [i.key, i.dependsOn.join(), i.ticket?.number])).toEqual([
      ["lib", "", 40],
      ["page", "lib", 41],
    ]);
    // The library first, although the plan lists the page first: the page depends on it.
    const subtasks = m.of<{ key: string; ownConversation: boolean; branch: string; repo: { name: string }; ticket?: { number: number }; stackedOn?: string }>("initSubtask");
    expect(subtasks.map((i) => [i.key, i.repo.name, i.branch, i.ticket?.number, i.ownConversation, i.stackedOn])).toEqual([
      ["lib", "demo", "agent/1-add-subtract-abc123-lib", 40, true, undefined],
      ["page", "web", "agent/1-add-subtract-abc123-page", 41, true, undefined],
    ]);
    // The requester checked each change before its pull request opened; the approval is bound to the commit.
    const checksAsked = m.of<{ key: string; commit: string; round: number; files: { path: string }[] }>("requestChangeCheck");
    expect(checksAsked.map((c) => [c.key, c.commit, c.round])).toEqual([
      ["lib", "head1", 0],
      ["page", "head2", 0],
    ]);
    const published = m.calls.map((c) => c.name).filter((n) => n === "requestChangeCheck" || n === "pushBranch" || n === "openPullRequest");
    expect(published).toEqual(["requestChangeCheck", "pushBranch", "openPullRequest", "requestChangeCheck", "pushBranch", "openPullRequest"]);
    // Across repositories the page starts from its own default branch and can read the library's approved change.
    expect(m.of<{ stackedOn?: unknown }>("prepareSubtaskRepo").map((p) => p.stackedOn)).toEqual([undefined, undefined]);
    const pageSteps = m.of<StepPrep>("prepareStep").filter((p) => p.subtaskKey === "page");
    expect(pageSteps[0]!.references).toEqual([expect.objectContaining({ key: "lib", branch: "agent/1-add-subtract-abc123-lib", headCommit: "head1", prNumber: 7 })]);
    expect(pageSteps[0]!.plan!.subtasks[1]!.description).toContain('"Add subtract function" (in acme/demo) is approved but not merged yet: its change is checked out read-only');
    const prs = m.of<{ repo: { name: string }; title: string; body: string; base: string }>("openPullRequest");
    expect(prs.map((p) => [p.repo.name, p.base])).toEqual([
      ["demo", "main"],
      ["web", "main"],
    ]);
    expect(prs[0]!.title).toContain("(1/2): Add subtract function");
    expect(prs[0]!.body).toContain("Part of #1");
    expect(prs[0]!.body).toContain("Closes #40");
    expect(prs[0]!.body).not.toContain("Merge order");
    // No pull request closes the story: the run closes it when the last one is merged, whichever that is.
    expect(prs[1]!.body).toContain("Part of acme/demo#1");
    expect(prs[1]!.body).toContain("Closes #41");
    expect(prs[1]!.body).toContain("- Merge after acme/demo#7 (Add subtract function).");
    expect(prs[1]!.body).toContain("@tester checked this change in the orchestrator before it was opened.");
    expect(m.of<{ outcome: string; close?: boolean }>("finalizeIssue")[0]).toMatchObject({ outcome: "completed", close: true });
    // What the implementers build from carries the plan's constraints and the contract between the products.
    const implement = m.of<StepPrep>("prepareStep").find((p) => p.kind === "implement")!;
    expect(implement.plan!.summary).toContain("Do not change add()");
    expect(implement.plan!.summary).toContain("subtract(a, b): Returns a - b for numbers (provided by: Add subtract function; used by: Use subtract on the page)");
    expect(implement.plan!.subtasks.map((st) => st.title)).toEqual(["Add subtract function", "Use subtract on the page"]);
    expect(m.of<{ number: number }>("closeSubIssue").map((c) => c.number).sort()).toEqual([40, 41]);
    expect(m.of<{ type: string; payload: { source?: string; products: string[] } }>("recordEvent").find((e) => e.payload.source === "plan")?.payload.products).toEqual(["calc", "shop"]);
    // Each sub-task checked that the token can push to its repository before it was built (AD-42).
    expect(m.of<{ repositories: string[] }>("checkAccess").map((c) => c.repositories.join())).toEqual(["acme/web,acme/demo", "acme/demo", "acme/web"]);
    expect(m.of("addStoryWarning")).toHaveLength(0);
    expect(events(m)).toEqual(
      expect.arrayContaining(["design.opened", "plan.version_created", "plan.proposed", "design.closed", "plan.approved", "ticket.subtasks_created", "change.check_requested", "change.decided"]),
    );
    expect(finalNotice(m)).toBe("All 2 sub-tasks are merged. Done.");
  });

  it("guided track: in one repository the next sub-task is stacked on the approved change, and its pull request moves to the default branch when the first one merges", async () => {
    const { state, m } = await runScenario({ track: "guided", plan: handoffStacked, prInitial: "open" }, async (h, mock) => {
      await designAndApprove(h, mock);
      await mock.reached("openPullRequest", 2);
      const moved = mock.reached("retargetPullRequest");
      mock.pr(7, "merged");
      await moved;
      mock.pr(8, "merged");
    });
    expect(state).toBe("completed");
    // The second branch starts from the approved commit of the first, on its pushed branch.
    expect(m.of<{ subtaskKey: string; stackedOn?: { branch: string; commit: string } }>("prepareSubtaskRepo").map((p) => [p.subtaskKey, p.stackedOn])).toEqual([
      ["api", undefined],
      ["docs", { branch: "agent/1-add-subtract-abc123-api", commit: "head1" }],
    ]);
    expect(m.of<{ key: string; stackedOn?: string }>("initSubtask")[1]).toMatchObject({ key: "docs", stackedOn: "api" });
    // Its reviewer sees only its own change, and no other repository is needed.
    const docs = m.of<StepPrep>("prepareStep").filter((p) => p.subtaskKey === "docs");
    expect(docs.map((p) => p.references)).toEqual([[], []]);
    expect(docs[0]!.plan!.subtasks[1]!.description).toContain('"Add subtract function" is approved but not merged yet: your branch starts from its change.');
    // The pull request targets the branch below while that one is open.
    const prs = m.of<{ base: string; body: string }>("openPullRequest");
    expect(prs.map((p) => p.base)).toEqual(["main", "agent/1-add-subtract-abc123-api"]);
    expect(prs[1]!.body).toContain("- Merge after #7 (Add subtract function).");
    expect(prs[1]!.body).toContain("builds on #7 and targets its branch `agent/1-add-subtract-abc123-api`");
    // When the first pull request merged, the second moved to the default branch and was brought up to date.
    expect(m.of<{ number: number; base: string }>("retargetPullRequest")).toEqual([expect.objectContaining({ number: 8, base: "main" })]);
    expect(m.of<{ subtaskKey: string }>("updateBranchFromDefault").map((u) => u.subtaskKey)).toEqual(["docs"]);
    expect(m.of<{ subtaskKey: string }>("pushBranch").map((p) => p.subtaskKey)).toEqual(["api", "docs", "docs"]);
    expect(events(m)).toContain("scm.pr_retargeted");
    expect(m.of("addStoryWarning")).toHaveLength(0);
  });

  it("guided track: the requester asks for changes at the check; the implementer does another round and the new commit is checked again", async () => {
    const { state, m } = await runScenario({ track: "guided", changeDecisions: { lib: ["changes", "approve"] } }, designAndApprove);
    expect(state).toBe("completed");
    const lib = m.of<StepPrep>("prepareStep").filter((p) => p.subtaskKey === "lib");
    expect(lib.map((p) => [p.kind, p.round])).toEqual([
      ["implement", 0],
      ["review", 0],
      ["implement", 1],
      ["review", 1],
    ]);
    // The requester's words reach the implementer; there are no reviewer findings to fix.
    expect(lib[2]).toMatchObject({ guidance: "Handle zero as well", findings: [] });
    expect(lib.every((p) => p.changeBase === "base000")).toBe(true);
    // Two checks, each on its own commit; only the approved one is pushed.
    expect(m.of<{ key: string; commit: string; round: number }>("requestChangeCheck").filter((c) => c.key === "lib").map((c) => [c.commit, c.round])).toEqual([
      ["head1", 0],
      ["head2", 1],
    ]);
    const firstPush = m.calls.findIndex((c) => c.name === "pushBranch");
    expect(m.calls.slice(0, firstPush).filter((c) => c.name === "requestChangeCheck")).toHaveLength(2);
    expect(events(m).filter((e) => e === "change.decided")).toHaveLength(3);
  });

  it("guided track: a dropped sub-task pushes nothing; the requester drops the sub-tasks that depend on it too", async () => {
    const { state, m } = await runScenario({ track: "guided", changeDecisions: { lib: ["drop"] } }, async (h, mock) => {
      const asked = mock.reached("requestDependentsDecision");
      await designAndApprove(h, mock);
      await asked;
      expect(mock.of<{ subtask: { key: string; state: string }; dependents: { key: string }[] }>("requestDependentsDecision")[0]).toMatchObject({
        subtask: { key: "lib", state: "dropped" },
        dependents: [{ key: "page" }],
      });
      await h.signal("approval", { approvalId: "apr_dependents_1", decision: "drop" });
    });
    expect(state).toBe("closed");
    expect(m.of("pushBranch")).toHaveLength(0);
    expect(m.of("initSubtask")).toHaveLength(1);
    expect(m.of<{ keys: string[] }>("dropSubtasks")[0]!.keys).toEqual(["page"]);
    // Both sub-issues are closed as not planned, and the ticket says that the sub-task was dropped.
    expect(m.of<{ number: number; dropped?: boolean }>("closeSubIssue")).toEqual([expect.objectContaining({ number: 40, dropped: true }), expect.objectContaining({ number: 41, dropped: true })]);
    expect(m.of<{ key: string }>("commentOnIssue").some((c) => /:dropped:lib$/.test(c.key))).toBe(true);
    expect(m.of<{ patch: { state?: string } }>("patchSubtask").some((p) => p.patch.state === "dropped")).toBe(true);
    expect(finalNotice(m)).toBe("Every sub-task was dropped; nothing was built.");
  });

  it("guided track: sub-tasks that depend on a dropped one are built without it when the requester says so, and the story completes", async () => {
    const { state, m } = await runScenario({ track: "guided", changeDecisions: { lib: ["drop"] } }, async (h, mock) => {
      const asked = mock.reached("requestDependentsDecision");
      await designAndApprove(h, mock);
      await asked;
      await h.signal("approval", { approvalId: "apr_dependents_1", decision: "build" });
    });
    expect(state).toBe("completed");
    expect(m.of("dropSubtasks")).toHaveLength(0);
    const page = m.of<StepPrep>("prepareStep").find((p) => p.subtaskKey === "page")!;
    expect(page.references).toEqual([]);
    expect(page.plan!.subtasks[1]!.description).toContain('"Add subtract function" (in acme/demo) was not delivered: its change is not available, build without it.');
    expect(m.of<{ repo: { name: string }; body: string }>("openPullRequest").map((p) => p.repo.name)).toEqual(["web"]);
    expect(m.of<{ body: string }>("openPullRequest")[0]!.body).not.toContain("Merge order");
    expect(finalNotice(m)).toBe("1 sub-task(s) merged, 1 dropped. Done.");
    expect(m.of<{ close?: boolean }>("finalizeIssue")[0]!.close).toBe(true);
  });

  it("guided track: a pull request merged before the one it depends on is flagged on the story and on the ticket", async () => {
    const { state, m } = await runScenario({ track: "guided", prInitial: "open" }, async (h, mock) => {
      await designAndApprove(h, mock);
      await mock.reached("openPullRequest", 2);
      const flagged = mock.reached("addStoryWarning");
      mock.pr(8, "merged");
      await flagged;
      mock.pr(7, "merged");
    });
    expect(state).toBe("completed");
    const warning = m.of<{ key: string; text: string }>("addStoryWarning")[0]!;
    expect(warning.key).toBe("page");
    expect(warning.text).toBe("Pull request #8 (Use subtract on the page) was merged before acme/demo#7 (Add subtract function), which it depends on.");
    expect(m.of<{ key: string; body: string }>("commentOnIssue").find((c) => /:order:page$/.test(c.key))?.body).toContain("Merge order");
    expect(events(m)).toContain("story.merged_out_of_order");
  });

  it("guided track: a newer plan version voids the approval asked for the older one", async () => {
    const { state, m } = await runScenario({ track: "guided" }, async (h, mock) => {
      await mock.reached("recordDesignTurn");
      let next = mock.reached("recordDesignTurn");
      await h.say("Put it up for approval");
      await next;
      // The requester asks for a change after the proposal: version 2 replaces version 1.
      next = mock.reached("recordDesignTurn");
      await h.say("Please change it: numbers only");
      await next;
      // An approval of the old version arrives late: it must not start anything.
      next = mock.reached("recordDesignTurn");
      await h.approvePlan("apr_plan_1");
      await h.say("One more question");
      await next;
      expect(mock.of("finalizePlan")).toHaveLength(0);
      next = mock.reached("recordDesignTurn");
      await h.say("Now put it up for approval");
      await next;
      await h.approvePlan("apr_plan_2");
    });
    expect(state).toBe("completed");
    expect(m.of<{ version: number }>("finalizePlan").map((f) => f.version)).toEqual([2]);
    expect(events(m)).toContain("plan.approval_voided");
    expect(m.of<StepPrep>("prepareStep").find((p) => p.kind === "implement")!.plan!.summary).toContain("Numbers only");
    // Five turns: the opening and four messages, each delivered once.
    expect(m.of<{ turn: DesignTurnInput }>("awaitDesignTurn").map((t) => t.turn.messages.join())).toEqual([
      "",
      "Put it up for approval",
      "Please change it: numbers only",
      "One more question",
      "Now put it up for approval",
    ]);
  });

  it("guided track: saves the session after a silence and resumes it in a new workspace on the next message", async () => {
    const { state, m } = await runScenario({ track: "guided", designIdleSeconds: 2 }, async (h, mock) => {
      await mock.reached("recordDesignTurn");
      await mock.reached("suspendDesignWorkspace");
      const proposed = mock.reached("recordDesignTurn");
      await h.say("Put it up for approval");
      await proposed;
      await h.approvePlan("apr_plan_1");
    });
    expect(state).toBe("completed");
    // Two session workspaces: the one that was saved, and the one the next message started.
    const sessions = m.of<{ stepId: string; session?: boolean }>("createWorkspace").filter((w) => w.session);
    expect(sessions.map((w) => w.stepId)).toEqual(["d1", "d2"]);
    expect(events(m)).toEqual(expect.arrayContaining(["design.suspended", "design.resumed"]));
    expect(m.of("createWorkspace")).toHaveLength(m.of("destroyWorkspace").length);
  });

  it("guided track: a lost session workspace is replaced and gets the same turn again", async () => {
    const { state, m } = await runScenario({ track: "guided", loseWorkspace: 1 }, designAndApprove);
    expect(state).toBe("completed");
    const turns = m.of<{ turn: DesignTurnInput; stepId: string }>("awaitDesignTurn");
    expect(turns.slice(0, 2).map((t) => [t.turn.turnId, t.stepId])).toEqual([
      [turns[0]!.turn.turnId, "d1"],
      [turns[0]!.turn.turnId, "d2"],
    ]);
    // The reply is recorded once.
    expect(m.of<{ turn: DesignTurnInput }>("recordDesignTurn").filter((r) => r.turn.opening)).toHaveLength(1);
  });

  it("guided track: a pull request closed without merging does not stop the other sub-tasks; the run ends as closed", async () => {
    const { state, m } = await runScenario({ track: "guided", prInitial: "open" }, async (h, mock) => {
      await designAndApprove(h, mock);
      await mock.reached("openPullRequest", 2);
      mock.pr(7, "closed");
      mock.pr(8, "merged");
    });
    expect(state).toBe("closed");
    expect(m.of("initSubtask")).toHaveLength(2);
    expect(m.of<{ number: number }>("closeSubIssue").map((c) => c.number)).toEqual([41]);
    expect(finalNotice(m)).toBe("1 of 2 sub-tasks merged. Not delivered: 1. Add subtract function: Pull request closed without merging.");
    expect(m.of<{ outcome: string; close?: boolean }>("finalizeIssue")[0]).toMatchObject({ outcome: "closed", close: false });
  });

  it("guided track: a failed sub-task fails the run and ends the sub-tasks whose pull requests were still waiting", async () => {
    const { state, m } = await runScenario({ track: "guided", prInitial: "open", failSubtask: "page" }, async (h, mock) => {
      await designAndApprove(h, mock);
      await mock.reached("openPullRequest");
    });
    // The first pull request is open; the implementation of the second sub-task then fails.
    expect(state).toBe("failed");
    expect(finalNotice(m)).toMatch(/Sub-task 2 failed/);
    const states = m.of<{ key: string; patch: { state?: string } }>("patchSubtask");
    expect(states.some((p) => p.key === "lib" && p.patch.state === "cancelled")).toBe(true);
    expect(states.some((p) => p.key === "page" && p.patch.state === "failed")).toBe(true);
  });

  // --- Changing the track (FR-A3) ------------------------------------------------------

  it("switches a fast-track change to the guided track on the requester's request, before anything is pushed", async () => {
    const { state, m } = await runScenario({ risk: true }, async (h, mock) => {
      await mock.reached("requestRiskApproval");
      const opened = mock.reached("recordDesignTurn");
      await h.changeTrack("guided", "It touches CI, I want a plan");
      await opened;
      expect(mock.of("pushBranch")).toHaveLength(0);
      const proposed = mock.reached("recordDesignTurn");
      await h.say("Put it up for approval");
      await proposed;
      let risk = mock.reached("requestRiskApproval");
      await h.approvePlan("apr_plan_1");
      await risk;
      risk = mock.reached("requestRiskApproval");
      await h.signalSubtask("lib", "approval", { approvalId: "apr_risk", decision: "approve" });
      await risk;
      await h.signalSubtask("page", "approval", { approvalId: "apr_risk", decision: "approve" });
    });
    expect(state).toBe("completed");
    // The change was set aside while it waited for the high-risk approval; its decision is closed.
    expect(m.of<{ key: string }>("initSubtask").map((i) => i.key)).toEqual(["change", "lib", "page"]);
    expect(m.of<{ subtaskKey?: string; key?: string }>("pushBranch").map((p) => p.subtaskKey)).toEqual(["lib", "page"]);
    expect(m.of<{ subtaskKey?: string }>("closeOutApprovals").some((c) => c.subtaskKey === "change")).toBe(true);
    const changed = m.of<{ type: string; payload: { track: string; from: string; by: string; reason: string } }>("recordEvent").find((e) => e.type === "track.changed")!;
    expect(changed.payload).toMatchObject({ track: "guided", from: "fast", by: "tester", reason: "It touches CI, I want a plan" });
    expect(m.of<{ track: string }>("setTrackLabel").map((l) => l.track)).toEqual(["fast", "guided"]);
    expect(m.of<{ key: string; body: string }>("commentOnIssue").find((c) => /:track=1$/.test(c.key))?.body).toContain("Track changed to **guided** by @tester: It touches CI, I want a plan");
  });

  it("refuses to switch a fast-track change once it is being published", async () => {
    const { state, m } = await runScenario({ prInitial: "open" }, async (h, mock) => {
      await mock.reached("openPullRequest");
      const refused = mock.reached("postNotice");
      await h.changeTrack("guided");
      await refused;
      mock.pr(7, "merged");
    });
    expect(state).toBe("completed");
    expect(m.of<{ noticeKey: string; text: string }>("postNotice").find((n) => n.noticeKey === "track-refused-change")?.text).toMatch(/already being published/);
    expect(events(m)).not.toContain("track.changed");
    expect(m.of("recordDesignTurn")).toHaveLength(0);
  });

  it("switches a design session to the fast track when the plan stays in one repository: the plan becomes one change", async () => {
    const { state, m } = await runScenario({ track: "guided", plan: handoffStacked }, async (h, mock) => {
      await mock.reached("recordDesignTurn");
      await h.changeTrack("fast", "Small enough after all");
    });
    expect(state).toBe("completed");
    expect(m.of("closeDesignSession")).toHaveLength(1);
    expect(m.of<{ subtaskKey?: string }>("closeOutApprovals").some((c) => !c.subtaskKey)).toBe(true);
    expect(m.of("finalizePlan")).toHaveLength(0);
    expect(m.of("mirrorPlanOnTicket")).toHaveLength(0);
    // One change, without the requester's check, holding every sub-task and acceptance criterion of the plan.
    const change = m.of<{ key: string; ownConversation: boolean; repo: { name: string } }>("initSubtask");
    expect(change.map((c) => [c.key, c.ownConversation, c.repo.name])).toEqual([["change", false, "demo"]]);
    expect(m.of("requestChangeCheck")).toHaveLength(0);
    const plan = m.of<StepPrep>("prepareStep").find((p) => p.kind === "implement")!.plan!;
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0]!.acceptanceCriteria).toEqual(["works", "documented"]);
    expect(plan.subtasks[0]!.description).toContain("1. Add subtract function: d1");
    expect(plan.subtasks[0]!.description).toContain("2. Document subtract: d2");
    expect(m.of<{ checkLimits: boolean }>("inspectChanges")[0]!.checkLimits).toBe(true);
    expect(m.of<{ type: string; payload: { track: string; from: string } }>("recordEvent").find((e) => e.type === "track.changed")!.payload).toMatchObject({ track: "fast", from: "guided" });
    expect(m.of<{ track: string }>("setTrackLabel").map((l) => l.track)).toEqual(["guided", "fast"]);
  });

  it("refuses to switch a design session to the fast track when the plan changes two repositories", async () => {
    const { state, m } = await runScenario({ track: "guided" }, async (h, mock) => {
      await mock.reached("recordDesignTurn");
      const refused = mock.reached("postNotice");
      await h.changeTrack("fast");
      await refused;
      const proposed = mock.reached("recordDesignTurn");
      await h.say("Put it up for approval");
      await proposed;
      await h.approvePlan("apr_plan_1");
    });
    expect(state).toBe("completed");
    const notice = m.of<{ text: string }>("postNotice").find((n) => /needs the work to stay in one repository/.test(n.text))!;
    expect(notice.text).toContain("involves 2: acme/web, acme/demo");
    expect(events(m)).toContain("track.switch_refused");
    expect(events(m)).not.toContain("track.changed");
    expect(m.of("closeDesignSession")).toHaveLength(1);
  });

  it("comes back to the design session after a switch to the fast track: a new session with turns of its own", async () => {
    const { state, m } = await runScenario({ track: "guided", plan: handoffStacked, limits: ["The change touches 9 files (the fast-track limit is 5)"] }, async (h, mock) => {
      await mock.reached("recordDesignTurn");
      await h.changeTrack("fast");
      await mock.reached("requestLimitsDecision");
      const reopened = mock.reached("recordDesignTurn");
      await h.signalSubtask("change", "approval", { approvalId: "apr_limits", decision: "guided" });
      await reopened;
      const proposed = mock.reached("recordDesignTurn");
      await h.say("Put it up for approval");
      await proposed;
      await h.approvePlan("apr_plan_2");
    });
    expect(state).toBe("completed");
    expect(m.of<{ track: string }>("setTrackLabel").map((l) => l.track)).toEqual(["guided", "fast", "guided"]);
    // Two sessions: every turn has its own id, and the second session opens by itself again.
    const turns = m.of<{ turn: DesignTurnInput }>("awaitDesignTurn").map((t) => t.turn);
    expect(new Set(turns.map((t) => t.turnId)).size).toBe(turns.length);
    expect(turns.filter((t) => t.opening)).toHaveLength(2);
    expect(m.of<{ key: string }>("initSubtask").map((i) => i.key)).toEqual(["change", "api", "docs"]);
    expect(m.of<{ version: number }>("finalizePlan").map((f) => f.version)).toEqual([2]);
    // The events of both sessions are recorded: their writers do not collide.
    const keys = m.of<{ key: string }>("recordEvent").map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(events(m).filter((e) => e === "design.opened")).toHaveLength(2);
  });

  // --- Access (AD-42) ------------------------------------------------------------------

  it("waits for the requester when the token cannot push: before the build, and when the push is refused", async () => {
    const { state, m } = await runScenario({ accessRefusals: 1, pushRefusals: 1 }, async (h, mock) => {
      await mock.reached("requestBlockedDecision");
      expect(mock.of("prepareStep").filter((p) => (p as StepPrep).kind === "implement")).toHaveLength(0);
      const second = mock.reached("requestBlockedDecision");
      await h.signalSubtask("change", "approval", { approvalId: "apr_blocked_1", decision: "retry" });
      await second;
      await h.signalSubtask("change", "approval", { approvalId: "apr_blocked_2", decision: "retry" });
    });
    expect(state).toBe("completed");
    expect(m.of<{ what: string; problems: string[] }>("requestBlockedDecision").map((b) => b.what)).toEqual(["push to acme/demo", "push the branch to acme/demo"]);
    expect(m.of<{ problems: string[] }>("requestBlockedDecision")[1]!.problems[0]).toMatch(/refused: 403/);
    expect(m.of("pushBranch")).toHaveLength(2);
    expect(m.of("openPullRequest")).toHaveLength(1);
    expect(events(m).filter((e) => e === "access.blocked")).toHaveLength(2);
  });

  it("cancels the run when the requester gives up on a blocked sub-task; nothing is built", async () => {
    const { state, m } = await runScenario({ accessRefusals: 1 }, async (h, mock) => {
      await mock.reached("requestBlockedDecision");
      await h.signalSubtask("change", "approval", { approvalId: "apr_blocked_1", decision: "cancel" });
    });
    expect(state).toBe("cancelled");
    expect(kinds(m)).toEqual(["analyse"]);
    expect(m.of("pushBranch")).toHaveLength(0);
    expect(finalNotice(m)).toMatch(/the token cannot push to acme\/demo; nothing was built/);
  });

  it("does not put a plan up for approval while the token cannot push to one of its repositories", async () => {
    const { state, m } = await runScenario({ track: "guided", accessRefusals: 1 }, async (h, mock) => {
      await mock.reached("recordDesignTurn");
      let next = mock.reached("recordDesignTurn");
      await h.say("Put it up for approval");
      await next;
      next = mock.reached("recordDesignTurn");
      await h.say("The access is fixed: put it up for approval again");
      await next;
      await h.approvePlan("apr_plan_1");
    });
    // The first proposal was held back; the second, after the access was fixed, was approved.
    expect(state).toBe("completed");
    const recorded = m.of<{ result: DesignTurnResult; accessProblems?: string[] }>("recordDesignTurn");
    expect(recorded[1]!.result.proposed).toBe(false);
    expect(recorded[1]!.accessProblems).toEqual(["The token cannot push to acme/web", "The token cannot push to acme/demo"]);
    expect(recorded[2]!.result.proposed).toBe(true);
    expect(events(m)).toContain("access.plan_refused");
  });

  // --- Failures (§18) ------------------------------------------------------------------

  it("waits out the model provider: a step that failed on a rate limit is tried again after a pause", async () => {
    const { state, m } = await runScenario({ providerFailures: 2 });
    expect(state).toBe("completed");
    expect(kinds(m)).toEqual(["analyse", "implement", "implement", "implement", "review"]);
    expect(m.of<StepPrep & { title: string }>("prepareStep").map((p) => p.title).slice(1, 4)).toEqual([
      "Implement: Add subtract",
      "Implement: Add subtract (attempt 2)",
      "Implement: Add subtract (attempt 3)",
    ]);
    const waits = m.of<{ type: string; payload: { reason: string; waitSeconds: number } }>("recordEvent").filter((e) => e.type === "step.retry_scheduled");
    expect(waits.map((w) => w.payload)).toEqual([expect.objectContaining({ reason: "model provider", waitSeconds: 1 }), expect.objectContaining({ reason: "model provider", waitSeconds: 1 })]);
    expect(m.of<{ headline: string }>("updateProgress").some((p) => /Waiting for the model provider/.test(p.headline))).toBe(true);
  });

  it("starts the design session afresh from the current plan on the requester's request", async () => {
    const { state, m } = await runScenario({ track: "guided" }, async (h, mock) => {
      await mock.reached("recordDesignTurn");
      const restarted = mock.reached("restartDesignSession");
      await h.signalDesign("freshSession", { by: "tester" });
      await restarted;
      const proposed = mock.reached("recordDesignTurn");
      await h.say("Put it up for approval");
      await proposed;
      await h.approvePlan("apr_plan_1");
    });
    expect(state).toBe("completed");
    expect(events(m)).toContain("design.restarted");
    // The first workspace went away; the next message started a new one.
    expect(m.of<{ stepId: string; session?: boolean }>("createWorkspace").filter((w) => w.session).map((w) => w.stepId)).toEqual(["d1", "d2"]);
    expect(m.of<{ stepId: string }>("destroyWorkspace").some((d) => d.stepId === "d1")).toBe(true);
    expect(m.of<{ text: string }>("postNotice").some((n) => /starts afresh with your next message/.test(n.text))).toBe(true);
  });

  // --- Cancelling --------------------------------------------------------------------

  it("cancels the run during the design session: the session is closed and nothing is built", async () => {
    const { state, m } = await runScenario({ track: "guided" }, async (h, mock) => {
      await mock.reached("recordDesignTurn");
      await h.signal("cancel", { reason: "test" });
    });
    expect(state).toBe("cancelled");
    expect(m.of("closeDesignSession")).toHaveLength(1);
    expect(m.of("initSubtask")).toHaveLength(0);
    expect(m.of("mirrorPlanOnTicket")).toHaveLength(0);
    expect(m.of("createWorkspace")).toHaveLength(m.of("destroyWorkspace").length);
    expect(m.of<{ outcome: string }>("finalizeIssue")[0]!.outcome).toBe("cancelled");
  });

  it("cancels the run while one pull request waits for its merge and the next change waits for the requester's check", async () => {
    const { state, m } = await runScenario({ track: "guided", prInitial: "open", changeDecisions: "manual" }, async (h, mock) => {
      const first = mock.reached("requestChangeCheck");
      await designAndApprove(h, mock);
      await first;
      const second = mock.reached("requestChangeCheck");
      await h.signalSubtask("lib", "approval", { approvalId: "apr_change_lib_1", decision: "approve" });
      await second;
      await h.signal("cancel", { reason: "test" });
    });
    expect(state).toBe("cancelled");
    expect(m.of("openPullRequest")).toHaveLength(1);
    const states = m.of<{ key: string; patch: { state?: string } }>("patchSubtask");
    expect(["lib", "page"].every((k) => states.some((p) => p.key === k && p.patch.state === "cancelled"))).toBe(true);
    expect(m.of<{ outcome: string }>("finalizeIssue")[0]!.outcome).toBe("cancelled");
    expect(m.of("createWorkspace")).toHaveLength(m.of("destroyWorkspace").length);
  });

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
