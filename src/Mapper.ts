import { basename, dirname, join, relative } from "node:path";
import { managedAgentDirs } from "./AgentFiles.ts";
import type { GitContext } from "./Git.ts";

/** overlay mappings can be cross project, per project, or per worktree */
export type Scope = "global" | "project" | "worktree";

/** CLI options for scope selection */
export interface ScopeOptions {
  global?: boolean;
  project?: boolean;
  worktree?: boolean;
}

/** Resolve scope from CLI options
 * @param options - The CLI options
 * @param defaultScope - Default scope if none specified, or "require" to throw
 */
export function resolveScopeFromOptions(
  options: ScopeOptions,
  defaultScope: Scope | "require" = "project",
): Scope {
  if (options.global) return "global";
  if (options.project) return "project";
  if (options.worktree) return "worktree";

  if (defaultScope === "require") {
    throw new Error(
      "Must specify target scope: --global, --project, or --worktree",
    );
  }
  return defaultScope;
}

/** Result of mapping an overlay path to a target path */
export interface TargetMapping {
  targetPath: string;
  scope: Scope;
}

/** params for mapping from the overlay repo to the target project repo */
export interface MapperContext {
  overlayRoot: string;
  targetRoot: string;
  gitContext: GitContext;
}

/** Get overlay path for a project: overlay/targets/{projectName} */
export function overlayProjectDir(
  overlayRoot: string,
  projectName: string,
): string {
  return join(overlayRoot, "targets", projectName);
}

/** Get overlay path for a worktree: overlay/targets/{project}/worktrees/{branch} */
export function overlayWorktreeDir(
  overlayRoot: string,
  gitContext: GitContext,
): string {
  const { projectName, worktreeName } = gitContext;
  return join(overlayRoot, "targets", projectName, "worktrees", worktreeName);
}

/**
 * Map overlay path to target path
 *
 * Structure:
 * - overlay/global/clank/ ==> target/clank/
 * - overlay/global/claude/commands/ ==> target/.claude/commands/
 * - overlay/global/claude/agents/ ==> target/.claude/agents/
 * - overlay/targets/{project}/clank/ ==> target/clank/
 * - overlay/targets/{project}/claude/settings.json ==> target/.claude/settings.json
 * - overlay/targets/{project}/claude/commands/ ==> target/.claude/commands/
 * - overlay/targets/{project}/claude/agents/ ==> target/.claude/agents/
 * - overlay/targets/{project}/agents.md ==> target/agents.md (etc.)
 * - overlay/targets/{project}/worktrees/{branch}/clank/ ==> target/clank/
 * - overlay/targets/{project}/worktrees/{branch}/claude/commands/ ==> target/.claude/commands/
 * - overlay/targets/{project}/worktrees/{branch}/agents.md ==> target/agents.md
 */
export function overlayToTarget(
  overlayPath: string,
  context: MapperContext,
): TargetMapping | null {
  const { overlayRoot, targetRoot, gitContext } = context;
  const projectPrefix = join(overlayRoot, "targets", gitContext.projectName);
  const globalPrefix = join(overlayRoot, "global");

  if (overlayPath.startsWith(globalPrefix)) {
    return mapGlobalOverlay(overlayPath, globalPrefix, targetRoot);
  }

  if (overlayPath.startsWith(projectPrefix)) {
    return mapProjectOverlay(overlayPath, projectPrefix, context);
  }

  return null;
}

/**
 * Map target path to overlay path (for clank add command)
 *
 * Files go to overlay based on scope:
 * - --global: overlay/global/clank/
 * - --project: overlay/targets/{project}/clank/
 * - --worktree: overlay/targets/{project}/worktrees/{branch}/clank/
 *
 * .claude/ files:
 * - --global: overlay/global/claude/{commands,agents}/
 * - --project: overlay/targets/{project}/claude/{commands,agents}/
 * - --worktree: overlay/targets/{project}/worktrees/{branch}/claude/{commands,agents}/
 *
 * agents.md files stay at their natural path in the overlay
 */
export function targetToOverlay(
  targetPath: string,
  scope: Scope,
  context: MapperContext,
): string {
  const { overlayRoot, targetRoot, gitContext } = context;
  const relPath = relative(targetRoot, targetPath);

  let overlayBase: string;
  if (scope === "global") {
    overlayBase = join(overlayRoot, "global");
  } else if (scope === "worktree") {
    overlayBase = overlayWorktreeDir(overlayRoot, gitContext);
  } else {
    overlayBase = overlayProjectDir(overlayRoot, gitContext.projectName);
  }

  return encodeTargetPath(relPath, overlayBase);
}

/** Encode a target-relative path to an overlay path */
function encodeTargetPath(relPath: string, overlayBase: string): string {
  // agents.md stays at natural path
  if (basename(relPath) === "agents.md") {
    return join(overlayBase, relPath);
  }
  // .claude/prompts/ and .gemini/prompts/ → prompts/ in overlay (agent-agnostic)
  for (const agentDir of managedAgentDirs) {
    const prefix = `${agentDir}/prompts/`;
    if (relPath.startsWith(prefix)) {
      return join(overlayBase, "prompts", relPath.slice(prefix.length));
    }
  }
  // .claude/* and .gemini/* → claude/*, gemini/* in overlay (agent-specific)
  for (const agentDir of managedAgentDirs) {
    if (relPath.startsWith(`${agentDir}/`)) {
      const subPath = relPath.slice(agentDir.length + 1);
      return join(overlayBase, agentDir.slice(1), subPath); // strip leading dot
    }
  }
  // Files with clank/ in path → preserve structure
  if (relPath.includes("clank/")) {
    return join(overlayBase, relPath);
  }
  // Plain files → add clank/ prefix
  return join(overlayBase, "clank", relPath);
}

/**
 * Normalize file path argument from clank add command
 * All files go to clank/ in target (except .claude/ files and agent files)
 *
 * @param input - The file path provided by the user
 * @param cwd - The current working directory
 * @param gitRoot - The git repository root
 */
export function normalizeAddPath(
  input: string,
  cwd: string,
  gitRoot: string,
): string {
  const normalized = input.replace(/^\.\//, "");

  // Treat agent files (CLAUDE.md, GEMINI.md) as aliases for agents.md
  // Support both relative paths (packages/foo/CLAUDE.md) and running from subdirectory
  if (isAgentFile(normalized)) {
    const inputDir = dirname(normalized);
    const targetDir = inputDir === "." ? cwd : join(cwd, inputDir);
    return join(targetDir, "agents.md");
  }

  // .claude/ and .gemini/ files keep their path (relative to git root)
  for (const agentDir of managedAgentDirs) {
    if (normalized.startsWith(`${agentDir}/`)) {
      return join(gitRoot, normalized);
    }
  }

  // If path already contains /clank/ in the middle, preserve its structure
  if (normalized.includes("/clank/")) {
    return join(cwd, normalized);
  }

  // Strip clank/ prefix if present at start
  const filename = normalized.startsWith("clank/")
    ? normalized.slice("clank/".length)
    : normalized;

  // Strip trailing /clank from cwd to avoid clank/clank nesting
  // But don't strip if we're at the git root (project might be named "clank")
  const inClankSubdir = cwd.endsWith("/clank") && cwd !== gitRoot;
  const normalizedCwd = inClankSubdir ? cwd.slice(0, -"/clank".length) : cwd;

  return join(normalizedCwd, "clank", filename);
}

/** Check if a filename is an agent file (CLAUDE.md, GEMINI.md, AGENTS.md) */
export function isAgentFile(filename: string): boolean {
  const name = basename(filename).toLowerCase();
  return name === "claude.md" || name === "gemini.md" || name === "agents.md";
}

/** Check if a path is a prompt file in an agent's prompts directory */
export function isPromptFile(normalizedPath: string): boolean {
  for (const agentDir of managedAgentDirs) {
    if (normalizedPath.includes(`/${agentDir}/prompts/`)) {
      return true;
    }
  }
  return false;
}

/** Extract the prompt-relative path from a full prompt path */
export function getPromptRelPath(normalizedPath: string): string | null {
  for (const agentDir of managedAgentDirs) {
    const marker = `/${agentDir}/prompts/`;
    const idx = normalizedPath.indexOf(marker);
    if (idx !== -1) {
      return normalizedPath.slice(idx + marker.length);
    }
  }
  return null;
}

/**
 * Add scope suffix to filename for conflict resolution
 * e.g., "notes.md" + "project" => "notes-project.md"
 */
export function addScopeSuffix(filename: string, scope: Scope): string {
  if (scope === "global") return filename;
  const dotIndex = filename.lastIndexOf(".");
  const base = dotIndex === -1 ? filename : filename.slice(0, dotIndex);
  const ext = dotIndex === -1 ? "" : filename.slice(dotIndex);
  return `${base}-${scope}${ext}`;
}

/** Map global overlay files to target */
function mapGlobalOverlay(
  overlayPath: string,
  globalPrefix: string,
  targetRoot: string,
): TargetMapping | null {
  const relPath = relative(globalPrefix, overlayPath);

  // Skip init templates
  if (relPath.startsWith("init/")) return null;

  return decodeOverlayPath(relPath, targetRoot, "global");
}

/** Decode an overlay-relative path to target (shared by all scopes) */
function decodeOverlayPath(
  relPath: string,
  targetRoot: string,
  scope: Scope,
): TargetMapping | null {
  // clank/ files (at root or in subdirectories)
  if (relPath.startsWith("clank/") || relPath.includes("/clank/")) {
    return { targetPath: join(targetRoot, relPath), scope };
  }

  // prompts/ files → map to .claude/prompts/ (primary target, multiplexed in Link.ts)
  if (relPath.startsWith("prompts/")) {
    const promptRelPath = relPath.slice("prompts/".length);
    return {
      targetPath: join(targetRoot, ".claude/prompts", promptRelPath),
      scope,
    };
  }

  // claude/, gemini/ files → map to .claude/, .gemini/ in target
  for (const agentDir of managedAgentDirs) {
    const overlayDir = agentDir.slice(1); // "claude" or "gemini"
    if (relPath.startsWith(`${overlayDir}/`)) {
      const subPath = relPath.slice(overlayDir.length + 1);
      return { targetPath: join(targetRoot, agentDir, subPath), scope };
    }
  }

  // Agent files (agents.md at any level)
  if (basename(relPath) === "agents.md") {
    return { targetPath: join(targetRoot, relPath), scope };
  }

  return null;
}

/** Map project overlay files to target */
function mapProjectOverlay(
  overlayPath: string,
  projectPrefix: string,
  context: MapperContext,
): TargetMapping | null {
  const { targetRoot, gitContext } = context;
  const relPath = relative(projectPrefix, overlayPath);

  // Worktree-specific files
  const worktreePrefix = join("worktrees", gitContext.worktreeName);
  if (relPath.startsWith(`${worktreePrefix}/`)) {
    const innerPath = relative(worktreePrefix, relPath);
    return decodeOverlayPath(innerPath, targetRoot, "worktree");
  }

  // Skip other worktrees
  if (relPath.startsWith("worktrees/")) return null;

  // Project settings.json (project-only, before shared logic)
  if (relPath === "claude/settings.json") {
    return {
      targetPath: join(targetRoot, ".claude/settings.json"),
      scope: "project",
    };
  }

  return decodeOverlayPath(relPath, targetRoot, "project");
}
