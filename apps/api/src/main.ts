/**
 * api: control plane for the local MVP. Serves the web app, REST endpoints, one server-sent event
 * stream, and hosts the front-door agent. Single-user local mode: no sign-in, bound to localhost.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply } from "fastify";
import { z } from "zod";
import { config, errorMessage, log } from "@orch/common";
import { PlanDecision, QuestionAnswer, RiskDecision, type OrchestratorCard } from "@orch/contracts";
import { GitHubClient } from "@orch/github";
import {
  connectStore,
  createConversation,
  getApproval,
  getCard,
  getConversation,
  getPreference,
  getRun,
  getRunWorkflowId,
  listConversations,
  listMessages,
  listPendingApprovals,
  listProgress,
  listRunEvents,
  listRuns,
  listSteps,
  listen,
  resolveApproval,
  setPreference,
  upsertCard,
} from "@orch/store";
import { FrontDoor, newConversationTitle } from "./frontdoor.js";
import { StreamHub } from "./hub.js";
import { signalRun, startRunForIssue, temporal, UserError, type Services } from "./services.js";

const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ?? `localhost:${config.apiPort()},127.0.0.1:${config.apiPort()}`)
  .split(",")
  .map((h) => h.trim().toLowerCase());

async function main(): Promise<void> {
  const db = await connectStore();
  const github = new GitHubClient(config.githubToken(), config.githubApiUrl());
  const me = await github.getAuthenticatedUser();
  const hub = new StreamHub();
  const services: Services = { db, github, owner: me, hub, temporal };
  const frontDoor = new FrontDoor(services);
  listen((notice) => hub.broadcast(notice));

  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  // Local single-user mode: protect against DNS rebinding and cross-site requests.
  app.addHook("onRequest", async (req, reply) => {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!ALLOWED_HOSTS.includes(host)) return reply.code(403).send({ error: `Host ${host} not allowed` });
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-orch-client"] !== "web") {
      return reply.code(403).send({ error: "Missing X-Orch-Client header" });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof UserError) return reply.code(400).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "Invalid request", issues: err.issues.slice(0, 5) });
    log("api", `request failed: ${errorMessage(err)}`);
    return reply.code(500).send({ error: errorMessage(err) });
  });

  const notFound = (reply: FastifyReply, what: string) => reply.code(404).send({ error: `${what} not found` });

  // --- Session and preferences ------------------------------------------------
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/me", async () => ({
    login: me.login,
    name: me.name,
    roles: ["developer", "engineering-lead", "agent-developer", "platform-admin", "auditor"],
    repos: config.githubRepos(),
    triggerLabel: config.triggerLabel(),
    model: config.model(),
    landingView: (await getPreference<string>(db, "landingView")) ?? "user",
    lastConversationId: await getPreference<string>(db, "lastConversationId"),
  }));
  app.put("/api/preferences", async (req) => {
    const body = z
      .object({ landingView: z.enum(["user", "operator"]).optional(), lastConversationId: z.string().optional() })
      .parse(req.body);
    if (body.landingView) await setPreference(db, "landingView", body.landingView);
    if (body.lastConversationId) await setPreference(db, "lastConversationId", body.lastConversationId);
    return { ok: true };
  });

  // --- Stream --------------------------------------------------------------------
  app.get("/api/stream", (req, reply) => {
    reply.hijack();
    hub.add(reply.raw);
  });

  // --- Conversations (user view) -----------------------------------------------
  app.get("/api/conversations", async () => listConversations(db));
  app.post("/api/conversations", async (req) => {
    const body = z.object({ title: z.string().max(120).optional() }).parse(req.body ?? {});
    const id = await createConversation(db, body.title ?? newConversationTitle());
    return getConversation(db, id);
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/conversations/:id", async (req, reply) => {
    const conversation = await getConversation(db, req.params.id);
    if (!conversation) return notFound(reply, "Conversation");
    const messages = await listMessages(db, req.params.id, Number(req.query.after ?? 0) || 0);
    return { conversation, messages, busy: frontDoor.isBusy(req.params.id) };
  });
  app.post<{ Params: { id: string } }>("/api/conversations/:id/messages", async (req, reply) => {
    const { text } = z.object({ text: z.string().min(1).max(8000) }).parse(req.body);
    if (!(await getConversation(db, req.params.id))) return notFound(reply, "Conversation");
    if (frontDoor.isBusy(req.params.id)) throw new UserError("The assistant is still replying");
    void frontDoor.handle(req.params.id, text);
    return reply.code(202).send({ accepted: true });
  });
  app.post<{ Params: { id: string } }>("/api/conversations/:id/form", async (req, reply) => {
    const body = z.object({ title: z.string().optional(), values: z.record(z.string(), z.string()) }).parse(req.body);
    if (!(await getConversation(db, req.params.id))) return notFound(reply, "Conversation");
    if (frontDoor.isBusy(req.params.id)) throw new UserError("The assistant is still replying");
    void frontDoor.handle(req.params.id, frontDoor.formText(body.title, body.values));
    return reply.code(202).send({ accepted: true });
  });

  // --- Pending actions ---------------------------------------------------------
  app.get("/api/pending", async () => listPendingApprovals(db));

  // --- Decisions on orchestrator cards (never routed through the agent) ---------
  const loadPendingApproval = async (id: string, kind: "plan" | "questions" | "risk") => {
    const approval = await getApproval(db, id);
    if (!approval || approval.kind !== kind) throw new UserError("Unknown approval");
    if (approval.state !== "pending") throw new UserError("This decision was already made");
    const run = await getRun(db, approval.runId);
    const workflowId = await getRunWorkflowId(db, approval.runId);
    if (!run || !workflowId || !run.conversationId) throw new UserError("Run not found");
    return { approval, run, workflowId, conversationId: run.conversationId };
  };

  const updateCard = async (conversationId: string, cardKey: string, patch: Partial<OrchestratorCard>) => {
    const card = await getCard(db, cardKey);
    if (card) await upsertCard(db, conversationId, cardKey, { ...card, ...patch } as OrchestratorCard);
  };

  app.post<{ Params: { id: string } }>("/api/approvals/:id/plan", async (req) => {
    const body = PlanDecision.parse(req.body);
    const { approval, run, workflowId, conversationId } = await loadPendingApproval(req.params.id, "plan");
    if (body.hash !== approval.hash) throw new UserError("The plan changed since you looked at it; reload and decide again");
    if (body.decision === "changes" && !body.feedback?.trim()) throw new UserError("Describe the changes you want");
    await signalRun(services, workflowId, "approval", { approvalId: approval.id, decision: body.decision, feedback: body.feedback });
    await resolveApproval(db, approval.id, { decision: body.decision, feedback: body.feedback ?? null, by: me.login });
    const status = { approve: "approved", changes: "changes_requested", reject: "rejected" }[body.decision] as "approved";
    await updateCard(conversationId, `run:${run.id}:plan:${approval.id}`, { status, feedback: body.feedback } as Partial<OrchestratorCard>);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/approvals/:id/risk", async (req) => {
    const body = RiskDecision.parse(req.body);
    const { approval, run, workflowId, conversationId } = await loadPendingApproval(req.params.id, "risk");
    if (body.hash !== approval.hash) throw new UserError("The change set differs from the one you reviewed; reload and decide again");
    await signalRun(services, workflowId, "approval", { approvalId: approval.id, decision: body.decision });
    await resolveApproval(db, approval.id, { decision: body.decision, by: me.login });
    await updateCard(conversationId, `run:${run.id}:risk:${approval.id}`, { status: body.decision === "approve" ? "approved" : "rejected" } as Partial<OrchestratorCard>);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/approvals/:id/answer", async (req) => {
    const body = QuestionAnswer.parse(req.body);
    const { approval, run, workflowId, conversationId } = await loadPendingApproval(req.params.id, "questions");
    await signalRun(services, workflowId, "answer", { approvalId: approval.id, answer: body.answer, source: "chat" });
    await resolveApproval(db, approval.id, { answer: body.answer, source: "chat", by: me.login });
    await updateCard(conversationId, `run:${run.id}:questions:${approval.id}`, { status: "answered", answer: body.answer } as Partial<OrchestratorCard>);
    return { ok: true };
  });

  // --- Runs (operator view) --------------------------------------------------------
  app.get("/api/runs", async () => listRuns(db, 200));
  app.post("/api/runs", async (req) => {
    const body = z.object({ repo: z.string(), issueNumber: z.number().int().positive(), conversationId: z.string().optional() }).parse(req.body);
    return startRunForIssue(services, body.repo, body.issueNumber, body.conversationId ?? null);
  });
  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const run = await getRun(db, req.params.id);
    if (!run) return notFound(reply, "Run");
    const [steps, events, pending] = await Promise.all([listSteps(db, run.id), listRunEvents(db, run.id), listPendingApprovals(db)]);
    return { run, steps, events, pending: pending.filter((p) => p.runId === run.id) };
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (req) => {
    const { reason } = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});
    const workflowId = await getRunWorkflowId(db, req.params.id);
    if (!workflowId) throw new UserError("Run not found");
    await signalRun(services, workflowId, "cancel", { reason: reason ?? `Cancelled by ${me.login}` });
    return { ok: true };
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/steps/:id/progress", async (req) =>
    listProgress(db, req.params.id, Number(req.query.after ?? 0) || 0),
  );

  // --- Web app ---------------------------------------------------------------------
  const webDist = config.webDistDir() ?? resolve(process.cwd(), "apps/web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "not found" });
    });
  } else {
    log("api", `web app not found at ${webDist}; serving the API only`);
  }

  const shutdown = async () => {
    await frontDoor.stop();
    await app.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  await app.listen({ host: "0.0.0.0", port: config.apiPort() });
  log("api", `listening on ${config.apiPort()} as ${me.login}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
