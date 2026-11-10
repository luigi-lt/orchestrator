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
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  CopilotClient,
  defineTool,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionEvent,
  type ToolResultObject,
} from "@github/copilot-sdk";
import { GUIDANCE_FILES, analyst, implementer, planner, type AgentProfile } from "@orch/agent-profiles";
import {
  Analysis,
  Assessment,
  StepBrief,
  repoSlug,
  workItemType,
  type BriefRepository,
  type ProgressEvent,
  type RepositoryRequestDto,
  type StepResult,
} from "@orch/contracts";
import { z } from "zod";

const GATEWAY = process.env.GATEWAY_URL ?? "http://sandbox-gateway:8090";
const TOKEN = process.env.WORKSPACE_TOKEN ?? "";
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "http://egress-proxy:8080/anthropic";
const ROOT = "/workspace";
const REPOS = join(ROOT, "repos");
const MAX_GUIDANCE_CHARS = 12_000;

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
        `- ${c.dir} — ${repoSlug(c.entry.repo)} (product ${c.entry.product}, ${c.entry.role}, ${c.entry.mode === "writable" ? "writable" : "read-only"})`,
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

function planPrompt(brief: StepBrief): string {
  const parts = [...ticketSection(brief), ...analysisSection(brief), ...repositoriesSection(false), ...guidanceSection(), ...questionsSection(brief)];
  if (brief.feedback) parts.push("", "## The requester asked for changes to the previous plan", brief.feedback);
  parts.push("", "Assess the issue against the repository and call submit_assessment.");
  return parts.join("\n");
}

function implementPrompt(brief: StepBrief): string {
  const plan = brief.plan!;
  const index = brief.subtaskIndex ?? 0;
  const sub = plan.subtasks[index]!;
  return [
    ...ticketSection(brief),
    "",
    "## Approved plan",
    plan.summary,
    ...plan.subtasks.map((s, i) => `${i + 1}. ${s.title}${i < index ? " (done)" : i === index ? " (current)" : ""}`),
    "",
    `## Your sub-task (${index + 1} of ${plan.subtasks.length}): ${sub.title}`,
    sub.description,
    "",
    "Acceptance criteria:",
    ...(sub.acceptanceCriteria.length ? sub.acceptanceCriteria.map((c) => `- ${c}`) : ["- (none given)"]),
    ...repositoriesSection(false),
    ...guidanceSection(),
    "",
    "Implement this sub-task now, then call submit_result.",
  ].join("\n");
}

// Agent session ----------------------------------------------------------------------

interface AgentOutcome {
  analysis?: Analysis;
  assessment?: Assessment;
  summary?: string;
  lastMessage?: string;
}

/** A failed tool call keeps the agent loop running, so the model can read the problem and retry. */
const failure = (message: string): ToolResultObject => ({ textResultForLlm: message, resultType: "failure", error: message });

function analystTools(brief: StepBrief, outcome: AgentOutcome) {
  return [
    defineTool("request_repository", {
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
    }),
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

function plannerTools(outcome: AgentOutcome) {
  return [
    defineTool("submit_assessment", {
      description: "Submit your assessment of the issue: either clarifying questions (ready=false) or the plan (ready=true).",
      parameters: Assessment,
      skipPermission: true,
      isTerminal: true,
      handler: async (args: Assessment) => {
        const parsed = Assessment.safeParse(args);
        if (!parsed.success) return failure(`Invalid assessment: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
        if (parsed.data.ready && !parsed.data.plan) return failure("When ready is true you must include the plan.");
        if (!parsed.data.ready && parsed.data.questions.length === 0) return failure("When ready is false you must ask at least one question.");
        outcome.assessment = parsed.data;
        return "Assessment recorded.";
      },
    }),
  ];
}

function implementerTools(outcome: AgentOutcome) {
  return [
    defineTool("submit_result", {
      description: "Report that the sub-task is finished, with a short summary of the changes and how you verified them.",
      parameters: z.object({ summary: z.string().min(1).describe("What changed and how it was verified") }),
      skipPermission: true,
      isTerminal: true,
      handler: async ({ summary }: { summary: string }) => {
        outcome.summary = summary;
        return "Result recorded.";
      },
    }),
  ];
}

async function runAgent(brief: StepBrief, profile: AgentProfile, cwd: string): Promise<AgentOutcome> {
  const outcome: AgentOutcome = {};
  const tools = brief.kind === "analyse" ? analystTools(brief, outcome) : brief.kind === "plan" ? plannerTools(outcome) : implementerTools(outcome);

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
    const prompt = brief.kind === "analyse" ? analysePrompt(brief) : brief.kind === "plan" ? planPrompt(brief) : implementPrompt(brief);
    await session.sendAndWait({ prompt }, timeoutMs);
    const missing = brief.kind === "analyse" ? (outcome.analysis ? null : "submit_analysis") : brief.kind === "plan" ? (outcome.assessment ? null : "submit_assessment") : null;
    if (missing) {
      report("status", `Asking the agent to call ${missing}`);
      await session.sendAndWait({ prompt: `Call ${missing} now with your result.`, source: "system" }, 10 * 60 * 1000);
    }
    await session.disconnect();
  } finally {
    await client.stop().catch(() => undefined);
  }
  return outcome;
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
    const outcome = await runAgent(brief, analyst, REPOS);
    if (!outcome.analysis) return { status: "failed", summary: "The analyst did not submit an analysis", error: outcome.lastMessage?.slice(0, 500) };
    const a = outcome.analysis;
    const summary = a.ready
      ? `Analysis: ${a.products.length} product(s), size ${a.size}, proposes the ${a.proposedTrack} track`
      : `${a.questions.length} clarifying question(s)`;
    return { status: "succeeded", summary, analysis: a };
  }

  if (brief.kind === "plan") {
    const outcome = await runAgent(brief, planner, primary.dir);
    if (!outcome.assessment) return { status: "failed", summary: "The planner did not submit an assessment", error: outcome.lastMessage?.slice(0, 500) };
    const a = outcome.assessment;
    const summary = a.ready ? `Plan with ${a.plan?.subtasks.length ?? 0} sub-tasks` : `${a.questions.length} clarifying question(s)`;
    return { status: "succeeded", summary, assessment: a };
  }

  // Implementation: commit whatever the agent changed in the one writable repository and hand the commits back as a bundle.
  if (primary.entry.mode !== "writable") throw new Error("An implementation step needs a writable repository");
  const repo = primary.dir;
  const base = (await git(["rev-parse", "HEAD"], repo)).trim();
  const outcome = await runAgent(brief, implementer, repo);
  const sub = brief.plan!.subtasks[brief.subtaskIndex ?? 0]!;
  const summary = outcome.summary ?? outcome.lastMessage ?? "No summary provided";
  await git(["add", "-A"], repo);
  const dirty = (await git(["status", "--porcelain"], repo)).trim().length > 0;
  if (dirty) {
    const message = `${sub.title}\n\n${summary}\n\nAgent-Run: ${brief.runId}\nRequested-By: ${brief.workItem.requester.login}`;
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
  return { status: "succeeded", summary: commits ? summary : `No changes were needed. ${summary}`, commits };
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
