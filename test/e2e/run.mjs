// End-to-end scenario against the running stack (started by test/e2e/run.sh), with a fake GitHub serving
// two repositories of two products and a fake model. Exercises iteration 2, increments 1 to 3:
// product catalog, analysis in a sandbox with several repositories, track rules, conversations grouped by
// ticket, run and sub-task; the fast track with the product's test command, the AI review and its fix loop;
// the guided track with its design session (the architect agent in the run's conversation, plan versions,
// approval bound to a version, the session saved and restored), sub-issues on the ticket, and one branch,
// pull request and conversation per sub-task, across two repositories; the requester's check of each change
// before its pull request opens, sub-tasks that build on an approved change (stacked in one repository,
// readable in another), the story view with merge order, a dropped sub-task; the requester's decisions on
// open findings and on a change beyond the fast-track limits.
const API = process.env.API_URL ?? "http://localhost:3000";
const GH = process.env.FAKE_GITHUB_URL ?? "http://127.0.0.1:8095";
const MODEL = process.env.FAKE_ANTHROPIC_URL ?? "http://127.0.0.1:8099";

import { execFileSync } from "node:child_process";

const WORKER = process.env.E2E_WORKER_CONTAINER ?? "orchestrator-e2e-worker-1";
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
const say = (conversationId, text) => api(`/api/conversations/${conversationId}/messages`, { method: "POST", body: { text } });
const planCardOf = async (conversationId) => (await cardsOf(conversationId)).filter((c) => c.type === "plan").pop();
const waitForPlan = (conversationId, what, pred) =>
  waitFor(what, async () => {
    const card = await planCardOf(conversationId);
    return card && pred(card) ? card : null;
  }, 300_000);
const architectSaid = async (conversationId) =>
  (await api(`/api/conversations/${conversationId}`)).messages.filter((m) => m.role === "agent" && m.author === "architect");
const refused = (promise) => promise.then(() => false, () => true);
const storyOf = async (conversationId) => (await cardsOf(conversationId)).find((c) => c.type === "story");

/** Waits until a sub-task of a run is in one of the states; a failed run ends the wait at once. */
const subtaskIn = (runId, key, states) =>
  waitFor(
    `sub-task ${key} to be ${states.join(" or ")}`,
    async () => {
      const d = await api(`/api/runs/${runId}`);
      if (d.run.state === "failed") throw Object.assign(new Error(`run failed: ${d.run.error}`), { fatal: true });
      const st = d.subtasks.find((x) => x.key === key);
      return st && states.includes(st.state) ? { d, st } : null;
    },
    600_000,
  );
/** The requester's pending check of a sub-task's change: the card in the sub-task's conversation. */
const pendingCheck = (st, round = 0) =>
  waitFor(`the check of ${st.key}`, async () => (await cardsOf(st.conversationId)).find((c) => c.type === "change" && c.status === "pending" && c.round === round), 120_000);
const decideChange = (card, decision, feedback) => api(`/api/approvals/${card.approvalId}/change`, { method: "POST", body: { decision, hash: card.hash, feedback } });
const pullOf = async (branch) => (await gh("/_test/state")).pulls.find((p) => p.head === branch);

/** Listens to the web app's event stream, as a browser does. */
function listen() {
  const notices = [];
  const ctrl = new AbortController();
  (async () => {
    const res = await fetch(`${API}/api/stream`, { headers: { "x-orch-client": "web" }, signal: ctrl.signal });
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let i = buffer.indexOf("\n\n"); i >= 0; i = buffer.indexOf("\n\n")) {
        const data = buffer.slice(0, i).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        buffer = buffer.slice(i + 2);
        if (data) notices.push(JSON.parse(data));
      }
    }
  })().catch(() => undefined);
  return { notices, stop: () => ctrl.abort() };
}

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
  check(!fastCards.some((c) => ["plan", "findings", "limits", "change"].includes(c.type)), "no approval of any kind on the fast track");
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

  console.log("4. Work across two products, started from the chat: the design session opens by itself");
  const story = await newIssue("Show negated amounts in the shop", "Add negate and use it on the shop page. [web]", ["enhancement"]);
  await say(chat.id, `work on issue #${story.number}`);
  const crossRun = await runFor(story.number);
  const linkCard = await waitFor("link card in the chat", async () => (await cardsOf(chat.id)).find((c) => c.type === "run_link" && c.runId === crossRun.id), 60_000);
  check(linkCard.conversationId !== chat.id, "the chat shows a link to the run's own conversation");
  const crossConversation = linkCard.conversationId;
  const draft = await waitForPlan(crossConversation, "the architect's first draft", (c) => c.version === 1);
  const cross = await api(`/api/runs/${crossRun.id}`);
  check(cross.run.conversationId === crossConversation && cross.run.state === "designing", "the run lives in the linked conversation and is in its design session");
  check(cross.run.products.join() === "calc,shop", `products found: ${cross.run.products}`);
  check(cross.run.track === "guided" && cross.run.analysis.proposedTrack === "fast", "the rules chose guided although the analyst proposed fast");
  check(/More than one product/.test(cross.run.trackReasons.join()), `reason: ${cross.run.trackReasons[0]}`);
  const transcript = await api(`/api/steps/${cross.steps[0].id}/progress`);
  check(transcript.some((l) => /Opened acme\/web read-only/.test(l.text)), "the analyst opened the second repository on demand");
  check((await issueOf(story.number)).labels.includes("track:guided"), "the ticket carries the label track:guided");
  check(cross.design?.state === "active" && cross.design.repositories.join() === "acme/demo,acme/web", `the session workspace holds ${cross.design?.repositories.join(" and ")}`);
  const opening = await architectSaid(crossConversation);
  check(opening.length === 1 && /first draft/.test(opening[0].text), "the architect opened the session with a message of its own");
  check(
    draft.status === "draft" && !draft.approvalId && draft.plan.subtasks.map((st) => st.repository).sort().join() === "acme/demo,acme/web" && draft.plan.contracts.length === 1,
    "a draft plan card shows sub-tasks in both repositories and the contract between them",
  );
  check(!cross.pending.some((p) => p.kind === "plan"), "a draft is not up for approval");
  const routed = await say(crossConversation, "Why two sub-tasks?");
  check(routed.to === "architect", "a message in the run's conversation goes to the architect while the session is open");
  await waitFor("the architect's answer", async () => (await architectSaid(crossConversation)).find((m) => /The plan stays as it is/.test(m.text)), 120_000);
  await say(crossConversation, "Compare the options in a table");
  const withOptions = await waitFor("the architect's table", async () => (await architectSaid(crossConversation)).find((m) => m.components.some((c) => c.type === "table")), 120_000);
  check(withOptions.components[0].title === "Options" && /comparison/.test(withOptions.text ?? ""), "the architect can show structured content in the conversation");
  check((await api(`/api/runs/${crossRun.id}/plans`)).length === 1, "an answer that changes nothing creates no plan version");
  await api(`/api/runs/${crossRun.id}/cancel`, { method: "POST", body: { reason: "not now" } });
  const crossCancelled = await waitForState(crossRun.id, ["cancelled"], 120_000);
  const afterCancel = await gh("/_test/state");
  check(crossCancelled.design.state === "closed" && crossCancelled.steps.every((st) => st.state !== "running"), "cancelling during the design closes the session and its workspace");
  check(crossCancelled.subtasks.length === 0 && afterCancel.subIssues.length === 0 && afterCancel.pulls.length === 1, "nothing was built, pushed or created on the ticket");
  check((await api(`/api/conversations/${crossConversation}`)).design === null, "the conversation is no longer a design session");

  console.log("5. The same ticket run again: runs grouped by ticket; the plan is shaped in the conversation and approved");
  const again = await api("/api/runs", { method: "POST", body: { repo: "acme/demo", issueNumber: story.number } });
  check(again.started && again.runId !== crossRun.id, "a ticket whose run ended can be run again");
  const second = await waitForState(again.runId, ["designing"]);
  const conv = second.run.conversationId;
  const v1 = await waitForPlan(conv, "the first draft of the second run", (c) => c.version === 1);
  let tickets = await api("/api/tickets");
  let ticket = tickets.find((t) => t.issueNumber === story.number);
  check(tickets.length === 2 && ticket?.runs.length === 2, `${tickets.length} tickets; the ticket #${story.number} holds ${ticket?.runs.length} runs`);
  check(ticket.runs[0].runId === again.runId && ticket.runs[0].ordinal === 2 && ticket.runs[1].ordinal === 1, "its runs are listed newest first and numbered in the order they started");
  check(new Set(ticket.runs.map((r) => r.conversationId)).size === 2 && ticket.runs[0].conversationId === conv, "each run keeps its own conversation under the ticket");
  check(ticket.key === second.run.ticketKey && second.ticket?.runs.length === 2, "a run knows its ticket and the other runs of it");
  check(tickets.find((t) => t.issueNumber === bug.number)?.runs.length === 1 && ticket.active && ticket.pending === 0, "other tickets keep their own runs; this one is active with nothing to decide yet");

  const stream = listen();
  await say(conv, "Constraint: do not touch the existing page.js");
  const v2 = await waitForPlan(conv, "plan version 2", (c) => c.version === 2);
  check(v2.status === "draft" && v2.plan.constraints.join() === "Constraint: do not touch the existing page.js", "the requester's constraint is in version 2 of the plan");
  check(
    v2.changes.some((c) => c.what === "plan" && c.title === "Constraints") && v2.changes.some((c) => c.what === "subtask" && c.kind === "changed" && c.title === "Use negate on the shop page"),
    `the card says what changed: ${v2.changes.map((c) => `${c.kind} ${c.title}`).join(", ")}`,
  );
  check(/do not touch/.test(v2.promptedBy ?? "") && v2.hash !== v1.hash, "version 2 records the request that prompted it");
  const timeline = (await api(`/api/conversations/${conv}`)).messages;
  check(
    timeline.findIndex((m) => m.components.some((c) => c.type === "plan")) > timeline.findLastIndex((m) => m.author === "architect"),
    "the plan card moved below the architect's reply, where the requester is reading",
  );
  let versions = await api(`/api/runs/${again.runId}/plans`);
  check(versions.map((v) => v.status).join() === "superseded,draft" && versions.every((v) => /^architect@/.test(v.author)), "version 1 stays viewable as superseded; both were written by the architect");
  check(stream.notices.some((n) => n.t === "delta" && n.c === conv && n.text), "the architect's reply reached the conversation while it was being written");
  stream.stop();

  await say(conv, "Looks good, put it up for approval");
  const proposed = await waitForPlan(conv, "the plan put up for approval", (c) => c.status === "proposed" && !!c.approvalId);
  const waiting = await api(`/api/runs/${again.runId}`);
  check(proposed.version === 2 && waiting.run.state === "awaiting_approval" && waiting.pending.some((p) => p.id === proposed.approvalId), "version 2 is up for approval and the run waits for the requester");
  ticket = (await api("/api/tickets")).find((t) => t.issueNumber === story.number);
  check(ticket.pending === 1 && ticket.runs[0].pending === 1, "the hierarchy shows a decision waiting on the ticket and its run");

  await say(conv, "One more constraint: do not rename anything");
  const v3 = await waitForPlan(conv, "plan version 3", (c) => c.version === 3);
  const voided = await api(`/api/runs/${again.runId}`);
  check(v3.status === "draft" && !voided.pending.some((p) => p.kind === "plan") && voided.run.state === "designing", "a newer version voids the approval asked for the older one");
  check(await refused(api(`/api/approvals/${proposed.approvalId}/plan`, { method: "POST", body: { decision: "approve", hash: proposed.hash } })), "the voided approval can no longer be used");
  await say(conv, "Now please go ahead with the approval");
  const final = await waitForPlan(conv, "version 3 put up for approval", (c) => c.version === 3 && c.status === "proposed" && !!c.approvalId);
  check(await refused(api(`/api/approvals/${final.approvalId}/plan`, { method: "POST", body: { decision: "approve", hash: v2.hash } })), "approval with the hash of another version is refused");
  check(await refused(api(`/api/approvals/${final.approvalId}/plan`, { method: "POST", body: { decision: "reject", hash: final.hash } })), "a plan cannot be rejected or edited here: changes are asked for in the conversation");
  await api(`/api/approvals/${final.approvalId}/plan`, { method: "POST", body: { decision: "approve", hash: final.hash } });

  console.log("6. The approved plan is built across two repositories: the requester checks each change before its pull request opens");
  const { d: firstCheck, st: c1 } = await subtaskIn(again.runId, "calc-negate", ["awaiting_check"]);
  check((await planCardOf(conv)).status === "approved" && firstCheck.design.state === "closed", "the plan card shows the approved version and the design session is closed");
  check((await say(conv, "hello")).to === "front-door", "after the session the conversation is answered by the front-door agent again");
  versions = await api(`/api/runs/${again.runId}/plans`);
  check(versions.map((v) => v.status).join() === "superseded,superseded,approved", "all three versions are kept; the third is the approved one");
  let hub = await gh("/_test/state");
  const storyKey = `acme/demo#${story.number}`;
  const children = hub.subIssues.filter((x) => x.parent === storyKey).map((x) => hub.issues.find((i) => i.k === x.child));
  check(
    children.length === 2 && children.map((c) => c.k.split("#")[0]).join() === "acme/demo,acme/web" && children.every((c) => c.labels.includes("ai-subtask") && c.state === "open"),
    `the ticket has a sub-issue per sub-task, each in the repository it changes: ${children.map((c) => c.k).join(", ")}`,
  );
  check(hub.comments[storyKey].some((c) => /Plan approved\*\* \(version 3\)/.test(c.body) && c.body.includes(`acme/web#${children[1].number}`)), "the approved plan is summarised on the ticket");
  // The story view: every sub-task of the plan from the start, in build order.
  let storyCard = await storyOf(conv);
  check(
    storyCard.subtasks.map((st) => `${st.key}:${st.state}`).join() === "calc-negate:awaiting_check,shop-page:planned" &&
      storyCard.subtasks[1].dependsOn.join() === "calc-negate" &&
      storyCard.products[storyCard.subtasks[1].product] === "Web shop" &&
      storyCard.subtasks[1].ticketNumber === children[1].number,
    "the story view lists every sub-task from the start, in build order, with its product, its sub-issue and what it depends on",
  );
  check(c1.repository === "acme/demo" && c1.branch.endsWith("-calc-negate"), "the calculator sub-task is built first, because the shop sub-task depends on it");
  check(!!c1.conversationId && c1.conversationId !== conv && c1.ticketNumber === children[0].number, "the sub-task has its own conversation and knows its sub-issue");

  // The requester's check of the change: bound to the commit, with nothing pushed before it.
  const check1 = await pendingCheck(c1);
  check(firstCheck.run.state === "awaiting_approval" && (await api("/api/pending")).some((p) => p.id === check1.approvalId && p.kind === "change"), "the change waits for the requester's check");
  check(check1.hash === c1.headCommit && check1.files.map((f) => `${f.path} +${f.added} -${f.removed}`).join() === "negate.js +2 -0", `the card shows the commit and the files changed: ${check1.files.map((f) => f.path)}`);
  check(
    check1.criteria.length === 1 && check1.criteria[0].criterion === "negate(2) returns -2" && /negate\.js/.test(check1.criteria[0].evidence ?? "") && check1.criteria[0].met === true,
    "each acceptance criterion carries the implementer's evidence and the reviewer's judgment",
  );
  check(check1.verification?.passed && check1.review.blocking === 0 && /Added negate\.js/.test(check1.summary), "the card carries the summary, the checks and the review");
  check(hub.pulls.length === 1 && (await refused(gh(`/_test/branch?repo=acme/demo&name=${encodeURIComponent(c1.branch)}`))), "nothing is pushed before the requester's check");
  check(await refused(api(`/api/approvals/${check1.approvalId}/change`, { method: "POST", body: { decision: "approve", hash: "stale" } })), "a check with the hash of another commit is refused");
  check(await refused(decideChange(check1, "changes", "  ")), "asking for changes needs to say what should change");
  await decideChange(check1, "approve");
  await subtaskIn(again.runId, "calc-negate", ["pr_open"]);
  const crossPr1 = await pullOf(c1.branch);
  const pushed1 = await gh(`/_test/branch?repo=acme/demo&name=${encodeURIComponent(c1.branch)}`);
  check(pushed1.commits === 1 && pushed1.log.startsWith(check1.hash), "exactly the approved commit was pushed");
  check(
    crossPr1?.repo === "acme/demo" && /\(1\/2\): Add negate to the calculator/.test(crossPr1.title) && crossPr1.body.includes(`Part of #${story.number}`) && crossPr1.body.includes(`Closes #${children[0].number}`),
    "its pull request is part of the ticket and closes its sub-issue",
  );
  check(/@tester checked this change in the orchestrator before it was opened/.test(crossPr1.body) && !/Merge order/.test(crossPr1.body), "the pull request says that the requester checked the change");

  // The next sub-task starts as soon as the first one is approved and its pull request is open: no waiting for the merge.
  const { d: secondCheck, st: c2 } = await subtaskIn(again.runId, "shop-page", ["awaiting_check"]);
  check(secondCheck.subtasks[0].state === "pr_open" && c2.repository === "acme/web", "the shop sub-task was built while the calculator pull request is still open");
  const shopStep = secondCheck.steps.filter((st) => st.kind === "implement").pop();
  const shopLog = await api(`/api/steps/${shopStep.id}/progress`);
  check(shopLog.some((l) => l.text.includes(`acme/demo@${check1.hash.slice(0, 10)}`)), "its implementer could read the approved calculator change, at exactly the approved commit");
  check(secondCheck.run.plan.summary.includes("do not rename anything") && /negate\(a\)/.test(secondCheck.run.plan.summary), "the implementers get the plan's constraints and the contract between the products");
  const check2 = await pendingCheck(c2);
  check(check2.buildsOn.join() === "Add negate to the calculator" && check2.files.map((f) => f.path).join() === "shop.js" && check2.criteria.length === 2, "its check says what it builds on and shows its own change");
  await decideChange(check2, "approve");
  await subtaskIn(again.runId, "shop-page", ["pr_open"]);
  const crossPr2 = await pullOf(c2.branch);
  const shopBranch = await gh(`/_test/branch?repo=acme/web&name=${encodeURIComponent(c2.branch)}`);
  check(crossPr2?.repo === "acme/web" && crossPr2.base === "main" && shopBranch.files.join() === "shop.js" && shopBranch.commits === 1, "the shop pull request is in the shop's repository with one commit of its own");
  check(
    crossPr2.body.includes(`Part of acme/demo#${story.number}`) && crossPr2.body.includes(`Closes #${children[1].number}`) && crossPr2.body.includes(`Merge after acme/demo#${crossPr1.number} (Add negate to the calculator)`),
    "it links the story across repositories, closes its own sub-issue and states the merge order",
  );
  storyCard = await storyOf(conv);
  check(storyCard.subtasks.every((st) => st.state === "pr_open" && st.prNumber) && storyCard.subtasks[0].conversationId === c1.conversationId, "the story view shows both pull requests open, each with the link to its conversation");

  // Merge order is advice the orchestrator watches: the shop pull request is merged first.
  await gh(`/_test/pulls/${crossPr2.number}/merge`, { method: "POST" });
  await subtaskIn(again.runId, "shop-page", ["merged"]);
  storyCard = await storyOf(conv);
  hub = await gh("/_test/state");
  check(
    new RegExp(`was merged before acme/demo#${crossPr1.number} \\(Add negate to the calculator\\), which it depends on`).test(storyCard.subtasks[1].warnings.join()) &&
      hub.comments[storyKey].some((c) => /Merge order/.test(c.body)),
    "a pull request merged before the one it depends on is flagged on the story and on the ticket",
  );
  check(hub.issues.find((i) => i.k === children[1].k).state === "closed" && (await api(`/api/runs/${again.runId}`)).run.state !== "completed", "its sub-issue is closed; the story is not complete yet");
  await gh(`/_test/pulls/${crossPr1.number}/merge`, { method: "POST" });
  const crossDone = await waitForState(again.runId, ["completed"], 180_000);
  hub = await gh("/_test/state");
  check(crossDone.subtasks.every((st) => st.state === "merged") && children.every((c) => hub.issues.find((i) => i.k === c.k).state === "closed"), "the run completed after both merges and both sub-issues are closed");
  const storyIssue = await issueOf(story.number);
  check(storyIssue.state === "closed" && storyIssue.labels.includes("ai-done"), "the story is closed by the orchestrator when its last pull request is merged");
  const crossEvents = crossDone.events.map((e) => e.type);
  check(
    ["design.opened", "plan.version_created", "plan.proposed", "plan.approval_voided", "design.closed", "plan.approved", "ticket.subtasks_created", "change.check_requested", "change.decided", "story.merged_out_of_order"].every((t) =>
      crossEvents.includes(t),
    ) && crossDone.events.every((e, i) => e.seq === i + 1),
    "the events of the design session, the checks and the sub-tasks are in the run's one gapless sequence",
  );

  console.log("7. A design session that falls silent is saved, and restored by the next message");
  const guided = await newIssue("Add multiply with care", "A multiply function that needs a design choice. [guided]", ["ai-ready"]);
  const guidedRun = await runFor(guided.number);
  const designing = await waitForState(guidedRun.id, ["designing"]);
  check(designing.run.track === "guided", "the run is on the guided track");
  const analyseStep = designing.steps.find((s) => s.kind === "analyse");
  const analyseLog = await api(`/api/steps/${analyseStep.id}/progress`);
  check(analyseStep.state === "succeeded" && analyseLog.filter((l) => /^submit_analysis/.test(l.text)).length === 2, "an analysis naming an unknown product was sent back and corrected");
  const gconv = designing.run.conversationId;
  const g1 = await waitForPlan(gconv, "the first draft", (c) => c.version === 1);
  let fake = await call(MODEL, "/_test/state");
  check(fake.planSentBack && g1.plan.subtasks[1].dependsOn.join() === "multiply" && (await api(`/api/runs/${guidedRun.id}/plans`)).length === 1, "a plan with an unknown dependency was sent back and corrected in the same turn");
  const saved = await waitFor("the session to be saved", async () => {
    const d = await api(`/api/runs/${guidedRun.id}`);
    return d.design?.state === "suspended" ? d : null;
  }, 240_000);
  const firstSession = saved.steps.find((s) => s.kind === "design");
  check(firstSession.state === "succeeded" && /saved/.test(firstSession.summary ?? "") && saved.run.state === "designing", "after a silence the session was saved and its workspace shut down; the run stays in design");
  check((await api(`/api/conversations/${gconv}`)).design?.state === "suspended" && saved.events.some((e) => e.type === "design.suspended"), "the conversation shows the session as resting");
  const turnsBefore = fake.designTurns.length;
  await say(gconv, "Constraint: do not change math.js");
  const g2 = await waitForPlan(gconv, "version 2 after the restore", (c) => c.version === 2);
  const restored = await api(`/api/runs/${guidedRun.id}`);
  const sessions = restored.steps.filter((s) => s.kind === "design");
  const secondLog = await api(`/api/steps/${sessions[1].id}/progress`);
  check(sessions.length === 2 && secondLog.some((l) => /Session restored from its checkpoint/.test(l.text)) && restored.events.some((e) => e.type === "design.resumed"), "the next message started a new workspace that restored the saved session");
  fake = await call(MODEL, "/_test/state");
  const resumedTurn = fake.designTurns[turnsBefore];
  check(resumedTurn?.remembersOpening && !resumedTurn.rebuilt && resumedTurn.prompts === 2, "the restored session still had its memory: the model saw the opening of the session again (R-13)");
  check(g2.plan.constraints.join() === "Constraint: do not change math.js" && g2.plan.subtasks[0].acceptanceCriteria.length === 2, "the architect revised the plan in the restored session");

  // The fallback (R-13): a saved session whose checkpoint is gone is rebuilt from the record of the conversation.
  await waitFor("the session to be saved again", async () => (await api(`/api/runs/${guidedRun.id}`)).design?.state === "suspended", 240_000);
  execFileSync("docker", ["exec", WORKER, "rm", "-f", `/data/artifacts/design-${guidedRun.id}/checkpoint.tgz`]);
  const turnsBeforeRebuild = (await call(MODEL, "/_test/state")).designTurns.length;
  await say(gconv, "One more constraint: do not add dependencies");
  const g3 = await waitForPlan(gconv, "version 3 from the rebuilt session", (c) => c.version === 3);
  const rebuilt = await api(`/api/runs/${guidedRun.id}`);
  const thirdLog = await api(`/api/steps/${rebuilt.steps.filter((s) => s.kind === "design")[2].id}/progress`);
  const rebuiltTurn = (await call(MODEL, "/_test/state")).designTurns[turnsBeforeRebuild];
  check(thirdLog.some((l) => /Session rebuilt from the record/.test(l.text)) && rebuiltTurn?.rebuilt && rebuiltTurn.prompts === 1, "without its checkpoint the session was rebuilt from the record of the conversation");
  check(
    g3.plan.constraints.join(" | ") === "Constraint: do not change math.js | One more constraint: do not add dependencies",
    "the rebuilt architect still knew the earlier constraint, and got the new message once",
  );
  await say(gconv, "Fine, put it up for approval");
  const gProposed = await waitForPlan(gconv, "the plan put up for approval", (c) => c.status === "proposed" && !!c.approvalId);
  await api(`/api/approvals/${gProposed.approvalId}/plan`, { method: "POST", body: { decision: "approve", hash: gProposed.hash } });

  // The first sub-task: the requester asks for a change at the check, and checks the new commit.
  const { st: m1 } = await subtaskIn(guidedRun.id, "multiply", ["awaiting_check"]);
  const mCheck1 = await pendingCheck(m1);
  await decideChange(mCheck1, "changes", "Please also mention zero");
  const mCheck2 = await pendingCheck(m1, 1);
  const reworked = await api(`/api/runs/${guidedRun.id}`);
  check(
    reworked.steps.filter((s) => s.id.includes("-multiply-s")).map((s) => s.kind).join() === "implement,review,implement,review" &&
      reworked.steps.some((s) => /^Changes requested \(1\)/.test(s.title)),
    "the requested change went to the implementer and the result was reviewed again",
  );
  const m1Cards = (await cardsOf(m1.conversationId)).filter((c) => c.type === "change");
  check(
    mCheck2.hash !== mCheck1.hash && /as requested/.test(mCheck2.summary) && m1Cards[0].status === "changes" && m1Cards[0].feedback === "Please also mention zero",
    "the check returned with a new commit; the earlier card shows what was asked",
  );
  check((await gh("/_test/state")).pulls.every((p) => p.head !== m1.branch), "still nothing pushed for it");
  await decideChange(mCheck2, "approve");
  const { d: firstOpen, st: s1 } = await subtaskIn(guidedRun.id, "multiply", ["pr_open"]);
  check(s1.headCommit === mCheck2.hash && s1.checkRounds === 1, "the pull request opened with the commit approved at the second check");
  check(!!s1.conversationId && s1.conversationId !== firstOpen.run.conversationId, "the sub-task has its own conversation");
  const s1Cards = (await cardsOf(s1.conversationId)).map((c) => c.type);
  check(["subtask", "progress", "review", "change", "pull_request"].every((t) => s1Cards.includes(t)), `its conversation holds its own cards: ${[...new Set(s1Cards)].join(", ")}`);
  const runCards = await cardsOf(firstOpen.run.conversationId);
  check(!runCards.some((c) => c.type === "review" || c.type === "pull_request" || c.type === "change"), "the sub-task's cards are not in the run's conversation");
  const guidedTicket = (await api("/api/tickets")).find((t) => t.issueNumber === guided.number);
  check(guidedTicket.runs[0].subtasks.map((st) => st.conversationId).includes(s1.conversationId), "the hierarchy lists the sub-task under its run");
  const pr1 = await pullOf(s1.branch);
  check(/\(1\/2\): Add multiply function/.test(pr1.title) && pr1.base === "main" && pr1.body.includes(`Part of #${guided.number}`) && !pr1.body.includes(`Closes #${guided.number}`), "the first pull request is part of the ticket and does not close it");

  // The second sub-task depends on the first, in the same repository: its branch is stacked on the approved change.
  const { st: n1 } = await subtaskIn(guidedRun.id, "notes", ["awaiting_check"]);
  check(n1.stackedOn === "multiply" && n1.baseCommit === mCheck2.hash, "the second sub-task started from the approved commit of the first, before any merge");
  const nCheck = await pendingCheck(n1);
  check(nCheck.files.map((f) => f.path).join() === "NOTES.md" && nCheck.buildsOn.join() === "Add multiply function", "its check shows only its own change and says what it builds on");
  await decideChange(nCheck, "approve");
  const { st: s2 } = await subtaskIn(guidedRun.id, "notes", ["pr_open"]);
  const pr2 = await pullOf(s2.branch);
  check(
    pr2.base === s1.branch && pr2.body.includes(`builds on #${pr1.number} and targets its branch`) && pr2.body.includes(`Merge after #${pr1.number} (Add multiply function)`),
    "its pull request targets the branch of the first one and states the merge order",
  );
  const own = await gh(`/_test/branch?repo=acme/demo&name=${encodeURIComponent(s2.branch)}&base=${encodeURIComponent(s1.branch)}`);
  const whole = await gh(`/_test/branch?repo=acme/demo&name=${encodeURIComponent(s2.branch)}`);
  check(own.files.join() === "NOTES.md" && own.commits === 1 && whole.files.sort().join() === "NOTES.md,multiply.js", "reviewers see only its own commit, on a branch that contains the change it builds on");
  check((await storyOf(firstOpen.run.conversationId)).subtasks[1].stackedOn === "multiply", "the story view says which branch it builds on");

  // When the first pull request merges, the second one moves to the default branch.
  await gh(`/_test/pulls/${pr1.number}/merge`, { method: "POST" });
  const moved = await waitFor("the stacked pull request to move to main", async () => (await gh("/_test/state")).pulls.find((p) => p.number === pr2.number && p.base === "main"), 180_000);
  check(moved.retargeted === 1 && moved.state === "open", "after the merge of the first pull request the second one targets main");
  await gh(`/_test/pulls/${pr2.number}/merge`, { method: "POST" });
  const guidedDone = await waitForState(guidedRun.id, ["completed"], 180_000);
  const guidedStory = await storyOf(guidedDone.run.conversationId);
  check(guidedDone.subtasks.every((st) => st.state === "merged") && guidedStory.subtasks.every((st) => st.warnings.length === 0), "the run completed after both merges, in order, with no warning");
  check(guidedDone.events.some((e) => e.type === "scm.pr_retargeted") && (await issueOf(guided.number)).state === "closed", "the story is closed when its last pull request is merged");

  console.log("8. Findings still open after two fix rounds: the requester decides");
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

  console.log("9. A fast-track change that turned out too big: the requester switches to the guided track");
  const big = await newIssue("Add a big thing", "Looks small. [big] [file:big.js]", ["ai-ready", "bug"]);
  const bigRun = await runFor(big.number);
  const tooBig = await waitForState(bigRun.id, ["awaiting_approval"]);
  const limitsApproval = (await api("/api/pending")).find((p) => p.runId === bigRun.id && p.kind === "limits");
  const limitsCard = (await cardsOf(tooBig.run.conversationId)).find((c) => c.type === "limits");
  check(!!limitsApproval && /7 files \(the fast-track limit is 5\)/.test(limitsCard?.reasons.join()), `the change is stopped: ${limitsCard?.reasons[0]}`);
  await api(`/api/approvals/${limitsApproval.id}/limits`, { method: "POST", body: { decision: "guided", hash: limitsCard.hash } });
  const redesign = await waitFor(
    "the design session of the guided track",
    async () => {
      const d = await api(`/api/runs/${bigRun.id}`);
      return d.run.track === "guided" && d.plans.length === 1 ? d : null;
    },
    300_000,
  );
  check(redesign.events.some((e) => e.type === "track.changed") && (await issueOf(big.number)).labels.includes("track:guided"), "the track and its label changed to guided");
  check(redesign.subtasks[0].state === "cancelled" && (await gh("/_test/state")).pulls.every((p) => p.head !== tooBig.run.branch), "the fast-track change was set aside and nothing was pushed");
  check(redesign.run.state === "designing" && redesign.design?.state === "active" && (await planCardOf(redesign.run.conversationId))?.status === "draft", "a design session with the architect opened, with a first draft plan");
  await api(`/api/runs/${bigRun.id}/cancel`, { method: "POST", body: { reason: "end of test" } });
  const bigCancelled = await waitForState(bigRun.id, ["cancelled"], 120_000);
  check(bigCancelled.design.state === "closed", "cancelling ends the design session with nothing built");

  console.log("10. A sub-task dropped at the check: nothing is pushed, and the requester decides about the sub-tasks that depend on it");
  const modulo = await newIssue("Add modulo with care", "A modulo function that needs a design choice. [guided]", ["ai-ready"]);
  const moduloRun = await runFor(modulo.number);
  const moduloConv = (await waitForState(moduloRun.id, ["designing"])).run.conversationId;
  await waitForPlan(moduloConv, "the first draft", (c) => c.version === 1);
  await say(moduloConv, "Fine, put it up for approval");
  const moduloPlan = await waitForPlan(moduloConv, "the plan put up for approval", (c) => c.status === "proposed" && !!c.approvalId);
  await api(`/api/approvals/${moduloPlan.approvalId}/plan`, { method: "POST", body: { decision: "approve", hash: moduloPlan.hash } });
  const { st: toDrop } = await subtaskIn(moduloRun.id, "multiply", ["awaiting_check"]);
  const pullsBefore = (await gh("/_test/state")).pulls.length;
  await decideChange(await pendingCheck(toDrop), "drop");
  const asked = await waitFor("the question about the sub-task that depends on it", async () => (await api("/api/pending")).find((p) => p.runId === moduloRun.id && p.kind === "dependents"), 120_000);
  const dependents = (await cardsOf(moduloConv)).find((c) => c.type === "dependents");
  check(
    dependents?.subtask.key === "multiply" && dependents.subtask.state === "dropped" && dependents.dependents.map((x) => x.key).join() === "notes" && dependents.status === "pending",
    "the run asks what to do with the sub-task that depends on the dropped one",
  );
  check(await refused(api(`/api/approvals/${asked.id}/dependents`, { method: "POST", body: { decision: "drop", hash: "stale" } })), "a stale decision is refused");
  await api(`/api/approvals/${asked.id}/dependents`, { method: "POST", body: { decision: "drop", hash: dependents.hash } });
  const droppedRun = await waitForState(moduloRun.id, ["closed"], 180_000);
  hub = await gh("/_test/state");
  check(droppedRun.subtasks.map((st) => st.state).join() === "dropped,dropped" && hub.pulls.length === pullsBefore, "both sub-tasks are dropped and nothing was pushed");
  check(await refused(gh(`/_test/branch?repo=acme/demo&name=${encodeURIComponent(toDrop.branch)}`)), "the dropped change never left the orchestrator");
  const moduloKey = `acme/demo#${modulo.number}`;
  const moduloChildren = hub.subIssues.filter((x) => x.parent === moduloKey).map((x) => hub.issues.find((i) => i.k === x.child));
  check(moduloChildren.length === 2 && moduloChildren.every((c) => c.state === "closed") && hub.comments[moduloKey].some((c) => /was dropped by @tester/.test(c.body)), "their sub-issues are closed and the ticket says what was dropped");
  const moduloCards = await cardsOf(moduloConv);
  check(
    moduloCards.find((c) => c.type === "story").subtasks.every((st) => st.state === "dropped") && moduloCards.some((c) => c.type === "notice" && /Every sub-task was dropped/.test(c.text)),
    "the story view shows both as dropped and the run says that nothing was built",
  );
  const moduloIssue = await issueOf(modulo.number);
  check(moduloIssue.state === "open" && !moduloIssue.labels.includes("ai-done"), "the ticket stays open: nothing was delivered");

  console.log(failures ? `\nFAILED: ${failures} check(s)` : "\nPASSED: all checks");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`);
  process.exit(1);
});
