/** Minimal GitHub REST client for the personal deployment: issues, labels, comments, pull requests. */

export interface RepoRef {
  owner: string;
  name: string;
}

export interface GitHubUser {
  login: string;
  id: number;
  name: string | null;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  state: "open" | "closed";
  labels: string[];
  author: string;
  updatedAt: string;
}

export interface GitHubComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface GitHubPullRequest {
  number: number;
  url: string;
  title: string;
  state: "open" | "closed";
  merged: boolean;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  labels: ({ name?: string } | string)[];
  user: { login: string } | null;
  updated_at: string;
  pull_request?: unknown;
}

const toIssue = (r: RawIssue): GitHubIssue => ({
  number: r.number,
  title: r.title,
  body: r.body ?? "",
  url: r.html_url,
  state: r.state,
  labels: r.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
  author: r.user?.login ?? "",
  updatedAt: r.updated_at,
});

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly apiUrl = "https://api.github.com",
  ) {}

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; etag?: string | null; allow404?: boolean; allow422?: boolean } = {},
  ): Promise<{ status: number; data: T | null; etag: string | null }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "orchestrator-mvp",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.etag) headers["If-None-Match"] = opts.etag;
    const res = await fetch(`${this.apiUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const etag = res.headers.get("etag");
    if (res.status === 304) return { status: 304, data: null, etag };
    if ((res.status === 404 && opts.allow404) || (res.status === 422 && opts.allow422)) {
      return { status: res.status, data: null, etag };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const rateLimited =
        res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(text)));
      const retryable = rateLimited || res.status >= 500;
      throw new GitHubError(`GitHub ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`, res.status, retryable);
    }
    const data = res.status === 204 ? null : ((await res.json()) as T);
    return { status: res.status, data, etag };
  }

  private repoPath(r: RepoRef): string {
    return `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`;
  }

  async getAuthenticatedUser(): Promise<GitHubUser> {
    const { data } = await this.request<{ login: string; id: number; name: string | null }>("GET", "/user");
    return { login: data!.login, id: data!.id, name: data!.name };
  }

  async getDefaultBranch(repo: RepoRef): Promise<string> {
    const { data } = await this.request<{ default_branch: string }>("GET", this.repoPath(repo));
    return data!.default_branch;
  }

  /** Open issues carrying a label, oldest update first. Supports conditional requests (ETag). */
  async listLabelledIssues(
    repo: RepoRef,
    label: string,
    etag?: string | null,
  ): Promise<{ notModified: boolean; etag: string | null; issues: GitHubIssue[] }> {
    const q = new URLSearchParams({ labels: label, state: "open", sort: "updated", direction: "asc", per_page: "50" });
    const res = await this.request<RawIssue[]>("GET", `${this.repoPath(repo)}/issues?${q}`, { etag });
    if (res.status === 304) return { notModified: true, etag: res.etag, issues: [] };
    const issues = (res.data ?? []).filter((i) => !i.pull_request).map(toIssue);
    return { notModified: false, etag: res.etag, issues };
  }

  async getIssue(repo: RepoRef, number: number): Promise<GitHubIssue> {
    const { data } = await this.request<RawIssue>("GET", `${this.repoPath(repo)}/issues/${number}`);
    return toIssue(data!);
  }

  async createIssue(repo: RepoRef, title: string, body: string): Promise<GitHubIssue> {
    const { data } = await this.request<RawIssue>("POST", `${this.repoPath(repo)}/issues`, { body: { title, body } });
    return toIssue(data!);
  }

  /** Who most recently added the label, from the issue's event history. */
  async findLabeler(repo: RepoRef, number: number, label: string): Promise<string | null> {
    let labeler: string | null = null;
    for (let page = 1; page <= 10; page++) {
      const { data } = await this.request<{ event: string; label?: { name: string }; actor?: { login: string } }[]>(
        "GET",
        `${this.repoPath(repo)}/issues/${number}/events?per_page=100&page=${page}`,
      );
      const events = data ?? [];
      for (const e of events) {
        if (e.event === "labeled" && e.label?.name === label && e.actor) labeler = e.actor.login;
      }
      if (events.length < 100) break;
    }
    return labeler;
  }

  async listComments(repo: RepoRef, number: number, since?: string): Promise<GitHubComment[]> {
    const q = new URLSearchParams({ per_page: "100" });
    if (since) q.set("since", since);
    const { data } = await this.request<{ id: number; user: { login: string } | null; body: string; created_at: string }[]>(
      "GET",
      `${this.repoPath(repo)}/issues/${number}/comments?${q}`,
    );
    return (data ?? []).map((c) => ({ id: c.id, author: c.user?.login ?? "", body: c.body, createdAt: c.created_at }));
  }

  async createComment(repo: RepoRef, number: number, body: string): Promise<number> {
    const { data } = await this.request<{ id: number }>("POST", `${this.repoPath(repo)}/issues/${number}/comments`, { body: { body } });
    return data!.id;
  }

  async ensureLabel(repo: RepoRef, name: string, color: string, description: string): Promise<void> {
    await this.request("POST", `${this.repoPath(repo)}/labels`, { body: { name, color, description }, allow422: true });
  }

  async addLabels(repo: RepoRef, number: number, labels: string[]): Promise<void> {
    await this.request("POST", `${this.repoPath(repo)}/issues/${number}/labels`, { body: { labels } });
  }

  async removeLabel(repo: RepoRef, number: number, label: string): Promise<void> {
    await this.request("DELETE", `${this.repoPath(repo)}/issues/${number}/labels/${encodeURIComponent(label)}`, { allow404: true });
  }

  async findPullRequestByHead(repo: RepoRef, branch: string): Promise<GitHubPullRequest | null> {
    const q = new URLSearchParams({ head: `${repo.owner}:${branch}`, state: "all", per_page: "5" });
    const { data } = await this.request<{ number: number; html_url: string; title: string; state: "open" | "closed"; merged_at: string | null }[]>(
      "GET",
      `${this.repoPath(repo)}/pulls?${q}`,
    );
    const pr = data?.[0];
    return pr ? { number: pr.number, url: pr.html_url, title: pr.title, state: pr.state, merged: pr.merged_at != null } : null;
  }

  async createPullRequest(repo: RepoRef, p: { title: string; head: string; base: string; body: string }): Promise<GitHubPullRequest> {
    const { data } = await this.request<{ number: number; html_url: string; title: string; state: "open" | "closed" }>(
      "POST",
      `${this.repoPath(repo)}/pulls`,
      { body: p },
    );
    return { number: data!.number, url: data!.html_url, title: data!.title, state: data!.state, merged: false };
  }

  async getPullRequest(repo: RepoRef, number: number): Promise<GitHubPullRequest> {
    const { data } = await this.request<{ number: number; html_url: string; title: string; state: "open" | "closed"; merged: boolean }>(
      "GET",
      `${this.repoPath(repo)}/pulls/${number}`,
    );
    return { number: data!.number, url: data!.html_url, title: data!.title, state: data!.state, merged: data!.merged };
  }
}

/** Builds a clone URL from a template such as `https://github.com/{owner}/{repo}.git`. */
export function gitUrl(template: string, repo: RepoRef): string {
  return template.replace("{owner}", repo.owner).replace("{repo}", repo.name);
}

/** Git configuration passed through environment variables, so the token never lands in .git/config or argv. */
export function gitAuthEnv(token: string, url: string): Record<string, string> {
  if (!/^https?:\/\//.test(url)) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}
