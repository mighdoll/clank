import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentFiles, targetManagedDirs } from "./AgentFiles.ts";
import { execFileAsync } from "./Exec.ts";
import { isTrackedByGit, readFileIfExists } from "./FsUtil.ts";
import { getGitCommonDir, getGitDir } from "./Git.ts";

export const clankMarkerStart = "# Added by clank";
export const clankMarkerEnd = "# End clank";

/** Add clank entries to .git/info/exclude */
export async function addGitExcludes(targetRoot: string): Promise<void> {
  const gitDir = await getGitCommonDir(targetRoot);
  if (!gitDir) return;

  const infoDir = join(gitDir, "info");
  const excludePath = join(infoDir, "exclude");

  // Ensure info directory exists (may not exist in worktrees)
  await mkdir(infoDir, { recursive: true });

  let content = (await readFileIfExists(excludePath)) ?? "";

  // Remove existing clank section to rebuild with current entries
  if (content.includes(clankMarkerStart)) {
    content = removeClankSection(content);
  }

  // Build exclude list dynamically based on what's not tracked
  const excludeList: string[] = [];

  // Only exclude managed directories if they have no tracked files
  for (const dir of targetManagedDirs) {
    if (!(await hasTrackedFiles(dir, targetRoot))) {
      excludeList.push(`${dir}/`);
    }
  }

  // Only exclude agent files if not tracked
  for (const agentFile of agentFiles) {
    const agentPath = join(targetRoot, agentFile);
    if (!(await isTrackedByGit(agentPath, targetRoot))) {
      excludeList.push(agentFile);
    }
  }

  const clankSection = [
    "",
    clankMarkerStart,
    ...excludeList,
    clankMarkerEnd,
    "",
  ].join("\n");

  await writeFile(excludePath, content + clankSection, "utf-8");
  console.log("Added clank entries to .git/info/exclude");
}

/** Add a single entry to the clank block in .git/info/exclude */
export async function addToGitExclude(
  targetRoot: string,
  entry: string,
): Promise<void> {
  const gitDir = await getGitCommonDir(targetRoot);
  if (!gitDir) return;

  const infoDir = join(gitDir, "info");
  const excludePath = join(infoDir, "exclude");

  await mkdir(infoDir, { recursive: true });

  let content = (await readFileIfExists(excludePath)) ?? "";
  if (content.includes(entry)) return;

  if (content.includes(clankMarkerStart)) {
    content = content.replace(clankMarkerEnd, `${entry}\n${clankMarkerEnd}`);
  } else {
    content += `\n${clankMarkerStart}\n${entry}\n${clankMarkerEnd}\n`;
  }

  await writeFile(excludePath, content, "utf-8");
}

/** Remove clank entries from .git/info/exclude */
export async function removeGitExcludes(targetRoot: string): Promise<void> {
  // Don't modify shared excludes from a worktree
  if (await isWorktree(targetRoot)) return;

  const gitDir = await getGitCommonDir(targetRoot);
  if (!gitDir) return;

  const excludePath = join(gitDir, "info/exclude");
  const content = await readFileIfExists(excludePath);

  if (!content || !content.includes(clankMarkerStart)) {
    return; // No clank entries
  }

  const newContent = removeClankSection(content);

  await writeFile(excludePath, newContent, "utf-8");
  console.log("Removed clank entries from .git/info/exclude");
}

/** Remove the clank section from exclude file content */
function removeClankSection(content: string): string {
  const pattern = new RegExp(
    `\\n*${clankMarkerStart}[\\s\\S]*?${clankMarkerEnd}\\n*`,
    "g",
  );
  return content.replace(pattern, "\n");
}

/** Filter out clank section from lines */
export function filterClankLines(lines: string[]): string[] {
  const result: string[] = [];
  let inClankSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === clankMarkerStart) {
      inClankSection = true;
    } else if (trimmed === clankMarkerEnd) {
      inClankSection = false;
    } else if (!inClankSection) {
      result.push(line);
    }
  }
  return result;
}

/** Check if a directory has any tracked files */
async function hasTrackedFiles(
  dirPath: string,
  repoRoot: string,
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--", dirPath], {
      cwd: repoRoot,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Check if we're in a worktree (git-dir differs from git-common-dir) */
async function isWorktree(targetRoot: string): Promise<boolean> {
  const [gitDir, commonDir] = await Promise.all([
    getGitDir(targetRoot),
    getGitCommonDir(targetRoot),
  ]);
  return gitDir !== commonDir;
}
