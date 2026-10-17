# Orchestrator Layer — Capability Map

| | |
|---|---|
| **Status** | Agreed baseline (v1.2) |
| **Date** | 2026-10-17 |
| **Phase** | Capability definition — precedes non-functional requirements and reference architecture |

## 1. Purpose and scope

The orchestrator layer turns a request — a ticket or a chat message — into a unit of work that is **controlled, traceable and recoverable**, carried out by one or more AI agents.

This document defines **what** the orchestrator must be able to do. It deliberately says nothing about **how** (components, technologies, build vs. adopt); that is the job of the reference architecture that follows.

## 2. Requirements context

The capability map is shaped by these answers.

| Topic | Answer | Consequence |
|---|---|---|
| First use case | Software delivery: stories, bugs, tech debt | Agents are coding, testing and review agents working on repositories |
| Agent landscape | In-house, one framework: **GitHub Copilot SDK** | Simple agent registry; cross-vendor interop (A2A) deferred to Tier 3 |
| Models | Business: provided through Copilot, which offers multiple providers. Personal: Anthropic models through the Copilot SDK with our own API key | No separate LLM gateway; model choice per step goes through the Copilot SDK in both deployments |
| Blast radius | Agents may write; writes are **gated by risk tier** | Action policy and human approval are Tier 1 |
| Task duration | Hours to days | Durable execution that survives restarts and waits on people and CI |
| Deployment | Two separate deployments of the same software: business and personal (§2.1). Business runs on a single public cloud | No shared instance; differences between deployments are configuration. Cloud provider still to be chosen (see §9) |
| Compliance | Not specified | Assume an enterprise baseline; confirm with security and compliance (see §9) |
| Existing platform | Identity/SSO, observability stack | Integrate with both; durable execution must be provided by the orchestrator |
| Ticket tools | Jira Cloud, GitHub Issues | Two intake adapters behind one common work-item model |
| Ticket write-back | Full: sub-tasks, status, comments, PR links | The ticket is where people follow progress |
| Operators | Platform/SRE, agent developers, engineering leads, auditors | Role-based operator console |
| Channels | User view: web app and Microsoft Teams. Operator view: web only | Generative UI must render on web and as Teams Adaptive Cards |

### 2.1 Deployment scenarios

The same software is deployed twice. The two deployments share nothing: no data, credentials, identities, cloud accounts or billing.

| | Business | Personal |
|---|---|---|
| Purpose | Company software delivery | Personal projects |
| Agent runtime | Copilot SDK with the company's Copilot subscription | Copilot SDK in bring-your-own-key mode with a personal Anthropic API key |
| Models | Those enabled in the company's Copilot | Anthropic Claude models |
| Billing | Copilot premium requests (company) | Anthropic API, per token (personal) |
| Sign-in | Company SSO | Personal account |
| Ticket tools | Jira Cloud, GitHub Issues | GitHub Issues |
| Channels | Web app, Microsoft Teams | Web app |
| Observability | Company observability stack | To be confirmed |
| Hosting | Company public cloud | To be confirmed |

Bring-your-own-key needs an Anthropic API key; a Claude Pro or Max subscription can't be used for this.

## 3. Architecture decisions

| ID | Decision | Rationale |
|---|---|---|
| D1 | **Fixed skeleton, agentic steps.** The orchestrator owns the flow (§4); agents reason freely inside each step. | Predictable and auditable control flow, with agent flexibility where it adds value. |
| D2 | **Central orchestration.** The orchestrator hands work to agents and collects results; external events (webhooks, schedules) only trigger or resume runs. | One place to trace, audit and intervene. |
| D3 | **Agents run in orchestrator-managed sandboxed workers** using the Copilot SDK. GitHub's hosted Copilot coding agent is not used. | Full control over tools, credentials, policy and telemetry. |
| D4 | **Generative UI uses a component catalog.** Agents pick pre-approved components and fill them with data; each channel renders them. | Safe, consistent, testable, and it works within Teams' Adaptive Cards. |
| D5 | **Writes are gated by risk tier**, decided by policy, not by the agent. | Autonomy where the risk is low, human approval where it is high. |
| D6 | **Integrate, don't rebuild,** existing identity/SSO and observability. | Reuse enterprise investments; the orchestrator owns only what's missing. |
| D7 | **One run event stream** feeds the user view, the operator view and ticket write-back. | All surfaces show the same truth (§7). |
| D8 | **Two separate deployments, business and personal, of the same software** (§2.1). Everything that differs between them is configuration, never code. | Company code and data never reach a personal account, and vice versa. The boundary is physical, not a setting someone can get wrong. |
| D9 | **The Copilot SDK is the only agent runtime in both deployments.** The personal deployment reaches Anthropic models through bring-your-own-key. The runtime sits behind an internal interface so the Claude Agent SDK can be added later (CAP-20). | One code path to build, secure and evaluate, with a way out if Copilot's agent loop limits what Claude models can do. |

## 4. The delivery skeleton

Every software-delivery run follows this fixed flow. Agents work inside the steps; the orchestrator owns the transitions.

```
 Intake ─► Readiness ─► Plan ─► Plan approval ─► Execute ─► Review ─► Integrate ─► Close
            check        │         (human)        │  ▲        │  ▲     (gated)
              │          │                        │  │        │  │
              ▼          ▼                        ▼  │        ▼  │
        Ask questions  Sub-tasks             CI fails ─┘   Review comments ─┘
        on the ticket  created in tracker    → fix loop    → fix loop
```

- **Intake:** a ticket or chat request becomes a work item.
- **Readiness check:** is the ticket clear enough? If not, ask on the ticket and wait.
- **Plan:** break the work into sub-tasks, each assigned to an agent role (e.g., implementer, tester, reviewer).
- **Plan approval:** a person approves or edits the plan. Policy may later auto-approve low-risk plans.
- **Execute:** agents implement, test and open pull requests in sandboxed workspaces.
- **Review:** agent review plus human pull-request review; loops back on CI failures or review comments.
- **Integrate:** merging follows risk-tier policy and the repository's branch protection.
- **Close:** ticket updated, outputs linked, workspace cleaned up.

## 5. Context

```
     Users (web app, Microsoft Teams)            Operators (web console)
                    │                                     │
 ┌──────────────────▼─────────────────────────────────────▼────────────┐
 │                         EXPERIENCE LAYER                            │
 │  User view: front-door agent + generative UI  │  Operator console   │
 └──────────────────────────────────┬──────────────────────────────────┘
                                    │ commands · run event stream
 ┌──────────────────────────────────▼──────────────────────────────────┐
 │                           ORCHESTRATOR                              │
 │   intake · plan · route · execute · approve · govern · observe      │
 └───────┬───────────────────┬────────────────────────┬────────────────┘
         │                   │                        │
   Ticket tools        Sandboxed workers         Enterprise platform
   Jira Cloud,         Copilot SDK agents        Identity/SSO,
   GitHub Issues       (models via Copilot)      observability stack
                             │
                  GitHub repos, CI, MCP tool servers
```

The business deployment is shown. The personal deployment has the same shape with its own settings (§2.1).

## 6. Capability map

Tier 1 capabilities are needed from the first release, each in its essential form. Tier 2 makes the platform enterprise-grade. Tier 3 covers scale and optimization.

| ID | Capability | Tier |
|---|---|---|
| CAP-01 | Agent registry | 1 |
| CAP-02 | Planning and routing | 1 |
| CAP-03 | Durable execution runtime | 1 |
| CAP-04 | Agent workspaces (sandboxed workers) | 1 |
| CAP-05 | State, context and memory | 1 |
| CAP-06 | Tool and integration gateway | 1 |
| CAP-07 | Work intake and ticketing integration | 1 |
| CAP-08 | Identity, policy and authorization | 1 |
| CAP-09 | Human in the loop | 1 |
| CAP-10 | User view: chat with generative UI | 1 |
| CAP-11 | Operator view: run console | 1 |
| CAP-12 | Guardrails and safety | 2 |
| CAP-13 | Observability and audit | 2 |
| CAP-14 | Evaluation and quality | 2 |
| CAP-15 | Multi-tenancy and isolation | 2 |
| CAP-16 | Cost and quota management | 2 |
| CAP-17 | Advanced resilience | 3 |
| CAP-18 | Optimization | 3 |
| CAP-19 | Developer experience | 3 |
| CAP-20 | Ecosystem extensions | 3 |

---

### Tier 1 — Core

#### CAP-01 Agent registry

**Purpose:** know which agents exist, what each can do, and which version is live.

- An **agent profile** per role: purpose and instructions, allowed tools and MCP servers, default model, risk tier, owner, version.
- Versioning and promotion (draft → staging → production) and rollback.
- Lookup by role or skill, used by the planner to assign steps.
- Health and availability of each profile.

*Notes:* all agents are built on the Copilot SDK, so profiles map to Copilot SDK custom agents. Cross-vendor interop is deferred to CAP-20.

#### CAP-02 Planning and routing

**Purpose:** turn a work item into an approved plan and send each step to the right agent.

- Break a ticket into sub-tasks with dependencies, acceptance criteria and an assigned agent role.
- Plans are shown and edited as structured data (generative UI plan component), not free text.
- Route each step to an agent profile; choose the model per step from those Copilot offers.
- Patterns supported within the skeleton: sequential, parallel sub-tasks with a join, and fix loops (CI failure, review comments).
- Re-plan when a step fails repeatedly or the ticket changes.

#### CAP-03 Durable execution runtime

**Purpose:** run long tasks reliably over hours or days.

- Checkpoint after every step; resume after crashes, deploys or restarts with no lost work.
- Wait cheaply for external events: human approvals, CI results, PR reviews, ticket replies.
- Retries with backoff, timeouts, idempotent steps.
- Compensation when a run is cancelled or fails: close PRs, delete agent branches, revert ticket status.
- Queues, priorities, concurrency limits, backpressure.
- Runaway prevention: limits on steps, time, and model usage per run; loop detection.
- Emits the **run event stream** (§7).

*Notes:* no workflow engine exists in the enterprise today, so the orchestrator must provide this capability. Build vs. adopt is decided in the architecture phase.

#### CAP-04 Agent workspaces (sandboxed workers)

**Purpose:** give each agent a safe, isolated place to read, change and run code.

- An ephemeral workspace per step or run: container, repository checkout, toolchain.
- Copilot SDK agent hosted inside the workspace, driven by the orchestrator.
- Network egress policy: only allowed hosts (package registries, GitHub, approved tools).
- Short-lived, narrowly scoped credentials injected at start, never stored by the agent.
- CPU, memory, disk and time limits; guaranteed cleanup.
- Transcript, file changes and test output collected as run artifacts.

*Notes:* the Copilot SDK enables all first-party tools by default; workspaces must restrict them through client options to match the agent profile (CAP-01) and policy (CAP-08). Workers drive the Copilot SDK through an internal runtime interface (D9), so the same worker serves both deployments — company Copilot or bring-your-own-key — and another runtime can be added later.

#### CAP-05 State, context and memory

**Purpose:** each agent gets the context it needs, and the run remembers what happened.

- Run and step state (owned by CAP-03).
- Context assembly per step: ticket, plan, relevant code, prior step outputs — scoped and compacted, not everything.
- Artifact store: branches, PR links, diffs, test reports, transcripts.
- Long-term repository knowledge (conventions, architecture notes, past decisions) — essential form in Tier 1, learning from outcomes later.

#### CAP-06 Tool and integration gateway

**Purpose:** controlled access to the systems agents work with.

- Tool access through MCP servers: GitHub (repos, PRs, Actions/CI), Jira, internal systems.
- Per-profile tool allowlists and parameter validation.
- Credential broker: short-lived GitHub App tokens, Jira OAuth tokens; agents never see long-lived secrets.
- Acting on behalf of a user where the action must carry their permissions.

*Notes:* Jira and GitHub appear here as **tools** (an agent reads or updates something during a step) and in CAP-07 as **sources of work**. The two roles stay separate.

#### CAP-07 Work intake and ticketing integration

**Purpose:** pull work from ticket tools and keep the ticket updated as the system of record for people.

- **One common work-item model** (title, description, acceptance criteria, links, attachments, requester, priority), with adapters for **Jira Cloud** and **GitHub Issues**. Chat requests convert to the same model.
- **Triggers:** webhooks plus a filtered queue (JQL or label such as `ai-ready`, or assignment to an agent user), and on demand from chat.
- **Readiness check:** if the ticket is unclear, ask questions as ticket comments and wait.
- **Context enrichment:** linked issues, comments, attachments, linked documentation.
- **Full write-back:** plan mirrored as Jira sub-tasks or GitHub sub-issues, status transitions, progress comments, links to PRs and outputs.
- **Claiming:** a ticket is locked to one run. Issues assigned to GitHub's hosted Copilot coding agent are skipped to avoid double processing.
- **Edits mid-run:** default is pause and ask the requester whether to re-plan.
- **Visibility:** the orchestrator only acts on tickets the requester can see.

#### CAP-08 Identity, policy and authorization

**Purpose:** every action is attributable and allowed.

- User sign-in through the existing identity provider (SSO), for web and Teams.
- Each agent and worker has its own service identity (e.g., a GitHub App installation), distinct from users.
- Every action is checked against **who the run acts for** and **what the agent profile may do**, as policy-as-code.
- **Risk tiers for actions** decide what runs autonomously and what needs approval. Initial classification, to be refined with engineering leads and security:

| Risk | Examples | Gate |
|---|---|---|
| Low | Read code and tickets, run tests in the workspace, push to an agent branch, comment on a ticket | Autonomous |
| Medium | Open a PR, create sub-tasks, change ticket status | Autonomous with notification; a project may require approval |
| High | Merge to a protected branch; change CI/CD, infrastructure or permissions; touch secrets; add new dependencies | Human approval required |

- Repository branch protection remains an independent safety net.

#### CAP-09 Human in the loop

**Purpose:** people approve, steer and take over when it matters.

- **One approval object** per decision, actionable from the web user view, a Teams card or the operator console. Resolved in one place means resolved everywhere. The ticket shows that approval is pending and links to it.
- Approval content is built from **orchestrator data, never from agent text**, and the orchestrator verifies who approved and that they had the authority.
- Plan approval, risk-tier approvals, clarifying questions, escalation on repeated failure.
- Pause, resume, cancel, take over a step.
- Reminders and timeouts for approvals that wait days.

#### CAP-10 User view: chat with generative UI

**Purpose:** a conversational way to ask for, follow and steer work, on **web and Microsoft Teams**.

- A **front-door agent** (Copilot SDK) understands the request and submits work. It is a **client of the orchestrator**, not the orchestrator: planning and governance stay in the skeleton.
- **Generative UI from a component catalog:** forms for missing details, editable plan, approval card, progress tracker, PR and test summary, tables.
- A **channel-neutral component spec** with two renderers:
  - **Web:** full catalog.
  - **Teams:** Adaptive Cards for the components that fit (forms, approvals, progress); a deep link to the web view for the rest (plan graph, diff viewer).
- User actions return as **typed events**, validated by the orchestrator, never as text.
- Any action from a component goes through the same authorization as an API call (CAP-08).
- Long-running work: progress updates in the thread; notification on completion or when input is needed; the conversation resumes days later.
- Starting work from a ticket ("plan PROJ-123") or from scratch, which creates the ticket.

#### CAP-11 Operator view: run console

**Purpose:** see and control what the system is doing. **Web only.**

- **Role-based workspaces:**

| Persona | Primary needs |
|---|---|
| Platform / SRE | Health, failures, queues, capacity, incident handling |
| Agent developers | Step transcripts, tool calls, prompts, model usage, evaluation results |
| Engineering leads | What agents are working on, pending approvals, delivery outcomes and quality |
| Auditors / compliance | Who approved what, what agents changed, full audit history (read-only) |

- **Tier 1 essentials:** run list and search; plan graph with per-step status, agent, inputs and outputs; live transcript; approvals inbox; intervention (pause, resume, cancel, retry, edit plan, re-route, take over).
- **Grows in Tier 2:** trace and audit search (CAP-13), evaluation dashboards (CAP-14), cost and quota views (CAP-16), registry and policy admin (CAP-01, CAP-08).

---

### Tier 2 — Enterprise-grade

#### CAP-12 Guardrails and safety

- **Prompt injection defense:** ticket text, repository content and tool outputs are untrusted input.
- Secret and personal-data detection on agent outputs (commits, comments, PR descriptions).
- Output validation against expected schemas.
- Content policies for agent-written text.
- Builds on the essential limits already in CAP-03 and the tool allowlists in CAP-06 and CAP-08.

#### CAP-13 Observability and audit

- End-to-end traces across orchestrator, workers, tools and model calls via OpenTelemetry, exported to the **existing observability stack**. The Copilot SDK supports OpenTelemetry tracing.
- Metrics: run duration, step success, approval wait time, cost per run.
- Tamper-evident audit trail of plans, approvals, actions and changes.
- Replay of a run for debugging and incident review.

#### CAP-14 Evaluation and quality

- Benchmark set of representative tickets; a new agent profile version must pass it before promotion (CAP-01).
- Outcome signals in production: PR merged or rejected, review comment volume, CI pass rate, reverts, reopened tickets.
- Automated quality review of plans and PRs; user feedback in chat.
- Drift detection when a model or profile changes.

#### CAP-15 Multi-tenancy and isolation

- Tenants by business unit, team or project.
- Isolation of data, memory, repositories and workspaces between tenants.
- Per-tenant configuration: policies, risk-tier overrides, agent profiles, quotas.

*Notes:* tenancy applies within a deployment. Business and personal are separated by deployment (D8), not by tenancy.

#### CAP-16 Cost and quota management

- Track model usage and workspace compute per run, team and project: Copilot premium requests in the business deployment, Anthropic API tokens in the personal one.
- Budgets and quotas with alerts and hard stops.
- Chargeback reporting.

---

### Tier 3 — Scale and optimization

#### CAP-17 Advanced resilience

- Fallback to another model when one is unavailable (Copilot model switching).
- Graceful degradation, e.g., queue new work while still serving status and approvals.
- High availability and disaster recovery across zones or regions.

#### CAP-18 Optimization

- Pick the model per step by cost and quality, learning from CAP-14 outcomes.
- Reuse context and caches across steps and runs.
- Planner improvement from historical plans and their outcomes.

#### CAP-19 Developer experience

- Agent profiles and skeleton variants defined as code, versioned in Git.
- Local simulation and test harness for agent profiles.
- CI/CD pipeline for agent profiles, wired to CAP-14 evaluation.
- Self-service onboarding of a new repository or Jira project.

#### CAP-20 Ecosystem extensions

- The Claude Agent SDK as a second agent runtime, behind the runtime interface (D9).
- Interop with agents outside the Copilot SDK through the A2A (agent-to-agent) protocol.
- Additional ticket adapters (e.g., Azure DevOps, ServiceNow) via the common work-item model.
- Additional channels (e.g., Slack, IDE) via the channel-neutral component spec.
- Use cases beyond software delivery through new skeletons.

## 7. Cross-cutting design rules

1. **One run event stream.** Plan created, step started, approval requested, step completed, run finished. The user view, the operator view and ticket write-back are all consumers of this stream. The event model is a core contract of CAP-03.
2. **One approval, many surfaces.** An approval is a single object, resolved once, visible everywhere (CAP-09).
3. **Untrusted by default.** Ticket text, repository content, tool outputs and anything an agent generates are untrusted until validated (CAP-12).
4. **The UI is never a bypass.** Every action, from any surface, goes through CAP-08 authorization.
5. **Agents propose, the orchestrator disposes.** Agents produce plans, code and messages; the orchestrator decides what is executed, approved and written back.
6. **Configuration, not code, per deployment.** Identity provider, ticket tools, channels, model provider and credentials are deployment settings. No code path checks which deployment it runs in.

## 8. Reference scenario

1. A developer in Teams types: "plan PROJ-123".
2. The front-door agent submits the ticket. Intake pulls it from Jira, adds linked context and passes the readiness check.
3. The planner proposes three sub-tasks. Teams shows a summary card; the developer opens the editable plan on the web, adjusts one sub-task and approves.
4. Sub-tasks appear in Jira. Sandboxed workers implement and test each one and open a pull request.
5. CI fails on one PR; the fix loop handles it. An agent developer watches the transcript in the operator console.
6. One change touches the CI configuration, which is high risk. An approval card appears for the engineering lead, who approves it in Teams.
7. Human review passes, the PR is merged, the Jira ticket moves to Done with PR links, and the developer is notified in Teams.

## 9. Open items for the next phase

| Item | Why it matters | Owner (proposed) |
|---|---|---|
| Compliance requirements (data residency, retention of transcripts and code sent to model providers) | Not specified yet; may constrain models, storage and the cloud region | Security / compliance |
| Copilot licensing and billing for automated agents (seats, premium requests, bring-your-own-key option) | Determines cost model and agent identity setup | Platform + procurement |
| Copilot SDK maturity and language choice | Affects stability and the worker implementation | Architecture |
| Copilot SDK bring-your-own-key with Anthropic: feature parity and maturity | The personal deployment depends on it | Architecture |
| Personal deployment hosting and observability | The last undecided settings of the personal deployment (§2.1) | Personal deployment owner |
| Cloud provider choice | Affects workspace sandboxing and managed services | Platform |
| Build vs. adopt for durable execution | No existing workflow engine | Architecture |
| Generative UI protocol: evaluate AG-UI, A2UI, MCP Apps vs. our own spec | Avoid inventing a protocol if a standard fits | Architecture + frontend |
| Jira ↔ GitHub linking (tickets in Jira, code in GitHub) | Consistent traceability from ticket to PR | Architecture |
| Final risk-tier catalog of actions | Drives autonomy vs. approval | Engineering leads + security |
| Volume, concurrency and latency targets | Capacity planning | Non-functional requirements |

## 10. Next steps

1. **Non-functional requirements:** volume, latency, availability, retention, security baseline.
2. **Reference architecture:** components mapped to capabilities, interfaces, the run event model.
3. **Build vs. adopt decisions** for each component.
4. **First release scope:** a thin slice through every Tier 1 capability — for example, one Jira Cloud project, one repository, web user view plus essential operator console, the full skeleton from intake to merged PR.

## Change history

| Version | Change |
|---|---|
| 1.0 | Initial agreed baseline |
| 1.1 | Two separate deployments, business and personal (§2.1, D8). Copilot SDK as the only runtime in both, with Anthropic models via bring-your-own-key in the personal deployment (D9). Notes added to CAP-04, CAP-15, CAP-16 and CAP-20; design rule 6; two open items |
| 1.2 | Personal deployment: sign-in (personal account), ticket tools (GitHub Issues) and channels (web app) confirmed |
