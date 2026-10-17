# Orchestrator Layer — Non-Functional Requirements

| | |
|---|---|
| **Status** | Agreed baseline (v1.0) |
| **Date** | 2026-10-17 |
| **Phase** | Non-functional requirements — follows the [capability map](capabilities.md), precedes the reference architecture |

## 1. Purpose

The [capability map](capabilities.md) defines **what** the orchestrator must do. This document defines **how well**: scale, speed, reliability, data handling, security, cost, operability and usability.

Each requirement has an ID, a target for each deployment (business and personal, see capabilities §2.1) and a way to verify it. "Same" means the business target applies to both.

## 2. Decisions

| Topic | Decision |
|---|---|
| Scale | Business: pilot team at first release (~20 developers), a department (~200 developers) within 12 months |
| Chat responsiveness | Acknowledge within 2 s; the agent's reply starts streaming within 5 s |
| Availability | Best effort for the first release; no run or approval is ever lost |
| Portability | Same build everywhere: laptop and cloud |
| Retention (business) | Audit trail 1 year; transcripts and step logs 90 days |
| Run over budget (business) | Pause and ask the requester or engineering lead |
| Personal spending cap | $50 per month on Anthropic usage |
| Disaster recovery (business) | Lose at most 1 hour of data; restore within 1 business day |

Set as defaults, open to review:

| Topic | Default |
|---|---|
| Data classification | Source code, tickets and transcripts are Confidential |
| Language | English UI at launch, built so translations need no code changes |
| Accessibility | WCAG 2.2 AA for the web app |

## 3. Requirements

### 3.1 Scale and capacity

| ID | Requirement | Business | Personal | Verification |
|---|---|---|---|---|
| NFR-SC-01 | Users served | First release: ~20 developers. 12 months: ~200, without re-architecture | 1 user | Load test |
| NFR-SC-02 | Runs executing at the same time | First release: ≥ 10. 12 months: ≥ 50 | ≥ 2 (limited by the laptop) | Load test |
| NFR-SC-03 | Runs waiting at the same time (on approvals, CI, replies) | First release: ≥ 100. 12 months: ≥ 1,000 | ≥ 20 | Load test |
| NFR-SC-04 | Repositories and ticket projects | First release: ≤ 5 repos, 1–2 Jira projects. 12 months: ≤ 100 repos, ≤ 20 projects | A handful of personal repos | Configuration test |
| NFR-SC-05 | Growth by adding instances | Going from pilot to department scale means adding instances, not bigger machines or redesign | n/a | Load test at 12-month targets before department rollout |
| NFR-SC-06 | Longest run supported | Up to 30 days, mostly waiting on people; then escalation | Same | Long-run test with simulated waits |

### 3.2 Performance

Targets are 95th percentile. Model and agent thinking time is excluded unless stated.

| ID | Requirement | Business | Personal | Verification |
|---|---|---|---|---|
| NFR-PF-01 | Chat acknowledges a message | < 2 s | Same | Synthetic monitoring |
| NFR-PF-02 | Agent reply starts streaming | < 5 s, including model time | Same | Synthetic monitoring |
| NFR-PF-03 | Work that takes longer becomes a background run with progress in the chat; status never ambiguous | Always | Same | UX acceptance test |
| NFR-PF-04 | Run status in the web user view and operator console reflects run events | < 5 s | Same | Event-lag metric |
| NFR-PF-05 | Teams cards are updated in place at key milestones, not re-posted | Always | n/a (no Teams) | UX acceptance test |
| NFR-PF-06 | New ticket picked up and run started | < 1 min after the webhook | Polling every ≤ 5 min (configurable) | Intake latency metric |
| NFR-PF-07 | Orchestration overhead per step (scheduling, checkpoint, policy check) | < 1 s | Same | Tracing |
| NFR-PF-08 | Agent workspace ready (container started, repo checked out) | < 60 s for repos up to 1 GB | < 2 min | Tracing |
| NFR-PF-09 | Operator console pages load | < 2 s | Same | Synthetic monitoring |

### 3.3 Availability, reliability and recovery

| ID | Requirement | Business | Personal | Verification |
|---|---|---|---|---|
| NFR-AV-01 | Availability | Best effort for the first release. A formal target is set before department rollout | Best effort | — |
| NFR-AV-02 | **No lost work.** A completed step, an approval or a ticket write-back is never lost on crash, restart or deploy; runs resume automatically | Always | Same, including after the laptop sleeps or shuts down | Failure tests: kill orchestrator and workers mid-step |
| NFR-AV-03 | **No duplicate side effects.** Retrying a step never creates a second PR, comment, sub-task or status change | Always | Same | Failure tests with forced retries |
| NFR-AV-04 | Disaster recovery | Lose ≤ 1 h of data (point-in-time backups); restore within 1 business day | Daily backup of local data; restore best effort | Restore rehearsal before go-live, then every 6 months |
| NFR-AV-05 | Dependency outages (Copilot or model provider, Jira, GitHub, Teams): affected runs pause and retry with backoff; users see why; nothing fails silently | Always | Same | Failure tests with stubbed outages |
| NFR-AV-06 | Deploys may briefly interrupt service but must respect NFR-AV-02 | Outside working hours | Any time | Deploy test with runs in flight |

### 3.4 Data and retention

| ID | Requirement | Business | Personal | Verification |
|---|---|---|---|---|
| NFR-DR-01 | Data classification | Source code, tickets, transcripts: Confidential | Owner's own data | Data inventory review |
| NFR-DR-02 | Retention | Audit trail 1 year; transcripts, step logs and artifacts (diffs, test reports) 90 days | Kept until the owner deletes them | Automated purge test |
| NFR-DR-03 | Workspaces deleted after the run step ends | Within 1 h | Same | Cleanup metric |
| NFR-DR-04 | Deletion on request: all data of a given run or user can be purged | Within 30 days of request | On demand | Purge test |
| NFR-DR-05 | Data location | Run data stays in the chosen cloud region; model calls go through Copilot under the company agreement | Run data stays on the laptop; model calls go to Anthropic | Architecture review |

Retention values are to be confirmed with compliance (capabilities §9).

### 3.5 Security

| ID | Requirement | Business | Personal | Verification |
|---|---|---|---|---|
| NFR-SE-01 | Encryption | TLS 1.2+ in transit (1.3 preferred); all stores encrypted at rest | TLS for external calls; OS disk encryption | Configuration scan |
| NFR-SE-02 | User sign-in | Company SSO with multi-factor authentication; no local accounts | Personal account sign-in | Security review |
| NFR-SE-03 | Secrets | In a secrets manager; never in code, Git, logs or transcripts | In the OS keychain or a local secret store; same rules | Secret scanning in CI and on transcripts |
| NFR-SE-04 | Credentials in workspaces | Short-lived (≤ 1 h) and scoped to one repository | Same | Security review |
| NFR-SE-05 | Workspace isolation | Isolated container, non-root, no host access, network egress allowlist, resource limits, destroyed after use | Same | Isolation tests |
| NFR-SE-06 | Least privilege | Agents get only their profile's tools and permissions; every action authorized; deny by default (CAP-08) | Same | Policy tests |
| NFR-SE-07 | Audit trail | Every plan, approval, action and policy decision recorded with actor and time; tamper-evident | Recorded; tamper evidence optional | Audit review |
| NFR-SE-08 | Untrusted input | Ticket text, repository content and tool outputs treated as untrusted; a prompt-injection test suite runs before every release (CAP-12) | Same | Test suite results |
| NFR-SE-09 | Supply chain | Dependency and container image scanning in CI; signed images | Scanning in CI | CI reports |
| NFR-SE-10 | Security assurance | Threat model before build; security review and penetration test before go-live | Threat model shared with business | Review sign-off |
| NFR-SE-11 | Business–personal separation: no shared credentials, accounts, storage or network paths (capabilities D8) | Always | Always | Configuration review |
| NFR-SE-12 | Agent-authored content (PRs, commits, comments) is clearly marked as such | Always | Same | UX acceptance test |

### 3.6 Cost

| ID | Requirement | Business | Personal | Verification |
|---|---|---|---|---|
| NFR-CO-01 | Every run has a budget (model usage plus workspace time), with a default per project | Notify at 80%; at 100% the run pauses and asks the requester or engineering lead to approve more or cancel | Covered by NFR-CO-03 | Budget tests |
| NFR-CO-02 | Monthly budget per team or project | Alerts at 50%, 80%, 100%; values set after the pilot baseline | n/a | Budget tests |
| NFR-CO-03 | Monthly spending cap | n/a | $50 on Anthropic usage. Alerts at 50%, 80%, 100%; at the cap new model calls stop and runs pause until the cap is raised or the month rolls over. The same limit is also set in the Anthropic Console as an independent safety net | Budget tests |
| NFR-CO-04 | Cost visibility | Estimated cost per run shown while it runs; reconciled with provider billing at least daily | Same | Reconciliation report |
| NFR-CO-05 | Idle cost | Workspaces scale to zero when idle | No paid cloud resources (runs locally) | Cost report |

### 3.7 Operability and portability

| ID | Requirement | Business | Personal | Verification |
|---|---|---|---|---|
| NFR-OP-01 | **Same build everywhere.** One set of container images runs on a laptop and in the cloud. Cloud-specific services are used only behind adapters with a local equivalent | Always | Same | CI runs end-to-end tests on the local setup |
| NFR-OP-02 | Core building blocks are portable (e.g., OCI containers, PostgreSQL, OpenTelemetry) | Always | Same | Architecture review |
| NFR-OP-03 | Local footprint | n/a | Runs on a typical developer laptop (16 GB RAM) with a container runtime, including 2 concurrent workspaces | Local test |
| NFR-OP-04 | Setup | Environment fully reproducible from infrastructure-as-code | Starts with one command; one configuration file plus secrets | Fresh-install test |
| NFR-OP-05 | Telemetry | All components emit OpenTelemetry traces, metrics and logs to the company stack; one trace ID per run across orchestrator, workers and tools | Same, to any OpenTelemetry-compatible tool | Trace completeness check |
| NFR-OP-06 | **Upgrades never break runs in flight.** Run state and event formats are versioned; a run started on version N completes on N+1 | Always | Same | Upgrade test with runs in flight |
| NFR-OP-07 | Alerts | Stuck runs (no progress beyond a threshold), failure spikes, budget breaches, queue backlog; handled in working hours | Notifications to the owner | Alert tests |
| NFR-OP-08 | Extensibility | A new ticket tool, channel or agent runtime is added as an adapter without changing the core | Same | Architecture review |

### 3.8 Usability and accessibility

| ID | Requirement | Business | Personal | Verification |
|---|---|---|---|---|
| NFR-UX-01 | Accessibility | Web app meets WCAG 2.2 AA; Teams cards follow Microsoft's Adaptive Cards accessibility guidance | Web app meets WCAG 2.2 AA | Accessibility audit |
| NFR-UX-02 | Language | English UI at launch; all UI text externalized so translations need no code changes; agents reply in the user's language | Same | Review |
| NFR-UX-03 | Browsers | Current Edge, Chrome, Firefox and Safari; desktop first, usable on tablet | Same | Browser test matrix |
| NFR-UX-04 | Consistency | Generative UI components come from one design system and behave the same everywhere | Same | Design review |
| NFR-UX-05 | Transparency | Users can always see what the agent is doing, why a run is paused and what it needs from them | Same | UX acceptance test |

## 4. Agent quality metrics

These measure how good the agents' work is (CAP-14). They are **not targets yet**: the pilot's first 4–6 weeks establish a baseline, then targets are set.

| Metric | What it shows |
|---|---|
| Plans approved without edits | Planning quality |
| PRs passing CI on the first attempt | Implementation quality |
| PRs merged vs. closed without merge | Usefulness of the output |
| Review rounds per PR | How much human correction is needed |
| Time from ticket pickup to PR ready for review | Delivery speed |
| Cost per merged PR | Efficiency |
| Reverted or reopened work | Hidden defects |

## 5. Verification approach

| Activity | When |
|---|---|
| Threat model | Before build starts |
| Failure tests (no lost work, no duplicates, dependency outages) | Every release |
| Prompt-injection test suite | Every release |
| Upgrade test with runs in flight | Every release |
| End-to-end tests on the local setup | Every CI build |
| Load test at 12-month targets | Before department rollout |
| Restore rehearsal | Before go-live, then every 6 months |
| Security review and penetration test | Before business go-live |
| Accessibility audit | Before business go-live |

## 6. Open items

| Item | Why it matters | Owner (proposed) |
|---|---|---|
| Formal availability target | Needed before department rollout | Platform + engineering leads |
| Retention values | To confirm with compliance | Security / compliance |
| Per-run and per-team budget values | Set from the pilot baseline | Engineering leads |
| Agent quality targets | Set from the pilot baseline | Engineering leads |
| Cloud provider | Affects how backups, recovery and scaling are implemented | Platform |

## Change history

| Version | Change |
|---|---|
| 1.0 | Initial agreed baseline |
