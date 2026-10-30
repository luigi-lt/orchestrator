# Orchestrator

An orchestration layer for AI agents that turns tickets into reviewed pull requests: it picks up work, has agents plan and implement it in isolated sandboxes, keeps people in control through approvals, and shows everything in a conversational user view and a technical operator view.

## Documents

| Document | Content |
|---|---|
| [Capability map](docs/capabilities.md) | What the orchestrator must do (tiers, decisions, deployment scenarios) |
| [Non-functional requirements](docs/non-functional-requirements.md) | How well: scale, reliability, security, cost |
| [Reference architecture](docs/architecture.md) | How it is built: components, flows, data, security, deployment |
| [MVP guide](docs/mvp.md) | Run the local MVP, use it, and what it leaves out |

## Quick start (local MVP)

Requires Docker, a GitHub fine-grained token and an Anthropic API key — details in the [MVP guide](docs/mvp.md).

```bash
./bin/orchestrator init     # create .env, then fill in GITHUB_TOKEN, GITHUB_REPOS, ANTHROPIC_API_KEY
./bin/orchestrator up       # build and start
open http://localhost:3000
```

Label an issue `ai-ready` in a configured repository, or ask in the chat: "work on owner/repo#12".

## Repository layout

```
apps/        api, worker, workspace-manager, sandbox-gateway, workspace-host, egress-proxy, web
packages/    contracts, common, store, github, agent-profiles
infra/local/ Dockerfile, docker-compose.yml
bin/         launcher
test/e2e/    end-to-end test with fake GitHub and fake Anthropic API
docs/        capability map, requirements, architecture, MVP guide
```
