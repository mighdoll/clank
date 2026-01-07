import { basename, isAbsolute, join } from "node:path";
import { exec } from "./Exec.ts";

/** Selected git project/worktree metadata */
export interface GitContext {
  projectName: string;
  worktreeName: string;
  isWorktree: boolean;
  gitRoot: string;
}

/** @return metadata about the current git project and worktree */
export async function getGitContext(
  cwd: string = process.cwd(),
): Promise<GitContext> {
  const [projectName, worktreeName, isWorktree, gitRoot] = await Promise.all([
    detectProjectName(cwd),
    detectWorktreeName(cwd),
    isGitWorktree(cwd),
    detectGitRoot(cwd),
  ]);

  return {
    projectName,
    worktreeName,
    isWorktree,
    gitRoot,
  };
}

/** Get the git repository root directory */
export async function detectGitRoot(
  cwd: string = process.cwd(),
): Promise<string> {
  const toplevel = await gitCommand("rev-parse --show-toplevel", cwd);
  if (toplevel) {
    return toplevel;
  }
  throw new Error("Not in a git repository");
}

/** Detect project name from git remote or repository directory */
export async function detectProjectName(
  cwd: string = process.cwd(),
): Promise<string> {
  // Try git remote first (works for clones and worktrees)
  const remoteUrl = await gitCommand("config --get remote.origin.url", cwd);
  if (remoteUrl) {
    const repoName = parseRepoName(remoteUrl);
    if (repoName) {
      return repoName;
    }
  }

  // Fall back to git toplevel directory name
  const toplevel = await gitCommand("rev-parse --show-toplevel", cwd);
  if (toplevel) {
    return basename(toplevel);
  }

  throw new Error("Not in a git repository");
}

/** Detect worktree/branch name */
export async function detectWorktreeName(
  cwd: string = process.cwd(),
): Promise<string> {
  const branch = await gitCommand("branch --show-current", cwd);
  if (branch) {
    return branch;
  }

  // Fallback: detached HEAD or other edge case
  const rev = await gitCommand("rev-parse --short HEAD", cwd);
  if (rev) {
    return `detached-${rev}`;
  }

  throw new Error("Could not determine branch/worktree name");
}

/** Check if current directory is a git worktree (not the main repository) */
export async function isGitWorktree(
  cwd: string = process.cwd(),
): Promise<boolean> {
  const gitDir = await gitCommand("rev-parse --git-dir", cwd);
  if (!gitDir) {
    return false;
  }

  // Worktrees have .git/worktrees/* in their git-dir path
  return gitDir.includes("/worktrees/");
}

/** Parse repository name from git remote URL (handles HTTPS and SSH formats) */
export function parseRepoName(url: string): string | null {
  // Remove trailing .git
  const normalizedUrl = url.replace(/\.git$/, "");

  // Handle HTTPS: https://github.com/user/repo
  const httpsMatch = normalizedUrl.match(
    /https?:\/\/[^/]+\/(?:[^/]+\/)?([\w-]+)$/,
  );
  if (httpsMatch) {
    return httpsMatch[1];
  }

  // Handle SSH: git@github.com:user/repo
  const sshMatch = normalizedUrl.match(/:(?:[^/]+\/)?([\w-]+)$/);
  if (sshMatch) {
    return sshMatch[1];
  }

  // Last resort: take last path component
  return basename(normalizedUrl);
}

/** Get the .git directory for the current worktree */
export async function getGitDir(cwd: string): Promise<string | null> {
  const gitDir = await gitCommand("rev-parse --git-dir", cwd);
  if (!gitDir) return null;
  return isAbsolute(gitDir) ? gitDir : join(cwd, gitDir);
}

/** Get the common .git directory (shared across worktrees) */
export async function getGitCommonDir(cwd: string): Promise<string | null> {
  const gitDir = await gitCommand("rev-parse --git-common-dir", cwd);
  if (!gitDir) return null;
  return isAbsolute(gitDir) ? gitDir : join(cwd, gitDir);
}

/** Execute a git command and return stdout, or null if it fails */
async function gitCommand(args: string, cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await exec(`git ${args}`, { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}