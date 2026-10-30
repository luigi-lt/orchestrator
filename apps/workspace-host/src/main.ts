/**
 * workspace-host: runs inside the sandbox for exactly one step.
 * Fetches the brief and repository bundle from the sandbox gateway, drives a Copilot SDK session
 * with the agent profile, then reports progress, the result and (for implementation steps) a bundle
 * of the new commits. It holds no credentials other than its step-scoped workspace token.
 */
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CopilotClient, defineTool, type PermissionRequest, type PermissionRequestResult, type SessionEvent } from "@github/copilot-sdk";
import { implementer, planner, type AgentProfile } from "@orch/agent-profiles";
import { Assessment, StepBrief, type ProgressEvent, type StepResult } from "@orch/contracts";
import { z } from "zod";

const GATEWAY = process.env.GATEWAY_URL ?? "http://sandbox-gateway:8090";
const TOKEN = process.env.WORKSPACE_TOKEN ?? "";
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "http://egress-proxy:8080/anthropic";
const ROOT = "/workspace";
const REPO = join(ROOT, "repo");

const auth = { Authorization: `Bearer ${TOKEN}` };

async function gateway(path: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${GATEWAY}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
      if (res.status >= 500 && attempt < 5) throw new Error(`gateway ${res.status}`);
      return res;
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
}

async function postJson(path: string, body: unknown): Promise<void> {
  const res = await gateway(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
}

function git(args: string[], cwd = REPO): Promise<string> {
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
  const pick = a.command ?? a.cmd ?? a.path ?? a.file_path ?? a.filePath ?? a.pattern ?? a.query ?? a.url;
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

// Prompts ------------------------------------------------------------------------

function issueContext(brief: StepBrief): string {
  const w = brief.workItem;
  return [`# Issue #${w.number}: ${w.title}`, `Repository: ${w.repo.owner}/${w.repo.name}`, "", w.body.trim() || "(no description)"].join("\n");
}

function planPrompt(brief: StepBrief): string {
  const parts = [issueContext(brief)];
  if (brief.questionRounds.length) {
    parts.push("", "## Earlier questions and the requester's answers");
    brief.questionRounds.forEach((r, i) => parts.push(`### Round ${i + 1}`, ...r.questions.map((q) => `- ${q}`), "", `Answer: ${r.answer}`));
  }
  if (brief.feedback) parts.push("", "## The requester asked for changes to the previous plan", brief.feedback);
  parts.push("", "Assess the issue against the repository and call submit_assessment.");
  return parts.join("\n");
}

function implementPrompt(brief: StepBrief): string {
  const plan = brief.plan!;
  const index = brief.subtaskIndex ?? 0;
  const sub = plan.subtasks[index]!;
  return [
    issueContext(brief),
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
    "",
    "Implement this sub-task now, then call submit_result.",
  ].join("\n");
}

// Agent session ----------------------------------------------------------------------

interface AgentOutcome {
  assessment?: Assessment;
  summary?: string;
  lastMessage?: string;
}

async function runAgent(brief: StepBrief, profile: AgentProfile): Promise<AgentOutcome> {
  const outcome: AgentOutcome = {};
  const tools =
    brief.kind === "plan"
      ? [
          defineTool("submit_assessment", {
            description: "Submit your assessment of the issue: either clarifying questions (ready=false) or the plan (ready=true).",
            parameters: Assessment,
            skipPermission: true,
            isTerminal: true,
            handler: async (args: Assessment) => {
              const parsed = Assessment.safeParse(args);
              if (!parsed.success) return `Invalid assessment: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
              if (parsed.data.ready && !parsed.data.plan) return "When ready is true you must include the plan.";
              if (!parsed.data.ready && parsed.data.questions.length === 0) return "When ready is false you must ask at least one question.";
              outcome.assessment = parsed.data;
              return "Assessment recorded.";
            },
          }),
        ]
      : [
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

  const onPermissionRequest = (request: PermissionRequest): PermissionRequestResult => {
    const kind = request.kind as string;
    if ((profile.allow as string[]).includes(kind)) return { kind: "approve-once" };
    return { kind: "reject", feedback: `${kind} is not allowed for the ${profile.id} agent in this sandbox.` };
  };

  const client = new CopilotClient({
    useLoggedInUser: false,
    baseDirectory: join(ROOT, ".copilot"),
    workingDirectory: REPO,
    logLevel: "error",
  });
  await client.start();
  try {
    const session = await client.createSession({
      model: brief.model,
      provider: { type: "anthropic", baseUrl: ANTHROPIC_BASE_URL, apiKey: "injected-by-egress-proxy" },
      workingDirectory: REPO,
      systemMessage: { content: profile.instructions },
      tools,
      onPermissionRequest,
    });
    session.on((event) => {
      onEvent(event);
      if (event.type === "assistant.message" && event.data.content?.trim()) outcome.lastMessage = event.data.content.trim();
    });
    const timeoutMs = brief.timeoutMinutes * 60 * 1000;
    const prompt = brief.kind === "plan" ? planPrompt(brief) : implementPrompt(brief);
    await session.sendAndWait({ prompt }, timeoutMs);
    if (brief.kind === "plan" && !outcome.assessment) {
      report("status", "Asking the agent to submit its assessment");
      await session.sendAndWait({ prompt: "Call submit_assessment now with your assessment.", source: "system" }, 10 * 60 * 1000);
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

  await mkdir(ROOT, { recursive: true });
  const bundlePath = join(ROOT, "in.bundle");
  const bundleRes = await gateway("/v1/step/bundle");
  if (!bundleRes.ok || !bundleRes.body) throw new Error(`Could not download the repository bundle: ${bundleRes.status}`);
  await pipeline(Readable.fromWeb(bundleRes.body as import("node:stream/web").ReadableStream), createWriteStream(bundlePath));
  await git(["clone", "--quiet", "--branch", brief.branch, bundlePath, REPO], ROOT);
  await git(["config", "user.name", brief.commitAuthor.name]);
  await git(["config", "user.email", brief.commitAuthor.email]);
  const base = (await git(["rev-parse", "HEAD"])).trim();
  report("status", `Repository ready at ${base.slice(0, 10)} on ${brief.branch}`);

  const profile = brief.kind === "plan" ? planner : implementer;
  const outcome = await runAgent(brief, profile);

  if (brief.kind === "plan") {
    if (!outcome.assessment) return { status: "failed", summary: "The planner did not submit an assessment", error: outcome.lastMessage?.slice(0, 500) };
    const a = outcome.assessment;
    const summary = a.ready ? `Plan with ${a.plan?.subtasks.length ?? 0} sub-tasks` : `${a.questions.length} clarifying question(s)`;
    return { status: "succeeded", summary, assessment: a };
  }

  // Implementation: commit whatever the agent changed and hand the commits back as a bundle.
  const sub = brief.plan!.subtasks[brief.subtaskIndex ?? 0]!;
  const summary = outcome.summary ?? outcome.lastMessage ?? "No summary provided";
  await git(["add", "-A"]);
  const dirty = (await git(["status", "--porcelain"])).trim().length > 0;
  if (dirty) {
    const message = `${sub.title}\n\n${summary}\n\nAgent-Run: ${brief.runId}\nRequested-By: ${brief.workItem.requester.login}`;
    await git(["commit", "--quiet", "--no-verify", "-m", message]);
  }
  const commits = Number.parseInt((await git(["rev-list", "--count", `${base}..HEAD`])).trim(), 10) || 0;
  if (commits > 0) {
    const out = join(ROOT, "out.bundle");
    await git(["bundle", "create", out, `${base}..${brief.branch}`]);
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
