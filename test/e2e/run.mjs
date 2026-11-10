// End-to-end scenario against the running stack (started by test/e2e/run.sh), with a fake GitHub serving
// two repositories of two products and a fake model. Exercises iteration 2, increment 1:
// product catalog, analysis in a sandbox with several repositories, track rules, one conversation per run,
// the fast track without stops, the guided track with plan approval, and work that spans two products.
const API = process.env.API_URL ?? "http://localhost:3000";
const GH = process.env.FAKE_GITHUB_URL ?? "http://127.0.0.1:8095";
const MODEL = process.env.FAKE_ANTHROPIC_URL ?? "http://127.0.0.1:8099";

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
    } catch (err) {
      if (err.fatal) throw err;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** Waits until the run reaches one of the states; a failed run ends the wait at once. */
const waitForState = (runId, states, timeoutMs = 600_000) =>
  waitFor(
    `run ${runId} to be ${states.join(" or ")}`,
    async () => {
      const d = await api(`/api/runs/${runId}`);
      if (d.run.state === "failed" && !states.includes("failed")) throw Object.assign(new Error(`run failed: ${d.run.error}`), { fatal: true });
      return states.includes(d.run.state) ? d : null;
    },
    timeoutMs,
  );

const cardsOf = async (conversationId) => (await api(`/api/conversations/${conversationId}`)).messages.flatMap((m) => m.components);
const issueOf = async (number) => (await gh("/_test/state")).issues.find((i) => i.number === number);
const newIssue = (title, body, labels, repo = "acme/demo") => gh("/_test/issues", { method: "POST", body: { title, body, labels, repo } });
const runFor = (number) => waitFor(`run for issue #${number}`, async () => (await api("/api/runs")).find((r) => r.issueNumber === number), 120_000);

async function main() {
  console.log("Waiting for the api…");
  await waitFor("api health", () => api("/api/health"), 180_000);
  const me = await api("/api/me");
  check(me.login === "tester", `api runs as ${me.login}`);

  console.log("1. Product catalog");
  const products = await api("/api/products");
  check(products.products.map((p) => p.id).join(",") === "calc,shop" && !products.error, `catalog ${products.hash} has the products calc and shop`);
  check(me.repos.join(",") === "acme/demo,acme/web" && !me.catalogError, "both repositories come from the catalog");
  const outside = await api("/api/runs", { method: "POST", body: { repo: "acme/other", issueNumber: 1 } }).then(
    () => false,
    (e) => /not in the product catalog/.test(e.message),
  );
  check(outside, "work cannot start from a repository outside the catalog");

  console.log("2. Chat with generative UI");
  const chat = await api("/api/conversations", { method: "POST", body: {} });
  check(chat.kind === "general", "a new chat is a general conversation");
  await api(`/api/conversations/${chat.id}/messages`, { method: "POST", body: { text: "Show me a table please" } });
  const withTable = await waitFor("agent reply with a table", async () => {
    const { messages } = await api(`/api/conversations/${chat.id}`);
    return messages.find((m) => m.role === "agent" && m.components.some((c) => c.type === "table"));
  }, 120_000);
  check(withTable.author === "front-door", "the reply is labelled with the agent that wrote it");

  console.log("3. Fast track: a labelled bug goes from analysis to a pull request with no approval");
  const bug = await newIssue("Add subtract", "Please add a subtract function. [ask]", ["ai-ready", "bug"]);
  const fastRun = await runFor(bug.number);
  ok(`run ${fastRun.id} started for issue #${bug.number}`);
  await waitForState(fastRun.id, ["awaiting_answers"], 300_000);
  const questions = (await api("/api/pending")).find((p) => p.runId === fastRun.id && p.kind === "questions");
  check(!!questions, "the analyst's questions are pending");
  await api(`/api/approvals/${questions.id}/answer`, { method: "POST", body: { answer: "Numbers only." } });

  const fast = await waitForState(fastRun.id, ["awaiting_merge"]);
  check(fast.run.track === "fast" && fast.run.products.join() === "calc" && fast.run.homeProduct === "calc", `track ${fast.run.track}, products ${fast.run.products}`);
  check(fast.run.catalogHash === products.hash, "the run pinned the catalog version");
  const fastConversation = (await api("/api/conversations")).find((c) => c.id === fast.run.conversationId);
  check(fastConversation?.kind === "run" && fastConversation.focusedRunId === fastRun.id, "the run has its own conversation");
  const fastCards = await cardsOf(fast.run.conversationId);
  const analysisCard = fastCards.find((c) => c.type === "analysis");
  check(analysisCard?.track === "fast" && analysisCard.products[0]?.name === "Calculator library", "analysis card shows the product and the fast track");
  check(!fastCards.some((c) => c.type === "plan"), "no plan approval on the fast track");
  check(fast.steps.map((s) => s.kind).join(",") === "analyse,analyse,implement", `steps: ${fast.steps.map((s) => s.kind).join(", ")}`);
  check((await issueOf(bug.number)).labels.includes("track:fast"), "the ticket carries the label track:fast");

  let state = await gh("/_test/state");
  const fastPr = state.pulls.find((p) => p.head === fast.run.branch);
  check(!!fastPr && fastPr.repo === "acme/demo", `pull request #${fastPr?.number} opened from ${fast.run.branch}`);
  const branch = await gh(`/_test/branch?repo=acme/demo&name=${encodeURIComponent(fast.run.branch)}`);
  check(branch.files.includes("subtract.js"), "branch contains subtract.js");
  check(/Agent-Run: /.test(branch.log) && /Requested-By: tester/.test(branch.log), "commit carries Agent-Run and Requested-By trailers");
  check(/Closes #\d+/.test(fastPr.body) && /fast track/.test(fastPr.body), "pull request body links the issue and names the track");

  const model = await call(MODEL, "/_test/state");
  check(model.guidanceInPrompt, "the product team's AGENTS.md reached the agent as content");
  check(!model.guidanceInSystem, "the runtime did not load guidance into the system prompt by itself");

  await gh(`/_test/pulls/${fastPr.number}/merge`, { method: "POST" });
  await waitForState(fastRun.id, ["completed"], 180_000);
  const doneIssue = await issueOf(bug.number);
  check(doneIssue.labels.includes("ai-done") && !doneIssue.labels.includes("ai-ready") && !doneIssue.labels.includes("ai-in-progress"), `issue labels: ${doneIssue.labels.join(", ")}`);
  state = await gh("/_test/state");
  const comments = state.comments[`acme/demo#${bug.number}`].map((c) => c.body);
  check(comments.some((b) => b.includes("**Analysis**") && b.includes("track: **fast**")), "the analysis was posted on the ticket");
  check(comments.some((b) => b.includes("Pull request opened")), "pull request comment posted");
  const fastEvents = (await api(`/api/runs/${fastRun.id}`)).events.map((e) => e.type);
  check(["analysis.completed", "products.identified", "track.set", "scm.pr_merged", "run.completed"].every((t) => fastEvents.includes(t)), `run events recorded (${fastEvents.length})`);

  console.log("4. Work across two products, started from the chat");
  const story = await newIssue("Show subtraction in the shop", "Add subtract and use it on the shop page. [web]", ["enhancement"]);
  await api(`/api/conversations/${chat.id}/messages`, { method: "POST", body: { text: `work on issue #${story.number}` } });
  const crossRun = await runFor(story.number);
  const linkCard = await waitFor("link card in the chat", async () => (await cardsOf(chat.id)).find((c) => c.type === "run_link" && c.runId === crossRun.id), 60_000);
  check(linkCard.conversationId !== chat.id, "the chat shows a link to the run's own conversation");
  const cross = await waitForState(crossRun.id, ["closed"]);
  check(cross.run.conversationId === linkCard.conversationId, "the run lives in the linked conversation");
  check(cross.run.products.join() === "calc,shop", `products found: ${cross.run.products}`);
  check(cross.run.track === "guided" && cross.run.analysis.proposedTrack === "fast", "the rules chose guided although the analyst proposed fast");
  check(/More than one product/.test(cross.run.trackReasons.join()), `reason: ${cross.run.trackReasons[0]}`);
  const transcript = await api(`/api/steps/${cross.steps[0].id}/progress`);
  check(transcript.some((l) => /Opened acme\/web read-only/.test(l.text)), "the analyst opened the second repository on demand");
  check((await issueOf(story.number)).labels.includes("track:guided"), "the ticket carries the label track:guided");
  check(!(await gh("/_test/state")).pulls.some((p) => p.head === cross.run.branch) && !cross.run.prUrl, "nothing was built or pushed");
  const crossCards = await cardsOf(cross.run.conversationId);
  check(crossCards.some((c) => c.type === "notice" && /2 repositories/.test(c.text)), "the conversation says why the run stopped");

  console.log("5. Guided track: plan approval before anything is built");
  const guided = await newIssue("Add subtract with care", "A subtract function that needs a design choice. [guided]", ["ai-ready"]);
  const guidedRun = await runFor(guided.number);
  const awaiting = await waitForState(guidedRun.id, ["awaiting_approval"]);
  check(awaiting.run.track === "guided", "the run is on the guided track");
  const analyseStep = awaiting.steps.find((s) => s.kind === "analyse");
  const analyseLog = await api(`/api/steps/${analyseStep.id}/progress`);
  check(analyseStep.state === "succeeded" && analyseLog.filter((l) => /^submit_analysis/.test(l.text)).length === 2, "an analysis naming an unknown product was sent back and corrected");
  const planCard = (await cardsOf(awaiting.run.conversationId)).filter((c) => c.type === "plan" && c.status === "pending").pop();
  check(!!planCard, "plan card is shown in the run's conversation");
  const stale = await api(`/api/approvals/${planCard.approvalId}/plan`, { method: "POST", body: { decision: "approve", hash: "stale" } }).then(
    () => false,
    () => true,
  );
  check(stale, "approval with a stale plan hash is refused");
  await api(`/api/approvals/${planCard.approvalId}/plan`, { method: "POST", body: { decision: "approve", hash: planCard.hash } });
  const built = await waitForState(guidedRun.id, ["awaiting_merge"]);
  check(built.steps.map((s) => s.kind).join(",") === "analyse,plan,implement", `steps: ${built.steps.map((s) => s.kind).join(", ")}`);
  const guidedPr = (await gh("/_test/state")).pulls.find((p) => p.head === built.run.branch);
  check(!!guidedPr, `pull request #${guidedPr?.number} opened after the approval`);
  await gh(`/_test/pulls/${guidedPr.number}/merge`, { method: "POST" });
  await waitForState(guidedRun.id, ["completed"], 180_000);
  ok("guided run completed after the merge");

  console.log(failures ? `\nFAILED: ${failures} check(s)` : "\nPASSED: all checks");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`);
  process.exit(1);
});
