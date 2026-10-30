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
  requester: z.object({ login: z.string(), id: z.number().int().optional() }),
});
export type WorkItem = z.infer<typeof WorkItem>;

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

export const StepKind = z.enum(["plan", "implement"]);
export type StepKind = z.infer<typeof StepKind>;

export const StepState = z.enum(["pending", "running", "succeeded", "failed"]);
export type StepState = z.infer<typeof StepState>;

/** Everything a workspace needs to run one step. Written by the worker, read by the workspace host. */
export const StepBrief = z.object({
  stepId: z.string(),
  runId: z.string(),
  kind: StepKind,
  model: z.string(),
  branch: z.string(),
  workItem: WorkItem,
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
  assessment: Assessment.optional(),
  commits: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type StepResult = z.infer<typeof StepResult>;

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
export const NoticeCard = z.object({
  type: z.literal("notice"),
  runId: z.string().optional(),
  level: z.enum(["info", "success", "warning", "error"]),
  text: z.string(),
});
export const OrchestratorCard = z.discriminatedUnion("type", [
  WorkItemCard,
  ProgressCard,
  PlanCard,
  QuestionsCard,
  RiskCard,
  PullRequestCard,
  NoticeCard,
]);
export type OrchestratorCard = z.infer<typeof OrchestratorCard>;

export const SYSTEM_ONLY_TYPES = new Set<string>(["work_item", "progress", "plan", "questions", "risk", "pull_request", "notice"]);

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

export interface MessageDto {
  id: string;
  conversationId: string;
  role: MessageRole;
  text: string | null;
  components: Component[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDto {
  id: string;
  title: string;
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
  /** Set when the run was started from a conversation; otherwise a home conversation is created. */
  conversationId: string | null;
}

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
