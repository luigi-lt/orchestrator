# Orchestrator MVP — local deployment

The MVP is a thin, working slice of the [reference architecture](architecture.md) for the **personal deployment**, running on your machine with Docker. No audit trail and no observability stack, as agreed.

It now includes **increments 1 and 2 of iteration 2** (architecture §24): the product catalog, the analyst agent, the two tracks, conversations grouped by ticket, run and sub-task, and — new with increment 2 — the reviewer agent with its fix loop, the product's build and test commands, and one branch and pull request per sub-task. §5 lists what of iteration 2 is still to come.

**What it does:** you label a GitHub issue `ai-ready` (or ask in the chat). The orchestrator picks it up and an **analyst agent** studies the ticket and the code: what the work is, which products it touches, how big it is. The orchestrator's rules then choose a track:

- **Fast track** (small, clear change in one place): an agent implements it in an isolated Docker sandbox, a **reviewer agent** reviews it, and a pull request opens, with no stops.
- **Guided track** (stories, larger or unclear work): an agent proposes a plan and you approve it in the web app. Then each sub-task is implemented and reviewed on its own branch, with its own pull request and its own conversation, one after the other.

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
4. **Fast track:** the card shows the intended approach; the change is built right away. **Guided track:** a **plan** card asks for your approval: *Approve*, *Request changes* (the agent re-plans with your feedback) or *Reject*.
5. An agent implements the change in a sandbox. When your catalog gives the repository a build or test command, the orchestrator runs it on the result; if it fails, the same agent is asked to repair it (twice at most).
6. The **reviewer agent** reviews the change in a fresh sandbox, against the acceptance criteria, the plan and the product's guidance. A **review** card shows its summary, the findings with their severity, and the checks that ran.
   - *Blocking* and *major* findings go back to the implementer, then the change is reviewed again: up to two fix rounds. *Minor* findings never block.
   - If findings are still open after that, a card asks you to decide: *Guide and retry* (one more round with your guidance), *Open the pull request anyway* (the findings are listed in it), *Take over the branch* (it is pushed without a pull request), or *Cancel*.
7. On the fast track the finished change is checked against the fast-track limits again. If it turned out bigger (more files than allowed, or an interface touched), a card asks you: *Continue*, *Switch to the guided track* (the change is set aside and a plan is agreed first), or *Cancel*.
8. If the change touches CI/CD, infrastructure, dependency manifests, ownership files or agent guidance files, a **high-risk** card asks for approval before anything is pushed — on both tracks.
9. A **pull request** card links the PR. Its description carries the AI review (what was fixed, what is open) and the checks, marked as written by an agent. Review and merge it on GitHub.

**Guided track: one conversation per sub-task.** After you approve the plan, each sub-task appears under its run in the side panel, with its own conversation: its description, progress, review, decisions and pull request. The run's conversation keeps the analysis and the plan, and lists the sub-tasks with their state. For now a sub-task starts when the pull request of the one before it is **merged**; the last pull request closes the issue.

**What is pushed** is one commit per sub-task: the implementation and its fix rounds are squashed, so nothing from an earlier round stays in the history.

**When is work fast track?** Only when all of this holds: the expected behavior is clear, the change stays in one area of one product, the size is S (at most `FAST_TRACK_MAX_FILES` files, 5 by default), no interface (contract path) or high-risk file is expected to change, and the ticket is not a story. Anything else is guided.

**Work across several repositories** is recognised (the analyst opens other products' repositories read-only when it needs to), shown on the analysis card and put on the guided track — but it cannot be built yet: the run stops there and says so. Building across products arrives with increments 3 and 4.

Orchestrator cards are marked **◆ Orchestrator**: they come from the orchestrator's records, never from the agent's text, so you can trust what an approval card says. Decisions go straight to the orchestrator and never pass through the agent.

**See everything** in the *operator view* (toggle in the header): all runs with their track, grouped by ticket in the same way, and for each run its analysis, track and reasons, plan, steps, a live transcript of what the agent is doing (messages, tool calls, results), the event timeline and a cancel button. The *Products* page shows the catalog. The toggle keeps context: from a run's conversation it opens that run; from a run it opens its conversation.

GitHub stays in sync: the issue gets comments (picked up, questions, analysis, plan, pull request) and labels (`ai-in-progress`, the track, then `ai-done`).

Allow **browser notifications** (button in the header) to be told when a decision is needed or a run finishes; they work while the app is open in a tab.

## 4. How it maps to the architecture

| Container | Role in the MVP | Architecture |
|---|---|---|
| `api` | Web app, REST, server-sent events, front-door agent (Copilot SDK, `mode: "empty"`, orchestrator tools only) | §6, §7.1, §7.5 |
| `worker` | Temporal workflows (delivery skeleton, discovery poller) and activities (GitHub, git, steps) | §7.2, §9, §14.1 |
| `workspace-manager` | The only service that talks to Docker; creates and destroys sandboxes; reaps orphans | §7.3 |
| `sandbox-gateway` | The only service sandboxes can reach: step brief, repository bundle, progress, result | §7.4 |
| `egress-proxy` | Holds the Anthropic key and injects it; forward proxy restricted to package registries | §6, §13 |
| `workspace` image | One container per step: workspace-host drives a Copilot SDK session (bring-your-own-key, Claude) | §7.3, §15 |
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
| Guided track | A planning agent proposes the plan in one go; you approve, ask for changes or reject on the card | Design session with the architect agent in the chat, versioned plans (increment 3) |
| Reviewer model | The same model as the implementer unless you set `ORCH_REVIEWER_MODEL`; one provider locally | Another model family by default where the deployment offers one (AD-39) |
| Sub-task order | A sub-task starts when the pull request of the one before it is merged | It starts once the one before it passed your diff check, stacked on its branch (increment 4) |
| Diff check | None yet | You approve each sub-task's change in the app before its pull request opens (increment 4) |
| Sub-issues | None yet: sub-tasks exist in the orchestrator only | Each sub-task is a sub-issue on the ticket (increment 3) |
| Work across repositories | Analysed and classified, not built | One sub-task and pull request per repository, in dependency order (increments 3 and 4) |
| Changing the track | Not yet: the rules decide | The requester can switch any time before the pull request (increment 5) |
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

Every analysis, planning, implementation and review step calls the model; a change with fix rounds costs more than one without. `ORCH_MODEL` defaults to `claude-opus-5-5` (most capable); `claude-sonnet-5-5` is cheaper and usually enough for small issues. Keep a spend limit in the Anthropic Console as a hard backstop.

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
| Unit tests: secret scanning, risk rules and product risk paths, path globs, egress allowlist, workspace tokens, hashing, component sanitizing, grouping of runs by ticket, review rounds (what goes back to the implementer, what counts as fixed), product catalog validation, track rules, fast-track limits on a real change, analysis checks against the catalog | Pass (31) |
| Workflow tests on Temporal, with the run workflow and its sub-task workflows: fast track with a clean review; a finding fixed and re-reviewed; findings still open after two fix rounds, with each of the requester's four decisions; a change beyond the fast-track limits, continued or switched to the guided track; high-risk rejected; implementation failure; analyst questions; analysis failure; work across repositories stops; building in another repository than the ticket's; guided track with two sub-tasks in sequence; a closed pull request stops the remaining sub-tasks; plan rejected; cancelling a run while its sub-task waits for a decision | Pass (18) |
| End-to-end in Docker with a fake GitHub (two repositories of two products) and a fake Anthropic API, agents run by the real Copilot runtime in sandboxes. Fast track: the analyst's questions; the product's test command failing on the first version and the implementer repairing it in the same session; a major review finding fixed and confirmed by a second review; one squashed commit; the pull request with the review, the fixed finding and the checks; merge and ticket write-back. Catalog, analysis card, track labels, one conversation per run with the link card, a second repository opened on demand, the rules overruling the analyst's track, an analysis naming an unknown product sent back, a ticket run twice grouped under it, product guidance reaching the agent as content. Guided track: plan approval (stale hash refused), two sub-tasks each with its own branch, conversation, review and pull request, the second starting from the merged first, only the last pull request closing the ticket. Open findings after two fix rounds: decision card, stale decision refused, pull request opened with the finding listed, run cancelled together with its sub-task. A change beyond the fast-track limits: stopped, switched to the guided track, nothing pushed | Pass (75 checks) |
| Browser check of the web app against that stack: pages load under the content security policy with no console errors; agent text with an image and raw HTML makes no request to another host; the side panel groups conversations by ticket, run and sub-task; review, decision, story and sub-task cards render; the run page lists sub-tasks with their review and checks | Pass |

Not verified in the build environment: calls to the real GitHub API and the real Anthropic API (no credentials there; the fakes follow their documented formats), and therefore the quality of the agents' judgment on your repositories: how well the analyst places work and proposes a track, and how well the reviewer finds real defects without noise (architecture R-16). The first real runs are the remaining check.
