import { lstat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { managedAgentDirs } from "./AgentFiles.ts";
import { createSymlink, ensureDir, getLinkTarget, resolveSymlinkTarget, walkDirectory } from "./FsUtil.ts";
import { getPromptRelPath, type MapperContext, overlayToTarget } from "./Mapper.ts";

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

/** Check if two paths are equivalent prompt files in different agent directories */
function isMatchingPromptPath(
  canonicalPath: string,
  actualPath: string,
): boolean {
  const canonicalPrompt = getPromptRelPath(canonicalPath);
  const actualPrompt = getPromptRelPath(actualPath);
  return canonicalPrompt !== null && canonicalPrompt === actualPrompt;
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
): AsyncGenerator<string> {
  for await (const { path, isDirectory } of walkDirectory(overlayRoot, {
    skipDirs: [".git", "node_modules"],
  })) {
    if (isDirectory) continue;

    const relPath = relative(overlayRoot, path);
    if (relPath.startsWith("clank/init/")) continue;

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
