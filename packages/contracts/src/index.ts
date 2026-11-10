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

export const Assessment = z.object({
  ready: z.boolean().describe("true when the issue is clear enough to plan and implement"),
  questions: z.array(z.string()).max(5).describe("Clarifying questions for the requester when ready is false; empty otherwise"),
  plan: Plan.optional().describe("The plan when ready is true"),
});
export type Assessment = z.infer<typeof Assessment>;

export const QuestionRound = z.object({ questions: z.array(z.string()), answer: z.string() });
export type QuestionRound = z.infer<typeof QuestionRound>;

// ---------------------------------------------------------------------------
// Runs and steps
// ---------------------------------------------------------------------------

export const RunState = z.enum([
  "intake",
  "analysing",
  "planning",
  "awaiting_answers",
  "awaiting_approval",
  "executing",
  "publishing",
  "awaiting_merge",
  "completed",
  "closed",
  "cancelled",
  "failed",
]);
export type RunState = z.infer<typeof RunState>;

export const FINAL_RUN_STATES: readonly RunState[] = ["completed", "closed", "cancelled", "failed"];

export const StepKind = z.enum(["analyse", "plan", "implement"]);
export type StepKind = z.infer<typeof StepKind>;

export const StepState = z.enum(["pending", "running", "succeeded", "failed"]);
export type StepState = z.infer<typeof StepState>;

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
  commitAuthor: z.object({ name: z.string(), email: z.string() }),
  timeoutMinutes: z.number().int().positive(),
});
export type StepBrief = z.infer<typeof StepBrief>;

export const StepResult = z.object({
  status: z.enum(["succeeded", "failed"]),
  summary: z.string(),
  analysis: Analysis.optional(),
  assessment: Assessment.optional(),
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
export const PlanCard = z.object({
  type: z.literal("plan"),
  runId: z.string(),
  approvalId: z.string(),
  hash: z.string(),
  plan: Plan,
  status: z.enum(["pending", "approved", "changes_requested", "rejected", "expired"]),
  feedback: z.string().optional(),
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
  reasons: z.array(z.string()),
  files: z.array(z.string()),
  status: z.enum(["pending", "approved", "rejected", "expired"]),
});
export const PullRequestCard = z.object({
  type: z.literal("pull_request"),
  runId: z.string(),
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
  PullRequestCard,
  NoticeCard,
]);
export type OrchestratorCard = z.infer<typeof OrchestratorCard>;

export const SYSTEM_ONLY_TYPES = new Set<string>(["work_item", "run_link", "analysis", "progress", "plan", "questions", "risk", "pull_request", "notice"]);

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
  /** "run": the conversation of one run; "general": a chat with the front-door agent. */
  kind: "general" | "run";
  /** The run a run conversation belongs to. */
  focusedRunId: string | null;
  updatedAt: string;
  pending: number;
}

export interface RunDto {
  id: string;
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

export interface ApprovalDto {
  id: string;
  runId: string;
  kind: "plan" | "questions" | "risk";
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

export const PlanDecision = z.object({
  decision: z.enum(["approve", "changes", "reject"]),
  feedback: z.string().max(4000).optional(),
  hash: z.string(),
});
export type PlanDecision = z.infer<typeof PlanDecision>;

export const RiskDecision = z.object({ decision: z.enum(["approve", "reject"]), hash: z.string() });
export type RiskDecision = z.infer<typeof RiskDecision>;

export const QuestionAnswer = z.object({ answer: z.string().min(1).max(8000) });
export type QuestionAnswer = z.infer<typeof QuestionAnswer>;

// Activities served by workspace-manager on the `workspaces` task queue.
export interface WorkspaceActivities {
  createWorkspace(input: { stepId: string; runId: string }): Promise<{ containerId: string }>;
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
}

/** Memo set on runs started by this version; older executions are retired at worker start. */
export const RUN_WORKFLOW_GENERATION = 2;

export const workflowIdForIssue = (repo: RepoRef, number: number) => `run:github:${repo.owner}/${repo.name}#${number}`;

// Signals delivered to the delivery-run workflow.
export interface ApprovalSignal {
  approvalId: string;
  decision: "approve" | "changes" | "reject";
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
