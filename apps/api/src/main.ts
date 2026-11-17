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
import {
  BlockedDecision,
  ChangeDecision,
  ChangeTrackRequest,
  DependentsDecision,
  FindingsDecision,
  LimitsDecision,
  PlanDecision,
  QuestionAnswer,
  RiskDecision,
  FINAL_RUN_STATES,
  catalogRepositories,
  designWorkflowId,
  isFastTrackKey,
  type ApprovalKind,
  type Catalog,
  type OrchestratorCard,
  type TrackSwitchDto,
  type DesignStateDto,
  type RunPageDto,
  type SubtaskPageDto,
  type AgentAvailabilityDto,
  type ConversationDto,
  type RunDto,
} from "@orch/contracts";
import { GitHubClient } from "@orch/github";
import {
  connectStore,
  createConversation,
  getApproval,
  getConversation,
  getDesignSession,
  getLatestPlanVersion,
  getPreference,
  getRun,
  getRunWorkflowId,
  architectRepliedSince,
  hasOpenDesignTurn,
  insertMessage,
  listPlanVersions,
  listConversations,
  listMessages,
  listPendingApprovals,
  listProgress,
  listRunEvents,
  listRuns,
  listSteps,
  listSubtasks,
  listTickets,
  listen,
  resolveApproval,
  setPreference,
  listPageCards,
  patchCard,
  getSubtask,
  hasMessages,
  wasApproved,
} from "@orch/store";
import { FrontDoor, newConversationTitle } from "./frontdoor.js";
import { StreamHub } from "./hub.js";
import { catalog, signalRun, startRunForIssue, temporal, UserError, type Services } from "./services.js";

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

  // Agents read untrusted code and tickets, and their text is shown in this app. The policy below keeps a
  // browser from loading or sending anything outside this origin, whatever that text contains (architecture §7.5, §13).
  const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  app.addHook("onSend", async (_req, reply) => {
    reply.header("content-security-policy", CONTENT_SECURITY_POLICY);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
  });

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
  // The catalog on disk, or the reason it cannot be used (shown in the app instead of failing every page).
  const catalogOrError = (): { catalog: Catalog | null; error: string | null } => {
    try {
      return { catalog: catalog(), error: null };
    } catch (err) {
      return { catalog: null, error: errorMessage(err) };
    }
  };
  app.get("/api/products", async () => {
    const c = catalogOrError();
    return { hash: c.catalog?.hash ?? null, products: c.catalog?.products ?? [], error: c.error };
  });
  app.get("/api/me", async () => ({
    login: me.login,
    name: me.name,
    roles: ["developer", "engineering-lead", "agent-developer", "platform-admin", "auditor"],
    repos: (() => {
      const c = catalogOrError().catalog;
      return c ? catalogRepositories(c).map((r) => r.id) : [];
    })(),
    catalogError: catalogOrError().error,
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
  /**
   * Whether the requester can talk with the architect of a run, and why not (FR-C4): its conversation takes
   * messages while the design session is open, and stays readable after it.
   */
  const architectOf = async (run: RunDto): Promise<AgentAvailabilityDto> => {
    const base = { agent: "architect" as const, name: "Architect agent" };
    const session = await getDesignSession(db, run.id);
    if (session && session.state !== "closed") return { ...base, state: "available", why: null, conversationId: run.conversationId };
    const spoke = !!run.conversationId && (await hasMessages(db, run.conversationId));
    if (spoke) {
      // The requester's approval counts at once: the session closes a moment before the version is marked approved.
      const approved = (await wasApproved(db, run.id, "plan")) || (await listPlanVersions(db, run.id)).some((v) => v.status === "approved");
      const why = approved
        ? "The plan is approved: this conversation is kept for reference and takes no new messages."
        : FINAL_RUN_STATES.includes(run.state)
          ? "The run has ended: this conversation is kept for reference."
          : run.track === "fast"
            ? "The run moved to the fast track: the design session ended."
            : "The design session is closed.";
      return { ...base, state: "read_only", why, conversationId: run.conversationId };
    }
    if (run.track === "fast") return { ...base, state: "not_available", why: "On the fast track no agent talks with you: the change is built and reviewed by agents.", conversationId: null };
    if (FINAL_RUN_STATES.includes(run.state)) return { ...base, state: "not_available", why: "The run ended before a design session.", conversationId: null };
    if (!run.track) return { ...base, state: "not_yet", why: "The analysis decides the track first. On the guided track the architect opens a design session here.", conversationId: null };
    return { ...base, state: "not_yet", why: "The design session is starting.", conversationId: null };
  };
  const ASSISTANT: AgentAvailabilityDto = {
    agent: "assistant",
    name: "Assistant",
    state: "elsewhere",
    why: "The assistant is in your chats, for all your runs: ask it there about this one.",
    conversationId: null,
  };
  const IMPLEMENTER: AgentAvailabilityDto = {
    agent: "implementer",
    name: "Implementer agent",
    state: "not_yet",
    why: "Talking with the implementer of a sub-task comes later. What it did is on this page.",
    conversationId: null,
  };

  /**
   * Who answers in a conversation is decided by the conversation (AD-38), never by a model: in a run's, the
   * architect while its design session is open; in a chat, the assistant. A sub-task's has no agent yet.
   */
  type Route = { to: "architect"; runId: string } | { to: "front-door" } | { to: null; why: string };
  const routeOf = async (conversation: ConversationDto): Promise<Route> => {
    if (conversation.agent === "assistant") return { to: "front-door" };
    const run = conversation.agent === "architect" && conversation.focusedRunId ? await getRun(db, conversation.focusedRunId) : null;
    if (run) {
      const architect = await architectOf(run);
      return architect.state === "available" ? { to: "architect", runId: run.id } : { to: null, why: architect.why ?? "The architect is not available." };
    }
    return { to: null, why: IMPLEMENTER.why! };
  };
  /** Sends a message to the agent of the conversation, or refuses it with the reason. */
  const deliver = async (conversation: ConversationDto, text: string) => {
    const route = await routeOf(conversation);
    if (route.to === null) throw new UserError(route.why);
    if (route.to === "architect") {
      await toArchitect(conversation.id, route.runId, text);
      return "architect" as const;
    }
    if (frontDoor.isBusy(conversation.id)) throw new UserError("The assistant is still replying");
    void frontDoor.handle(conversation.id, text);
    return "front-door" as const;
  };

  /**
   * Whether the requester can switch the track of a run now (FR-A3): fast → guided until the change is published,
   * guided → fast until a plan is approved and only when the work stays in one repository. The workflow checks again.
   */
  const trackSwitchOf = async (runId: string): Promise<TrackSwitchDto | null> => {
    const run = await getRun(db, runId);
    if (!run?.track) return null;
    if (FINAL_RUN_STATES.includes(run.state)) return { current: run.track, to: null, why: "The run has ended." };
    if (run.track === "fast") {
      const change = (await listSubtasks(db, runId)).filter((st) => isFastTrackKey(st.key)).pop();
      const published = !!change && (change.prNumber !== null || ["pr_open", "merged", "closed", "handed_over"].includes(change.state));
      return published ? { current: "fast", to: null, why: "The pull request is open: the track can no longer be switched." } : { current: "fast", to: "guided", why: null };
    }
    const plans = await listPlanVersions(db, runId);
    if (plans.some((v) => v.status === "approved")) return { current: "guided", to: null, why: "The plan is approved: the work stays on the guided track." };
    if (run.state !== "designing" && run.state !== "awaiting_approval") return { current: "guided", to: null, why: null };
    const latest = plans[plans.length - 1];
    const repositories = new Set(
      (latest ? latest.plan.subtasks.map((st) => st.repository) : (run.analysis?.products ?? []).flatMap((p) => p.repositories)).map((r) => r.toLowerCase()),
    );
    if (repositories.size !== 1) {
      return {
        current: "guided",
        to: null,
        why: `The fast track needs the work to stay in one repository; ${latest ? "the current plan" : "the analysis"} involves ${repositories.size}.`,
      };
    }
    return { current: "guided", to: "fast", why: null };
  };

  const toArchitect = async (conversationId: string, runId: string, text: string) => {
    const message = await insertMessage(db, { conversationId, role: "user", text });
    const client = await temporal();
    await client.workflow.getHandle(designWorkflowId(runId)).signal("requesterMessage", { messageId: message.id, text });
    // Shown at once, also while a saved session is still being restored; the end of the turn clears it.
    hub.broadcast({ t: "typing", c: conversationId, on: true });
  };

  /** The run's design session while it is open: the requester is talking to the architect, and whether its workspace is up. */
  const designStateOf = async (runId: string, conversationId: string | null): Promise<DesignStateDto | null> => {
    const session = await getDesignSession(db, runId);
    if (!session || session.state === "closed") return null;
    return {
      runId,
      state: session.state,
      turnRunning: await hasOpenDesignTurn(db, runId),
      // Started afresh from the current plan, and the architect has not answered since (R-14).
      fresh: !!session.historySince && !!conversationId && !(await architectRepliedSince(db, conversationId, session.historySince)),
      hasPlan: !!(await getLatestPlanVersion(db, runId)),
    };
  };

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/conversations/:id", async (req, reply) => {
    const conversation = await getConversation(db, req.params.id);
    if (!conversation) return notFound(reply, "Conversation");
    const messages = await listMessages(db, req.params.id, Number(req.query.after ?? 0) || 0);
    const design = conversation.agent === "architect" && conversation.focusedRunId ? await designStateOf(conversation.focusedRunId, conversation.id) : null;
    const route = await routeOf(conversation);
    return {
      conversation,
      messages,
      busy: frontDoor.isBusy(req.params.id) || !!design?.turnRunning,
      design,
      // Whether a message here reaches an agent now, and if not, why (AD-38).
      canSend: route.to !== null,
      why: route.to === null ? route.why : null,
    };
  });
  app.post<{ Params: { id: string } }>("/api/conversations/:id/messages", async (req, reply) => {
    const { text } = z.object({ text: z.string().min(1).max(8000) }).parse(req.body);
    const conversation = await getConversation(db, req.params.id);
    if (!conversation) return notFound(reply, "Conversation");
    return reply.code(202).send({ accepted: true, to: await deliver(conversation, text) });
  });
  app.post<{ Params: { id: string } }>("/api/conversations/:id/form", async (req, reply) => {
    const body = z.object({ title: z.string().optional(), values: z.record(z.string(), z.string()) }).parse(req.body);
    const conversation = await getConversation(db, req.params.id);
    if (!conversation) return notFound(reply, "Conversation");
    // A choice made in a form an agent showed goes back to that agent, as a message.
    return reply.code(202).send({ accepted: true, to: await deliver(conversation, frontDoor.formText(body.title, body.values)) });
  });

  // --- Pending actions ---------------------------------------------------------
  app.get("/api/pending", async () => listPendingApprovals(db));

  // --- Decisions on orchestrator cards (never routed through the agent) ---------
  // A decision goes to the workflow that asked for it (the run's, or one of its sub-tasks'),
  // and its card lives on the page of that run or sub-task.
  const loadPendingApproval = async (id: string, kind: ApprovalKind) => {
    const approval = await getApproval(db, id);
    if (!approval || approval.kind !== kind) throw new UserError("Unknown approval");
    if (approval.state !== "pending") throw new UserError("This decision was already made");
    const run = await getRun(db, approval.runId);
    const workflowId = approval.workflowId ?? (await getRunWorkflowId(db, approval.runId));
    if (!run || !workflowId) throw new UserError("Run not found");
    return { approval, run, workflowId };
  };

  // The decision shows on its card at once, on the page that holds it; the workflow goes on from the signal.
  const updateCard = async (cardKey: string, patch: Partial<OrchestratorCard>) => {
    await patchCard(db, cardKey, patch as Record<string, unknown>);
  };

  // Approval of one plan version: a button on the plan card, bound to the version's hash (FR-P4).
  // Changes to a plan are asked for in the conversation with the architect; there is no way to edit one here.
  app.post<{ Params: { id: string } }>("/api/approvals/:id/plan", async (req) => {
    const body = PlanDecision.parse(req.body);
    const { approval, run, workflowId } = await loadPendingApproval(req.params.id, "plan");
    if (body.hash !== approval.hash) throw new UserError("The plan changed since you looked at it; reload and decide on the version shown now");
    await signalRun(services, workflowId, "approval", { approvalId: approval.id, decision: "approve" });
    await resolveApproval(db, approval.id, { decision: "approve", by: me.login });
    await updateCard(`run:${run.id}:plan`, { status: "approved" } as Partial<OrchestratorCard>);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/approvals/:id/risk", async (req) => {
    const body = RiskDecision.parse(req.body);
    const { approval, run, workflowId } = await loadPendingApproval(req.params.id, "risk");
    if (body.hash !== approval.hash) throw new UserError("The change set differs from the one you reviewed; reload and decide again");
    await signalRun(services, workflowId, "approval", { approvalId: approval.id, decision: body.decision });
    await resolveApproval(db, approval.id, { decision: body.decision, by: me.login });
    await updateCard(`run:${run.id}:risk:${approval.id}`, { status: body.decision === "approve" ? "approved" : "rejected" } as Partial<OrchestratorCard>);
    return { ok: true };
  });

  // Findings still blocking after the fix rounds: open anyway, guide and retry, take over the branch, or cancel (FR-R2).
  app.post<{ Params: { id: string } }>("/api/approvals/:id/findings", async (req) => {
    const body = FindingsDecision.parse(req.body);
    const { approval, run, workflowId } = await loadPendingApproval(req.params.id, "findings");
    if (body.hash !== approval.hash) throw new UserError("The findings changed since you looked at them; reload and decide again");
    if (body.decision === "retry" && !body.guidance?.trim()) throw new UserError("Say what the agent should do differently");
    await signalRun(services, workflowId, "approval", { approvalId: approval.id, decision: body.decision, feedback: body.guidance });
    await resolveApproval(db, approval.id, { decision: body.decision, guidance: body.guidance ?? null, by: me.login });
    await updateCard(`run:${run.id}:findings:${approval.id}`, { status: body.decision, guidance: body.guidance } as Partial<OrchestratorCard>);
    return { ok: true };
  });

  // A fast-track change beyond the fast-track limits: continue, switch to the guided track, or cancel (FR-A2).
  app.post<{ Params: { id: string } }>("/api/approvals/:id/limits", async (req) => {
    const body = LimitsDecision.parse(req.body);
    const { approval, run, workflowId } = await loadPendingApproval(req.params.id, "limits");
    if (body.hash !== approval.hash) throw new UserError("The change differs from the one you looked at; reload and decide again");
    await signalRun(services, workflowId, "approval", { approvalId: approval.id, decision: body.decision });
    await resolveApproval(db, approval.id, { decision: body.decision, by: me.login });
    await updateCard(`run:${run.id}:limits:${approval.id}`, { status: body.decision } as Partial<OrchestratorCard>);
    return { ok: true };
  });

  // The requester's check of a sub-task's change before its pull request opens (FR-R4). The decision is bound
  // to the commit on the card: exactly that commit is published (AD-40).
  app.post<{ Params: { id: string } }>("/api/approvals/:id/change", async (req) => {
    const body = ChangeDecision.parse(req.body);
    const { approval, run, workflowId } = await loadPendingApproval(req.params.id, "change");
    if (body.hash !== approval.hash) throw new UserError("The change differs from the one you looked at; reload and decide on the commit shown now");
    if (body.decision === "changes" && !body.feedback?.trim()) throw new UserError("Say what should change");
    const feedback = body.decision === "changes" ? body.feedback : undefined;
    await signalRun(services, workflowId, "approval", { approvalId: approval.id, decision: body.decision, feedback });
    await resolveApproval(db, approval.id, { decision: body.decision, feedback: feedback ?? null, by: me.login });
    const status = body.decision === "approve" ? "approved" : body.decision === "drop" ? "dropped" : "changes";
    await updateCard(`run:${run.id}:change:${approval.id}`, { status, feedback } as Partial<OrchestratorCard>);
    return { ok: true };
  });

  // Sub-tasks that depend on one that was not delivered: drop them too, build them anyway, or cancel the run (FR-R4).
  app.post<{ Params: { id: string } }>("/api/approvals/:id/dependents", async (req) => {
    const body = DependentsDecision.parse(req.body);
    const { approval, run, workflowId } = await loadPendingApproval(req.params.id, "dependents");
    if (body.hash !== approval.hash) throw new UserError("The sub-tasks changed since you looked; reload and decide again");
    await signalRun(services, workflowId, "approval", { approvalId: approval.id, decision: body.decision });
    await resolveApproval(db, approval.id, { decision: body.decision, by: me.login });
    await updateCard(`run:${run.id}:dependents:${approval.id}`, { status: body.decision } as Partial<OrchestratorCard>);
    return { ok: true };
  });

  // A sub-task blocked by missing access: retry once the access is fixed, or cancel (AD-42).
  app.post<{ Params: { id: string } }>("/api/approvals/:id/blocked", async (req) => {
    const body = BlockedDecision.parse(req.body);
    const { approval, run, workflowId } = await loadPendingApproval(req.params.id, "blocked");
    if (body.hash !== approval.hash) throw new UserError("This card is out of date; reload and decide again");
    await signalRun(services, workflowId, "approval", { approvalId: approval.id, decision: body.decision });
    await resolveApproval(db, approval.id, { decision: body.decision, by: me.login });
    await updateCard(`run:${run.id}:blocked:${approval.id}`, { status: body.decision } as Partial<OrchestratorCard>);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/approvals/:id/answer", async (req) => {
    const body = QuestionAnswer.parse(req.body);
    const { approval, run, workflowId } = await loadPendingApproval(req.params.id, "questions");
    await signalRun(services, workflowId, "answer", { approvalId: approval.id, answer: body.answer, source: "chat" });
    await resolveApproval(db, approval.id, { answer: body.answer, source: "chat", by: me.login });
    await updateCard(`run:${run.id}:questions:${approval.id}`, { status: "answered", answer: body.answer } as Partial<OrchestratorCard>);
    return { ok: true };
  });

  // --- Runs (operator view) --------------------------------------------------------
  app.get("/api/runs", async () => listRuns(db, 200));
  // Tickets with their runs: the hierarchy both views show (ticket, run, later sub-task).
  app.get("/api/tickets", async () => listTickets(db));
  app.post("/api/runs", async (req) => {
    const body = z.object({ repo: z.string(), issueNumber: z.number().int().positive(), conversationId: z.string().optional() }).parse(req.body);
    return startRunForIssue(services, body.repo, body.issueNumber, body.conversationId ?? null);
  });
  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const run = await getRun(db, req.params.id);
    if (!run) return notFound(reply, "Run");
    const [steps, events, pending, tickets, subtasks, plans, session] = await Promise.all([
      listSteps(db, run.id),
      listRunEvents(db, run.id),
      listPendingApprovals(db),
      listTickets(db, 1, run.ticketKey),
      listSubtasks(db, run.id),
      listPlanVersions(db, run.id),
      getDesignSession(db, run.id),
    ]);
    return {
      run,
      steps,
      events,
      pending: pending.filter((p) => p.runId === run.id),
      ticket: tickets[0] ?? null,
      subtasks,
      plans,
      design: session ? { state: session.state, repositories: session.repositories.map((r) => `${r.repo.owner}/${r.repo.name}`) } : null,
    };
  });
  // The requester switches the track (FR-A3). The run passes it on to the work going on, which decides whether it still can.
  app.post<{ Params: { id: string } }>("/api/runs/:id/track", async (req, reply) => {
    const body = ChangeTrackRequest.parse(req.body);
    const now = await trackSwitchOf(req.params.id);
    if (!now) throw new UserError("The run has no track yet: the analysis decides it first");
    if (now.current === body.track) throw new UserError(`The run is already on the ${body.track} track`);
    if (now.to !== body.track) throw new UserError(now.why ?? "The track cannot be switched now");
    const workflowId = await getRunWorkflowId(db, req.params.id);
    if (!workflowId) throw new UserError("Run not found");
    await signalRun(services, workflowId, "changeTrack", { track: body.track, by: me.login, reason: body.reason?.trim() || undefined });
    return reply.code(202).send({ accepted: true });
  });

  // Starts the design session again from the current plan, without the conversation before it (R-14).
  app.post<{ Params: { id: string } }>("/api/runs/:id/fresh-session", async (req, reply) => {
    const session = await getDesignSession(db, req.params.id);
    if (!session || session.state === "closed") throw new UserError("There is no open design session");
    if (!(await getLatestPlanVersion(db, req.params.id))) throw new UserError("The architect has not written a plan yet");
    if (await hasOpenDesignTurn(db, req.params.id)) throw new UserError("The architect is still replying; try again when it has finished");
    await signalRun(services, designWorkflowId(req.params.id), "freshSession", { by: me.login });
    return reply.code(202).send({ accepted: true });
  });

  // --- Pages (user view, AD-44): what the orchestrator records and asks, by run and by sub-task -----------
  app.get<{ Params: { id: string } }>("/api/runs/:id/page", async (req, reply): Promise<RunPageDto | undefined> => {
    const run = await getRun(db, req.params.id);
    if (!run) return notFound(reply, "Run");
    const [cards, needsYou, tickets, track, design, architect] = await Promise.all([
      listPageCards(db, run.id, null),
      listPendingApprovals(db, run.id),
      listTickets(db, 1, run.ticketKey),
      trackSwitchOf(run.id),
      designStateOf(run.id, run.conversationId),
      architectOf(run),
    ]);
    const ticketRun = tickets[0]?.runs.find((r) => r.runId === run.id);
    return {
      run,
      ordinal: ticketRun?.ordinal ?? 1,
      runsOfTicket: tickets[0]?.runs.length ?? 1,
      cards,
      needsYou,
      subtasks: ticketRun?.subtasks ?? [],
      track,
      design,
      agents: [architect, ASSISTANT],
    };
  });
  app.get<{ Params: { id: string; key: string } }>("/api/runs/:id/subtasks/:key/page", async (req, reply): Promise<SubtaskPageDto | undefined> => {
    const [run, subtask] = await Promise.all([getRun(db, req.params.id), getSubtask(db, req.params.id, req.params.key)]);
    if (!run || !subtask) return notFound(reply, "Sub-task");
    const [cards, pending] = await Promise.all([listPageCards(db, run.id, subtask.key), listPendingApprovals(db, run.id)]);
    return { run, subtask, cards, needsYou: pending.filter((p) => p.subtaskKey === subtask.key), agents: [IMPLEMENTER, ASSISTANT] };
  });

  // Every version of a run's plan, oldest first: earlier versions stay viewable (FR-P3).
  app.get<{ Params: { id: string } }>("/api/runs/:id/plans", async (req) => listPlanVersions(db, req.params.id));
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
