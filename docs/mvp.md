# Orchestrator MVP — local deployment

The MVP is a thin, working slice of the [reference architecture](architecture.md) for the **personal deployment**, running on your machine with Docker. No audit trail and no observability stack, as agreed.

It now includes **all five increments of iteration 2** (architecture §24): the product catalog, the analyst agent, the two tracks, conversations grouped by ticket, run and sub-task, the reviewer agent with its fix loop, the product's build and test commands, one branch and pull request per sub-task, the design session with the architect agent, versioned hand-off plans, sub-issues on the ticket, work built across several repositories, your check of each change before its pull request opens, sub-tasks that build on an approved change without waiting for its merge, the story view and merge-order warnings, and — new with increment 5 — **switching the track yourself**, **access checks** that make work wait instead of fail, and the handling of failures such as an overloaded model provider. §5 lists what stays simpler than the architecture; §10 is a checklist for the first real runs.

**What it does:** you label a GitHub issue `ai-ready` (or ask in the chat). The orchestrator picks it up and an **analyst agent** studies the ticket and the code: what the work is, which products it touches, how big it is. The orchestrator's rules then choose a track:

- **Fast track** (small, clear change in one place): an agent implements it in an isolated Docker sandbox, a **reviewer agent** reviews it, and a pull request opens, with no stops.
- **Guided track** (stories, larger or unclear work, more than one product): an **architect agent** opens a design session in the run's conversation. You talk the plan through with it; it writes the hand-off plan and revises it as you ask. Nothing is built until you approve a version of the plan. Then each sub-task is implemented and reviewed in the repository it belongs to, on its own branch and in its own conversation; you check its change, and its pull request opens when you approve.

Every change is reviewed by the reviewer agent before its pull request opens; what it finds goes back to the implementer for up to two fix rounds. You review and merge on GitHub, and the run completes.

## 1. What you need

| Requirement | Notes |
|---|---|
| Docker with Compose v2 | Docker Desktop (macOS/Windows), Docker Engine (Linux), Rancher Desktop, Colima or Podman. Give Docker at least 8 GB of memory and ~15 GB of disk |
| A GitHub fine-grained personal access token | For the repositories you want to use (see below) |
| An Anthropic API key | From the Anthropic Console. A Claude Pro/Max subscription cannot be used. Set a monthly spend limit there (the agreed cap is $50) |
| macOS or Linux shell | Windows: use WSL 2 |

### Creating the GitHub token

GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token:

- **Resource owner:** your account. **Expiration:** your choice (90 days is reasonable).
- **Repository access:** *Only select repositories* — every repository you list in `products.yaml`.
- **Repository permissions:** Contents: *Read and write*; Issues: *Read and write*; Pull requests: *Read and write*; Metadata: *Read-only* (automatic).

The orchestrator checks before work starts that it can push to each repository involved (see "Access" in §3). It cannot check the Issues and Pull requests permissions without writing; if one is missing, the work waits for you at that point instead of failing.

## 2. Start it

```bash
git clone <this repository> && cd orchestrator
./bin/orchestrator init        # creates .env, products.yaml and a local signing secret
# edit .env: GITHUB_TOKEN, ANTHROPIC_API_KEY
# edit products.yaml: your products and their repositories (see below)
./bin/orchestrator up          # builds the images (first time: several minutes) and starts everything
```

Open **http://localhost:3000**.

### The product catalog (`products.yaml`)

The catalog says what each product owns and where its code lives. It replaces the `GITHUB_REPOS` list: the orchestrator watches and works on the repositories in it, and nowhere else.

```yaml
products:
  - id: calc                      # lowercase letters, digits, dashes
    name: Calculator library
    description: >                # what it owns AND what it does not: the analyst uses this to place work
      Owns the arithmetic functions. Does not own any web page.
    owners: [your-github-login]
    repositories:
      - id: your-account/calc     # a repository belongs to exactly one product
        role: library
        contractPaths: ["index.d.ts"]   # where its interfaces live: work touching them is never fast track
  - id: shop
    name: Web shop
    description: Owns the shop's pages, which call the calculator library.
    repositories:
      - id: your-account/shop
        role: web client
```

- [`products.example.yaml`](../products.example.yaml) shows every setting. `products.yaml` is git-ignored.
- **Coming from the MVP?** If your `.env` still has `GITHUB_REPOS`, `init` creates `products.yaml` with one product per repository. Improve the descriptions when you can.
- A run keeps the catalog version it started with; edits apply to new runs. An invalid file stops new runs and shows a banner in the web app; the *Products* page of the operator view shows what was loaded.
- Product teams keep their guidance for agents in their own repository, in `AGENTS.md` or `.github/copilot-instructions.md`. Agents get it as information about conventions; it cannot change their tools or any approval, and changing those files is a high-risk change.

**Upgrading from the MVP:** runs that were in flight cannot continue on the new workflow. At start-up they are stopped and marked as failed with an explanation; label the issue again to restart the work.

| Command | Does |
|---|---|
| `./bin/orchestrator logs [service…]` | Follow logs (e.g. `logs worker`) |
| `./bin/orchestrator status` | Container status |
| `./bin/orchestrator down` | Stop (data is kept) |
| `./bin/orchestrator reset` | Stop and delete all local data |

## 3. Use it

**Start work** in either way:

- **Label an issue `ai-ready`** in a repository of the catalog. Only labels you add yourself count (the orchestrator checks who added it). It is picked up within about a minute. Labels such as `bug` or `story` are a hint for the analysis; a `story` always takes the guided track.
- **Ask in the chat:** "work on owner/repo#12", or "create an issue in owner/repo to add input validation to the signup form".

**Every run has its own conversation, grouped by ticket.** The side panel lists your tickets; under each ticket are its runs, newest first ("Run 2 · guided · executing"). A ticket that is run again keeps all its runs together. A ticket opens by itself while it is active or waits for you; a dot marks where a decision is waiting. Your chats with the assistant are listed below the tickets, and a chat that started a run shows a link card to it.

**Follow and steer it** in the run's conversation:

1. A **work item** and a **progress** card appear.
2. The analyst agent studies the ticket and the code. If the ticket is unclear, a **questions** card appears. Answer there, or reply on the GitHub issue.
3. An **analysis** card shows what the analyst understood, the products involved and why, the size, and the **track** with the reasons for it. The track is decided by the orchestrator's rules: the analyst only proposes. The analysis is also posted on the issue, which gets the label `track:fast` or `track:guided`.
4. **Fast track:** the card shows the intended approach; the change is built right away. **Guided track:** the design session opens (see below), and the build starts when you approve the plan.
5. An agent implements the change in a sandbox. When your catalog gives the repository a build or test command, the orchestrator runs it on the result; if it fails, the same agent is asked to repair it (twice at most).
6. The **reviewer agent** reviews the change in a fresh sandbox, against the acceptance criteria, the plan and the product's guidance. A **review** card shows its summary, the findings with their severity, and the checks that ran.
   - *Blocking* and *major* findings go back to the implementer, then the change is reviewed again: up to two fix rounds. *Minor* findings never block.
   - If findings are still open after that, a card asks you to decide: *Guide and retry* (one more round with your guidance), *Open the pull request anyway* (the findings are listed in it), *Take over the branch* (it is pushed without a pull request), or *Cancel*.
7. On the fast track the finished change is checked against the fast-track limits again. If it turned out bigger (more files than allowed, or an interface touched), a card asks you: *Continue*, *Switch to the guided track* (the change is set aside and a plan is agreed first), or *Cancel*.
8. If the change touches CI/CD, infrastructure, dependency manifests, ownership files or agent guidance files, a **high-risk** card asks for approval before anything is pushed — on both tracks.
9. A **pull request** card links the PR. Its description carries the AI review (what was fixed, what is open) and the checks, marked as written by an agent. Review and merge it on GitHub.

**Guided track: the design session.** After the analysis, the architect agent opens the session by itself: it reads the ticket, the analysis and the code (read-only, in every repository the analysis named; it can open more), writes a first message and a first draft of the **hand-off plan**. A strip at the top of the run's conversation says you are talking to the architect.

- **Talk to it.** Ask about the code, set constraints ("do not change the public API"), ask for a sub-task to be split or dropped. Its reply appears while it is written. Messages you send while it is working are answered together.
- **The plan card is read-only.** It shows the goal, the approach, your constraints, the contracts between products, and the sub-tasks grouped by product and numbered in build order. Every change the architect makes is a new **version**; the card says what changed and which request of yours prompted it, and the arrows show earlier versions. You never edit the plan yourself: you ask, the architect writes.
- **Approving.** When you are happy, ask the architect to put the plan up for approval. An *Approve version N* button appears on the card. It approves exactly the version shown: if a newer version appears, the earlier request for approval is void. Typing "approve" in the conversation approves nothing; the architect cannot approve either.
- **Pauses.** After 20 minutes of silence (`DESIGN_IDLE_SECONDS`) the session is saved and its sandbox shut down. Your next message restores it, which takes up to a minute; the strip tells you. If a saved session cannot be restored, the architect is given the record of the conversation and the current plan instead.
- **A long session.** If the session has grown long and the architect gets slow or loses track, use *Start afresh from the current plan* in the strip: the architect keeps the analysis and the current plan, but not the conversation before that point.
- To stop, cancel the run (operator view). Nothing was built.

**After the approval** the plan is summarised on the ticket, and each sub-task becomes a **sub-issue** of the ticket in the repository it changes (label `ai-subtask`). If GitHub refuses the sub-issue link, the ticket still lists the issues. The sub-tasks are then built in the plan's order, each after the ones it depends on.

**Guided track: one conversation per sub-task.** Each sub-task appears under its run in the side panel, with its own conversation: its description, progress, review, your check of the change, decisions and pull request. The run's conversation keeps the analysis, the design session, the plan and the story view.

**Guided track: your check of each change.** After the AI review, and before anything is pushed, a **check of the change** card appears in the sub-task's conversation. It shows what the implementer says it did, each acceptance criterion with the implementer's evidence and the reviewer agent's judgment, the files changed with their line counts, the result of the product's commands, and a summary of the AI review. It does not show the code: you read the code in the pull request. (A view of the code changes in the app is planned as a second stage.) You decide:

- *Approve and open the pull request*: exactly the commit named on the card is pushed, and the pull request opens. Its description says that you checked the change.
- *Request changes*, with what should change: the implementer does another round, the reviewer reviews again, and the card comes back with a new commit.
- *Drop the sub-task*: it is closed as not done, its sub-issue is closed as not planned, and nothing is pushed. If sub-tasks that have not started depend on it, a card asks you whether to drop them too, build them without it, or cancel the run.

**Guided track: sub-tasks that build on each other.** Sub-tasks are built one at a time, in the plan's order. The next one starts as soon as the one before it has passed your check and its pull request is open; it does not wait for the merge.

- *Same repository:* the branch of the dependent sub-task starts from the approved commit, and its pull request targets the branch of the first one, so reviewers see only its own change. When the first pull request is merged, the orchestrator moves the second one to the default branch and brings its branch up to date. If that merge conflicts, the story view says so and you resolve it in the pull request.
- *Another repository:* the dependent sub-task starts from its own default branch; its implementer and reviewer get the other repository read-only, at the approved commit. Its pull request says "merge after" with a link.
- *Merge order* is advice, not a lock: if a pull request is merged before one it depends on, the story view and the ticket show a warning.

**The story view** in the run's conversation lists every sub-task of the plan from the start, grouped by product and numbered in build order: its state (planned, in progress, AI review, awaiting your check, pull request open, merged, dropped), its conversation, pull request and sub-issue, what it must be merged after, and any warning. Each pull request closes its own sub-issue. The story is complete when every sub-task that was not dropped is merged; the orchestrator then closes the ticket. A pull request closed without merging does not stop the other sub-tasks; the run then ends as "closed", saying what was not delivered.

**What is pushed** is one commit per sub-task: the implementation and its fix rounds are squashed, so nothing from an earlier round stays in the history.

**Switching the track yourself.** The run's conversation shows the track and, while it is allowed, a button to switch it, with an optional reason that is recorded on the ticket:

- *Fast → guided*, at any time before the pull request opens: the change being built is set aside (nothing is pushed), any decision it was waiting for is closed, and a design session starts from the analysis.
- *Guided → fast*, until you approve a plan, and only while the work stays in one repository: the design session ends, and the current plan (or the analysis, if there is no plan yet) becomes a single change, built with no stops before the pull request. A plan in two repositories cannot go to the fast track; the conversation says why.
- The switch, who made it and why are in the run's timeline and on the ticket; the `track:` label follows. If the work has moved on when your request arrives (for example the pull request is just being opened), the orchestrator says so and nothing changes.

**Access.** Before an agent works on a sub-task, the orchestrator checks that your token can push to its repository: the token must see the repository, you must have write access, and a push that sends nothing must be accepted. A plan is put up for approval only when this holds for every repository in it; otherwise the conversation says what is missing. If access is missing, or a push or pull request is refused later (for example because the token expired), the work does not fail: a **blocked** card says what could not be done and why, and waits. Fix the access, then *Retry*; or *Cancel*. If GitHub refuses to create a sub-issue in a repository, that sub-task is built without one and the ticket says so.

**When the model provider is in trouble.** The agent runtime retries a failing model call a few times by itself. If a step still fails because of the provider (rate limit, overload, an outage), the orchestrator waits and tries again (after 1, 5 and 15 minutes by default, `MODEL_RETRY_SECONDS`); the progress card says "waiting for the model provider". Any other failure of a step is tried once more before the work stops.

**When is work fast track?** Only when all of this holds: the expected behavior is clear, the change stays in one area of one product, the size is S (at most `FAST_TRACK_MAX_FILES` files, 5 by default), no interface (contract path) or high-risk file is expected to change, and the ticket is not a story. Anything else is guided.

**Work across several repositories** always takes the guided track. The analyst names the products involved (it opens other products' repositories read-only when it needs to); the architect fixes the contract between them in the plan; each sub-task changes exactly one repository and is built by an implementer working in that repository, with that product's guidance and commands. A sub-task that uses another product's change starts once you approved that change and its pull request is open, and can read it.

Orchestrator cards are marked **◆ Orchestrator**: they come from the orchestrator's records, never from the agent's text, so you can trust what an approval card says. Decisions go straight to the orchestrator and never pass through the agent.

**See everything** in the *operator view* (toggle in the header): all runs with their track, grouped by ticket in the same way, and for each run its analysis, track and reasons, plan, steps, a live transcript of what the agent is doing (messages, tool calls, results), the event timeline and a cancel button. The *Products* page shows the catalog. The toggle keeps context: from a run's conversation it opens that run; from a run it opens its conversation.

GitHub stays in sync: the issue gets comments (picked up, questions, analysis, the approved plan, pull request) and labels (`ai-in-progress`, the track, then `ai-done`); on the guided track it also gets its sub-issues, which are closed as their pull requests merge.

Allow **browser notifications** (button in the header) to be told when a decision is needed or a run finishes; they work while the app is open in a tab.

## 4. How it maps to the architecture

| Container | Role in the MVP | Architecture |
|---|---|---|
| `api` | Web app, REST, server-sent events, front-door agent (Copilot SDK, `mode: "empty"`, orchestrator tools only) | §6, §7.1, §7.5 |
| `worker` | Temporal workflows (delivery skeleton, discovery poller) and activities (GitHub, git, steps) | §7.2, §9, §14.1 |
| `workspace-manager` | The only service that talks to Docker; creates and destroys sandboxes; reaps orphans | §7.3 |
| `sandbox-gateway` | The only service sandboxes can reach: step brief, repository bundle, progress, result | §7.4 |
| `egress-proxy` | Holds the Anthropic key and injects it; forward proxy restricted to package registries | §6, §13 |
| `workspace` image | One container per step (analysis, implementation, review), and one that stays up for a design session: workspace-host drives a Copilot SDK session (bring-your-own-key, Claude) | §7.3, §15 |
| `postgres` | Runs, events, steps, approvals, conversations | §10, §11 |
| `temporal` | Durable execution | AD-12, AD-23 |

Security properties implemented as designed: sandboxes run as non-root with a read-only root filesystem, no capabilities, CPU/memory/process limits, on an internal network that reaches only the gateway and the egress proxy. They hold no GitHub token and no Anthropic key; code arrives as a git bundle and leaves as one; the worker secret-scans and risk-checks before pushing, and pushes only `agent/**` branches.

## 5. Deliberate simplifications (MVP vs. architecture)

| Area | MVP | Architecture (later) |
|---|---|---|
| Audit and observability | None (as requested) | Hash-chained audit, OpenTelemetry (CAP-13) |
| Sign-in | None: single user, bound to `127.0.0.1`, Host-header and CSRF-header checks | GitHub sign-in for the owner (personal), Entra ID (business) |
| Secrets | `.env` file (git-ignored), each secret passed only to the service that needs it | OS keychain injected by the launcher (personal), Key Vault (business) |
| Temporal persistence | Temporal dev server with a SQLite file on a volume | Temporal on PostgreSQL |
| Design session | One read-only sandbox per session, saved after a silence; the reply is shown while it is written, but you cannot interrupt the architect mid-reply | Steering an agent while it works (FR-N2), a pool of warm sandboxes |
| Reviewer model | The same model as the implementer unless you set `ORCH_REVIEWER_MODEL`; one provider locally | Another model family by default where the deployment offers one (AD-39) |
| Check of the change | The card describes the change (summary, evidence, files and line counts, checks, review); the code is read in the pull request | A view of the code changes in the app, unified and side by side (FR-N12, second stage) |
| Stacked branches | When the first pull request is merged, the second is moved to the default branch and brought up to date; a conflict is flagged for you to resolve | An agent fixes the conflict (bounded) |
| Sub-task order | One sub-task is built at a time | Independent sub-tasks in parallel (FR-N7) |
| Access check | Push access checked before each sub-task is built and before a plan is put up for approval; Issues and Pull requests permissions only found out when used (the work then waits for you) | The same, plus Jira projects in the business deployment (AD-42) |
| A ticket changed during a run | Not watched: a run goes on with the ticket as it was when it started | The run pauses at the next safe point and asks you (§9 of the architecture) |
| Pausing a run | Not available: cancel and run the ticket again | Pause and resume from the conversation (FR-N2) |
| Sandbox images | One image for every product (with an optional JDK) | An image per product, chosen in the catalog |
| Fix loops | None: humans handle CI failures and review comments on GitHub | CI fix and review fix loops (bounded) |
| Workflow upgrades | Runs in flight are retired at start-up | Workflow versioning with patching (AD-18) |
| Budgets, compensation | Not implemented | NFR-CO-01..03; compensation on cancel |
| Policy | Risk rules and approval checks in code | Cedar policies (AD-16) |
| Agent tools | Built-in Copilot tools in the sandbox; the gateway serves `request_repository` and checks analyses against the catalog | All read tools through the sandbox gateway (§7.4) |
| Generative UI transport | Own SSE notices plus REST, rendering our catalog directly | AG-UI events and A2UI renderers (D13) |
| Notifications | Browser notifications while the app is open | Web Push, Jira mentions |
| Stack | GitHub and Claude only | Jira, Bitbucket, Jenkins, Copilot seats, Azure |
| Egress | Forward proxy does not chain to a corporate proxy for package registries | Configurable |

## 6. Costs

Every analysis, implementation and review step calls the model, and so does every reply of the architect in a design session; a change with fix rounds costs more than one without, and a long design session more than a short one. `ORCH_MODEL` defaults to `claude-opus-5-5` (most capable); `claude-sonnet-5-5` is cheaper and usually enough for small issues. Keep a spend limit in the Anthropic Console as a hard backstop.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `Docker is not running` | Start Docker Desktop (or your engine) |
| Build fails pulling `node:22-bookworm` (rate limit) | Wait and retry, log in with `docker login`, or set `NODE_IMAGE` to a mirror, e.g. `NODE_IMAGE=mirror.gcr.io/library/node:22-bookworm` in `.env` |
| Build fails with certificate errors behind a corporate proxy | Put the proxy's CA certificate (`.crt`) in `infra/local/certs/` and rebuild |
| Port 3000 in use | Set `ORCH_PORT` in `.env` |
| A run fails with "Workspace image … not found" | Run `./bin/orchestrator up` again (it builds the sandbox image) |
| Podman | Set `DOCKER_SOCKET_PATH` in `.env` to your Podman socket |
| Agents cannot install dependencies | Add the registry host to `EGRESS_ALLOWLIST` in `.env` |
| Java/Gradle repositories | Set `WORKSPACE_WITH_JDK=1` and run `./bin/orchestrator up` |
| Nothing happens after labelling | Check `./bin/orchestrator logs worker`: the label must be added by the token's owner, and the repository must be in `products.yaml` |
| Banner "Product catalog problem" | `products.yaml` is invalid; the message names each problem. Fix the file; no restart is needed |
| A run fails with "not in the product catalog" | The issue's repository, or one the analysis named, is missing from `products.yaml` |
| Runs show "Stopped by an upgrade" | They were started by the previous version; label the issue `ai-ready` again |
| The architect says "I could not reply" | Its sandbox was lost three times in a row, or the model call failed. Send your message again; see `./bin/orchestrator logs workspace-manager` |
| The architect takes a minute to answer after a break | Expected: its session was saved and is being restored in a new sandbox. Raise `DESIGN_IDLE_SECONDS` in `.env` to keep sandboxes up longer |
| A **blocked** card: "cannot push to …" or "has no write access" | Give the token access to that repository (fine-grained token: add it under *Repository access*, with Contents, Issues and Pull requests set to *Read and write*), or renew an expired token in `.env` and restart with `./bin/orchestrator up`. Then press *Retry* |
| The progress card says "waiting for the model provider" | The model provider is rate-limiting or overloaded; the step is tried again by itself. Check the Anthropic status page and your spend limit |
| The architect has become slow or confused in a long design session | Use *Start afresh from the current plan* in the design strip |
| The "switch track" button is missing | Switching is possible only before the pull request opens (fast → guided), or before a plan is approved and with one repository (guided → fast). The conversation says why when it is not |

## 8. Development

```bash
npm install
npm run build                 # TypeScript project build + web app
npm test                      # unit and workflow tests (downloads Temporal's test server once)
TEMPORAL_TEST_ADDRESS=localhost:7233 npm test   # use an existing Temporal server instead
BUILD=1 ./test/e2e/run.sh     # full end-to-end run in Docker with fake GitHub and fake Anthropic API
```

The web app can run with hot reload against a running stack: `npm run dev -w @orch/web` (proxies `/api` to port 3000).

## 9. What was verified

| Check | Result |
|---|---|
| Unit tests: secret scanning, risk rules and product risk paths, path globs, egress allowlist, workspace tokens, hashing, component sanitizing, grouping of runs by ticket, review rounds (what goes back to the implementer, what counts as fixed), product catalog validation, track rules, fast-track limits on a real change, analysis checks against the catalog, hand-off plan checks (keys, the reserved key of the fast track, products, repositories, dependencies, cycles, contracts), build order, what changed between two plan versions | Pass (32) |
| Workflow tests on Temporal, with the run workflow, the design session workflow and the sub-task workflows: fast track with a clean review; a finding fixed and re-reviewed; findings still open after two fix rounds, with each of the requester's four decisions; a change beyond the fast-track limits, continued or switched to a design session; high-risk rejected; implementation failure; analyst questions; analysis failure; building in another repository than the ticket's. Guided track: the architect opens the session and a plan version is approved; each change is checked by the requester before it is pushed, and the next sub-task is built while the first pull request is still open; across repositories the dependent sub-task can read the approved change and its pull request states the merge order; in one repository it is stacked on the approved commit, and its pull request moves to the default branch when the first one merges; changes requested at the check lead to another round and a new commit; a dropped sub-task, with its dependents dropped too or built without it; a pull request merged before the one it depends on is flagged; a closed pull request does not stop the other sub-tasks; a failed sub-task fails the run and ends the waiting ones; a newer plan version voids a pending approval; the session saved after a silence and resumed; a lost session workspace replaced with the same turn; cancelling during the design session, while a pull request waits and the next change is at the check, and while a sub-task waits for a decision. Increment 5: a fast-track change switched to the guided track by the requester while it waited for a decision, and the switch refused once it was being published; a design session switched to the fast track with its plan made into one change, and refused when the plan changes two repositories; a run that comes back to the design session with turns and events of its own; a sub-task that waits while the token cannot push, before the build and when the push is refused, then goes on or is cancelled; a plan not put up for approval while access is missing; a step that failed on the model provider waited out and tried again; a design session started afresh | Pass (37) |
| End-to-end in Docker with a fake GitHub (two repositories of two products) and a fake Anthropic API, agents run by the real Copilot runtime in sandboxes. Fast track: the analyst's questions; the product's test command failing on the first version and the implementer repairing it in the same session; a major review finding fixed and confirmed by a second review; one squashed commit; the pull request with the review, the fixed finding and the checks; merge and ticket write-back. Catalog, analysis card, track labels, one conversation per run with the link card, a second repository opened on demand, the rules overruling the analyst's track, an analysis naming an unknown product sent back, product guidance reaching the agent as content. Design session: opened by the architect with a first draft; messages routed to the architect only while the session is open; an answer that changes nothing creates no version; a table shown by the architect; a constraint creates version 2 with what changed and the request that prompted it; the reply reaching the conversation while it is written; the plan card following the conversation; the plan put up for approval; a newer version voiding that approval; a stale hash and a rejection refused; all versions kept; a plan with an unknown dependency sent back in the same turn; a silent session saved and its sandbox shut down, then restored in a new sandbox with its memory; a session without its checkpoint rebuilt from the record; cancelling during the design. Build across two repositories: a sub-issue per sub-task in the repository it changes, attached to the ticket; the story view listing every sub-task from the start; the dependency built first although listed second; the requester's check of each change (commit, files with line counts, evidence per criterion with the reviewer's judgment, checks, review), nothing pushed before it, a stale commit refused, exactly the approved commit pushed; the dependent sub-task built while the first pull request is open, reading the approved change at its commit; the merge order stated in the pull request; a pull request merged out of order flagged on the story and on the ticket; sub-issues closed on merge and the story closed by the orchestrator; a ticket run twice grouped under it. One repository: changes requested at the check, another round and a new commit; the second sub-task stacked on the approved commit, its pull request targeting the first one's branch and showing only its own commit, then moved to the default branch after the first merge. A sub-task dropped at the check: the question about its dependent, both dropped, nothing pushed, sub-issues closed, the ticket left open. Increment 5: the requester switching a fast-track change to the guided track while it waits for a high-risk approval (who and why on the timeline and the ticket, the label, nothing pushed, the waiting decision closed), then back to the fast track from the design session (the plan made into one change, the plan card closed), and refused once the pull request is open; a change waiting before it is built because the user has no write access, then waiting again because the repository refuses the push, and opening its pull request after the access is fixed and retried; a plan not put up for approval while access is missing; a design session started afresh with only the analysis and the current plan, keeping its constraints; an overloaded model provider (the runtime's own retries used up) waited out until the analysis succeeds. Open findings after two fix rounds: decision card, stale decision refused, pull request opened with the finding listed, run cancelled together with its sub-task. A change beyond the fast-track limits: stopped, switched to a design session, nothing pushed | Pass (170 checks) |
| Browser check of the web app against that stack: pages load under the content security policy with no console errors; agent text with an image and raw HTML makes no request to another host; the side panel groups conversations by ticket, run and sub-task; review, decision, story and sub-task cards render. A design session driven from the browser: the strip, the architect's opening and the draft plan; a constraint typed in the composer, the reply growing while it is written, version 2 with what changed; earlier versions browsed; the strip after the session was saved; the Approve button once the plan is proposed; after approval the session ends and the sub-tasks appear under the run; the run page lists the plan versions and the session's workspaces. The check of a change driven from the browser: the card with criteria, evidence, files and no code; changes requested with a text, the card returning with a new commit; approval and the pull request card; the story view grouped by product with states, links and merge order; the merge-order warning; the dependents card and the dropped story; the run page with stacked sub-tasks. Increment 5, from the browser: the track bar and the switch with a reason; the design strip with *Start afresh from the current plan*; the blocked card and *Retry* | Pass |

Not verified in the build environment: calls to the real GitHub API and the real Anthropic API (no credentials there; the fakes follow their documented formats). That leaves three things for the first real runs: the quality of the agents' judgment on your repositories — how well the analyst places work and proposes a track, how well the architect plans, and how well the reviewer finds real defects without noise (architecture R-16); attaching a sub-issue in another repository than its parent with a fine-grained token (R-15; if GitHub refuses, the ticket lists the issues instead); moving a stacked pull request to the default branch on real GitHub, including when GitHub has already moved it because the branch below was deleted on merge (R-17); and how a long design session behaves once the runtime compacts it (R-14).

## 10. First real runs: a checklist

The fakes above follow GitHub's and Anthropic's documented formats, but some things can only be learned on real repositories with a real model. A short sequence for the first sessions of the pilot, each step building on the last:

1. **Setup.** Two small repositories you own, in two products of `products.yaml`, each with a `test` command that runs in under a minute. A fine-grained token as in §1, and a spend limit in the Anthropic Console.
2. **A small bug, fast track.** Label a clear one-file bug `ai-ready`. Check: the analysis places it in the right product (R-18); the pull request is right and the AI review is useful rather than noisy (R-16).
3. **Access.** Remove one repository from the token's repository access, then start work in it: a *blocked* card must appear before any agent runs. Add the repository back and press *Retry*. This confirms that GitHub refuses the probe push for a token without write access (architecture AD-42), which the fakes cannot show.
4. **A story across both repositories.** Talk the plan through with the architect, approve it, and check that the sub-issues appear on the ticket in both repositories (R-15). If GitHub refuses the cross-repository sub-issue, the ticket gets a checklist instead; note which, for the architecture.
5. **Two sub-tasks in one repository.** Approve the first change, let the second build on it, merge the first pull request on GitHub, and check that the second pull request moves to the default branch (R-17).
6. **A long design session.** Keep a session going for a while, with pauses, and note how answers change as it grows (R-14). Try *Start afresh from the current plan* once.
7. **Switch tracks.** Switch one run from fast to guided while it is building, and one plan in a single repository back to fast.

Note what surprised you for each step: these notes decide what the next iteration changes.

