/**
 * Checks applied to agent output before it leaves the orchestrator:
 * secret scanning on added lines, and risk classification of changed files.
 */

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "Private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Atlassian API token", re: /\bATATT[A-Za-z0-9_=-]{40,}\b/ },
];

export interface SecretFinding {
  file: string;
  line: number;
  kind: string;
}

/** Scans the added lines of a unified diff. */
export function scanDiffForSecrets(diff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let file = "";
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = /\+(\d+)/.exec(raw);
      line = m ? Number.parseInt(m[1]!, 10) - 1 : 0;
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      line += 1;
      for (const p of SECRET_PATTERNS) {
        if (p.re.test(raw)) findings.push({ file, line, kind: p.name });
      }
    } else if (!raw.startsWith("-")) {
      line += 1;
    }
  }
  return findings;
}

const RISK_RULES: { reason: string; test: (path: string) => boolean }[] = [
  {
    reason: "Changes CI/CD configuration",
    test: (p) =>
      p.startsWith(".github/workflows/") ||
      p.startsWith(".gitlab-ci") ||
      /(^|\/)Jenkinsfile$/.test(p) ||
      p.startsWith(".circleci/") ||
      p === "azure-pipelines.yml" ||
      p === "bitbucket-pipelines.yml",
  },
  {
    reason: "Changes infrastructure or container definitions",
    test: (p) => /(^|\/)Dockerfile[^/]*$/.test(p) || /\.tf$/.test(p) || /(^|\/)docker-compose[^/]*\.ya?ml$/.test(p),
  },
  {
    reason: "Changes dependencies",
    test: (p) =>
      /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|go\.mod|Cargo\.toml|pom\.xml|Gemfile|composer\.json)$/.test(p) ||
      /(^|\/)(build\.gradle|build\.gradle\.kts|settings\.gradle|settings\.gradle\.kts|libs\.versions\.toml)$/.test(p),
  },
  {
    reason: "Changes ownership or permission files",
    test: (p) => /(^|\/)CODEOWNERS$/.test(p) || p.startsWith(".github/settings"),
  },
  {
    // Guidance shapes how every agent works on the product, so changing it needs a person's approval (FR-M6).
    reason: "Changes agent guidance files",
    test: (p) => isGuidanceFile(p),
  },
];

/** Files a product team keeps in its repository to guide agents (FR-M6); changing them is high risk. */
export function isGuidanceFile(path: string): boolean {
  return /(^|\/)AGENTS\.md$/.test(path) || path === ".github/copilot-instructions.md" || path.startsWith(".github/instructions/");
}

/**
 * Minimal glob for catalog paths: `**` matches across directories, `*` within one, `?` one character.
 * A pattern without a slash matches the file name at any depth; a trailing slash matches everything below.
 */
export function globToRegExp(pattern: string): RegExp {
  let glob = pattern.trim().replace(/^\.?\//, "");
  if (glob.endsWith("/")) glob += "**";
  const anyDepth = !glob.includes("/");
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${anyDepth ? "(?:.*/)?" : ""}${re}$`);
}

export const matchesAnyGlob = (path: string, patterns: readonly string[]): boolean => patterns.some((p) => globToRegExp(p).test(path));

export interface RiskAssessment {
  reasons: string[];
  files: string[];
}

/**
 * High-risk paths need a human approval before they are pushed (risk tier "high").
 * `extraPaths` are the product's own high-risk globs from the catalog: they can add to the baseline, never remove (D15).
 */
export function classifyRisk(changedFiles: string[], extraPaths: readonly string[] = []): RiskAssessment {
  const reasons = new Set<string>();
  const files: string[] = [];
  const extra = extraPaths.map(globToRegExp);
  for (const f of changedFiles) {
    const hits = RISK_RULES.filter((r) => r.test(f)).map((r) => r.reason);
    if (extra.some((re) => re.test(f))) hits.push("Changes a path the product marks as high risk");
    if (hits.length) {
      files.push(f);
      hits.forEach((h) => reasons.add(h));
    }
  }
  return { reasons: [...reasons], files };
}

/** Hosts sandboxes may reach through the egress proxy. Subdomains of listed hosts are allowed. */
export function isHostAllowed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    return h === e || h.endsWith(`.${e}`);
  });
}
