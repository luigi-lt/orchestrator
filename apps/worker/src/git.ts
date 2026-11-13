import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "@orch/common";
import { gitAuthEnv, gitUrl, type RepoRef } from "@orch/github";

export class GitError extends Error {}

export function git(args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 10 * 60 * 1000,
      },
      (err, stdout, stderr) => {
        if (err) reject(new GitError(`git ${args[0]} failed: ${stderr.trim() || err.message}`));
        else resolve(stdout);
      },
    );
  });
}

/** The worker's clone of the repository one sub-task changes: every sub-task has its own, on its own branch (FR-B1). */
export const workRepoDir = (runId: string, subtaskKey: string) => join(config.reposDir(), runId, subtaskKey.replace(/[^A-Za-z0-9_.-]/g, "_"));
export const mirrorDir = (repo: RepoRef) => join(config.reposDir(), "_mirrors", repo.owner, `${repo.name}.git`);
export const stepArtifactsDir = (stepId: string) => join(config.artifactsDir(), stepId);

export function remoteFor(repo: RepoRef): { url: string; env: Record<string, string> } {
  const url = gitUrl(config.githubGitUrlTemplate(), repo);
  return { url, env: gitAuthEnv(config.githubToken(), url) };
}

/**
 * Clones the repository for a sub-task (once) and creates its branch: on the current head of the default
 * branch, or, for a sub-task stacked on another one of the same repository, on that one's approved commit (AD-41).
 * Returns the commit the sub-task's own change starts from.
 */
export async function ensureWorkRepo(
  runId: string,
  subtaskKey: string,
  repo: RepoRef,
  defaultBranch: string,
  branch: string,
  stackedOn?: { branch: string; commit: string },
): Promise<{ dir: string; baseCommit: string }> {
  const dir = workRepoDir(runId, subtaskKey);
  const { url, env } = remoteFor(repo);
  if (!existsSync(join(dir, ".git"))) {
    await mkdir(join(dir, ".."), { recursive: true });
    await git(["clone", "--no-tags", "--single-branch", "--branch", defaultBranch, url, dir], { env });
  }
  const local = await git(["branch", "--list", branch], { cwd: dir });
  if (!local.trim()) {
    let start = `origin/${defaultBranch}`;
    if (stackedOn) {
      // The branch below was pushed when its pull request opened; the approved commit must be on it.
      await git(["fetch", "--no-tags", url, `+refs/heads/${stackedOn.branch}:refs/remotes/origin/${stackedOn.branch}`], { cwd: dir, env });
      await git(["merge-base", "--is-ancestor", stackedOn.commit, `origin/${stackedOn.branch}`], { cwd: dir });
      start = stackedOn.commit;
    }
    await git(["checkout", "-B", branch, start], { cwd: dir });
  } else await git(["checkout", branch], { cwd: dir });
  const baseCommit = stackedOn ? stackedOn.commit : (await git(["merge-base", branch, `origin/${defaultBranch}`], { cwd: dir })).trim();
  return { dir, baseCommit };
}

/**
 * Brings a sub-task's branch up to date with the default branch by merging it in. Used when the pull request
 * a branch was stacked on has merged. A conflict leaves the branch as it was.
 */
export async function mergeDefaultBranch(
  runId: string,
  subtaskKey: string,
  repo: RepoRef,
  defaultBranch: string,
  branch: string,
  author: { name: string; email: string },
): Promise<{ status: "up_to_date" | "merged" | "conflict"; headCommit: string }> {
  const cwd = workRepoDir(runId, subtaskKey);
  const { url, env } = remoteFor(repo);
  await git(["fetch", "--no-tags", url, `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`], { cwd, env });
  await git(["checkout", branch], { cwd });
  const head = async () => (await git(["rev-parse", "HEAD"], { cwd })).trim();
  const contained = await git(["merge-base", "--is-ancestor", `origin/${defaultBranch}`, "HEAD"], { cwd }).then(
    () => true,
    () => false,
  );
  if (contained) return { status: "up_to_date", headCommit: await head() };
  const identity = ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`];
  try {
    await git([...identity, "merge", "--no-edit", "--no-verify", "-m", `Merge ${defaultBranch} into ${branch}`, `origin/${defaultBranch}`], { cwd });
  } catch {
    await git(["merge", "--abort"], { cwd }).catch(() => undefined);
    return { status: "conflict", headCommit: await head() };
  }
  return { status: "merged", headCommit: await head() };
}

/** What a refused push or clone says: no access, no write access, or rejected credentials. */
export const ACCESS_REFUSED =
  /\b40[13]\b|permission to .* denied|access denied|denied to|not allowed|authentication failed|could not read username|insufficient permission|read-only|readonly|invalid username or password|bad credentials|write access/i;

/**
 * Tries a push to the repository without sending anything: the deletion of a branch that does not exist, with
 * --dry-run. The remote must accept the push before it can say the branch is missing. Returns why the push was
 * refused, or null; trouble that is not a refusal (the network) is not reported here.
 */
export async function probePush(repo: RepoRef): Promise<string | null> {
  const dir = join(config.reposDir(), "_probe");
  if (!existsSync(join(dir, "HEAD"))) {
    await mkdir(dir, { recursive: true });
    await git(["init", "--bare", "--quiet", dir]);
  }
  const { url, env } = remoteFor(repo);
  try {
    await git(["push", "--dry-run", "--no-verify", url, ":refs/heads/agent/orchestrator-access-check"], { cwd: dir, env, timeoutMs: 60_000 });
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/remote ref does not exist|unable to delete/i.test(message)) return null;
    return ACCESS_REFUSED.test(message) ? message.slice(0, 300) : null;
  }
}

// One git operation at a time per mirror: concurrent fetches into the same repository fight over ref locks.
const mirrorLocks = new Map<string, Promise<unknown>>();
function withMirrorLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const next = (mirrorLocks.get(dir) ?? Promise.resolve()).then(fn, fn);
  mirrorLocks.set(
    dir,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Writes a git bundle of a repository's branch for a read-only checkout in a workspace (AD-24, AD-37).
 * The repository is fetched with the requester's token into a cached bare mirror; returns the bundled commit and its ref.
 */
export async function bundleReadOnly(repo: RepoRef, branch: string, target: string, pin?: string): Promise<{ commit: string; ref: string }> {
  const dir = mirrorDir(repo);
  const { url, env } = remoteFor(repo);
  return withMirrorLock(dir, async () => {
    if (!existsSync(join(dir, "HEAD"))) {
      await mkdir(dir, { recursive: true });
      await git(["init", "--bare", "--quiet", dir]);
    }
    await git(["fetch", "--no-tags", "--prune", url, `+refs/heads/${branch}:refs/heads/${branch}`], { cwd: dir, env });
    let commit = (await git(["rev-parse", `refs/heads/${branch}`], { cwd: dir })).trim();
    let ref = branch;
    // A design session keeps the commits it opened: a restored workspace gets the same code (AD-34).
    if (pin && pin !== commit && (await git(["cat-file", "-e", `${pin}^{commit}`], { cwd: dir }).then(() => true, () => false))) {
      ref = `orch-pin-${pin.slice(0, 12)}`;
      await git(["branch", "-f", ref, pin], { cwd: dir });
      commit = pin;
    }
    await git(["bundle", "create", target, `refs/heads/${ref}`], { cwd: dir });
    return { commit, ref };
  });
}
