/**
 * Front-door agent (CAP-10): one Copilot session per conversation on a shared runtime in `mode: "empty"`,
 * with orchestrator tools only. Conversation history lives in PostgreSQL; sessions are a cache.
 */
import { CopilotClient, defineTool, type CopilotSession } from "@github/copilot-sdk";
import { frontDoor } from "@orch/agent-profiles";
import { config, errorMessage, log, newId } from "@orch/common";
import { AgentComponent, FINAL_RUN_STATES, sanitizeAgentComponents } from "@orch/contracts";
import {
  findLatestCardByPrefix,
  getRun,
  insertMessage,
  listMessages,
  listRuns,
  listSteps,
  renameConversation,
  setFocusedRun,
} from "@orch/store";
import { z } from "zod";
import { allowedRepo, startRunForIssue, UserError, type Services } from "./services.js";

interface Turn {
  components: AgentComponent[];
}

export class FrontDoor {
  private client: CopilotClient | undefined;
  private starting: Promise<CopilotClient> | undefined;
  private sessions = new Map<string, CopilotSession>();
  private turns = new Map<string, Turn>();
  private busy = new Set<string>();

  constructor(private readonly s: Services) {}

  isBusy(conversationId: string): boolean {
    return this.busy.has(conversationId);
  }

  private async runtime(): Promise<CopilotClient> {
    if (this.client) return this.client;
    this.starting ??= (async () => {
      const client = new CopilotClient({
        mode: "empty",
        useLoggedInUser: false,
        baseDirectory: config.copilotHome(),
        logLevel: "error",
      });
      await client.start();
      this.client = client;
      return client;
    })();
    try {
      return await this.starting;
    } catch (err) {
      this.starting = undefined;
      throw err;
    }
  }

  private systemPrompt(): string {
    return [
      frontDoor.instructions.replace("{label}", config.triggerLabel()),
      "",
      "## Context",
      `- The person you talk to is the owner, GitHub user @${this.s.owner.login}.`,
      `- Configured repositories: ${config.githubRepos().join(", ") || "none"}.`,
      `- Today is ${new Date().toISOString().slice(0, 10)}.`,
    ].join("\n");
  }

  private tools(conversationId: string) {
    const s = this.s;
    const turn = () => this.turns.get(conversationId);
    const RepoArg = z.string().describe("Repository as owner/name");
    return [
      defineTool("submit_work_item", {
        description: "Start a delivery run for an existing GitHub issue.",
        parameters: z.object({ repo: RepoArg, issueNumber: z.number().int().positive() }),
        skipPermission: true,
        handler: async ({ repo, issueNumber }: { repo: string; issueNumber: number }) => {
          try {
            const r = await startRunForIssue(s, repo, issueNumber, conversationId);
            await setFocusedRun(s.db, conversationId, r.runId);
            return r.started
              ? { runId: r.runId, status: "started", note: "Progress, questions and the plan will appear as cards in this conversation." }
              : { runId: r.runId, status: "already running" };
          } catch (err) {
            return { error: errorMessage(err) };
          }
        },
      }),
      defineTool("create_work_item", {
        description: "Create a new GitHub issue from the person's description and start a delivery run for it.",
        parameters: z.object({
          repo: RepoArg,
          title: z.string().min(5).max(200),
          description: z.string().min(1).describe("Issue body in Markdown, including acceptance criteria when known"),
        }),
        skipPermission: true,
        handler: async ({ repo, title, description }: { repo: string; title: string; description: string }) => {
          try {
            const ref = allowedRepo(repo);
            const issue = await s.github.createIssue(ref, title, description);
            const r = await startRunForIssue(s, repo, issue.number, conversationId);
            await setFocusedRun(s.db, conversationId, r.runId);
            return { issue: issue.number, url: issue.url, runId: r.runId, status: "started" };
          } catch (err) {
            return { error: errorMessage(err) };
          }
        },
      }),
      defineTool("list_runs", {
        description: "List recent runs with their state.",
        parameters: z.object({ activeOnly: z.boolean().optional() }),
        skipPermission: true,
        handler: async ({ activeOnly }: { activeOnly?: boolean }) => {
          const runs = await listRuns(s.db, 30);
          return runs
            .filter((r) => !activeOnly || !FINAL_RUN_STATES.includes(r.state))
            .map((r) => ({ runId: r.id, issue: `${r.repo}#${r.issueNumber}`, title: r.title, state: r.state, pr: r.prUrl, updatedAt: r.updatedAt }));
        },
      }),
      defineTool("get_run_status", {
        description: "Get the detailed status of one run: state, plan, steps and pull request.",
        parameters: z.object({ runId: z.string() }),
        skipPermission: true,
        handler: async ({ runId }: { runId: string }) => {
          const run = await getRun(s.db, runId);
          if (!run) return { error: `No run ${runId}` };
          await setFocusedRun(s.db, conversationId, runId);
          const steps = await listSteps(s.db, runId);
          return {
            runId,
            issue: `${run.repo}#${run.issueNumber}`,
            title: run.title,
            state: run.state,
            error: run.error,
            plan: run.plan,
            pullRequest: run.prUrl,
            steps: steps.map((st) => ({ title: st.title, state: st.state, summary: st.summary })),
          };
        },
      }),
      defineTool("show_card", {
        description: "Show a run's card in this conversation: its plan, progress, pull request or work item.",
        parameters: z.object({ runId: z.string(), card: z.enum(["plan", "progress", "pull_request", "work_item"]) }),
        skipPermission: true,
        handler: async ({ runId, card }: { runId: string; card: "plan" | "progress" | "pull_request" | "work_item" }) => {
          const prefix = { plan: `run:${runId}:plan:`, progress: `run:${runId}:progress`, pull_request: `run:${runId}:pr`, work_item: `run:${runId}:work_item` }[card];
          const found = await findLatestCardByPrefix(s.db, prefix);
          if (!found) return { error: `Run ${runId} has no ${card} card yet` };
          await insertMessage(s.db, { conversationId, role: "orchestrator", components: [found] });
          await setFocusedRun(s.db, conversationId, runId);
          return { shown: true };
        },
      }),
      defineTool("render", {
        description: "Show structured content in the conversation: text, tables or a form for collecting details.",
        parameters: z.object({ components: z.array(AgentComponent).min(1).max(5) }),
        skipPermission: true,
        handler: async ({ components }: { components: unknown[] }) => {
          const safe = sanitizeAgentComponents(components);
          turn()?.components.push(...safe);
          return { rendered: safe.length };
        },
      }),
    ];
  }

  private async session(conversationId: string): Promise<{ session: CopilotSession; fresh: boolean }> {
    const existing = this.sessions.get(conversationId);
    if (existing) return { session: existing, fresh: false };
    const client = await this.runtime();
    const session = await client.createSession({
      model: config.model(),
      provider: { type: "anthropic", baseUrl: config.egressAnthropicUrl(), apiKey: "injected-by-egress-proxy" },
      systemMessage: { mode: "replace", content: this.systemPrompt() },
      tools: this.tools(conversationId),
      availableTools: ["custom:*"],
      streaming: true,
      onPermissionRequest: (req) => (req.kind === "custom-tool" ? { kind: "approve-once" } : { kind: "reject", feedback: "Not available" }),
    });
    session.on((event) => {
      if (event.type === "assistant.message_delta" && event.data.deltaContent) {
        this.s.hub.broadcast({ t: "delta", c: conversationId, tempId: conversationId, text: event.data.deltaContent });
      }
    });
    this.sessions.set(conversationId, session);
    return { session, fresh: true };
  }

  /** Handles one user turn; the reply is persisted as an agent message when the turn ends. */
  async handle(conversationId: string, text: string): Promise<void> {
    if (this.busy.has(conversationId)) throw new UserError("The assistant is still replying in this conversation");
    this.busy.add(conversationId);
    this.turns.set(conversationId, { components: [] });
    this.s.hub.broadcast({ t: "typing", c: conversationId, on: true });
    try {
      const history = await listMessages(this.s.db, conversationId);
      await insertMessage(this.s.db, { conversationId, role: "user", text });
      if (history.length === 0) await renameConversation(this.s.db, conversationId, text.slice(0, 60));
      const { session, fresh } = await this.session(conversationId);
      let prompt = text;
      if (fresh && history.length > 0) {
        const transcript = history
          .slice(-30)
          .map((m) => `${m.role}: ${m.text ?? m.components.map((c) => c.type).join(", ")}`)
          .join("\n");
        prompt = `Earlier in this conversation (for context):\n${transcript}\n\nNew message from the person:\n${text}`;
      }
      const final = await session.sendAndWait({ prompt }, 5 * 60 * 1000);
      const reply = final?.data.content?.trim() ?? "";
      const components = this.turns.get(conversationId)?.components ?? [];
      if (reply || components.length) await insertMessage(this.s.db, { conversationId, role: "agent", text: reply || null, components });
    } catch (err) {
      log("api", `front-door turn failed: ${errorMessage(err)}`);
      this.sessions.delete(conversationId);
      await insertMessage(this.s.db, {
        conversationId,
        role: "agent",
        text: `Sorry, I could not reply: ${errorMessage(err)}`,
      });
    } finally {
      this.turns.delete(conversationId);
      this.busy.delete(conversationId);
      this.s.hub.broadcast({ t: "typing", c: conversationId, on: false });
    }
  }

  /** A submitted form arrives as a structured user message. */
  formText(formTitle: string | undefined, values: Record<string, string>): string {
    const lines = Object.entries(values).map(([k, v]) => `- ${k}: ${v}`);
    return `Submitted form${formTitle ? ` "${formTitle}"` : ""}:\n${lines.join("\n")}`;
  }

  async stop(): Promise<void> {
    await this.client?.stop().catch(() => undefined);
  }
}

export const newConversationTitle = () => `Conversation ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
export const tempId = () => newId("tmp");
