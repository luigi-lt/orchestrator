# Orchestrator MVP — local deployment

The MVP is a thin, working slice of the [reference architecture](architecture.md) for the **personal deployment**, running on your machine with Docker. No audit trail and no observability stack, as agreed.

**What it does:** you label a GitHub issue `ai-ready` (or ask in the chat). The orchestrator picks it up, an agent studies the repository and either asks clarifying questions or proposes a plan. You approve the plan in the web app. Agents implement each sub-task in isolated Docker sandboxes, the orchestrator checks the changes and opens a pull request. You review and merge on GitHub, and the run completes.

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
- **Repository access:** *Only select repositories* — the ones you will list in `GITHUB_REPOS`.
- **Repository permissions:** Contents: *Read and write*; Issues: *Read and write*; Pull requests: *Read and write*; Metadata: *Read-only* (automatic).

## 2. Start it

```bash
git clone <this repository> && cd orchestrator
./bin/orchestrator init        # creates .env and a local signing secret
# edit .env: GITHUB_TOKEN, GITHUB_REPOS (owner/name, comma-separated), ANTHROPIC_API_KEY
./bin/orchestrator up          # builds the images (first time: several minutes) and starts everything
```

Open **http://localhost:3000**.

| Command | Does |
|---|---|
| `./bin/orchestrator logs [service…]` | Follow logs (e.g. `logs worker`) |
| `./bin/orchestrator status` | Container status |
| `./bin/orchestrator down` | Stop (data is kept) |
| `./bin/orchestrator reset` | Stop and delete all local data |

## 3. Use it

**Start work** in either way:

- **Label an issue `ai-ready`** in one of your configured repositories. Only labels you add yourself count (the orchestrator checks who added it). It is picked up within about a minute.
- **Ask in the chat:** "work on owner/repo#12", or "create an issue in owner/repo to add input validation to the signup form".

**Follow and steer it** in the *user view* (the conversation):

1. A **work item** and a **progress** card appear in the run's conversation.
2. If the issue is unclear, a **questions** card appears. Answer there, or reply on the GitHub issue.
3. A **plan** card asks for your approval: *Approve*, *Request changes* (the agent re-plans with your feedback) or *Reject*.
4. Agents implement each sub-task in a sandbox; the progress card updates live.
5. If the changes touch CI/CD, infrastructure, dependency manifests or ownership files, a **high-risk** card asks for approval before anything is pushed.
6. A **pull request** card links the PR. Review and merge it on GitHub; the run completes when it is merged.

Orchestrator cards are marked **◆ Orchestrator**: they come from the orchestrator's records, never from the agent's text, so you can trust what an approval card says. Decisions go straight to the orchestrator and never pass through the agent.

**See everything** in the *operator view* (toggle in the header): all runs, and for each run its plan, steps, a live transcript of what the agent is doing (messages, tool calls, results), the event timeline and a cancel button. The toggle keeps context: from a conversation it opens that run; from a run it opens its conversation.

GitHub stays in sync: the issue gets comments (picked up, questions, plan, pull request) and labels (`ai-in-progress`, then `ai-done`).

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
| Pull requests | One branch and pull request per run, one commit per sub-task | One branch/pull request per sub-task |
| Fix loops | None: humans handle CI failures and review comments on GitHub | CI fix and review fix loops (bounded) |
| Budgets, compensation | Not implemented | NFR-CO-01..03; compensation on cancel |
| Policy | Risk rules and approval checks in code | Cedar policies (AD-16) |
| Agent tools | Built-in Copilot tools in the sandbox; no MCP tool gateway | Read tools through the sandbox gateway (§7.4) |
| Generative UI transport | Own SSE notices plus REST, rendering our catalog directly | AG-UI events and A2UI renderers (D13) |
| Notifications | Browser notifications while the app is open | Web Push, Jira mentions |
| Stack | GitHub and Claude only | Jira, Bitbucket, Jenkins, Copilot seats, Azure |
| Egress | Forward proxy does not chain to a corporate proxy for package registries | Configurable |

## 6. Costs

Every planning and implementation step calls the model. `ORCH_MODEL` defaults to `claude-opus-5-5` (most capable); `claude-sonnet-5-5` is cheaper and usually enough for small issues. Keep a spend limit in the Anthropic Console as a hard backstop.

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
| Nothing happens after labelling | Check `./bin/orchestrator logs worker`: the label must be added by the token's owner, and the repository must be in `GITHUB_REPOS` |

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
| Unit tests: secret scanning, risk rules, egress allowlist, workspace tokens, hashing, catalog sanitizing | Pass (16) |
| Workflow tests on Temporal: happy path, questions, plan rejected, high-risk rejected, cancel, planning failure | Pass (6) |
| End-to-end in Docker with fake GitHub and fake Anthropic API: chat with generative UI, label pickup, questions answered in chat, plan approval (stale hash refused), implementation by the real Copilot runtime in a sandbox through the egress proxy, push, pull request, merge detection, labels and comments | Pass (16 checks) |

Not verified in the build environment: calls to the real GitHub API and the real Anthropic API (no credentials there; the fakes follow their documented formats). The first real run is the remaining check.
