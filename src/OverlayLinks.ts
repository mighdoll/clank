import { lstat, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import picomatch from "picomatch";
import { managedAgentDirs, targetManagedDirs } from "./AgentFiles.ts";
import {
  createSymlink,
  ensureDir,
  getLinkTarget,
  isSymlink,
  resolveSymlinkTarget,
  walkDirectory,
} from "./FsUtil.ts";
import type { GitContext } from "./Git.ts";
import {
  getPromptRelPath,
  type MapperContext,
  overlayToTarget,
} from "./Mapper.ts";

export type ManagedFileState =
  | { kind: "valid" }
  | { kind: "unadded" }
  | { kind: "outside-overlay"; currentTarget: string }
  | {
      kind: "wrong-mapping";
      currentTarget: string;
      expectedTarget: string;
    };

/** Check if a file in a managed directory is a valid symlink to the overlay.
 *  Returns null if valid, or an issue object if not. */
export async function verifyManaged(
  linkPath: string,
  context: MapperContext,
): Promise<ManagedFileState> {
  const { overlayRoot } = context;

  try {
    const stats = await lstat(linkPath);
    if (!stats.isSymbolicLink()) {
      return { kind: "unadded" };
    }

    const absoluteTarget = await resolveSymlinkTarget(linkPath);

    // Check if symlink points to overlay at all
    if (!absoluteTarget.startsWith(overlayRoot)) {
      return { kind: "outside-overlay", currentTarget: absoluteTarget };
    }

    // Check if symlink points to correct overlay location
    const mapping = overlayToTarget(absoluteTarget, context);
    if (!mapping) {
      return {
        kind: "wrong-mapping",
        currentTarget: absoluteTarget,
        expectedTarget: "(no valid mapping)",
      };
    }

    // Prompt files are fanned out to all agent directories (.claude/prompts/, .gemini/prompts/)
    // Accept any agent's prompts dir as valid if the filename matches
    if (mapping.targetPath !== linkPath) {
      if (!isMatchingPromptPath(mapping.targetPath, linkPath)) {
        return {
          kind: "wrong-mapping",
          currentTarget: absoluteTarget,
          expectedTarget: mapping.targetPath,
        };
      }
    }

    return { kind: "valid" };
  } catch {
    return { kind: "unadded" };
  }
}

/** Check if a path is a symlink pointing to the overlay repository */
export async function isSymlinkToOverlay(
  linkPath: string,
  overlayRoot: string,
): Promise<boolean> {
  try {
    const stats = await lstat(linkPath);
    if (!stats.isSymbolicLink()) {
      return false;
    }

    const absoluteTarget = await resolveSymlinkTarget(linkPath);
    return absoluteTarget.startsWith(overlayRoot);
  } catch {
    return false;
  }
}

/** Walk overlay directory and yield all files that should be linked (excludes init/ templates) */
export async function* walkOverlayFiles(
  overlayRoot: string,
  ignorePatterns: string[] = [],
): AsyncGenerator<string> {
  const isIgnored =
    ignorePatterns.length > 0 ? picomatch(ignorePatterns) : null;

  const skip = (relPath: string): boolean => {
    if (relPath.startsWith("clank/init/")) return true; // Skip templates
    if (!isIgnored) return false;
    const basename = relPath.split("/").at(-1) ?? "";
    return isIgnored(relPath) || isIgnored(basename);
  };

  const genEntries = walkDirectory(overlayRoot, { skip });
  for await (const { path, isDirectory } of genEntries) {
    if (isDirectory) continue;
    yield path;
  }
}

/** Create prompt symlinks in all agent directories */
export async function createPromptLinks(
  overlayPath: string,
  promptRelPath: string,
  gitRoot: string,
): Promise<string[]> {
  const created: string[] = [];
  for (const agentDir of managedAgentDirs) {
    const targetPath = join(gitRoot, agentDir, "prompts", promptRelPath);
    await ensureDir(dirname(targetPath));
    const linkTarget = getLinkTarget(targetPath, overlayPath);
    await createSymlink(linkTarget, targetPath);
    created.push(targetPath);
  }
  return created;
}

/** Check if two paths are equivalent prompt files in different agent directories */
function isMatchingPromptPath(
  canonicalPath: string,
  actualPath: string,
): boolean {
  const canonical = getPromptRelPath(canonicalPath);
  return canonical !== null && canonical === getPromptRelPath(actualPath);
}

/** Find and remove symlinks pointing to wrong worktree in the overlay.
 *  Returns paths that were removed. */
export async function cleanStaleWorktreeSymlinks(
  targetRoot: string,
  overlayRoot: string,
  gitContext: GitContext,
): Promise<string[]> {
  const removed: string[] = [];
  const currentWorktree = gitContext.worktreeName;
  const projectName = gitContext.projectName;
  const worktreesPrefix = `${overlayRoot}/targets/${projectName}/worktrees/`;

  for await (const { path, isDirectory } of walkDirectory(targetRoot)) {
    if (isDirectory) continue;

    const relPath = relative(targetRoot, path);
    if (!isInManagedDir(relPath)) continue;
    if (!(await isSymlink(path))) continue;

    const target = await resolveSymlinkTarget(path);
    if (!target.startsWith(worktreesPrefix)) continue;

    // Extract worktree name from path like .../worktrees/main/clank/notes.md
    const afterPrefix = target.slice(worktreesPrefix.length);
    const worktreeName = afterPrefix.split("/")[0];

    if (worktreeName && worktreeName !== currentWorktree) {
      await unlink(path);
      removed.push(relPath);
    }
  }

  return removed;
}

/** Check if a path is inside a clank-managed directory */
function isInManagedDir(relPath: string): boolean {
  const parts = relPath.split("/");
  return parts.some((part) => targetManagedDirs.includes(part));
}
