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
 * Clones the repository for a sub-task (once) and puts its branch on the current head of the default branch.
 * Returns the commit the sub-task starts from.
 */
export async function ensureWorkRepo(runId: string, subtaskKey: string, repo: RepoRef, defaultBranch: string, branch: string): Promise<{ dir: string; baseCommit: string }> {
  const dir = workRepoDir(runId, subtaskKey);
  const { url, env } = remoteFor(repo);
  if (!existsSync(join(dir, ".git"))) {
    await mkdir(join(dir, ".."), { recursive: true });
    await git(["clone", "--no-tags", "--single-branch", "--branch", defaultBranch, url, dir], { env });
  }
  const local = await git(["branch", "--list", branch], { cwd: dir });
  if (!local.trim()) await git(["checkout", "-B", branch, `origin/${defaultBranch}`], { cwd: dir });
  else await git(["checkout", branch], { cwd: dir });
  const baseCommit = (await git(["merge-base", branch, `origin/${defaultBranch}`], { cwd: dir })).trim();
  return { dir, baseCommit };
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
