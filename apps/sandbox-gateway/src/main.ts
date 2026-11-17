/**
 * sandbox-gateway: the only service sandboxes can reach. Authenticates each workspace with its
 * step-scoped token; serves the step brief and one bundle per repository; takes requests for more
 * catalog repositories; validates analyses against the catalog; receives progress and results.
 */
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import Fastify, { type FastifyRequest } from "fastify";
import { validateAnalysis, validateHandoffPlan } from "@orch/catalog";
import { config, log, sleep, tokenHash, verifyWorkspaceToken } from "@orch/common";
import { Analysis, DesignTurnResult, HandoffPlan, ProgressEvent, StepBrief, StepResult, findCatalogRepository, repoSlug } from "@orch/contracts";
import {
  completeDesignTurn,
  completeStep,
  connectStore,
  createRepositoryRequest,
  getCatalogForRun,
  getDesignSession,
  getRepositoryRequest,
  getRun,
  getStep,
  notify,
  saveDesignSession,
  takeDesignTurn,
  insertProgress,
  listRepositoryRequests,
  markStepRunning,
  touchStep,
  type StepRecord,
} from "@orch/store";
import { z } from "zod";

const ProgressBatch = z.object({ events: z.array(ProgressEvent).max(500) });
const RepositoryRequest = z.object({ repository: z.string().min(3).max(200), reason: z.string().max(1000).optional() });

async function main(): Promise<void> {
  const db = await connectStore();
  const secret = config.workspaceTokenSecret();
  const artifacts = config.artifactsDir();
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

  const authenticate = async (req: FastifyRequest): Promise<StepRecord | null> => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const claims = token ? verifyWorkspaceToken(token, secret) : null;
    if (!claims) return null;
    const step = await getStep(db, claims.stepId);
    if (!step || step.tokenHash !== tokenHash(token)) return null;
    if (step.state !== "pending" && step.state !== "running") return null;
    return step;
  };

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/v1/step", async (req, reply) => {
    const step = await authenticate(req);
    if (!step) return reply.code(401).send({ error: "unauthorized" });
    await markStepRunning(db, step.id);
    const brief = JSON.parse(await readFile(join(artifacts, step.id, "brief.json"), "utf8"));
    return brief;
  });

  const readBrief = async (stepId: string) => StepBrief.parse(JSON.parse(await readFile(join(artifacts, stepId, "brief.json"), "utf8")));

  // One bundle per repository of the step (AD-37); only the worker writes them, into the step's own directory.
  app.get<{ Params: { index: string } }>("/v1/step/bundle/:index", async (req, reply) => {
    const step = await authenticate(req);
    if (!step) return reply.code(401).send({ error: "unauthorized" });
    if (!/^\d{1,3}$/.test(req.params.index)) return reply.code(400).send({ error: "invalid repository index" });
    const file = join(artifacts, step.id, `repo-${Number(req.params.index)}.bundle`);
    if (!existsSync(file)) return reply.code(404).send({ error: "bundle missing" });
    reply.header("content-type", "application/octet-stream");
    return reply.send(createReadStream(file));
  });

  // request_repository: the analyst asks for another catalog repository; the worker prepares its bundle.
  app.post("/v1/step/repositories", async (req, reply) => {
    const step = await authenticate(req);
    if (!step) return reply.code(401).send({ error: "unauthorized" });
    const parsed = RepositoryRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid repository request" });
    if (step.kind !== "analyse" && step.kind !== "design") return reply.code(403).send({ error: "This step cannot open more repositories" });
    const catalog = await getCatalogForRun(db, step.runId);
    const entry = catalog ? findCatalogRepository(catalog, parsed.data.repository) : undefined;
    const reason = parsed.data.reason ?? null;
    if (!entry) {
      const known = catalog ? catalog.products.flatMap((p) => p.repositories.map((r) => r.id)).join(", ") : "none";
      const error = `${parsed.data.repository} is not in the product catalog. Repositories in the catalog: ${known}.`;
      return createRepositoryRequest(db, { stepId: step.id, repository: parsed.data.repository.toLowerCase(), reason, state: "denied", error });
    }
    const brief = await readBrief(step.id);
    const present = brief.repositories.find((r) => repoSlug(r.repo).toLowerCase() === entry.id.toLowerCase());
    if (present) return { id: `brief-${present.index}`, stepId: step.id, repository: entry.id, state: "ready", entry: present, error: null };
    const earlier = await listRepositoryRequests(db, step.id);
    const again = earlier.find((r) => r.repository === entry.id);
    if (again) return again;
    const held = brief.repositories.length + earlier.filter((r) => r.state === "ready" || r.state === "pending").length;
    if (held >= brief.maxRepositories) {
      const error = `This step already holds ${held} repositories, the limit. Decide with what you have.`;
      return createRepositoryRequest(db, { stepId: step.id, repository: entry.id, reason, state: "denied", error });
    }
    log("sandbox-gateway", `step ${step.id} asks for ${entry.id}`);
    return createRepositoryRequest(db, { stepId: step.id, repository: entry.id, reason });
  });

  app.get<{ Params: { id: string } }>("/v1/step/repositories/:id", async (req, reply) => {
    const step = await authenticate(req);
    if (!step) return reply.code(401).send({ error: "unauthorized" });
    const request = await getRepositoryRequest(db, req.params.id);
    if (!request || request.stepId !== step.id) return reply.code(404).send({ error: "unknown request" });
    return request;
  });

  /** Problems of an analysis against the catalog the run pinned; an empty list means it is acceptable. */
  const analysisProblems = async (step: StepRecord, analysis: Analysis): Promise<string[]> => {
    const catalog = await getCatalogForRun(db, step.runId);
    return catalog ? validateAnalysis(analysis, catalog) : ["The run has no product catalog"];
  };

  // submit_analysis checks here first, so the analyst can correct itself before the step ends.
  app.post("/v1/step/analysis/check", async (req, reply) => {
    const step = await authenticate(req);
    if (!step) return reply.code(401).send({ error: "unauthorized" });
    const parsed = Analysis.safeParse(req.body);
    if (!parsed.success) return { problems: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`) };
    return { problems: await analysisProblems(step, parsed.data) };
  });

  app.post("/v1/step/heartbeat", async (req, reply) => {
    const step = await authenticate(req);
    if (!step) return reply.code(401).send({ error: "unauthorized" });
    await touchStep(db, step.id);
    return { ok: true };
  });

  app.post("/v1/step/progress", async (req, reply) => {
    const step = await authenticate(req);
    if (!step) return reply.code(401).send({ error: "unauthorized" });
    const parsed = ProgressBatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid progress batch" });
    await touchStep(db, step.id);
    await insertProgress(db, step.id, step.runId, parsed.data.events);
    return { ok: true };
  });

  // --- Design session (AD-34, AD-35): turns for the architect's session workspace ------------------

  const checkpointFile = (runId: string) => join(artifacts, `design-${runId}`, "checkpoint.tgz");

  /** The workspace that holds the session now; a workspace that was replaced is told to stop. */
  const sessionStep = async (req: FastifyRequest) => {
    const step = await authenticate(req);
    if (!step || step.kind !== "design") return null;
    const session = await getDesignSession(db, step.runId);
    return session && session.stepId === step.id ? { step, session } : null;
  };

  const typing = async (runId: string, on: boolean) => {
    const conversationId = (await getRun(db, runId))?.conversationId;
    if (conversationId) await notify(db, { t: "typing", c: conversationId, on });
  };

  // Long poll: the next turn, or the request to save the session and stop, or to just stop.
  app.get<{ Querystring: { wait?: string } }>("/v1/session/turn", async (req, reply) => {
    const deadline = Date.now() + Math.min(25, Math.max(0, Number(req.query.wait) || 0)) * 1000;
    for (;;) {
      const current = await sessionStep(req);
      if (!current) return reply.code(401).send({ error: "unauthorized" });
      if (current.session.state === "closed") return { close: true };
      if (current.session.state === "suspending") return { checkpoint: true };
      const turn = await takeDesignTurn(db, current.step.runId);
      if (turn) {
        await touchStep(db, current.step.id);
        await typing(current.step.runId, true);
        return { turn: turn.input };
      }
      if (Date.now() >= deadline) return {};
      await sleep(700);
    }
  });

  // The reply as it is written: passed on to the conversation, never stored and never part of a workflow.
  app.post("/v1/session/delta", async (req, reply) => {
    const current = await sessionStep(req);
    if (!current) return reply.code(401).send({ error: "unauthorized" });
    const parsed = z.object({ text: z.string().max(20000) }).safeParse(req.body);
    const conversationId = (await getRun(db, current.step.runId))?.conversationId;
    if (parsed.success && conversationId) {
      for (let i = 0; i < parsed.data.text.length; i += 3000) {
        await notify(db, { t: "delta", c: conversationId, tempId: conversationId, text: parsed.data.text.slice(i, i + 3000) });
      }
    }
    return { ok: true };
  });

  /** Problems of a hand-off plan against the catalog the run pinned and the plan rules (FR-P2). */
  const planProblems = async (runId: string, plan: HandoffPlan): Promise<string[]> => {
    const catalog = await getCatalogForRun(db, runId);
    return catalog ? validateHandoffPlan(plan, catalog) : ["The run has no product catalog"];
  };

  // submit_plan checks here first, so the architect can correct the plan in the same turn.
  app.post("/v1/session/plan/check", async (req, reply) => {
    const current = await sessionStep(req);
    if (!current) return reply.code(401).send({ error: "unauthorized" });
    const parsed = HandoffPlan.safeParse(req.body);
    if (!parsed.success) return { problems: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`) };
    return { problems: await planProblems(current.step.runId, parsed.data) };
  });

  app.post("/v1/session/turn-result", async (req, reply) => {
    const current = await sessionStep(req);
    if (!current) return reply.code(401).send({ error: "unauthorized" });
    const parsed = DesignTurnResult.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid turn result", issues: parsed.error.issues.slice(0, 5) });
    let result = parsed.data;
    // Nothing the architect writes is taken on trust: a plan in the result is checked again before the workflow stores it.
    if (result.plan) {
      const problems = await planProblems(current.step.runId, result.plan);
      if (problems.length) result = { ...result, plan: undefined, proposed: false, error: `The plan was rejected: ${problems.join(" ")}`.slice(0, 2000) };
    }
    // Only a turn of this workspace's own run can be answered, whatever turn id the result names.
    if (!(await completeDesignTurn(db, current.step.runId, result.turnId, result))) {
      log("sandbox-gateway", `turn result ignored: ${result.turnId} is not an open turn of ${current.step.runId}`);
    }
    await touchStep(db, current.step.id);
    await typing(current.step.runId, false);
    return { ok: true };
  });

  // A saved session is the runtime's own state, far smaller than this limit; the limit bounds what a sandbox can store.
  app.put("/v1/session/checkpoint", { bodyLimit: 256 * 1024 * 1024 }, async (req, reply) => {
    const current = await sessionStep(req);
    if (!current) return reply.code(401).send({ error: "unauthorized" });
    const target = checkpointFile(current.step.runId);
    await mkdir(join(target, ".."), { recursive: true });
    await pipeline(req.body as Readable, createWriteStream(`${target}.partial`));
    await rename(`${target}.partial`, target);
    await saveDesignSession(db, current.step.runId, { hasCheckpoint: true });
    log("sandbox-gateway", `design session of ${current.step.runId} saved`);
    return { ok: true };
  });

  app.get("/v1/session/checkpoint", async (req, reply) => {
    const current = await sessionStep(req);
    if (!current) return reply.code(401).send({ error: "unauthorized" });
    const file = checkpointFile(current.step.runId);
    if (!existsSync(file)) return reply.code(404).send({ error: "no checkpoint" });
    reply.header("content-type", "application/octet-stream");
    return reply.send(createReadStream(file));
  });

  app.put("/v1/step/result-bundle", { bodyLimit: 1024 * 1024 * 1024 }, async (req, reply) => {
    const step = await authenticate(req);
    if (!step) return reply.code(401).send({ error: "unauthorized" });
    const target = join(artifacts, step.id, "out.bundle");
    const partial = `${target}.partial`;
    await pipeline(req.body as Readable, createWriteStream(partial));
    await rename(partial, target);
    return { ok: true };
  });

  app.post("/v1/step/result", async (req, reply) => {
    const step = await authenticate(req);
    if (!step) return reply.code(401).send({ error: "unauthorized" });
    const parsed = StepResult.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid result", issues: parsed.error.issues.slice(0, 5) });
    let result = parsed.data;
    // Nothing an analyst writes is taken on trust: the final result is checked again against the catalog.
    if (step.kind === "analyse" && result.status === "succeeded") {
      const problems = result.analysis ? await analysisProblems(step, result.analysis) : ["The step returned no analysis"];
      if (problems.length) result = { status: "failed", summary: "The analysis was rejected", error: problems.join(" ").slice(0, 2000) };
    }
    await completeStep(db, step.id, result);
    log("sandbox-gateway", `step ${step.id} ${result.status}`);
    return { ok: true };
  });

  await app.listen({ host: "0.0.0.0", port: config.gatewayPort() });
  log("sandbox-gateway", `listening on ${config.gatewayPort()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
