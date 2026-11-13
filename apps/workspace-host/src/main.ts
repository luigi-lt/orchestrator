/**
 * workspace-host: runs inside the sandbox for exactly one step.
 * Fetches the brief and one git bundle per repository from the sandbox gateway, drives a Copilot SDK
 * session with the agent profile, then reports progress and the step's validated result (an analysis,
 * an assessment, or a bundle of new commits for the one writable repository).
 * It holds no credentials other than its step-scoped workspace token.
 */
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  CopilotClient,
  defineTool,
  type CopilotSession,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionEvent,
  type ToolResultObject,
} from "@github/copilot-sdk";
import { GUIDANCE_FILES, analyst, architect, implementer, reviewer, type AgentProfile } from "@orch/agent-profiles";
import {
  Analysis,
  HandoffPlan,
  CriterionEvidence,
  ReviewReport,
  StepBrief,
  repoSlug,
  workItemType,
  type BriefRepository,
  type CommandResult,
  type DesignTurnInput,
  type DesignTurnResult,
  type ProgressEvent,
  type RepositoryRequestDto,
  type StepResult,
  type TrackedFinding,
  type Verification,
} from "@orch/contracts";
import { z } from "zod";

const GATEWAY = process.env.GATEWAY_URL ?? "http://sandbox-gateway:8090";
const TOKEN = process.env.WORKSPACE_TOKEN ?? "";
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "http://egress-proxy:8080/anthropic";
const ROOT = "/workspace";
const REPOS = join(ROOT, "repos");
const MAX_GUIDANCE_CHARS = 12_000;
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_COMMAND_OUTPUT = 6000;
/** How often the implementer is asked to repair a failing product command before the result is reported as it is. */
const MAX_VERIFICATION_REPAIRS = 2;

const auth = { Authorization: `Bearer ${TOKEN}` };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function gateway(path: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${GATEWAY}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
      if (res.status >= 500 && attempt < 5) throw new Error(`gateway ${res.status}`);
      return res;
    } catch (err) {
      if (attempt >= 5) throw err;
      await sleep(attempt * 1000);
    }
  }
}

const jsonInit = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function postJson(path: string, body: unknown): Promise<void> {
  const res = await gateway(path, jsonInit(body));
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]}: ${stderr.trim() || err.message}`));
      else resolve(stdout);
    });
  });
}

// Progress reporting -----------------------------------------------------------

const pending: ProgressEvent[] = [];
const report = (kind: ProgressEvent["kind"], text: string) => {
  pending.push({ kind, text: text.length > 3900 ? `${text.slice(0, 3900)}…` : text, at: new Date().toISOString() });
};
async function flush(): Promise<void> {
  if (!pending.length) return;
  const events = pending.splice(0, pending.length);
  await postJson("/v1/step/progress", { events }).catch((err) => console.error(`progress upload failed: ${err.message}`));
}

function describeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const pick = a.command ?? a.cmd ?? a.path ?? a.file_path ?? a.filePath ?? a.pattern ?? a.query ?? a.url ?? a.repository;
  return typeof pick === "string" ? pick.slice(0, 300) : "";
}

function onEvent(event: SessionEvent): void {
  switch (event.type) {
    case "assistant.message":
      if (event.data.content?.trim()) report("message", event.data.content.trim());
      break;
    case "tool.execution_start":
      report("tool_start", `${event.data.toolName} ${describeArgs(event.data.arguments)}`.trim());
      break;
    case "tool.execution_complete":
      report("tool_end", event.data.success ? "ok" : `failed${event.data.error ? `: ${JSON.stringify(event.data.error).slice(0, 300)}` : ""}`);
      break;
    case "session.error":
      report("error", event.data.message);
      break;
    default:
      break;
  }
}

// Product commands (FR-B1, FR-M4): from the catalog, never from the repository ------------------

/** Runs one of the product's commands in the repository and keeps the end of its output. */
function runCommand(name: CommandResult["name"], command: string, cwd: string): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile("bash", ["-lc", command], { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code as number) : 1) : 0;
      const timedOut = !!err && (err as { killed?: boolean }).killed === true;
      resolve({
        name,
        command,
        exitCode: code,
        durationMs: Date.now() - started,
        output: `${text.length > MAX_COMMAND_OUTPUT ? `…${text.slice(-MAX_COMMAND_OUTPUT)}` : text}${timedOut ? "\n(stopped: the command ran too long)" : ""}`,
      });
    });
  });
}

/** Build and test, in that order; stops at the first failure. No commands in the catalog means nothing to verify. */
async function verify(brief: StepBrief, cwd: string): Promise<Verification> {
  const commands: CommandResult[] = [];
  for (const name of ["build", "test"] as const) {
    const command = brief.commands[name];
    if (!command) continue;
    report("status", `Running the product's ${name} command: ${command}`);
    const result = await runCommand(name, command, cwd);
    commands.push(result);
    report(result.exitCode === 0 ? "status" : "error", `${name} ${result.exitCode === 0 ? "passed" : `failed (exit ${result.exitCode})`}`);
    if (result.exitCode !== 0) break;
  }
  return { commands, passed: commands.every((c) => c.exitCode === 0) };
}

const describeVerification = (v: Verification): string[] =>
  v.commands.length
    ? v.commands.map((c) => `- ${c.name} (\`${c.command}\`): ${c.exitCode === 0 ? "passed" : `FAILED with exit code ${c.exitCode}`}`)
    : ["- The product has no build or test command configured."];

// Repositories (AD-37): one checkout per repository, at most one writable ---------------

interface Checkout {
  entry: BriefRepository;
  dir: string;
  /** Guidance kept by the product team, read at the base commit (FR-M6). */
  guidance: { file: string; text: string }[];
}

const checkouts: Checkout[] = [];

async function checkout(entry: BriefRepository, author: { name: string; email: string }): Promise<Checkout> {
  const existing = checkouts.find((c) => c.entry.index === entry.index);
  if (existing) return existing;
  const bundle = join(ROOT, ".bundles", `repo-${entry.index}.bundle`);
  await mkdir(dirname(bundle), { recursive: true });
  const res = await gateway(`/v1/step/bundle/${entry.index}`);
  if (!res.ok || !res.body) throw new Error(`Could not download the bundle of ${repoSlug(entry.repo)}: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(bundle));
  const dir = join(ROOT, entry.path);
  await mkdir(dirname(dir), { recursive: true });
  await git(["clone", "--quiet", "--branch", entry.branch, bundle, dir], ROOT);
  await rm(bundle, { force: true });
  if (entry.mode === "writable") {
    await git(["config", "user.name", author.name], dir);
    await git(["config", "user.email", author.email], dir);
  }
  const guidance: Checkout["guidance"] = [];
  for (const file of GUIDANCE_FILES) {
    const text = await git(["show", `${entry.baseCommit ?? entry.commit}:${file}`], dir).catch(() => "");
    if (text.trim()) guidance.push({ file, text: text.length > MAX_GUIDANCE_CHARS ? `${text.slice(0, MAX_GUIDANCE_CHARS)}\n… (truncated)` : text });
  }
  const done: Checkout = { entry, dir, guidance };
  checkouts.push(done);
  return done;
}

// Prompts ------------------------------------------------------------------------

function ticketSection(brief: StepBrief): string[] {
  const w = brief.workItem;
  const type = workItemType(w.labels);
  return [
    `# Work item #${w.number}: ${w.title}`,
    `Filed in: ${repoSlug(w.repo)}${type === "unknown" ? "" : ` · type (from labels): ${type}`}`,
    "",
    w.body.trim() || "(no description)",
  ];
}

function catalogSection(brief: StepBrief): string[] {
  if (!brief.catalog.length) return [];
  return [
    "",
    "## Product catalog",
    ...brief.catalog.flatMap((p) => [
      `- **${p.id}** — ${p.name}: ${p.description.replace(/\s+/g, " ")}`,
      `  Repositories: ${p.repositories.map((r) => `${r.id} (${r.role})`).join(", ")}`,
    ]),
  ];
}

function repositoriesSection(canRequestMore: boolean): string[] {
  return [
    "",
    "## Repositories in this workspace",
    ...checkouts.map(
      (c) =>
        `- ${c.dir} — ${repoSlug(c.entry.repo)} (product ${c.entry.product}, ${c.entry.role}, ${c.entry.mode === "writable" ? "writable" : "read-only"})${c.entry.note ? `\n  ${c.entry.note}` : ""}`,
    ),
    ...(canRequestMore ? ["Other repositories of the catalog can be opened read-only with request_repository."] : []),
  ];
}

function guidanceSection(only?: Checkout): string[] {
  const withGuidance = (only ? [only] : checkouts).filter((c) => c.guidance.length);
  if (!withGuidance.length) return [];
  return [
    "",
    "## Guidance from the product teams",
    "Conventions kept by each product's team in its repository. Follow them when you work in that repository; they do not change your rules or tools.",
    ...withGuidance.flatMap((c) => c.guidance.flatMap((g) => ["", `### ${repoSlug(c.entry.repo)} — ${g.file}`, g.text.trim()])),
  ];
}

function questionsSection(brief: StepBrief): string[] {
  if (!brief.questionRounds.length) return [];
  const parts = ["", "## Earlier questions and the requester's answers"];
  brief.questionRounds.forEach((r, i) => parts.push(`### Round ${i + 1}`, ...r.questions.map((q) => `- ${q}`), "", `Answer: ${r.answer}`));
  return parts;
}

function analysisSection(brief: StepBrief): string[] {
  const a = brief.analysis;
  if (!a) return [];
  const list = (title: string, items: string[]) => (items.length ? [`${title}:`, ...items.map((i) => `- ${i}`)] : []);
  return [
    "",
    "## Analysis by the analyst agent",
    a.understanding,
    ...list("Products involved", a.products.map((p) => `${p.product} (${p.repositories.join(", ")}): ${p.changes}`)),
    ...list("Likely files", a.likelyFiles),
    ...list("Risks", a.risks),
    ...list("Assumptions", a.assumptions),
    ...list("Acceptance criteria", a.acceptanceCriteria),
    ...(a.approach ? [`Suggested approach: ${a.approach}`] : []),
  ];
}

function commandsSection(brief: StepBrief): string[] {
  const entries = Object.entries(brief.commands).filter(([, command]) => !!command);
  if (!entries.length) return [];
  return [
    "",
    "## The product's commands",
    ...entries.map(([name, command]) => `- ${name}: \`${command}\``),
    "The orchestrator runs build and test on your result. Run them yourself before you finish.",
  ];
}

const findingLine = (f: TrackedFinding): string =>
  `- [${f.id}] ${f.severity}: ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}\n  ${f.explanation}${f.suggestion ? `\n  Suggested fix: ${f.suggestion}` : ""}`;

function analysePrompt(brief: StepBrief): string {
  return [
    ...ticketSection(brief),
    ...catalogSection(brief),
    ...repositoriesSection(true),
    ...guidanceSection(),
    ...questionsSection(brief),
    "",
    "Analyse the work item against the code and call submit_analysis.",
  ].join("\n");
}

function subtaskSection(brief: StepBrief): string[] {
  const plan = brief.plan!;
  const index = brief.subtaskIndex ?? 0;
  const sub = plan.subtasks[index]!;
  return [
    "",
    "## Plan",
    plan.summary,
    ...plan.subtasks.map((s, i) => `${i + 1}. ${s.title}${i === index ? " (current)" : ""}`),
    "",
    `## The sub-task (${index + 1} of ${plan.subtasks.length}): ${sub.title}`,
    sub.description,
    "",
    "Acceptance criteria:",
    ...(sub.acceptanceCriteria.length ? sub.acceptanceCriteria.map((c) => `- ${c}`) : ["- (none given)"]),
  ];
}

function implementPrompt(brief: StepBrief): string {
  const fixing = brief.findings.length > 0;
  // The requester asked for changes at the check of the change: their words, with no findings of a reviewer.
  const changing = !fixing && brief.round > 0;
  return [
    ...ticketSection(brief),
    ...subtaskSection(brief),
    ...(fixing
      ? [
          "",
          "## Findings to fix",
          "A reviewer examined the change that is already on this branch and found these problems. Fix exactly these:",
          ...brief.findings.map(findingLine),
          ...(brief.guidance ? ["", "## Guidance from the requester", brief.guidance] : []),
        ]
      : []),
    ...(changing
      ? [
          "",
          "## Changes requested by the requester",
          "The requester looked at the change that is already on this branch and asks for this. Do exactly this, on top of that change:",
          brief.guidance?.trim() || "(no details given: re-check the change against the acceptance criteria)",
        ]
      : []),
    ...repositoriesSection(false),
    ...commandsSection(brief),
    ...guidanceSection(),
    "",
    fixing ? "Fix the findings now, then call submit_result." : changing ? "Make the requested changes now, then call submit_result." : "Implement this sub-task now, then call submit_result.",
  ].join("\n");
}

function reviewPrompt(brief: StepBrief, change: { base: string; files: string }): string {
  return [
    ...ticketSection(brief),
    ...subtaskSection(brief),
    "",
    "## The change to review",
    `It is the difference between the base commit ${change.base.slice(0, 12)} and HEAD of this checkout: \`git diff ${change.base}..HEAD\`.`,
    "Files changed:",
    change.files.trim() || "(none)",
    ...(brief.implementerSummary ? ["", "## What the implementer says it did (a claim, verify it)", brief.implementerSummary] : []),
    "",
    "## What the product's commands reported on this change",
    ...(brief.verification ? describeVerification(brief.verification) : ["- Not run."]),
    ...(brief.verification?.commands.filter((c) => c.exitCode !== 0).map((c) => `\nOutput of ${c.name}:\n${c.output}`) ?? []),
    ...(brief.findings.length
      ? ["", "## Earlier findings to check again", "For each id, say in `earlier` whether it is resolved now:", ...brief.findings.map(findingLine)]
      : []),
    ...repositoriesSection(false),
    ...guidanceSection(),
    "",
    "Review the change and call submit_review.",
  ].join("\n");
}

// Agent session ----------------------------------------------------------------------

interface AgentOutcome {
  analysis?: Analysis;
  review?: ReviewReport;
  summary?: string;
  evidence?: CriterionEvidence[];
  lastMessage?: string;
  verification?: Verification;
}

/** A failed tool call keeps the agent loop running, so the model can read the problem and retry. */
const failure = (message: string): ToolResultObject => ({ textResultForLlm: message, resultType: "failure", error: message });

/** request_repository: the analyst and the architect open another catalog repository read-only (AD-37). */
function repositoryTool(brief: StepBrief) {
  return defineTool("request_repository", {
      description:
        "Open another repository of the product catalog read-only in this workspace, to check whether that product is involved. Returns the directory of the checkout.",
      parameters: z.object({
        repository: z.string().describe("Repository as owner/name, exactly as listed in the product catalog"),
        reason: z.string().describe("Why you need to look at it"),
      }),
      skipPermission: true,
      handler: async ({ repository, reason }: { repository: string; reason: string }) => {
        const res = await gateway("/v1/step/repositories", jsonInit({ repository, reason }));
        if (!res.ok) return failure(`The request was refused: ${res.status} ${await res.text()}`);
        let request = (await res.json()) as RepositoryRequestDto;
        const deadline = Date.now() + 3 * 60 * 1000;
        while (request.state === "pending" && Date.now() < deadline) {
          await sleep(1000);
          const poll = await gateway(`/v1/step/repositories/${request.id}`);
          if (poll.ok) request = (await poll.json()) as RepositoryRequestDto;
        }
        if (request.state !== "ready" || !request.entry) return failure(request.error ?? `${repository} was not prepared in time`);
        const opened = await checkout(request.entry, brief.commitAuthor);
        report("status", `Opened ${repoSlug(opened.entry.repo)} read-only`);
        return {
          directory: opened.dir,
          product: opened.entry.product,
          role: opened.entry.role,
          guidance: opened.guidance.map((g) => ({ file: g.file, content: g.text })),
        };
      },
    });
}

function analystTools(brief: StepBrief, outcome: AgentOutcome) {
  return [
    repositoryTool(brief),
    defineTool("submit_analysis", {
      description: "Submit the analysis of the work item: either clarifying questions (ready=false) or the full analysis (ready=true).",
      parameters: Analysis,
      skipPermission: true,
      isTerminal: true,
      handler: async (args: Analysis) => {
        const parsed = Analysis.safeParse(args);
        if (!parsed.success) return failure(`Invalid analysis: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        // The gateway checks the analysis against the product catalog the run pinned.
        const res = await gateway("/v1/step/analysis/check", jsonInit(parsed.data));
        const check = res.ok ? ((await res.json()) as { problems: string[] }) : { problems: [`The analysis could not be checked (${res.status})`] };
        if (check.problems.length) return failure(`The analysis has problems: ${check.problems.join(" ")} Fix them and call submit_analysis again.`);
        outcome.analysis = parsed.data;
        return "Analysis recorded.";
      },
    }),
  ];
}

function implementerTools(outcome: AgentOutcome) {
  return [
    defineTool("submit_result", {
      description: "Report that the sub-task is finished: a short summary of the changes and how you verified them, and your evidence for each acceptance criterion.",
      parameters: z.object({
        summary: z.string().min(1).describe("What changed and how it was verified"),
        evidence: z.array(CriterionEvidence).max(20).optional().describe("One entry per acceptance criterion of the sub-task: what shows that it is met"),
      }),
      skipPermission: true,
      isTerminal: true,
      handler: async ({ summary, evidence }: { summary: string; evidence?: CriterionEvidence[] }) => {
        outcome.summary = summary;
        // Evidence is a claim shown to the reviewer's reader and the requester; a malformed list is dropped, not fatal.
        const parsed = z.array(CriterionEvidence).max(20).safeParse(evidence ?? []);
        outcome.evidence = parsed.success ? parsed.data : [];
        return "Result recorded.";
      },
    }),
  ];
}

function reviewerTools(brief: StepBrief, outcome: AgentOutcome) {
  return [
    defineTool("submit_review", {
      description: "Submit your review of the change: verdict, summary, each acceptance criterion, findings, and the state of earlier findings.",
      parameters: ReviewReport,
      skipPermission: true,
      isTerminal: true,
      handler: async (args: ReviewReport) => {
        const parsed = ReviewReport.safeParse(args);
        if (!parsed.success) return failure(`Invalid review: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        const known = new Set(brief.findings.map((f) => f.id));
        const unknown = parsed.data.earlier.filter((e) => !known.has(e.id)).map((e) => e.id);
        if (unknown.length) return failure(`Unknown earlier finding id(s): ${unknown.join(", ")}. Use the ids you were given: ${[...known].join(", ") || "none"}.`);
        const missing = [...known].filter((id) => !parsed.data.earlier.some((e) => e.id === id));
        if (missing.length) return failure(`Say for each earlier finding whether it is resolved. Missing: ${missing.join(", ")}.`);
        outcome.review = parsed.data;
        return "Review recorded.";
      },
    }),
  ];
}

interface AgentRun {
  prompt: string;
  /** Runs after the agent's turn, with the session still open; returns a follow-up prompt to continue, or null when done. */
  afterTurn?: (outcome: AgentOutcome) => Promise<string | null>;
}

async function runAgent(brief: StepBrief, profile: AgentProfile, cwd: string, run: AgentRun): Promise<AgentOutcome> {
  const outcome: AgentOutcome = {};
  const tools = brief.kind === "analyse" ? analystTools(brief, outcome) : brief.kind === "review" ? reviewerTools(brief, outcome) : implementerTools(outcome);

  const onPermissionRequest = (request: PermissionRequest): PermissionRequestResult => {
    const kind = request.kind as string;
    if ((profile.allow as string[]).includes(kind)) return { kind: "approve-once" };
    return { kind: "reject", feedback: `${kind} is not allowed for the ${profile.id} agent in this sandbox.` };
  };

  const client = new CopilotClient({
    useLoggedInUser: false,
    baseDirectory: join(ROOT, ".copilot"),
    workingDirectory: cwd,
    logLevel: "error",
  });
  await client.start();
  try {
    const session = await client.createSession({
      model: brief.model,
      provider: { type: "anthropic", baseUrl: ANTHROPIC_BASE_URL, apiKey: "injected-by-egress-proxy" },
      workingDirectory: cwd,
      systemMessage: { content: profile.instructions },
      // Guidance files are read by this host at the base commit and shown as content (FR-M6, R-20):
      // the runtime must not load them by itself from a checkout an agent can change.
      skipCustomInstructions: true,
      tools,
      onPermissionRequest,
    });
    session.on((event) => {
      onEvent(event);
      if (event.type === "assistant.message" && event.data.content?.trim()) outcome.lastMessage = event.data.content.trim();
    });
    const timeoutMs = brief.timeoutMinutes * 60 * 1000;
    await session.sendAndWait({ prompt: run.prompt }, timeoutMs);
    const missing = brief.kind === "analyse" ? (outcome.analysis ? null : "submit_analysis") : brief.kind === "review" ? (outcome.review ? null : "submit_review") : null;
    if (missing) {
      report("status", `Asking the agent to call ${missing}`);
      await session.sendAndWait({ prompt: `Call ${missing} now with your result.`, source: "system" }, 10 * 60 * 1000);
    }
    // The implementer keeps its session while the product's commands run, so it can repair what they report.
    for (let followUp = await run.afterTurn?.(outcome); followUp; followUp = await run.afterTurn?.(outcome)) {
      await session.sendAndWait({ prompt: followUp }, timeoutMs);
    }
    await session.disconnect();
  } finally {
    await client.stop().catch(() => undefined);
  }
  return outcome;
}

// Design session (FR-P1, AD-34): the architect keeps one Copilot session across many turns ----------

const COPILOT_DIR = join(ROOT, ".copilot");
const CHECKPOINT = join(ROOT, "checkpoint.tgz");
const TURN_TIMEOUT_MS = 15 * 60 * 1000;

function exec(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve()));
  });
}

/** What the architect produced in the turn it is working on. */
interface TurnDraft {
  texts: string[];
  components: unknown[];
  plan?: HandoffPlan;
  proposed: boolean;
}

function designContext(brief: StepBrief): string[] {
  return [...ticketSection(brief), ...analysisSection(brief), ...catalogSection(brief), ...repositoriesSection(true), ...guidanceSection()];
}

/** The prompt of a turn. A session that still has its memory gets only the requester's words. */
function turnPrompt(brief: StepBrief, turn: DesignTurnInput, start: "new" | "restored" | "rebuilt" | null): string {
  const design = brief.design!;
  const says = turn.messages.length ? ["The requester says:", ...turn.messages.map((m) => (turn.messages.length > 1 ? `- ${m}` : m))] : [];
  const currentPlan = design.latestPlan
    ? ["", `## The current plan (version ${design.latestVersion})`, "```json", JSON.stringify(design.latestPlan, null, 1), "```"]
    : [];
  if (start === "new" || (start === "rebuilt" && turn.opening && !design.latestPlan)) {
    return [...designContext(brief), "", "Open the design session now, as your instructions describe, and submit a first draft plan with submit_plan."].join("\n");
  }
  if (start === "rebuilt" && turn.opening) {
    // The run came back to the guided track after the requester had switched it to the fast track.
    return [
      ...designContext(brief),
      ...currentPlan,
      "",
      "The requester switched this work back to the guided track. Re-open the design session: say briefly where the plan stands and what you would change.",
      "Call submit_plan only when you change the plan.",
    ].join("\n");
  }
  if (start === "rebuilt") {
    // The saved session could not be restored: the record of the session stands in for its memory.
    // The messages of this turn are already in that record; they are given once, at the end.
    const record = [...design.history];
    for (const message of [...turn.messages].reverse()) {
      const last = record[record.length - 1];
      if (last?.role !== "requester" || last.text !== message.slice(0, last.text.length)) break;
      record.pop();
    }
    return [
      ...designContext(brief),
      "",
      "## The design session so far",
      ...(record.length
        ? ["You are continuing a design session. Your earlier working memory is gone; this is the record of it.", ...record.map((m) => `${m.role === "requester" ? "Requester" : "You (architect)"}: ${m.text}`)]
        : ["You are continuing a design session from its current plan. The requester started the session afresh: the conversation before this point is not available."]),
      ...currentPlan,
      "",
      ...says,
    ].join("\n");
  }
  return says.join("\n");
}

async function runDesignSession(brief: StepBrief): Promise<StepResult> {
  const design = brief.design!;
  let draft: TurnDraft = { texts: [], components: [], proposed: false };
  let planKnown = design.latestVersion !== undefined;

  const tools = [
    repositoryTool(brief),
    defineTool("submit_plan", {
      description:
        "Submit the complete hand-off plan (not a patch). It becomes a new draft version on the requester's plan card when your reply ends. Call it whenever the plan changes.",
      parameters: HandoffPlan,
      skipPermission: true,
      handler: async (args: HandoffPlan) => {
        const parsed = HandoffPlan.safeParse(args);
        if (!parsed.success) return failure(`Invalid plan: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        // The gateway checks the plan against the product catalog and the dependency rules (FR-P2).
        const res = await gateway("/v1/session/plan/check", jsonInit(parsed.data));
        const check = res.ok ? ((await res.json()) as { problems: string[] }) : { problems: [`The plan could not be checked (${res.status})`] };
        if (check.problems.length) return failure(`The plan has problems: ${check.problems.join(" ")} Fix them and call submit_plan again.`);
        draft.plan = parsed.data;
        planKnown = true;
        return "Plan accepted. It is shown to the requester as a new draft version when your reply ends. Say what you changed and why.";
      },
    }),
    defineTool("propose_plan", {
      description: "Put the current plan up for the requester's approval. Call it when the requester asks for it or agrees to it.",
      parameters: z.object({}),
      skipPermission: true,
      handler: async () => {
        if (!planKnown) return failure("There is no plan yet. Call submit_plan first.");
        draft.proposed = true;
        return "The plan is put up for approval when your reply ends. Tell the requester to use the Approve button on the plan card; you cannot approve it.";
      },
    }),
    defineTool("render", {
      description: "Show structured content in the conversation: a table, or a form with options for the requester to choose from.",
      parameters: z.object({ components: z.array(z.unknown()).min(1).max(5) }),
      skipPermission: true,
      handler: async ({ components }: { components: unknown[] }) => {
        draft.components.push(...components);
        return { rendered: components.length };
      },
    }),
  ];

  const onPermissionRequest = (request: PermissionRequest): PermissionRequestResult => {
    const kind = request.kind as string;
    if ((architect.allow as string[]).includes(kind)) return { kind: "approve-once" };
    return { kind: "reject", feedback: `${kind} is not allowed for the architect agent: it works read-only.` };
  };

  // A saved session is put back before the runtime starts, so the runtime finds it under its own directory.
  let restoredFiles = false;
  if (design.hasCheckpoint) {
    const res = await gateway("/v1/session/checkpoint");
    if (res.ok && res.body) {
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(CHECKPOINT));
      await exec("tar", ["-xzf", CHECKPOINT, "-C", ROOT]).then(
        () => (restoredFiles = true),
        (err: Error) => report("error", `The saved session could not be unpacked: ${err.message}`),
      );
      await rm(CHECKPOINT, { force: true });
    }
  }

  const config = {
    model: brief.model,
    provider: { type: "anthropic" as const, baseUrl: ANTHROPIC_BASE_URL, apiKey: "injected-by-egress-proxy" },
    workingDirectory: REPOS,
    systemMessage: { content: architect.instructions },
    skipCustomInstructions: true,
    streaming: true,
    // Long design sessions outgrow the context window; the runtime compacts them in the background (R-14).
    infiniteSessions: { enabled: true },
    tools,
    onPermissionRequest,
  };
  let client = new CopilotClient({ useLoggedInUser: false, baseDirectory: COPILOT_DIR, workingDirectory: REPOS, logLevel: "error" });
  await client.start();
  let session: CopilotSession | undefined;
  let start: "new" | "restored" | "rebuilt" = "new";
  if (restoredFiles) {
    try {
      session = await client.resumeSession(design.sessionId, config);
      start = "restored";
      report("status", "Session restored from its checkpoint");
    } catch (err) {
      // R-13 fallback: the session is rebuilt from the record (analysis, conversation, latest plan).
      report("error", `The saved session could not be restored (${(err as Error).message}); rebuilding it from the record`);
      await client.stop().catch(() => undefined);
      await rm(COPILOT_DIR, { recursive: true, force: true });
      client = new CopilotClient({ useLoggedInUser: false, baseDirectory: COPILOT_DIR, workingDirectory: REPOS, logLevel: "error" });
      await client.start();
    }
  }
  if (!session) {
    session = await client.createSession({ ...config, sessionId: design.sessionId });
    // With a plan or a conversation behind it, the session continues from the record (R-13), or from the plan alone
    // when the requester started it afresh (R-14).
    start = design.history.length || design.latestPlan ? "rebuilt" : "new";
    // Right after a fresh start the record holds only what the requester has just said: no reply of the architect yet.
    const afresh = design.history.every((m) => m.role === "requester");
    if (start === "rebuilt") report("status", afresh ? "Session started afresh from the current plan" : "Session rebuilt from the record of the conversation");
  }

  // Reply text goes to the conversation as it is written; the gateway passes it on without it entering any workflow.
  let pendingDelta = "";
  const flushDelta = async () => {
    if (!pendingDelta) return;
    const text = pendingDelta;
    pendingDelta = "";
    await postJson("/v1/session/delta", { text }).catch(() => undefined);
  };
  const deltaTimer = setInterval(() => void flushDelta(), 300);
  // A reply can be several messages with tool calls between them; shown as paragraphs, like the stored reply.
  let paragraphBreak = false;
  session.on((event) => {
    onEvent(event);
    if (event.type === "assistant.message_delta" && event.data.deltaContent) {
      pendingDelta += (paragraphBreak ? "\n\n" : "") + event.data.deltaContent;
      paragraphBreak = false;
    }
    if (event.type === "assistant.message" && event.data.content?.trim()) {
      draft.texts.push(event.data.content.trim());
      paragraphBreak = true;
    }
  });

  const saveCheckpoint = async () => {
    await session!.disconnect().catch(() => undefined);
    await client.stop().catch(() => undefined);
    if (!existsSync(COPILOT_DIR)) throw new Error("The runtime left no session state to save");
    await exec("tar", ["-czf", CHECKPOINT, "-C", ROOT, ".copilot"]);
    const upload = await gateway("/v1/session/checkpoint", {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "content-length": String(statSync(CHECKPOINT).size) },
      body: Readable.toWeb(createReadStream(CHECKPOINT)) as unknown as RequestInit["body"],
      duplex: "half",
    } as RequestInit);
    if (!upload.ok) throw new Error(`Uploading the checkpoint failed: ${upload.status}`);
  };

  try {
    let first = true;
    for (;;) {
      const res = await gateway("/v1/session/turn?wait=20");
      // The step was ended from outside (the session was closed or replaced): nothing more to do here.
      if (res.status === 401) return { status: "succeeded", summary: "Design session workspace released" };
      if (!res.ok) {
        await sleep(2000);
        continue;
      }
      const next = (await res.json()) as { turn?: DesignTurnInput; checkpoint?: boolean; close?: boolean };
      if (next.close) return { status: "succeeded", summary: "Design session closed" };
      if (next.checkpoint) {
        report("status", "Saving the session before the workspace is shut down");
        await saveCheckpoint();
        return { status: "succeeded", summary: "Design session saved; the workspace can be shut down" };
      }
      if (!next.turn) continue;

      const turn = next.turn;
      draft = { texts: [], components: [], proposed: false };
      paragraphBreak = false;
      report("status", turn.opening ? "Opening the design session" : `Turn: ${turn.messages.join(" / ").slice(0, 300)}`);
      let result: DesignTurnResult;
      try {
        await session.sendAndWait({ prompt: turnPrompt(brief, turn, first ? start : null) }, TURN_TIMEOUT_MS);
        result = {
          turnId: turn.turnId,
          status: "succeeded",
          text: draft.texts.join("\n\n"),
          components: draft.components,
          plan: draft.plan,
          proposed: draft.proposed,
          session: first ? start : "continued",
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report("error", message);
        result = { turnId: turn.turnId, status: "failed", text: "", components: [], proposed: false, session: first ? start : "continued", error: message.slice(0, 1000) };
      }
      first = false;
      await flushDelta();
      await flush();
      await postJson("/v1/session/turn-result", result);
    }
  } finally {
    clearInterval(deltaTimer);
  }
}

// Main ------------------------------------------------------------------------------------

async function main(): Promise<StepResult> {
  const res = await gateway("/v1/step");
  if (!res.ok) throw new Error(`Could not load the step brief: ${res.status}`);
  const brief = StepBrief.parse(await res.json());
  report("status", `Workspace started for ${brief.kind} step`);

  await mkdir(REPOS, { recursive: true });
  for (const entry of brief.repositories) await checkout(entry, brief.commitAuthor);
  const primary = checkouts.find((c) => c.entry.primary) ?? checkouts[0]!;
  report(
    "status",
    `Repositories ready: ${checkouts.map((c) => `${repoSlug(c.entry.repo)}@${c.entry.commit.slice(0, 10)}${c.entry.mode === "writable" ? " (writable)" : ""}`).join(", ")}`,
  );

  if (brief.kind === "analyse") {
    // The analyst may open several repositories, so it starts above them.
    const outcome = await runAgent(brief, analyst, REPOS, { prompt: analysePrompt(brief) });
    if (!outcome.analysis) return { status: "failed", summary: "The analyst did not submit an analysis", error: outcome.lastMessage?.slice(0, 500) };
    const a = outcome.analysis;
    const summary = a.ready
      ? `Analysis: ${a.products.length} product(s), size ${a.size}, proposes the ${a.proposedTrack} track`
      : `${a.questions.length} clarifying question(s)`;
    return { status: "succeeded", summary, analysis: a };
  }

  if (brief.kind === "design") return runDesignSession(brief);

  if (brief.kind === "review") {
    // The reviewer sees the sub-task's own change: the diff from the commit it started from (the approved change it
    // is stacked on, or the default branch), in a checkout it cannot hand back.
    const base = primary.entry.changeBase ?? primary.entry.baseCommit ?? primary.entry.commit;
    const files = await git(["diff", "--stat", `${base}..HEAD`], primary.dir).catch(() => "");
    const outcome = await runAgent(brief, reviewer, primary.dir, { prompt: reviewPrompt(brief, { base, files }) });
    if (!outcome.review) return { status: "failed", summary: "The reviewer did not submit a review", error: outcome.lastMessage?.slice(0, 500) };
    const r = outcome.review;
    const counts = (["blocking", "major", "minor"] as const).map((sev) => `${r.findings.filter((f) => f.severity === sev).length} ${sev}`).join(", ");
    return { status: "succeeded", summary: `Review: ${r.findings.length ? counts : "no findings"}`, review: r };
  }

  // Implementation: commit whatever the agent changed in the one writable repository and hand the commits back as a bundle.
  if (primary.entry.mode !== "writable") throw new Error("An implementation step needs a writable repository");
  const repo = primary.dir;
  const base = (await git(["rev-parse", "HEAD"], repo)).trim();
  if (brief.commands.setup) {
    report("status", `Running the product's setup command: ${brief.commands.setup}`);
    const setup = await runCommand("setup", brief.commands.setup, repo);
    if (setup.exitCode !== 0) report("error", `setup failed (exit ${setup.exitCode}): ${setup.output.slice(-800)}`);
  }
  let repairs = 0;
  const outcome = await runAgent(brief, implementer, repo, {
    prompt: implementPrompt(brief),
    // After each turn the product's own commands judge the result; a failure goes back to the same session.
    afterTurn: async (o) => {
      o.verification = await verify(brief, repo);
      if (o.verification.passed || repairs >= MAX_VERIFICATION_REPAIRS) return null;
      repairs++;
      const failed = o.verification.commands.find((c) => c.exitCode !== 0)!;
      report("status", `Asking the agent to repair the failing ${failed.name} command (attempt ${repairs} of ${MAX_VERIFICATION_REPAIRS})`);
      return [
        `The product's ${failed.name} command failed on your change.`,
        `Command: ${failed.command}`,
        `Exit code: ${failed.exitCode}`,
        "Output (end):",
        failed.output,
        "",
        "Fix the cause in your change, then call submit_result again.",
      ].join("\n");
    },
  });
  const sub = brief.plan!.subtasks[brief.subtaskIndex ?? 0]!;
  const summary = outcome.summary ?? outcome.lastMessage ?? "No summary provided";
  await git(["add", "-A"], repo);
  const dirty = (await git(["status", "--porcelain"], repo)).trim().length > 0;
  if (dirty) {
    const subject = brief.round > 0 ? `${brief.findings.length ? "Fix review findings" : "Changes requested"} (round ${brief.round}): ${sub.title}` : sub.title;
    const message = `${subject.slice(0, 200)}\n\n${summary}\n\nAgent-Run: ${brief.runId}\nRequested-By: ${brief.workItem.requester.login}`;
    await git(["commit", "--quiet", "--no-verify", "-m", message], repo);
  }
  const commits = Number.parseInt((await git(["rev-list", "--count", `${base}..HEAD`], repo)).trim(), 10) || 0;
  if (commits > 0) {
    const out = join(ROOT, "out.bundle");
    await git(["bundle", "create", out, `${base}..${brief.branch}`], repo);
    const size = statSync(out).size;
    const upload = await gateway("/v1/step/result-bundle", {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "content-length": String(size) },
      body: Readable.toWeb(createReadStream(out)) as unknown as RequestInit["body"],
      duplex: "half",
    } as RequestInit);
    if (!upload.ok) throw new Error(`Uploading the result bundle failed: ${upload.status}`);
  }
  return { status: "succeeded", summary: commits ? summary : `No changes were needed. ${summary}`, commits, verification: outcome.verification, evidence: outcome.evidence };
}

const heartbeat = setInterval(() => {
  void flush();
  void gateway("/v1/step/heartbeat", { method: "POST" }).catch(() => undefined);
}, 15_000);
const flusher = setInterval(() => void flush(), 1_500);

main()
  .catch((err: unknown): StepResult => {
    const message = err instanceof Error ? err.message : String(err);
    report("error", message);
    return { status: "failed", summary: "The workspace failed", error: message.slice(0, 2000) };
  })
  .then(async (result) => {
    clearInterval(heartbeat);
    clearInterval(flusher);
    report("status", `Step ${result.status}`);
    await flush();
    await postJson("/v1/step/result", result);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
