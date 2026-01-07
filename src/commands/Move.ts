import { rename, unlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { forEachAgentPath, managedAgentDirs } from "../AgentFiles.ts";
import { expandPath, loadConfig, validateOverlayExists } from "../Config.ts";
import { createSymlink, ensureDir, getLinkTarget } from "../FsUtil.ts";
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

/** Move file(s) between overlay scopes */
export async function moveCommand(
  filePaths: string[],
  options: MoveOptions,
): Promise<void> {
  const targetScope = resolveScopeFromOptions(options, "require");
  const cwd = process.cwd();
  const gitContext = await getGitContext(cwd);
  const config = await loadConfig();
  const overlayRoot = expandPath(config.overlayRepo);

  await validateOverlayExists(overlayRoot);

  const { gitRoot: targetRoot } = gitContext;
  const context: MapperContext = { overlayRoot, targetRoot, gitContext };

  for (const filePath of filePaths) {
    await moveSingleFile(filePath, targetScope, context, cwd, config);
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
