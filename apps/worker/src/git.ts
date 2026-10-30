import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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

export const runRepoDir = (runId: string) => join(config.reposDir(), runId);
export const stepArtifactsDir = (stepId: string) => join(config.artifactsDir(), stepId);

export function remoteFor(repo: RepoRef): { url: string; env: Record<string, string> } {
  const url = gitUrl(config.githubGitUrlTemplate(), repo);
  return { url, env: gitAuthEnv(config.githubToken(), url) };
}

/** Clones the repository for a run (once) and makes sure the run branch exists locally. */
export async function ensureRunRepo(runId: string, repo: RepoRef, defaultBranch: string, branch: string): Promise<string> {
  const dir = runRepoDir(runId);
  const { url, env } = remoteFor(repo);
  if (!existsSync(join(dir, ".git"))) {
    await git(["clone", "--no-tags", "--single-branch", "--branch", defaultBranch, url, dir], { env });
  } else {
    await git(["fetch", "--no-tags", "origin", defaultBranch], { cwd: dir, env });
  }
  const local = await git(["branch", "--list", branch], { cwd: dir });
  if (!local.trim()) await git(["checkout", "-B", branch, `origin/${defaultBranch}`], { cwd: dir });
  else await git(["checkout", branch], { cwd: dir });
  return dir;
}
