// End-to-end scenario against the running stack (started by test/e2e/run.sh), with a fake GitHub serving
// two repositories of two products and a fake model. Exercises iteration 2, increments 1 and 2:
// product catalog, analysis in a sandbox with several repositories, track rules, conversations grouped by
// ticket, run and sub-task; the fast track with the product's test command, the AI review and its fix loop;
// the guided track with one branch, pull request and conversation per sub-task; the requester's decisions on
// open findings and on a change beyond the fast-track limits.
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

  console.log("3. Fast track: a labelled bug goes from analysis to a reviewed pull request with no approval");
  const bug = await newIssue("Add subtract", "Please add a subtract function. [ask] [finding] [broken]", ["ai-ready", "bug"]);
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
  check(!fastCards.some((c) => ["plan", "findings", "limits"].includes(c.type)), "no approval of any kind on the fast track");
  check((await issueOf(bug.number)).labels.includes("track:fast"), "the ticket carries the label track:fast");

  // The product's test command, the AI review and one fix round (FR-B1, FR-R1, FR-R2).
  check(
    fast.steps.map((s) => s.kind).join(",") === "analyse,analyse,implement,review,implement,review",
    `steps: ${fast.steps.map((s) => s.kind).join(", ")}`,
  );
  const firstImplement = await api(`/api/steps/${fast.steps[2].id}/progress`);
  check(
    firstImplement.some((l) => /test failed/.test(l.text)) && firstImplement.some((l) => /repair the failing test command/.test(l.text)) && firstImplement.some((l) => /test passed/.test(l.text)),
    "the product's test command failed on the first version, and the implementer repaired it in the same session",
  );
  const change = fast.subtasks[0];
  check(fast.subtasks.length === 1 && change.key === "change" && change.conversationId === null, "the fast track has one change and no sub-task conversation");
  check(change.verification?.passed && change.verification.commands[0]?.command === "node test.mjs", "the checks of the final change passed");
  check(change.fixRounds === 1 && change.review.rounds === 2, `AI review: ${change.review.rounds} rounds, ${change.fixRounds} fix round`);
  check(change.review.resolved.map((f) => f.title).join() === "No input check" && change.review.open.length === 0, "the major finding was fixed and confirmed by the second review");
  const reviewCard = fastCards.find((c) => c.type === "review");
  check(reviewCard?.status === "clean" && reviewCard.review.resolved.length === 1, "the review card shows a clean review with the fixed finding");

  let state = await gh("/_test/state");
  const fastPr = state.pulls.find((p) => p.head === fast.run.branch);
  check(!!fastPr && fastPr.repo === "acme/demo", `pull request #${fastPr?.number} opened from ${fast.run.branch}`);
  const branch = await gh(`/_test/branch?repo=acme/demo&name=${encodeURIComponent(fast.run.branch)}`);
  check(branch.files.join() === "subtract.js" && branch.commits === 1, "the branch holds one commit with the final change");
  check(/Agent-Run: /.test(branch.log) && /Requested-By: tester/.test(branch.log), "commit carries Agent-Run and Requested-By trailers");
  check(/Closes #\d+/.test(fastPr.body) && /fast track/.test(fastPr.body), "pull request body links the issue and names the track");
  check(
    /### AI review/.test(fastPr.body) && /Fixed during the review/.test(fastPr.body) && /No input check/.test(fastPr.body) && /test \(`node test\.mjs`\): passed/.test(fastPr.body),
    "pull request body carries the review, the fixed finding and the checks",
  );
  check(/written by an AI reviewer agent/.test(fastPr.body), "the review in the pull request is marked as written by an agent");

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
  const fastDone = await api(`/api/runs/${fastRun.id}`);
  const fastEvents = fastDone.events.map((e) => e.type);
  check(
    ["analysis.completed", "track.set", "review.fix_requested", "review.completed", "scm.pr_merged", "subtask.merged", "run.completed"].every((t) => fastEvents.includes(t)),
    `run events recorded (${fastEvents.length})`,
  );
  check(fastDone.events.every((e, i) => e.seq === i + 1), "events of the run and of its sub-task share one gapless sequence");
  check(fastDone.subtasks[0].state === "merged", "the change is merged");

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

  console.log("5. Conversations grouped by ticket: the same ticket run again");
  const again = await api("/api/runs", { method: "POST", body: { repo: "acme/demo", issueNumber: story.number } });
  check(again.started && again.runId !== crossRun.id, "a ticket whose run ended can be run again");
  const second = await waitForState(again.runId, ["closed"]);
  const tickets = await api("/api/tickets");
  const ticket = tickets.find((t) => t.issueNumber === story.number);
  check(tickets.length === 2 && ticket?.runs.length === 2, `${tickets.length} tickets; the ticket #${story.number} holds ${ticket?.runs.length} runs`);
  check(ticket.runs[0].runId === again.runId && ticket.runs[0].ordinal === 2 && ticket.runs[1].ordinal === 1, "its runs are listed newest first and numbered in the order they started");
  check(
    new Set(ticket.runs.map((r) => r.conversationId)).size === 2 && ticket.runs[0].conversationId === second.run.conversationId,
    "each run keeps its own conversation under the ticket",
  );
  check(ticket.key === second.run.ticketKey && second.ticket?.runs.length === 2, "a run knows its ticket and the other runs of it");
  check(tickets.find((t) => t.issueNumber === bug.number)?.runs.length === 1 && !ticket.active && ticket.pending === 0, "other tickets keep their own runs");

  console.log("6. Guided track: a plan, then one branch, pull request and conversation per sub-task");
  const guided = await newIssue("Add multiply with care", "A multiply function that needs a design choice. [guided]", ["ai-ready"]);
  const guidedRun = await runFor(guided.number);
  const awaiting = await waitForState(guidedRun.id, ["awaiting_approval"]);
  check(awaiting.run.track === "guided", "the run is on the guided track");
  const analyseStep = awaiting.steps.find((s) => s.kind === "analyse");
  const analyseLog = await api(`/api/steps/${analyseStep.id}/progress`);
  check(analyseStep.state === "succeeded" && analyseLog.filter((l) => /^submit_analysis/.test(l.text)).length === 2, "an analysis naming an unknown product was sent back and corrected");
  const planCard = (await cardsOf(awaiting.run.conversationId)).filter((c) => c.type === "plan" && c.status === "pending").pop();
  check(planCard?.plan.subtasks.length === 2, "plan card with two sub-tasks is shown in the run's conversation");
  const stale = await api(`/api/approvals/${planCard.approvalId}/plan`, { method: "POST", body: { decision: "approve", hash: "stale" } }).then(
    () => false,
    () => true,
  );
  check(stale, "approval with a stale plan hash is refused");
  await api(`/api/approvals/${planCard.approvalId}/plan`, { method: "POST", body: { decision: "approve", hash: planCard.hash } });

  const firstOpen = await waitForState(guidedRun.id, ["awaiting_merge"]);
  const s1 = firstOpen.subtasks[0];
  check(firstOpen.subtasks.length === 1 && s1.key === "s1" && s1.state === "pr_open", "the first sub-task has its pull request open; the second has not started");
  check(!!s1.conversationId && s1.conversationId !== firstOpen.run.conversationId, "the sub-task has its own conversation");
  const s1Cards = (await cardsOf(s1.conversationId)).map((c) => c.type);
  check(["subtask", "progress", "review", "pull_request"].every((t) => s1Cards.includes(t)), `its conversation holds its own cards: ${s1Cards.join(", ")}`);
  const runCards = await cardsOf(firstOpen.run.conversationId);
  const storyCard = runCards.find((c) => c.type === "story");
  check(storyCard?.subtasks[0]?.conversationId === s1.conversationId && storyCard.subtasks[0].state === "pr_open", "the run's conversation lists the sub-task and links to its conversation");
  check(!runCards.some((c) => c.type === "review" || c.type === "pull_request"), "the sub-task's cards are not in the run's conversation");
  const guidedTicket = (await api("/api/tickets")).find((t) => t.issueNumber === guided.number);
  check(guidedTicket.runs[0].subtasks.map((st) => st.conversationId).join() === s1.conversationId, "the hierarchy lists the sub-task under its run");
  let pulls = (await gh("/_test/state")).pulls;
  const pr1 = pulls.find((p) => p.head === s1.branch);
  check(/\(1\/2\): Add multiply function/.test(pr1.title) && /Part of #\d+/.test(pr1.body) && !/Closes #/.test(pr1.body), "the first pull request is part of the ticket and does not close it");
  await gh(`/_test/pulls/${pr1.number}/merge`, { method: "POST" });

  const secondOpen = await waitFor(
    "the pull request of the second sub-task",
    async () => {
      const d = await api(`/api/runs/${guidedRun.id}`);
      if (d.run.state === "failed") throw Object.assign(new Error(`run failed: ${d.run.error}`), { fatal: true });
      return d.subtasks.length === 2 && d.subtasks[1].state === "pr_open" ? d : null;
    },
    600_000,
  );
  const s2 = secondOpen.subtasks[1];
  check(secondOpen.subtasks[0].state === "merged" && s2.branch.endsWith("-s2") && s2.conversationId !== s1.conversationId, "the second sub-task started after the first was merged, on its own branch and conversation");
  const s2Branch = await gh(`/_test/branch?repo=acme/demo&name=${encodeURIComponent(s2.branch)}`);
  check(s2Branch.files.join() === "NOTES.md", "the second branch starts from the merged first change and adds only its own file");
  pulls = (await gh("/_test/state")).pulls;
  const pr2 = pulls.find((p) => p.head === s2.branch);
  check(/\(2\/2\): Document multiply/.test(pr2.title) && /Closes #\d+/.test(pr2.body), "the last pull request closes the ticket");
  await gh(`/_test/pulls/${pr2.number}/merge`, { method: "POST" });
  const guidedDone = await waitForState(guidedRun.id, ["completed"], 180_000);
  check(guidedDone.subtasks.every((st) => st.state === "merged"), "guided run completed after both merges");

  console.log("7. Findings still open after two fix rounds: the requester decides");
  const stubborn = await newIssue("Add a stub", "A small stub file. [stubborn] [file:stub.js]", ["ai-ready", "bug"]);
  const stubbornRun = await runFor(stubborn.number);
  const undecided = await waitForState(stubbornRun.id, ["awaiting_approval"]);
  check(
    undecided.steps.map((s) => s.kind).join(",") === "analyse,implement,review,implement,review,implement,review",
    "two fix rounds were tried, each reviewed again",
  );
  const findingsApproval = (await api("/api/pending")).find((p) => p.runId === stubbornRun.id && p.kind === "findings");
  const findingsCard = (await cardsOf(undecided.run.conversationId)).find((c) => c.type === "findings");
  check(!!findingsApproval && findingsCard?.status === "pending" && findingsCard.findings[0]?.severity === "blocking", "the open blocking finding is put to the requester");
  check((await gh("/_test/state")).pulls.every((p) => p.head !== undecided.run.branch), "nothing was pushed while the decision is open");
  const staleFindings = await api(`/api/approvals/${findingsApproval.id}/findings`, { method: "POST", body: { decision: "open", hash: "stale" } }).then(
    () => false,
    () => true,
  );
  check(staleFindings, "a decision on a stale set of findings is refused");
  await api(`/api/approvals/${findingsApproval.id}/findings`, { method: "POST", body: { decision: "open", hash: findingsCard.hash } });
  const opened = await waitForState(stubbornRun.id, ["awaiting_merge"]);
  const stubbornPr = (await gh("/_test/state")).pulls.find((p) => p.head === opened.run.branch);
  check(/Opened with 1 unresolved finding\(s\), by the requester's decision/.test(stubbornPr.body) && /Unsafe approach/.test(stubbornPr.body), "the pull request opens with the unresolved finding listed");
  await api(`/api/runs/${stubbornRun.id}/cancel`, { method: "POST", body: { reason: "end of test" } });
  const cancelled = await waitForState(stubbornRun.id, ["cancelled"], 120_000);
  check(cancelled.subtasks[0].state === "cancelled", "cancelling the run cancels its sub-task");

  console.log("8. A fast-track change that turned out too big: the requester switches to the guided track");
  const big = await newIssue("Add a big thing", "Looks small. [big] [file:big.js]", ["ai-ready", "bug"]);
  const bigRun = await runFor(big.number);
  const tooBig = await waitForState(bigRun.id, ["awaiting_approval"]);
  const limitsApproval = (await api("/api/pending")).find((p) => p.runId === bigRun.id && p.kind === "limits");
  const limitsCard = (await cardsOf(tooBig.run.conversationId)).find((c) => c.type === "limits");
  check(!!limitsApproval && /7 files \(the fast-track limit is 5\)/.test(limitsCard?.reasons.join()), `the change is stopped: ${limitsCard?.reasons[0]}`);
  await api(`/api/approvals/${limitsApproval.id}/limits`, { method: "POST", body: { decision: "guided", hash: limitsCard.hash } });
  const replanned = await waitFor(
    "the plan of the guided track",
    async () => {
      const d = await api(`/api/runs/${bigRun.id}`);
      return d.run.track === "guided" && d.pending.some((p) => p.kind === "plan") ? d : null;
    },
    300_000,
  );
  check(replanned.events.some((e) => e.type === "track.changed") && (await issueOf(big.number)).labels.includes("track:guided"), "the track and its label changed to guided");
  check(replanned.subtasks[0].state === "cancelled" && (await gh("/_test/state")).pulls.every((p) => p.head !== tooBig.run.branch), "the fast-track change was set aside and nothing was pushed");
  const bigPlan = (await cardsOf(replanned.run.conversationId)).filter((c) => c.type === "plan" && c.status === "pending").pop();
  await api(`/api/approvals/${bigPlan.approvalId}/plan`, { method: "POST", body: { decision: "reject", hash: bigPlan.hash } });
  await waitForState(bigRun.id, ["cancelled"], 120_000);
  ok("rejecting the plan ends the run with nothing changed");

  console.log(failures ? `\nFAILED: ${failures} check(s)` : "\nPASSED: all checks");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`);
  process.exit(1);
});
