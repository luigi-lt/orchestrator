import { z } from "zod";

// ---------------------------------------------------------------------------
// Work items and plans
// ---------------------------------------------------------------------------

export const RepoRef = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
});
export type RepoRef = z.infer<typeof RepoRef>;

export const repoSlug = (r: RepoRef): string => `${r.owner}/${r.name}`;

export function parseRepoSlug(slug: string): RepoRef {
  const [owner, name, ...rest] = slug.trim().split("/");
  if (!owner || !name || rest.length > 0) throw new Error(`Invalid repository "${slug}", expected owner/name`);
  return { owner, name };
}

export const WorkItem = z.object({
  source: z.literal("github"),
  repo: RepoRef,
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  labels: z.array(z.string()).default([]),
  requester: z.object({ login: z.string(), id: z.number().int().optional() }),
});
export type WorkItem = z.infer<typeof WorkItem>;

export type WorkItemType = "bug" | "story" | "feature" | "unknown";

/** The ticket type is a hint for the analysis, read from labels (Jira issue types later). */
export function workItemType(labels: readonly string[]): WorkItemType {
  const set = new Set(labels.map((l) => l.toLowerCase()));
  if (set.has("story") || set.has("epic")) return "story";
  if (set.has("bug")) return "bug";
  if (set.has("enhancement") || set.has("feature")) return "feature";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Product catalog (trusted configuration, AD-30)
// ---------------------------------------------------------------------------

export const RepositoryCommands = z.object({
  setup: z.string().optional(),
  build: z.string().optional(),
  test: z.string().optional(),
});
export type RepositoryCommands = z.infer<typeof RepositoryCommands>;

export const CatalogRepository = z.object({
  id: z.string(),
  owner: z.string(),
  name: z.string(),
  product: z.string(),
  role: z.string(),
  image: z.string(),
  commands: RepositoryCommands,
  highRiskPaths: z.array(z.string()),
  contractPaths: z.array(z.string()),
  egress: z.array(z.string()),
});
export type CatalogRepository = z.infer<typeof CatalogRepository>;

export const CatalogProduct = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  owners: z.array(z.string()),
  repositories: z.array(CatalogRepository).min(1),
});
export type CatalogProduct = z.infer<typeof CatalogProduct>;

export const Catalog = z.object({
  hash: z.string(),
  products: z.array(CatalogProduct).min(1),
});
export type Catalog = z.infer<typeof Catalog>;

export const catalogRepositories = (c: Catalog): CatalogRepository[] => c.products.flatMap((p) => p.repositories);

export function findCatalogRepository(c: Catalog, slug: string): CatalogRepository | undefined {
  const wanted = slug.trim().toLowerCase();
  return catalogRepositories(c).find((r) => r.id.toLowerCase() === wanted);
}

export const findCatalogProduct = (c: Catalog, id: string): CatalogProduct | undefined => c.products.find((p) => p.id === id.trim().toLowerCase());

/** What agents get to see of the catalog: what each product owns and where its code lives. */
export const CatalogExtract = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    repositories: z.array(z.object({ id: z.string(), role: z.string() })),
  }),
);
export type CatalogExtract = z.infer<typeof CatalogExtract>;

export const catalogExtract = (c: Catalog): CatalogExtract =>
  c.products.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    repositories: p.repositories.map((r) => ({ id: r.id, role: r.role })),
  }));

// ---------------------------------------------------------------------------
// Analysis and track (FR-A1, FR-A2)
// ---------------------------------------------------------------------------

export const Track = z.enum(["fast", "guided"]);
export type Track = z.infer<typeof Track>;

export const Size = z.enum(["S", "M", "L"]);
export type Size = z.infer<typeof Size>;

export const AnalysisProduct = z.object({
  product: z.string().min(1).describe("Product id from the catalog"),
  repositories: z.array(z.string()).min(1).max(8).describe("Repositories of this product that need changes, as owner/name"),
  reason: z.string().min(1).describe("Why this product is involved"),
  changes: z.string().min(1).describe("What changes there, in one or two sentences"),
});
export type AnalysisProduct = z.infer<typeof AnalysisProduct>;

export const Analysis = z.object({
  ready: z.boolean().describe("false only when you need answers from the requester before the work can be understood"),
  questions: z.array(z.string()).max(5).describe("Clarifying questions when ready is false; empty otherwise"),
  understanding: z.string().min(1).describe("What the work item asks for, in your own words"),
  products: z.array(AnalysisProduct).max(8).describe("Every product that needs changes; at least one when ready is true"),
  likelyFiles: z.array(z.string()).max(40).describe("Files or areas likely to change, as owner/name:path"),
  risks: z.array(z.string()).max(10),
  assumptions: z.array(z.string()).max(10),
  acceptanceCriteria: z.array(z.string()).max(12).describe("Checkable conditions that prove the work is done"),
  size: Size.describe("S: a handful of files in one place; M: several files or areas; L: larger"),
  clearBehavior: z.boolean().describe("true when the expected behavior is clear from the ticket"),
  singleArea: z.boolean().describe("true when the change stays in one area of one repository"),
  changesContracts: z.boolean().describe("true when a public API, schema, data migration or another interface between products changes"),
  proposedTrack: Track.describe("fast: small, clear change that can go straight to a pull request; guided: needs design with the requester"),
  trackReasons: z.array(z.string()).max(6).describe("Why you propose this track"),
  approach: z.string().describe("How you would make the change: what will change and why, in a few sentences"),
});
export type Analysis = z.infer<typeof Analysis>;

// ---------------------------------------------------------------------------
// Hand-off plan (FR-P2, FR-M3): written by the architect agent, approved by the requester
// ---------------------------------------------------------------------------

export const PlanSubtask = z.object({
  key: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,23}$/)
    .describe("Short stable id in lowercase letters, digits and dashes, e.g. api-discount. Keep it the same across plan versions"),
  title: z.string().min(3).max(200).describe("Short imperative title"),
  description: z.string().min(1).max(4000).describe("What to change and why, with enough detail for an engineer"),
  acceptanceCriteria: z.array(z.string().min(1)).min(1).max(12).describe("Checkable conditions that prove the sub-task is done"),
  product: z.string().min(1).describe("Product id from the catalog"),
  repository: z.string().min(3).describe("The one repository this sub-task changes, as owner/name"),
  likelyFiles: z.array(z.string()).max(30).default([]).describe("Files or areas likely to change"),
  dependsOn: z.array(z.string()).max(10).default([]).describe("Keys of the sub-tasks that must be done before this one"),
  size: Size,
});
export type PlanSubtask = z.infer<typeof PlanSubtask>;

/** An interface between products that the plan fixes before anyone builds (FR-M3). */
export const PlanContract = z.object({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(3000).describe("The shape of the interface, its versioning and backward compatibility"),
  providers: z.array(z.string()).max(10).default([]).describe("Keys of the sub-tasks that provide it"),
  consumers: z.array(z.string()).max(10).default([]).describe("Keys of the sub-tasks that use it"),
});
export type PlanContract = z.infer<typeof PlanContract>;

export const HandoffPlan = z.object({
  goal: z.string().min(1).max(2000).describe("What the work achieves, for the requester"),
  approach: z.string().min(1).max(4000).describe("How it will be done and why this way"),
  outOfScope: z.array(z.string()).max(12).default([]),
  risks: z.array(z.string()).max(12).default([]),
  assumptions: z.array(z.string()).max(12).default([]),
  constraints: z.array(z.string()).max(12).default([]).describe("What the requester asked to respect, e.g. 'do not change the public API'"),
  definitionOfDone: z.array(z.string()).max(12).default([]),
  contracts: z.array(PlanContract).max(10).default([]).describe("Interfaces between products, when more than one product is involved"),
  rollout: z.string().max(2000).default("").describe("Order of changes across products, merge order, feature flags where needed"),
  subtasks: z.array(PlanSubtask).min(1).max(20).describe("Each sub-task changes exactly one repository and is reviewed and merged on its own"),
});
export type HandoffPlan = z.infer<typeof HandoffPlan>;

export interface PlanChange {
  kind: "added" | "removed" | "changed";
  what: "subtask" | "contract" | "plan";
  /** The sub-task title, the contract name, or the name of the plan section. */
  title: string;
  /** For a changed sub-task or contract: which of its fields differ. */
  fields?: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const PLAN_SECTIONS: [keyof HandoffPlan, string][] = [
  ["goal", "Goal"],
  ["approach", "Approach"],
  ["outOfScope", "Out of scope"],
  ["risks", "Risks"],
  ["assumptions", "Assumptions"],
  ["constraints", "Constraints"],
  ["definitionOfDone", "Definition of done"],
  ["rollout", "Rollout"],
];
const SUBTASK_FIELDS: [keyof PlanSubtask, string][] = [
  ["title", "title"],
  ["description", "description"],
  ["acceptanceCriteria", "acceptance criteria"],
  ["product", "product"],
  ["repository", "repository"],
  ["likelyFiles", "likely files"],
  ["dependsOn", "dependencies"],
  ["size", "size"],
];

/** What changed between two plan versions, shown on the plan card (FR-P3). Sub-tasks are matched by key. */
export function diffPlans(previous: HandoffPlan | null, next: HandoffPlan): PlanChange[] {
  if (!previous) return [];
  const changes: PlanChange[] = [];
  for (const [field, title] of PLAN_SECTIONS) if (!same(previous[field], next[field])) changes.push({ kind: "changed", what: "plan", title });
  const before = new Map(previous.subtasks.map((st) => [st.key, st]));
  const after = new Map(next.subtasks.map((st) => [st.key, st]));
  for (const st of next.subtasks) {
    const old = before.get(st.key);
    if (!old) changes.push({ kind: "added", what: "subtask", title: st.title });
    else {
      const fields = SUBTASK_FIELDS.filter(([f]) => !same(old[f], st[f])).map(([, label]) => label);
      if (fields.length) changes.push({ kind: "changed", what: "subtask", title: st.title, fields });
    }
  }
  for (const st of previous.subtasks) if (!after.has(st.key)) changes.push({ kind: "removed", what: "subtask", title: st.title });
  if (!same(previous.subtasks.map((st) => st.key).filter((k) => after.has(k)), next.subtasks.map((st) => st.key).filter((k) => before.has(k)))) {
    changes.push({ kind: "changed", what: "plan", title: "Order of sub-tasks" });
  }
  const contractsBefore = new Map(previous.contracts.map((c) => [c.name, c]));
  const contractsAfter = new Map(next.contracts.map((c) => [c.name, c]));
  for (const c of next.contracts) {
    const old = contractsBefore.get(c.name);
    if (!old) changes.push({ kind: "added", what: "contract", title: c.name });
    else if (!same(old, c)) changes.push({ kind: "changed", what: "contract", title: c.name });
  }
  for (const c of previous.contracts) if (!contractsAfter.has(c.name)) changes.push({ kind: "removed", what: "contract", title: c.name });
  return changes;
}

/**
 * The order in which sub-tasks are built: every sub-task after the ones it depends on, otherwise in plan order.
 * Returns null when the dependencies form a cycle.
 */
export function buildOrder(plan: HandoffPlan): PlanSubtask[] | null {
  const done = new Set<string>();
  const ordered: PlanSubtask[] = [];
  const known = new Set(plan.subtasks.map((st) => st.key));
  while (ordered.length < plan.subtasks.length) {
    const next = plan.subtasks.find((st) => !done.has(st.key) && st.dependsOn.every((d) => done.has(d) || !known.has(d)));
    if (!next) return null;
    done.add(next.key);
    ordered.push(next);
  }
  return ordered;
}

export type PlanVersionStatus = "draft" | "proposed" | "approved" | "superseded";

/** One immutable version of a run's hand-off plan (AD-36). */
export interface PlanVersionDto {
  runId: string;
  version: number;
  hash: string;
  plan: HandoffPlan;
  status: PlanVersionStatus;
  /** What changed compared with the version before. */
  changes: PlanChange[];
  /** The agent profile that wrote it, and the requester's request that prompted it. */
  author: string;
  promptedBy: string | null;
  createdAt: string;
}

export interface TrackDecision {
  track: Track;
  /** What the analyst proposed; the rules may have overruled it. */
  proposed: Track;
  reasons: string[];
}

export const Subtask = z.object({
  title: z.string().min(3).max(200).describe("Short imperative title, e.g. 'Add input validation to the signup form'"),
  description: z.string().min(1).describe("What to change and why, with enough detail for an engineer"),
  acceptanceCriteria: z.array(z.string()).describe("Checkable conditions that prove the sub-task is done"),
});
export type Subtask = z.infer<typeof Subtask>;

export const Plan = z.object({
  summary: z.string().min(1).describe("One or two sentences describing the overall approach"),
  subtasks: z.array(Subtask).min(1).max(8).describe("Ordered sub-tasks; each becomes one commit"),
});
export type Plan = z.infer<typeof Plan>;

export const QuestionRound = z.object({ questions: z.array(z.string()), answer: z.string() });
export type QuestionRound = z.infer<typeof QuestionRound>;

// ---------------------------------------------------------------------------
// Runs and steps
// ---------------------------------------------------------------------------

export const RunState = z.enum([
  "intake",
  "analysing",
  "planning",
  "designing",
  "awaiting_answers",
  "awaiting_approval",
  "executing",
  "reviewing",
  "publishing",
  "awaiting_merge",
  "completed",
  "closed",
  "cancelled",
  "failed",
]);
export type RunState = z.infer<typeof RunState>;

export const FINAL_RUN_STATES: readonly RunState[] = ["completed", "closed", "cancelled", "failed"];

export const StepKind = z.enum(["analyse", "plan", "design", "implement", "review"]);
export type StepKind = z.infer<typeof StepKind>;

export const StepState = z.enum(["pending", "running", "succeeded", "failed"]);
export type StepState = z.infer<typeof StepState>;

// ---------------------------------------------------------------------------
// Verification and AI review of a change (FR-B1, FR-R1, FR-R2)
// ---------------------------------------------------------------------------

/** One of the product's commands (from the catalog), run by the workspace host on the change. */
export const CommandResult = z.object({
  name: z.enum(["setup", "build", "test"]),
  command: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  /** The end of the combined output. */
  output: z.string().max(8000),
});
export type CommandResult = z.infer<typeof CommandResult>;

export const Verification = z.object({
  commands: z.array(CommandResult).max(10),
  /** True when every command exited with 0 (also when the product has no commands). */
  passed: z.boolean(),
});
export type Verification = z.infer<typeof Verification>;

export const ReviewSeverity = z.enum(["blocking", "major", "minor"]);
export type ReviewSeverity = z.infer<typeof ReviewSeverity>;

export const ReviewFinding = z.object({
  severity: ReviewSeverity.describe("blocking: must not ship; major: should be fixed before the pull request; minor: a note that never blocks"),
  title: z.string().min(3).max(200),
  file: z.string().max(400).optional().describe("Path of the file, relative to the repository root"),
  line: z.number().int().positive().optional(),
  explanation: z.string().min(1).max(2000).describe("What is wrong and why it matters"),
  suggestion: z.string().max(2000).optional().describe("How to fix it"),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

/** What the reviewer agent submits for one review round. */
export const ReviewReport = z.object({
  verdict: z.enum(["approve", "changes_needed"]).describe("approve only when there is no blocking or major finding"),
  summary: z.string().min(1).max(3000).describe("What the change does and how good it is, in a few sentences"),
  criteria: z
    .array(z.object({ criterion: z.string(), met: z.boolean(), note: z.string().max(1000).optional() }))
    .max(20)
    .describe("Each acceptance criterion of the sub-task and whether the change meets it"),
  findings: z.array(ReviewFinding).max(30).describe("Everything that is wrong with the change as it is now"),
  earlier: z
    .array(z.object({ id: z.string(), resolved: z.boolean(), note: z.string().max(1000).optional() }))
    .max(40)
    .default([])
    .describe("For each earlier finding you were given: whether it is resolved now"),
});
export type ReviewReport = z.infer<typeof ReviewReport>;

/** A finding as the orchestrator tracks it across review rounds. */
export const TrackedFinding = ReviewFinding.extend({
  id: z.string(),
  /** The review round that raised it (0 is the first review). */
  round: z.number().int().nonnegative(),
});
export type TrackedFinding = z.infer<typeof TrackedFinding>;

/** The state of a sub-task's AI review after its latest round. */
export const SubtaskReview = z.object({
  /** Number of review rounds so far. */
  rounds: z.number().int().positive(),
  summary: z.string(),
  criteria: ReviewReport.shape.criteria,
  /** What is wrong with the change as it is now. */
  open: z.array(TrackedFinding),
  /** Findings of earlier rounds that a later review confirmed as fixed. */
  resolved: z.array(TrackedFinding),
});
export type SubtaskReview = z.infer<typeof SubtaskReview>;

/** Blocking and major findings go back to the implementer; minor ones never block (FR-R2). */
export const findingsToFix = (review: SubtaskReview): TrackedFinding[] => review.open.filter((f) => f.severity !== "minor");

/**
 * Folds a review round into the sub-task's review. The newest report is the truth about what is open;
 * earlier findings the reviewer confirms as fixed move to `resolved`. The verdict word is not trusted:
 * what happens next follows from the severities (AD-39).
 */
export function mergeReview(previous: SubtaskReview | null, report: ReviewReport): SubtaskReview {
  const round = previous?.rounds ?? 0;
  const confirmed = new Set(report.earlier.filter((e) => e.resolved).map((e) => e.id));
  return {
    rounds: round + 1,
    summary: report.summary,
    criteria: report.criteria,
    open: report.findings.map((f, i) => ({ ...f, id: `r${round + 1}-${i + 1}`, round })),
    resolved: [...(previous?.resolved ?? []), ...(previous?.open ?? []).filter((f) => confirmed.has(f.id))],
  };
}

export const SubtaskState = z.enum([
  "planned",
  "implementing",
  "reviewing",
  "awaiting_decision",
  "publishing",
  "pr_open",
  "merged",
  "closed",
  "handed_over",
  "cancelled",
  "failed",
]);
export type SubtaskState = z.infer<typeof SubtaskState>;

export const FINAL_SUBTASK_STATES: readonly SubtaskState[] = ["merged", "closed", "handed_over", "cancelled", "failed"];

// ---------------------------------------------------------------------------
// Design session (FR-P1, AD-34, AD-35): turns of the architect agent in a session workspace
// ---------------------------------------------------------------------------

export const DesignTurnInput = z.object({
  turnId: z.string(),
  /** The first turn has no message: the architect opens the session from the analysis. */
  opening: z.boolean(),
  messages: z.array(z.string()),
});
export type DesignTurnInput = z.infer<typeof DesignTurnInput>;

export const DesignTurnResult = z.object({
  turnId: z.string(),
  status: z.enum(["succeeded", "failed"]),
  /** The architect's reply, as markdown. */
  text: z.string().max(40000).default(""),
  components: z.array(z.unknown()).max(10).default([]),
  /** The plan the architect submitted in this turn, already checked by the gateway. */
  plan: HandoffPlan.optional(),
  /** True when the architect put the plan up for the requester's approval. */
  proposed: z.boolean().default(false),
  /** How the session started in this workspace, for the record: new, restored from a checkpoint, or rebuilt from the record. */
  session: z.enum(["new", "restored", "rebuilt", "continued"]).default("continued"),
  error: z.string().optional(),
});
export type DesignTurnResult = z.infer<typeof DesignTurnResult>;

/** What a design step's brief adds: how to start or restore the architect's session. */
export const DesignBrief = z.object({
  sessionId: z.string(),
  hasCheckpoint: z.boolean(),
  /** The conversation so far and the latest plan: the record a session is rebuilt from when no checkpoint can be restored. */
  history: z.array(z.object({ role: z.enum(["requester", "architect"]), text: z.string() })).default([]),
  latestPlan: HandoffPlan.optional(),
  latestVersion: z.number().int().optional(),
});
export type DesignBrief = z.infer<typeof DesignBrief>;

export type DesignSessionState = "active" | "suspending" | "suspended" | "closed";

export interface DesignSessionDto {
  runId: string;
  state: DesignSessionState;
  /** True while the architect is working on a reply. */
  turnRunning: boolean;
  turns: number;
}

/** One repository checked out in a workspace (AD-37). At most one is writable. */
export const BriefRepository = z.object({
  index: z.number().int().nonnegative(),
  product: z.string(),
  repo: RepoRef,
  role: z.string(),
  branch: z.string(),
  commit: z.string(),
  /** Commit of the default branch the work starts from; guidance files are read there, never from the change itself. */
  baseCommit: z.string().optional(),
  mode: z.enum(["writable", "readonly"]),
  /** Checkout directory relative to the workspace root, e.g. repos/shop/acme__web. */
  path: z.string(),
  /** The repository the agent starts in. */
  primary: z.boolean(),
});
export type BriefRepository = z.infer<typeof BriefRepository>;

export const workspaceRepoPath = (product: string, repo: RepoRef): string => `repos/${product}/${repo.owner}__${repo.name}`;

/** Everything a workspace needs to run one step. Written by the worker, read by the workspace host. */
export const StepBrief = z.object({
  stepId: z.string(),
  runId: z.string(),
  kind: StepKind,
  model: z.string(),
  /** Branch of the primary repository (the agent branch for implementation steps). */
  branch: z.string(),
  workItem: WorkItem,
  repositories: z.array(BriefRepository).min(1),
  /** How many repositories the step may hold in total, including those requested on demand. */
  maxRepositories: z.number().int().positive().default(8),
  catalog: CatalogExtract.default([]),
  analysis: Analysis.optional(),
  questionRounds: z.array(QuestionRound).default([]),
  feedback: z.string().optional(),
  plan: Plan.optional(),
  subtaskIndex: z.number().int().optional(),
  /** 0 for the first implementation or review of a sub-task; fix and re-review rounds count up. */
  round: z.number().int().nonnegative().default(0),
  /** The product's commands for the repository being changed, from the catalog: trusted, run by the workspace host. */
  commands: RepositoryCommands.default({}),
  /** Implementation: the findings to fix. Review: the earlier findings to check again. */
  findings: z.array(TrackedFinding).default([]),
  /** The requester's guidance for a fix round. */
  guidance: z.string().optional(),
  /** Review: what the implementer said it did (a claim to verify) and what the product's commands reported. */
  implementerSummary: z.string().optional(),
  verification: Verification.optional(),
  /** Design steps: the session to start or restore. */
  design: DesignBrief.optional(),
  commitAuthor: z.object({ name: z.string(), email: z.string() }),
  timeoutMinutes: z.number().int().positive(),
});
export type StepBrief = z.infer<typeof StepBrief>;

export const StepResult = z.object({
  status: z.enum(["succeeded", "failed"]),
  summary: z.string(),
  analysis: Analysis.optional(),
  review: ReviewReport.optional(),
  verification: Verification.optional(),
  commits: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type StepResult = z.infer<typeof StepResult>;

/** A repository an agent asked for during a step (gateway tool request_repository). */
export const RepositoryRequestState = z.enum(["pending", "ready", "denied", "failed"]);
export type RepositoryRequestState = z.infer<typeof RepositoryRequestState>;

export interface RepositoryRequestDto {
  id: string;
  stepId: string;
  repository: string;
  state: RepositoryRequestState;
  entry: BriefRepository | null;
  error: string | null;
}

export const ProgressKind = z.enum(["status", "message", "tool_start", "tool_end", "error"]);
export type ProgressKind = z.infer<typeof ProgressKind>;

export const ProgressEvent = z.object({
  kind: ProgressKind,
  text: z.string().max(4000),
  data: z.record(z.string(), z.unknown()).optional(),
  at: z.string().optional(),
});
export type ProgressEvent = z.infer<typeof ProgressEvent>;

// ---------------------------------------------------------------------------
// Component catalog (generative UI)
// ---------------------------------------------------------------------------

// Components agents may emit.
export const TextComponent = z.object({ type: z.literal("text"), markdown: z.string().max(20000) });
export const TableComponent = z.object({
  type: z.literal("table"),
  title: z.string().optional(),
  columns: z.array(z.string()).min(1).max(12),
  rows: z.array(z.array(z.string())).max(200),
});
export const FormField = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["text", "textarea", "choice"]),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
});
export const FormComponent = z.object({
  type: z.literal("form"),
  id: z.string().min(1),
  title: z.string().optional(),
  fields: z.array(FormField).min(1).max(10),
  submitLabel: z.string().optional(),
});
export const AgentComponent = z.discriminatedUnion("type", [TextComponent, TableComponent, FormComponent]);
export type AgentComponent = z.infer<typeof AgentComponent>;

// Orchestrator cards: system-only components, rendered from orchestrator data.
export const ProgressStep = z.object({ title: z.string(), status: z.enum(["pending", "running", "done", "failed"]) });
export const WorkItemCard = z.object({
  type: z.literal("work_item"),
  runId: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
});
export const ProgressCard = z.object({
  type: z.literal("progress"),
  runId: z.string(),
  state: RunState,
  headline: z.string(),
  steps: z.array(ProgressStep),
});
/** The hand-off plan of a guided run: read-only, with its versions; approval is a button bound to one version (FR-P3, FR-P4). */
export const PlanCard = z.object({
  type: z.literal("plan"),
  runId: z.string(),
  version: z.number().int(),
  hash: z.string(),
  plan: HandoffPlan,
  /** draft: the architect is still shaping it; proposed: waiting for the requester's approval. */
  status: z.enum(["draft", "proposed", "approved", "expired"]),
  /** Set while the version is proposed. */
  approvalId: z.string().optional(),
  changes: z.array(z.object({ kind: z.enum(["added", "removed", "changed"]), what: z.enum(["subtask", "contract", "plan"]), title: z.string(), fields: z.array(z.string()).optional() })),
  /** The requester's request that led to this version. */
  promptedBy: z.string().nullable(),
  /** Product names, for grouping the sub-tasks. */
  products: z.record(z.string(), z.string()),
});
export const QuestionsCard = z.object({
  type: z.literal("questions"),
  runId: z.string(),
  approvalId: z.string(),
  questions: z.array(z.string()),
  status: z.enum(["pending", "answered", "expired"]),
  answer: z.string().optional(),
});
export const RiskCard = z.object({
  type: z.literal("risk"),
  runId: z.string(),
  approvalId: z.string(),
  hash: z.string(),
  subtaskKey: z.string().optional(),
  reasons: z.array(z.string()),
  files: z.array(z.string()),
  status: z.enum(["pending", "approved", "rejected", "expired"]),
});
export const PullRequestCard = z.object({
  type: z.literal("pull_request"),
  runId: z.string(),
  subtaskKey: z.string().optional(),
  number: z.number(),
  url: z.string(),
  title: z.string(),
  state: z.enum(["open", "merged", "closed"]),
});
export const AnalysisCard = z.object({
  type: z.literal("analysis"),
  runId: z.string(),
  understanding: z.string(),
  products: z.array(
    z.object({ id: z.string(), name: z.string(), repositories: z.array(z.string()), reason: z.string(), changes: z.string() }),
  ),
  size: Size,
  track: Track,
  proposedTrack: Track,
  trackReasons: z.array(z.string()),
  approach: z.string(),
  acceptanceCriteria: z.array(z.string()),
  risks: z.array(z.string()),
  assumptions: z.array(z.string()),
});
/** Shown in the chat that started a run: the run lives in its own conversation (AD-38). */
export const RunLinkCard = z.object({
  type: z.literal("run_link"),
  runId: z.string(),
  conversationId: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
});
/** The header of a sub-task's own conversation (FR-C2). */
export const SubtaskCard = z.object({
  type: z.literal("subtask"),
  runId: z.string(),
  subtaskKey: z.string(),
  index: z.number().int(),
  total: z.number().int(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  repository: z.string(),
  branch: z.string(),
});
/** The reviewer agent's report on a change, kept up to date across review rounds (FR-R1). */
export const ReviewCard = z.object({
  type: z.literal("review"),
  runId: z.string(),
  subtaskKey: z.string(),
  review: SubtaskReview,
  verification: Verification.nullable(),
  /** What happens next: nothing to fix, a fix round is running, or the requester must decide. */
  status: z.enum(["clean", "fixing", "needs_decision", "accepted_with_findings"]),
});
/** Findings still blocking after the fix rounds: the requester decides (FR-R2). */
export const FindingsCard = z.object({
  type: z.literal("findings"),
  runId: z.string(),
  subtaskKey: z.string(),
  approvalId: z.string(),
  hash: z.string(),
  findings: z.array(TrackedFinding),
  fixRounds: z.number().int(),
  status: z.enum(["pending", "open", "retry", "take_over", "cancel", "expired"]),
  guidance: z.string().optional(),
});
/** A fast-track change that turned out bigger than the fast track allows (FR-A2). */
export const LimitsCard = z.object({
  type: z.literal("limits"),
  runId: z.string(),
  subtaskKey: z.string(),
  approvalId: z.string(),
  hash: z.string(),
  reasons: z.array(z.string()),
  files: z.array(z.string()),
  status: z.enum(["pending", "continue", "guided", "cancel", "expired"]),
});
/** The sub-tasks of a guided run, each with its state and its own conversation (first form of the story view, FR-R7). */
export const StoryCard = z.object({
  type: z.literal("story"),
  runId: z.string(),
  subtasks: z.array(
    z.object({
      key: z.string(),
      index: z.number().int(),
      title: z.string(),
      state: SubtaskState,
      repository: z.string().nullable(),
      conversationId: z.string().nullable(),
      prNumber: z.number().nullable(),
      prUrl: z.string().nullable(),
    }),
  ),
});
export const NoticeCard = z.object({
  type: z.literal("notice"),
  runId: z.string().optional(),
  level: z.enum(["info", "success", "warning", "error"]),
  text: z.string(),
});
export const OrchestratorCard = z.discriminatedUnion("type", [
  WorkItemCard,
  RunLinkCard,
  AnalysisCard,
  ProgressCard,
  PlanCard,
  QuestionsCard,
  RiskCard,
  SubtaskCard,
  ReviewCard,
  FindingsCard,
  LimitsCard,
  StoryCard,
  PullRequestCard,
  NoticeCard,
]);
export type OrchestratorCard = z.infer<typeof OrchestratorCard>;

export const SYSTEM_ONLY_TYPES = new Set<string>([
  "work_item",
  "run_link",
  "analysis",
  "progress",
  "plan",
  "questions",
  "risk",
  "subtask",
  "review",
  "findings",
  "limits",
  "story",
  "pull_request",
  "notice",
]);

export type Component = AgentComponent | OrchestratorCard;

/** Drops anything an agent is not allowed to emit (system-only cards, malformed components). */
export function sanitizeAgentComponents(input: unknown[]): AgentComponent[] {
  const out: AgentComponent[] = [];
  for (const c of input) {
    if (c && typeof c === "object" && SYSTEM_ONLY_TYPES.has(String((c as { type?: unknown }).type))) continue;
    const parsed = AgentComponent.safeParse(c);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conversations and messages
// ---------------------------------------------------------------------------

export const MessageRole = z.enum(["user", "agent", "orchestrator"]);
export type MessageRole = z.infer<typeof MessageRole>;

/** Which agent wrote an agent message; shown next to it (AD-38). */
export type MessageAuthor = "front-door" | "architect";

export interface MessageDto {
  id: string;
  conversationId: string;
  role: MessageRole;
  author: MessageAuthor | null;
  text: string | null;
  components: Component[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDto {
  id: string;
  title: string;
  /** "run": the conversation of one run; "subtask": of one sub-task of a run; "general": a chat with the front-door agent. */
  kind: "general" | "run" | "subtask";
  /** The run a run or sub-task conversation belongs to. */
  focusedRunId: string | null;
  subtaskKey: string | null;
  updatedAt: string;
  pending: number;
}

export interface RunDto {
  id: string;
  /** Identity of the ticket the run belongs to; every run of the same ticket shares it. */
  ticketKey: string;
  repo: string;
  issueNumber: number;
  title: string;
  url: string;
  requester: string;
  state: RunState;
  conversationId: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  plan: Plan | null;
  track: Track | null;
  trackReasons: string[];
  /** Product the ticket belongs to, and every product the analysis found. */
  homeProduct: string | null;
  products: string[];
  analysis: Analysis | null;
  catalogHash: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A sub-task of a run, with its results so far. */
export interface SubtaskDto {
  runId: string;
  key: string;
  index: number;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  state: SubtaskState;
  product: string | null;
  repository: string | null;
  branch: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  prNumber: number | null;
  prUrl: string | null;
  /** The sub-task's own conversation on the guided track; null on the fast track, where the run's conversation is used. */
  conversationId: string | null;
  /** The sub-issue that mirrors the sub-task on the ticket (FR-P5). */
  ticketNumber: number | null;
  ticketUrl: string | null;
  review: SubtaskReview | null;
  verification: Verification | null;
  fixRounds: number;
  createdAt: string;
  updatedAt: string;
}

/** A sub-task as listed under its run in the conversation hierarchy (AD-43). */
export interface TicketSubtaskDto {
  key: string;
  index: number;
  title: string;
  state: SubtaskState;
  conversationId: string;
  pending: number;
}

/** One run of a ticket, as listed under it. Each run has its own conversation (AD-38). */
export interface TicketRunDto {
  runId: string;
  conversationId: string | null;
  /** 1 for the first run of the ticket, 2 for the next, and so on. */
  ordinal: number;
  state: RunState;
  track: Track | null;
  /** Decisions waiting for the requester in this run, its sub-tasks included. */
  pending: number;
  /** Sub-tasks that have their own conversation, in plan order (guided track). */
  subtasks: TicketSubtaskDto[];
  prNumber: number | null;
  prUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A ticket and everything under it: the top of the conversation hierarchy (ticket, run, later sub-task). */
export interface TicketDto {
  key: string;
  repo: string;
  issueNumber: number;
  title: string;
  url: string;
  requester: string;
  /** State and track of the newest run. */
  state: RunState;
  track: Track | null;
  /** True while the newest run has not reached a final state. */
  active: boolean;
  /** Decisions waiting anywhere under the ticket. */
  pending: number;
  updatedAt: string;
  /** Newest first. */
  runs: TicketRunDto[];
}

/** Groups runs by ticket: tickets by latest activity, runs newest first, numbered in the order they started. */
export function groupTickets(
  runs: readonly RunDto[],
  pendingByRun: Readonly<Record<string, number>> = {},
  subtasksByRun: Readonly<Record<string, TicketSubtaskDto[]>> = {},
): TicketDto[] {
  const byTicket = new Map<string, RunDto[]>();
  for (const run of runs) byTicket.set(run.ticketKey, [...(byTicket.get(run.ticketKey) ?? []), run]);
  const tickets: TicketDto[] = [];
  for (const [key, group] of byTicket) {
    const oldestFirst = [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const ticketRuns: TicketRunDto[] = oldestFirst
      .map((r, i) => ({
        runId: r.id,
        conversationId: r.conversationId,
        ordinal: i + 1,
        state: r.state,
        track: r.track,
        pending: pendingByRun[r.id] ?? 0,
        subtasks: subtasksByRun[r.id] ?? [],
        prNumber: r.prNumber,
        prUrl: r.prUrl,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }))
      .reverse();
    const newest = oldestFirst[oldestFirst.length - 1]!;
    tickets.push({
      key,
      repo: newest.repo,
      issueNumber: newest.issueNumber,
      title: newest.title,
      url: newest.url,
      requester: newest.requester,
      state: newest.state,
      track: newest.track,
      active: !FINAL_RUN_STATES.includes(newest.state),
      pending: ticketRuns.reduce((sum, r) => sum + r.pending, 0),
      updatedAt: group.map((r) => r.updatedAt).sort().pop()!,
      runs: ticketRuns,
    });
  }
  return tickets.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface StepDto {
  id: string;
  runId: string;
  kind: StepKind;
  title: string;
  subtaskIndex: number | null;
  state: StepState;
  summary: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunEventDto {
  runId: string;
  seq: number;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export type ApprovalKind = "plan" | "questions" | "risk" | "findings" | "limits";

export interface ApprovalDto {
  id: string;
  runId: string;
  kind: ApprovalKind;
  state: "pending" | "resolved" | "expired";
  conversationId: string | null;
  title: string;
  createdAt: string;
}

export interface ProgressDto {
  seq: number;
  stepId: string;
  kind: ProgressKind;
  text: string;
  at: string;
}

/** Notifications pushed over the single server-sent event stream; clients fetch details over REST. */
export type StreamNotice =
  | { t: "msg"; c: string; v: number }
  | { t: "delta"; c: string; tempId: string; text: string }
  | { t: "typing"; c: string; on: boolean }
  | { t: "run"; r: string }
  | { t: "progress"; r: string; s: string; q: number }
  | { t: "pending" };

// ---------------------------------------------------------------------------
// Decisions sent from the UI
// ---------------------------------------------------------------------------

/** Approval of one plan version. Changes are asked for in the conversation with the architect, never here (FR-P3). */
export const PlanDecision = z.object({ decision: z.literal("approve"), hash: z.string() });
export type PlanDecision = z.infer<typeof PlanDecision>;

export const RiskDecision = z.object({ decision: z.enum(["approve", "reject"]), hash: z.string() });
export type RiskDecision = z.infer<typeof RiskDecision>;

/** What to do with findings that are still blocking after the fix rounds (FR-R2). */
export const FindingsDecision = z.object({
  decision: z.enum(["open", "retry", "take_over", "cancel"]),
  guidance: z.string().max(4000).optional(),
  hash: z.string(),
});
export type FindingsDecision = z.infer<typeof FindingsDecision>;

/** What to do with a fast-track change that exceeds the fast-track limits (FR-A2). */
export const LimitsDecision = z.object({ decision: z.enum(["continue", "guided", "cancel"]), hash: z.string() });
export type LimitsDecision = z.infer<typeof LimitsDecision>;

export const QuestionAnswer = z.object({ answer: z.string().min(1).max(8000) });
export type QuestionAnswer = z.infer<typeof QuestionAnswer>;

// Activities served by workspace-manager on the `workspaces` task queue.
export interface WorkspaceActivities {
  /** `session`: a design-session workspace, which lives much longer than a step's (AD-34). */
  createWorkspace(input: { stepId: string; runId: string; session?: boolean }): Promise<{ containerId: string }>;
  destroyWorkspace(input: { stepId: string }): Promise<void>;
}

export const TASK_QUEUES = {
  orchestration: "orchestration",
  integration: "integration",
  agentSteps: "agent-steps",
  workspaces: "workspaces",
} as const;

export interface DeliveryRunInput {
  runId: string;
  workItem: WorkItem;
  /** The chat the run was started from, if any; it gets a link to the run's own conversation. */
  conversationId: string | null;
  /** How often an open pull request is polled, in seconds (default 60). */
  prPollSeconds?: number;
}

/** Memo set on runs started by this version; older executions are retired at worker start. */
export const RUN_WORKFLOW_GENERATION = 4;

export const workflowIdForIssue = (repo: RepoRef, number: number) => `run:github:${repo.owner}/${repo.name}#${number}`;

// Signals delivered to the delivery-run workflow.
export interface ApprovalSignal {
  approvalId: string;
  /** Plan: approve, changes, reject. Risk: approve, reject. Findings: open, retry, take_over, cancel. Limits: continue, guided, cancel. */
  decision: "approve" | "changes" | "reject" | "open" | "retry" | "take_over" | "cancel" | "continue" | "guided";
  feedback?: string;
}
export interface AnswerSignal {
  approvalId: string;
  answer: string;
  source: "chat" | "ticket";
}
export interface CancelSignal {
  reason: string;
}
/** A message of the requester for the architect, delivered to the design session of a run. */
export interface RequesterMessageSignal {
  messageId: string;
  text: string;
}

export const designWorkflowId = (runId: string) => `design:${runId}`;
