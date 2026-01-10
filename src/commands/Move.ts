import { rename, unlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { forEachAgentPath, managedAgentDirs } from "../AgentFiles.ts";
import { expandPath, loadConfig, validateOverlayExists } from "../Config.ts";
import {
  createSymlink,
  ensureDir,
  fileExists,
  getLinkTarget,
} from "../FsUtil.ts";
import { getGitContext } from "../Git.ts";
import {
  getPromptRelPath,
  isAgentFile,
  isPromptFile,
  type MapperContext,
  normalizeAddPath,
  resolveScopeFromOptions,
  type Scope,
  type ScopeOptions,
  targetToOverlay,
} from "../Mapper.ts";
import { createPromptLinks, isSymlinkToOverlay } from "../OverlayLinks.ts";
import { scopeFromSymlink } from "../ScopeFromSymlink.ts";

export type MoveOptions = ScopeOptions;

interface MoveContext {
  overlayRoot: string;
  gitRoot: string;
  agents: string[];
}

/** Move or rename file(s) in overlay */
export async function moveCommand(
  filePaths: string[],
  options: MoveOptions,
): Promise<void> {
  const hasScope = options.global || options.project || options.worktree;
  const cwd = process.cwd();
  const gitContext = await getGitContext(cwd);
  const config = await loadConfig();
  const overlayRoot = expandPath(config.overlayRepo);

  await validateOverlayExists(overlayRoot);

  const { gitRoot: targetRoot } = gitContext;
  const context: MapperContext = { overlayRoot, targetRoot, gitContext };

  if (hasScope) {
    // Scope-move mode (existing behavior)
    const targetScope = resolveScopeFromOptions(options, "require");
    for (const filePath of filePaths) {
      await moveSingleFile(filePath, targetScope, context, cwd, config);
    }
  } else if (filePaths.length === 2) {
    // Rename mode
    await renameFile(filePaths[0], filePaths[1], context, cwd, config);
  } else if (filePaths.length === 1) {
    throw new Error(
      "Must specify destination or scope flag (--global, --project, --worktree)",
    );
  } else {
    throw new Error(
      "Too many arguments without scope flag. Use --global, --project, or --worktree",
    );
  }
}

async function moveSingleFile(
  filePath: string,
  targetScope: Scope,
  context: MapperContext,
  cwd: string,
  config: { agents: string[] },
): Promise<void> {
  const { overlayRoot, targetRoot: gitRoot } = context;
  const normalizedPath = normalizeAddPath(filePath, cwd, gitRoot);
  const barePath = join(cwd, filePath);

  // Check if file is a symlink to overlay
  const currentScope = await scopeFromSymlink(barePath, context);
  if (!currentScope) {
    throw new Error(
      `${relative(cwd, barePath)} is not managed by clank.\nUse 'clank add' to add it to the overlay first.`,
    );
  }

  if (currentScope === targetScope) {
    console.log(
      `${basename(barePath)} is already in ${targetScope} scope, nothing to do.`,
    );
    return;
  }

  const currentOverlayPath = targetToOverlay(
    normalizedPath,
    currentScope,
    context,
  );
  const newOverlayPath = targetToOverlay(normalizedPath, targetScope, context);

  // Move the file in the overlay
  await ensureDir(dirname(newOverlayPath));
  await rename(currentOverlayPath, newOverlayPath);

  const moveCtx: MoveContext = { overlayRoot, gitRoot, agents: config.agents };

  // Recreate symlinks
  if (isAgentFile(filePath)) {
    await recreateAgentLinks(normalizedPath, newOverlayPath, moveCtx);
  } else if (isPromptFile(normalizedPath)) {
    await recreatePromptLinks(normalizedPath, newOverlayPath, moveCtx);
  } else {
    await recreateSymlink(normalizedPath, newOverlayPath, moveCtx);
  }

  const fileName = relative(cwd, barePath);
  console.log(
    `Moved ${fileName} from ${currentScope} → ${targetScope} overlay`,
  );
}

/** Rename a file within its current scope */
async function renameFile(
  sourcePath: string,
  destName: string,
  context: MapperContext,
  cwd: string,
  config: { agents: string[] },
): Promise<void> {
  const { overlayRoot, targetRoot: gitRoot } = context;
  const sourceBarePath = join(cwd, sourcePath);

  // Verify source is managed by clank
  const currentScope = await scopeFromSymlink(sourceBarePath, context);
  if (!currentScope) {
    throw new Error(`${sourcePath} is not managed by clank`);
  }
  if (isAgentFile(sourcePath)) {
    throw new Error(
      "Cannot rename agent files (CLAUDE.md, AGENTS.md, GEMINI.md)",
    );
  }

  // Build dest path (same directory as source)
  const sourceDir = dirname(sourcePath);
  const destPath = sourceDir === "." ? destName : join(sourceDir, destName);

  // Calculate overlay paths
  const normalizedSource = normalizeAddPath(sourcePath, cwd, gitRoot);
  const normalizedDest = normalizeAddPath(destPath, cwd, gitRoot);
  const sourceOverlay = targetToOverlay(
    normalizedSource,
    currentScope,
    context,
  );
  const destOverlay = targetToOverlay(normalizedDest, currentScope, context);

  if (await fileExists(destOverlay)) {
    throw new Error(`Destination already exists: ${destName}`);
  }

  // Rename in overlay and update symlinks
  await ensureDir(dirname(destOverlay));
  await rename(sourceOverlay, destOverlay);
  const moveCtx: MoveContext = { overlayRoot, gitRoot, agents: config.agents };
  if (isPromptFile(normalizedSource)) {
    await renamePromptLinks(
      normalizedSource,
      normalizedDest,
      destOverlay,
      moveCtx,
    );
  } else {
    await renameSymlink(normalizedSource, normalizedDest, destOverlay, moveCtx);
  }

  console.log(`Renamed ${sourcePath} → ${destName} (${currentScope} scope)`);
}

/** Recreate agent symlinks (CLAUDE.md, GEMINI.md, AGENTS.md) after moving */
async function recreateAgentLinks(
  normalizedPath: string,
  overlayPath: string,
  ctx: MoveContext,
): Promise<void> {
  const { overlayRoot, gitRoot, agents } = ctx;
  const targetDir = dirname(normalizedPath);
  const updated: string[] = [];

  await forEachAgentPath(targetDir, agents, async (agentPath) => {
    // Remove old symlink
    if (await isSymlinkToOverlay(agentPath, overlayRoot)) {
      await unlink(agentPath);
    }

    // Create new symlink
    await ensureDir(dirname(agentPath));
    const linkTarget = getLinkTarget(agentPath, overlayPath);
    await createSymlink(linkTarget, agentPath);
    updated.push(relative(gitRoot, agentPath));
  });

  if (updated.length > 0) {
    console.log(`Updated symlinks: ${updated.join(", ")}`);
  }
}

/** Recreate prompt symlinks in all agent directories after moving */
async function recreatePromptLinks(
  normalizedPath: string,
  overlayPath: string,
  ctx: MoveContext,
): Promise<void> {
  const { overlayRoot, gitRoot } = ctx;
  const promptRelPath = getPromptRelPath(normalizedPath);
  if (!promptRelPath) return;

  // Remove old symlinks
  for (const agentDir of managedAgentDirs) {
    const targetPath = join(gitRoot, agentDir, "prompts", promptRelPath);
    if (await isSymlinkToOverlay(targetPath, overlayRoot)) {
      await unlink(targetPath);
    }
  }

  // Create new symlinks
  const created = await createPromptLinks(overlayPath, promptRelPath, gitRoot);

  if (created.length > 0) {
    console.log(
      `Updated symlinks: ${created.map((p) => relative(gitRoot, p)).join(", ")}`,
    );
  }
}

/** Recreate a regular symlink after moving */
async function recreateSymlink(
  targetPath: string,
  overlayPath: string,
  ctx: MoveContext,
): Promise<void> {
  // Remove old symlink if it exists
  if (await isSymlinkToOverlay(targetPath, ctx.overlayRoot)) {
    await unlink(targetPath);
  }

  // Create new symlink
  const linkTarget = getLinkTarget(targetPath, overlayPath);
  await createSymlink(linkTarget, targetPath);
}

/** Rename prompt symlinks in all agent directories */
async function renamePromptLinks(
  oldNormPath: string,
  newNormPath: string,
  newOverlayPath: string,
  ctx: MoveContext,
): Promise<void> {
  const { overlayRoot, gitRoot } = ctx;
  const oldPromptRel = getPromptRelPath(oldNormPath);
  const newPromptRel = getPromptRelPath(newNormPath);
  if (!oldPromptRel || !newPromptRel) return;

  // Remove old symlinks
  for (const agentDir of managedAgentDirs) {
    const oldTarget = join(gitRoot, agentDir, "prompts", oldPromptRel);
    if (await isSymlinkToOverlay(oldTarget, overlayRoot)) {
      await unlink(oldTarget);
    }
  }

  // Create new symlinks
  const created = await createPromptLinks(
    newOverlayPath,
    newPromptRel,
    gitRoot,
  );

  if (created.length > 0) {
    console.log(
      `Updated symlinks: ${created.map((p) => relative(gitRoot, p)).join(", ")}`,
    );
  }
}

/** Rename a regular symlink */
async function renameSymlink(
  oldTargetPath: string,
  newTargetPath: string,
  newOverlayPath: string,
  ctx: MoveContext,
): Promise<void> {
  // Remove old symlink
  if (await isSymlinkToOverlay(oldTargetPath, ctx.overlayRoot)) {
    await unlink(oldTargetPath);
  }

  // Create new symlink
  await ensureDir(dirname(newTargetPath));
  const linkTarget = getLinkTarget(newTargetPath, newOverlayPath);
  await createSymlink(linkTarget, newTargetPath);
}
