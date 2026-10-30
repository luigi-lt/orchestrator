# syntax=docker/dockerfile:1
# One Dockerfile, two images:
#   target "app"       -> orchestrator-app:local       (api, worker, workspace-manager, sandbox-gateway, egress-proxy)
#   target "workspace" -> orchestrator-workspace:local (agent sandbox)

# The full Debian-based Node image already contains git, curl, Python and build tools,
# so the default build needs no package-manager access (helpful behind corporate proxies).
ARG NODE_IMAGE=node:22-bookworm
FROM ${NODE_IMAGE} AS base
# Optional extra CA certificates (e.g. a corporate TLS-inspection proxy): drop *.crt files into infra/local/certs/.
COPY infra/local/certs/ /usr/local/share/ca-certificates/extra/
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/common/package.json packages/common/
COPY packages/store/package.json packages/store/
COPY packages/github/package.json packages/github/
COPY packages/agent-profiles/package.json packages/agent-profiles/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/workspace-manager/package.json apps/workspace-manager/
COPY apps/sandbox-gateway/package.json apps/sandbox-gateway/
COPY apps/workspace-host/package.json apps/workspace-host/
COPY apps/egress-proxy/package.json apps/egress-proxy/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY apps apps
RUN npx tsc -b && npm run build -w @orch/web

FROM base AS app
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data/artifacts /data/repos /data/copilot && chown -R node:node /data
ENV NODE_ENV=production \
    WEB_DIST_DIR=/app/apps/web/dist \
    ARTIFACTS_DIR=/data/artifacts \
    REPOS_DIR=/data/repos \
    COPILOT_HOME_DIR=/data/copilot
USER node

FROM base AS workspace
ARG WITH_JDK=0
RUN if [ "$WITH_JDK" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk-headless && rm -rf /var/lib/apt/lists/*; \
    fi
WORKDIR /opt/workspace-host
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/workspace-host ./apps/workspace-host
RUN mkdir -p /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
ENV HOME=/workspace/home
ENTRYPOINT ["node", "/opt/workspace-host/apps/workspace-host/dist/main.js"]
