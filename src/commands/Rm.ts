import { rm, unlink } from "node:fs/promises";
import { basename, dirname, relative } from "node:path";
import { forEachAgentPath } from "../AgentFiles.ts";
import { expandPath, loadConfig, validateOverlayExists } from "../Config.ts";
import { fileExists } from "../FsUtil.ts";
import { getGitContext } from "../Git.ts";
import {
  isAgentFile,
  type MapperContext,
  normalizeAddPath,
  resolveScopeFromOptions,
  type Scope,
  type ScopeOptions,
  targetToOverlay,
} from "../Mapper.ts";
import { isSymlinkToOverlay } from "../OverlayLinks.ts";
import { scopeFromSymlink } from "../ScopeFromSymlink.ts";

export type RmOptions = ScopeOptions;

/** Remove file(s) from overlay and target */
export async function rmCommand(
  filePaths: string[],
  options: RmOptions = {},
): Promise<void> {
  const cwd = process.cwd();
  const gitContext = await getGitContext(cwd);
  const config = await loadConfig();
  const overlayRoot = expandPath(config.overlayRepo);

  await validateOverlayExists(overlayRoot);

  const { gitRoot } = gitContext;

  const context: MapperContext = {
    overlayRoot,
    targetRoot: gitRoot,
    gitContext,
  };

  for (const filePath of filePaths) {
    const normalizedPath = normalizeAddPath(filePath, cwd, gitRoot);

    const scope = await resolveScope(normalizedPath, options, context);
    const overlayPath = targetToOverlay(normalizedPath, scope, context);

    if (!(await fileExists(overlayPath))) {
      throw new Error(`Not found in overlay: ${relative(cwd, normalizedPath)}`);
    }

    if (isAgentFile(filePath)) {
      await removeAgentFiles(normalizedPath, overlayPath, overlayRoot, config);
    } else {
      await removeFile(normalizedPath, overlayPath, overlayRoot, cwd);
    }
  }
}

/** Resolve which scope to remove from */
async function resolveScope(
  targetPath: string,
  options: RmOptions,
  context: MapperContext,
): Promise<Scope> {
  // Explicit scope takes priority
  if (options.global || options.project || options.worktree) {
    return resolveScopeFromOptions(options);
  }

  const scope = await scopeFromSymlink(targetPath, context);
  if (scope) return scope;

  const found = await findInScopes(targetPath, context);

  if (found.length === 0) {
    throw new Error(
      `Not found in overlay: ${basename(targetPath)}\n` +
        `File does not exist in any scope (global, project, worktree)`,
    );
  }

  if (found.length > 1) {
    const scopeList = found.join(", ");
    throw new Error(
      `File exists in multiple scopes: ${scopeList}\n` +
        `Specify --global, --project, or --worktree`,
    );
  }

  return found[0];
}

/** Search all scopes to find where the file exists */
async function findInScopes(
  targetPath: string,
  context: MapperContext,
): Promise<Scope[]> {
  const found: Scope[] = [];

  for (const scope of ["worktree", "project", "global"] as const) {
    const overlayPath = targetToOverlay(targetPath, scope, context);
    if (await fileExists(overlayPath)) {
      found.push(scope);
    }
  }

  return found;
}

/** Remove a regular file */
async function removeFile(
  targetPath: string,
  overlayPath: string,
  overlayRoot: string,
  cwd: string,
): Promise<void> {
  const fileName = relative(cwd, targetPath);

  // Check if local file exists and handle it
  if (await fileExists(targetPath)) {
    if (await isSymlinkToOverlay(targetPath, overlayRoot)) {
      await unlink(targetPath);
      console.log(`Removed symlink: ${fileName}`);
    } else {
      throw new Error(
        `File exists but is not managed by clank: ${fileName}\n` +
          `Cannot remove a file that is not a symlink to the overlay`,
      );
    }
  }

  // Remove from overlay
  await rm(overlayPath);
  console.log(`Removed from overlay: ${basename(overlayPath)}`);
}

/** Remove agent files (CLAUDE.md, GEMINI.md, AGENTS.md → agents.md) */
async function removeAgentFiles(
  targetPath: string,
  overlayPath: string,
  overlayRoot: string,
  config: { agents: string[] },
): Promise<void> {
  const dir = dirname(targetPath);
  const removed: string[] = [];

  await forEachAgentPath(dir, config.agents, async (linkPath) => {
    if (await isSymlinkToOverlay(linkPath, overlayRoot)) {
      await unlink(linkPath);
      removed.push(basename(linkPath));
    }
  });

  if (removed.length > 0) {
    console.log(`Removed symlinks: ${removed.join(", ")}`);
  }

  // Remove agents.md from overlay
  await rm(overlayPath);
  console.log(`Removed from overlay: agents.md`);
}
