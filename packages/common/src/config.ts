/** Reads configuration from environment variables. Every deployment difference is configuration, never code. */

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v.trim() !== "") return v.trim();
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be an integer, got "${v}"`);
  return n;
}

function list(name: string, fallback: string[] = []): string[] {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  databaseUrl: () => str("DATABASE_URL", "postgres://orch:orch@localhost:5432/orch"),
  temporalAddress: () => str("TEMPORAL_ADDRESS", "localhost:7233"),
  temporalNamespace: () => str("TEMPORAL_NAMESPACE", "default"),

  githubToken: () => str("GITHUB_TOKEN"),
  /** Legacy: used only to build a one-product-per-repository catalog when no products file exists. */
  githubRepos: () => list("GITHUB_REPOS"),
  productsFile: () => str("PRODUCTS_FILE", "/config/products.yaml"),
  githubApiUrl: () => str("GITHUB_API_URL", "https://api.github.com"),
  githubGitUrlTemplate: () => str("GITHUB_GIT_URL_TEMPLATE", "https://github.com/{owner}/{repo}.git"),
  ownerLogin: () => process.env.ORCH_OWNER_LOGIN?.trim() || undefined,
  triggerLabel: () => str("ORCH_TRIGGER_LABEL", "ai-ready"),

  model: () => str("ORCH_MODEL", "claude-opus-5-5"),
  /** Model of the reviewer agent; another model than the implementer's gives a more independent review (AD-39). */
  reviewerModel: () => str("ORCH_REVIEWER_MODEL", str("ORCH_MODEL", "claude-opus-5-5")),
  /** How often an open pull request is polled. */
  prPollSeconds: () => int("PR_POLL_SECONDS", 60),
  /** Silence after which the architect's session workspace is saved and shut down (AD-34). */
  designIdleSeconds: () => int("DESIGN_IDLE_SECONDS", 20 * 60),
  /** The longest a session workspace lives before it is saved and replaced. */
  designMaxMinutes: () => int("DESIGN_MAX_MINUTES", 8 * 60),
  /** Fix rounds after an AI review before the requester decides (FR-R2). */
  maxFixRounds: () => int("MAX_FIX_ROUNDS", 2),
  pollIntervalSeconds: () => int("POLL_INTERVAL_SECONDS", 60),
  stepTimeoutMinutes: () => int("STEP_TIMEOUT_MINUTES", 60),
  /** Repositories one read-only step may hold, including those it asks for on demand (AD-37). */
  maxStepRepositories: () => int("MAX_STEP_REPOSITORIES", 8),
  /** Fast-track limit on the number of files the analysis expects to change (FR-A2). */
  fastTrackMaxFiles: () => int("FAST_TRACK_MAX_FILES", 5),

  workspaceTokenSecret: () => str("WORKSPACE_TOKEN_SECRET"),
  artifactsDir: () => str("ARTIFACTS_DIR", "/data/artifacts"),
  reposDir: () => str("REPOS_DIR", "/data/repos"),
  copilotHome: () => str("COPILOT_HOME_DIR", "/data/copilot"),

  workspaceImage: () => str("WORKSPACE_IMAGE", "orchestrator-workspace:local"),
  sandboxNetwork: () => str("SANDBOX_NETWORK", "orch-sandbox"),
  workspaceMemoryMb: () => int("WORKSPACE_MEMORY_MB", 4096),
  workspaceCpus: () => int("WORKSPACE_CPUS", 2),
  gatewayUrlForSandbox: () => str("GATEWAY_URL_FOR_SANDBOX", "http://sandbox-gateway:8090"),
  egressAnthropicUrl: () => str("EGRESS_ANTHROPIC_URL", "http://egress-proxy:8080/anthropic"),
  egressHttpProxy: () => str("EGRESS_HTTP_PROXY", "http://egress-proxy:3128"),

  anthropicApiKey: () => str("ANTHROPIC_API_KEY"),
  anthropicUpstream: () => str("ANTHROPIC_UPSTREAM", "https://api.anthropic.com"),
  egressAllowlist: () =>
    list("EGRESS_ALLOWLIST", [
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "files.pythonhosted.org",
      "repo.maven.apache.org",
      "repo1.maven.org",
      "plugins.gradle.org",
      "services.gradle.org",
      "downloads.gradle.org",
      "dl.google.com",
      "proxy.golang.org",
      "sum.golang.org",
      "index.crates.io",
      "static.crates.io",
    ]),

  apiPort: () => int("API_PORT", 3000),
  gatewayPort: () => int("GATEWAY_PORT", 8090),
  webDistDir: () => process.env.WEB_DIST_DIR?.trim() || undefined,
};
