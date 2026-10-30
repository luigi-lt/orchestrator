/**
 * sandbox-gateway: the only service sandboxes can reach. Authenticates each workspace with its
 * step-scoped token and serves the step brief and repository bundle; receives progress and results.
 */
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import Fastify, { type FastifyRequest } from "fastify";
import { config, log, tokenHash, verifyWorkspaceToken } from "@orch/common";
import { ProgressEvent, StepResult } from "@orch/contracts";
import { completeStep, connectStore, getStep, insertProgress, markStepRunning, touchStep, type StepRecord } from "@orch/store";
import { z } from "zod";

const ProgressBatch = z.object({ events: z.array(ProgressEvent).max(500) });

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

  app.get("/v1/step/bundle", async (req, reply) => {
    const step = await authenticate(req);
    if (!step) return reply.code(401).send({ error: "unauthorized" });
    const file = join(artifacts, step.id, "in.bundle");
    if (!existsSync(file)) return reply.code(404).send({ error: "bundle missing" });
    reply.header("content-type", "application/octet-stream");
    return reply.send(createReadStream(file));
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
    await completeStep(db, step.id, parsed.data);
    log("sandbox-gateway", `step ${step.id} ${parsed.data.status}`);
    return { ok: true };
  });

  await app.listen({ host: "0.0.0.0", port: config.gatewayPort() });
  log("sandbox-gateway", `listening on ${config.gatewayPort()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
