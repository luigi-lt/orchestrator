// End-to-end scenario against the running stack (started by test/e2e/run.sh).
// Exercises: chat with generative UI, issue pickup by label, clarifying questions, plan approval,
// sandboxed implementation, pull request, merge detection and ticket labels.
const API = process.env.API_URL ?? "http://localhost:3000";
const GH = process.env.FAKE_GITHUB_URL ?? "http://127.0.0.1:8095";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (msg) => console.log(`  ✔ ${msg}`);
const fail = (msg) => {
  failures++;
  console.log(`  ✘ ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

async function call(base, path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", "x-orch-client": "web" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${text}`);
  return data;
}
const api = (path, init) => call(API, path, init);
const gh = (path, init) => call(GH, path, init);

async function waitFor(what, fn, timeoutMs = 240_000, everyMs = 2000) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // keep waiting
    }
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

async function main() {
  console.log("Waiting for the api…");
  await waitFor("api health", () => api("/api/health"), 180_000);
  const me = await api("/api/me");
  check(me.login === "tester", `api runs as ${me.login}`);

  console.log("1. Chat with generative UI");
  const conv = await api("/api/conversations", { method: "POST", body: {} });
  await api(`/api/conversations/${conv.id}/messages`, { method: "POST", body: { text: "Show me a table please" } });
  const withTable = await waitFor("agent reply with a table", async () => {
    const { messages } = await api(`/api/conversations/${conv.id}`);
    return messages.find((m) => m.role === "agent" && m.components.some((c) => c.type === "table"));
  }, 120_000);
  check(!!withTable, "front-door agent rendered a table component");

  console.log("2. Issue labelled ai-ready is picked up");
  const { number } = await gh("/_test/issues", { method: "POST", body: { title: "Add subtract", body: "Please add a subtract function. [ask]", label: "ai-ready" } });
  const run = await waitFor("run for the issue", async () => (await api("/api/runs")).find((r) => r.issueNumber === number), 120_000);
  ok(`run ${run.id} started for issue #${number}`);

  console.log("3. Clarifying questions answered in the chat");
  await waitFor("awaiting_answers", async () => (await api(`/api/runs/${run.id}`)).run.state === "awaiting_answers", 300_000);
  const questions = (await api("/api/pending")).find((p) => p.runId === run.id && p.kind === "questions");
  check(!!questions, "questions are pending");
  await api(`/api/approvals/${questions.id}/answer`, { method: "POST", body: { answer: "Numbers only." } });

  console.log("4. Plan approval");
  await waitFor("awaiting_approval", async () => (await api(`/api/runs/${run.id}`)).run.state === "awaiting_approval", 300_000);
  const detail = await api(`/api/runs/${run.id}`);
  const { messages } = await api(`/api/conversations/${detail.run.conversationId}`);
  const planCard = messages.flatMap((m) => m.components).filter((c) => c.type === "plan" && c.status === "pending").pop();
  check(!!planCard, "plan card is shown in the run's home conversation");
  const wrongHash = await api(`/api/approvals/${planCard.approvalId}/plan`, { method: "POST", body: { decision: "approve", hash: "stale" } }).then(
    () => false,
    () => true,
  );
  check(wrongHash, "approval with a stale plan hash is refused");
  await api(`/api/approvals/${planCard.approvalId}/plan`, { method: "POST", body: { decision: "approve", hash: planCard.hash } });

  console.log("5. Implementation in a sandbox, pull request");
  await waitFor("awaiting_merge", async () => {
    const d = await api(`/api/runs/${run.id}`);
    if (d.run.state === "failed") throw Object.assign(new Error(d.run.error), { fatal: true });
    return d.run.state === "awaiting_merge";
  }, 600_000).catch((err) => {
    throw err;
  });
  const after = await api(`/api/runs/${run.id}`);
  check(after.steps.filter((s) => s.kind === "implement" && s.state === "succeeded").length === 1, "implementation step succeeded");
  const state = await gh("/_test/state");
  const pr = state.pulls[0];
  check(!!pr && pr.head === after.run.branch, `pull request #${pr?.number} opened from ${after.run.branch}`);
  const branch = await gh(`/_test/branch?repo=acme/demo&name=${encodeURIComponent(after.run.branch)}`);
  check(branch.files.includes("subtract.js"), "branch contains subtract.js");
  check(/Agent-Run: /.test(branch.log) && /Requested-By: tester/.test(branch.log), "commit carries Agent-Run and Requested-By trailers");
  check(/Closes #\d+/.test(pr.body) && /Generated by the orchestrator/.test(pr.body), "pull request body links the issue and is marked agent-generated");

  console.log("6. Merge detection and ticket write-back");
  await gh(`/_test/pulls/${pr.number}/merge`, { method: "POST" });
  await waitFor("completed", async () => (await api(`/api/runs/${run.id}`)).run.state === "completed", 180_000);
  ok("run completed after the merge");
  const finalState = await gh("/_test/state");
  const issue = finalState.issues.find((i) => i.number === number);
  check(issue.labels.includes("ai-done") && !issue.labels.includes("ai-ready") && !issue.labels.includes("ai-in-progress"), `issue labels: ${issue.labels.join(", ")}`);
  const comments = finalState.comments[`acme/demo#${number}`].map((c) => c.body);
  check(comments.some((b) => b.includes("picked up")), "pickup comment posted");
  check(comments.some((b) => b.includes("Pull request opened")), "pull request comment posted");
  const events = (await api(`/api/runs/${run.id}`)).events.map((e) => e.type);
  check(events.includes("plan.approved") && events.includes("scm.pr_merged") && events.includes("run.completed"), `run events recorded (${events.length})`);

  console.log(failures ? `\nFAILED: ${failures} check(s)` : "\nPASSED: all checks");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`);
  process.exit(1);
});
