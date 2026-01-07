import { rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { forEachAgentPath } from "../AgentFiles.ts";
import {
  agentFileProblems,
  classifyAgentFiles,
  formatAgentFileProblems,
} from "../ClassifyFiles.ts";
import {
  type ClankConfig,
  expandPath,
  loadConfig,
  validateOverlayExists,
} from "../Config.ts";
import { addGitExcludes } from "../Exclude.ts";
import {
  createSymlink,
  ensureDir,
  fileExists,
  getLinkTarget,
  isSymlink,
  isTrackedByGit,
} from "../FsUtil.ts";
import { type GitContext, getGitContext } from "../Git.ts";
import {
  addScopeSuffix,
  getPromptRelPath,
  type MapperContext,
  overlayProjectDir,
  overlayToTarget,
  type Scope,
  type TargetMapping,
} from "../Mapper.ts";
import {
  createPromptLinks as createPromptLinksShared,
  walkOverlayFiles,
} from "../OverlayLinks.ts";
import {
  initializeWorktreeOverlay,
  isWorktreeInitialized,
} from "../Templates.ts";
import { findOrphans } from "./Check.ts";
import { generateVscodeSettings, isVscodeProject } from "./VsCode.ts";

interface FileMapping extends TargetMapping {
  overlayPath: string;
}

interface LinkedFile {
  path: string;
  scope: Scope;
}

/** Link overlay repository to target directory */
export async function linkCommand(targetDir?: string): Promise<void> {
  const gitContext = await getGitContext(targetDir || process.cwd());
  const targetRoot = gitContext.gitRoot;
  console.log(`Linking clank overlay to: ${targetRoot}\n`);
  logGitContext(gitContext);

  const config = await loadConfig();
  const overlayRoot = expandPath(config.overlayRepo);
  await validateOverlayExists(overlayRoot);

  // Check for problematic agent files before proceeding
  await checkAgentFiles(targetRoot, overlayRoot);

  await ensureDir(join(overlayRoot, "targets", gitContext.projectName));
  await maybeInitWorktree(overlayRoot, gitContext);

  const ignorePatterns = config.ignore ?? [];
  const { agentsMappings, promptsMappings, regularMappings } =
    await collectMappings(overlayRoot, gitContext, targetRoot, ignorePatterns);

  // Create symlinks
  const linkedPaths = await createLinks(regularMappings, targetRoot);
  logLinkedPaths(linkedPaths);
  await createAgentLinks(agentsMappings, targetRoot, config.agents);
  await createPromptLinks(promptsMappings, targetRoot);

  await setupProjectSettings(overlayRoot, gitContext, targetRoot);
  await addGitExcludes(targetRoot);
  await maybeGenerateVscodeSettings(config, targetRoot);
  await warnOrphans(
    overlayRoot,
    targetRoot,
    gitContext.projectName,
    ignorePatterns,
  );
}

/** Generate VS Code settings if configured */
async function maybeGenerateVscodeSettings(
  config: ClankConfig,
  targetRoot: string,
): Promise<void> {
  const setting = config.vscodeSettings ?? "auto";

  if (setting === "never") return;

  if (setting === "auto") {
    const isVscode = await isVscodeProject(targetRoot);
    if (!isVscode) return;
  }

  // setting === "always" or (setting === "auto" && isVscodeProject)
  console.log("");
  await generateVscodeSettings(targetRoot);
}

function logGitContext(ctx: GitContext): void {
  const suffix = ctx.isWorktree ? " (worktree)" : "";
  console.log(`Project: ${ctx.projectName}`);
  console.log(`Branch: ${ctx.worktreeName}${suffix}`);
}

function logLinkedPaths(files: LinkedFile[]): void {
  if (files.length === 0) return;
  console.log(`\nLinked ${files.length} file(s):`);
  for (const { path, scope } of files) {
    const suffix = scope === "project" ? "" : ` (${scope})`;
    console.log(`  ${path}${suffix}`);
  }
}

async function warnOrphans(
  overlayRoot: string,
  targetRoot: string,
  projectName: string,
  ignorePatterns: string[] = [],
): Promise<void> {
  const orphans = await findOrphans(
    overlayRoot,
    targetRoot,
    projectName,
    ignorePatterns,
  );
  if (orphans.length > 0) {
    console.log(`\nWarning: ${orphans.length} orphaned overlay path(s) found.`);
    console.log("Run 'clank check' for details.");
  }
}

/** Check for problematic agent files and error if found */
async function checkAgentFiles(
  targetRoot: string,
  overlayRoot: string,
): Promise<void> {
  const classification = await classifyAgentFiles(targetRoot, overlayRoot);

  if (agentFileProblems(classification)) {
    throw new Error(formatAgentFileProblems(classification, process.cwd()));
  }
}

async function maybeInitWorktree(
  overlayRoot: string,
  gitContext: GitContext,
): Promise<void> {
  const initialized = await isWorktreeInitialized(overlayRoot, gitContext);
  if (!initialized) {
    console.log(
      `Initializing worktree ${gitContext.worktreeName} from templates...`,
    );
    await initializeWorktreeOverlay(overlayRoot, gitContext);
  }
}

/** Collect all file mappings from global, project, and worktree locations */
async function overlayMappings(
  overlayRoot: string,
  gitContext: GitContext,
  targetRoot: string,
  ignorePatterns: string[] = [],
): Promise<FileMapping[]> {
  const context: MapperContext = { overlayRoot, targetRoot, gitContext };
  const overlayGlobal = join(overlayRoot, "global");
  const overlayProject = overlayProjectDir(overlayRoot, gitContext.projectName);

  return [
    ...(await dirMappings(overlayGlobal, context, ignorePatterns)),
    ...(await dirMappings(overlayProject, context, ignorePatterns)),
  ];
}

interface SeparatedMappings {
  agentsMappings: FileMapping[];
  promptsMappings: FileMapping[];
  regularMappings: FileMapping[];
}

/** Collect and separate mappings by type (agents.md and prompts get special handling) */
async function collectMappings(
  overlayRoot: string,
  gitContext: GitContext,
  targetRoot: string,
  ignorePatterns: string[],
): Promise<SeparatedMappings> {
  const mappings = await overlayMappings(
    overlayRoot,
    gitContext,
    targetRoot,
    ignorePatterns,
  );
  return {
    agentsMappings: mappings.filter(
      (m) => basename(m.targetPath) === "agents.md",
    ),
    promptsMappings: mappings.filter((m) =>
      m.targetPath.includes("/.claude/prompts/"),
    ),
    regularMappings: mappings.filter(
      (m) =>
        basename(m.targetPath) !== "agents.md" &&
        !m.targetPath.includes("/.claude/prompts/"),
    ),
  };
}

async function dirMappings(
  dir: string,
  context: MapperContext,
  ignorePatterns: string[] = [],
): Promise<FileMapping[]> {
  if (!(await fileExists(dir))) return [];

  const mappings: FileMapping[] = [];
  for await (const overlayPath of walkOverlayFiles(dir, ignorePatterns)) {
    const result = overlayToTarget(overlayPath, context);
    if (result) {
      mappings.push({ overlayPath, ...result });
    }
  }
  return mappings;
}

/** Check if a file is tracked in git (exists as real file, not symlink, and tracked) */
async function isTrackedFile(path: string, gitRoot: string): Promise<boolean> {
  if (!(await fileExists(path))) return false;
  if (await isSymlink(path)) return false;
  return isTrackedByGit(path, gitRoot);
}

/** Process a single agents.md mapping into agent symlink paths */
async function processAgentMapping(
  mapping: FileMapping,
  targetRoot: string,
  agents: string[],
): Promise<{ created: string[]; skipped: string[] }> {
  const { overlayPath, targetPath } = mapping;
  const targetDir = dirname(targetPath);
  const created: string[] = [];
  const skipped: string[] = [];

  await forEachAgentPath(targetDir, agents, async (agentPath) => {
    if (await isTrackedFile(agentPath, targetRoot)) {
      skipped.push(relative(targetRoot, agentPath));
    } else {
      const linkTarget = getLinkTarget(agentPath, overlayPath);
      await createSymlink(linkTarget, agentPath);
      created.push(relative(targetRoot, agentPath));
    }
  });

  return { created, skipped };
}

/** Create agent symlinks (CLAUDE.md, GEMINI.md, AGENTS.md → agents.md) for all agents.md files */
async function createAgentLinks(
  agentsMappings: FileMapping[],
  targetRoot: string,
  agents: string[],
): Promise<void> {
  if (agentsMappings.length === 0) return;

  const results = await Promise.all(
    agentsMappings.map((m) => processAgentMapping(m, targetRoot, agents)),
  );

  const created = results.flatMap((r) => r.created);
  const skipped = results.flatMap((r) => r.skipped);

  if (created.length) {
    console.log(`\nCreated agent symlinks:`);
    for (const path of created) {
      console.log(`  ${path}`);
    }
  }

  if (skipped.length) {
    console.log(`\nSkipped (already tracked in git):`);
    for (const path of skipped) {
      console.log(`  ${path}`);
    }
  }
}

/** Create prompt symlinks in all agent directories (.claude/prompts/, .gemini/prompts/) */
async function createPromptLinks(
  promptsMappings: FileMapping[],
  targetRoot: string,
): Promise<void> {
  if (promptsMappings.length === 0) return;

  const results = await Promise.all(
    promptsMappings.map((m) => processPromptMapping(m, targetRoot)),
  );

  const created = results.flatMap((r) => r.created);
  if (created.length) {
    console.log(`\nCreated prompt symlinks:`);
    for (const path of created) {
      console.log(`  ${path}`);
    }
  }
}

/** Process a single prompt mapping into symlinks for all agent directories */
async function processPromptMapping(
  mapping: FileMapping,
  targetRoot: string,
): Promise<{ created: string[] }> {
  const { overlayPath, targetPath } = mapping;
  const promptRelPath = getPromptRelPath(targetPath);
  if (!promptRelPath) return { created: [] };

  const createdPaths = await createPromptLinksShared(
    overlayPath,
    promptRelPath,
    targetRoot,
  );
  return { created: createdPaths.map((p) => relative(targetRoot, p)) };
}

/** Create symlinks, handling conflicts with scope suffixes.
 * Conflicts occur when the same filename exists at multiple scopes (global, project, worktree).
 * Returns linked files with their scopes. */
async function createLinks(
  mappings: FileMapping[],
  targetRoot: string,
): Promise<LinkedFile[]> {
  // Filter out subdirectory clank files where parent doesn't exist in target
  const validMappings = await filterValidMappings(mappings, targetRoot);

  const byTarget = Map.groupBy(validMappings, (m) => m.targetPath);
  const links = [...byTarget].flatMap(([targetPath, files]) =>
    resolveLinks(targetPath, files),
  );

  const linkPromises = links.map(({ overlayPath, linkPath }) =>
    createSymlink(getLinkTarget(linkPath, overlayPath), linkPath),
  );
  await Promise.all(linkPromises);

  return links.map(({ linkPath, scope }) => ({
    path: relative(targetRoot, linkPath),
    scope,
  }));
}

/** Filter mappings to exclude subdirectory clank files where target parent doesn't exist.
 * (we'll warn about these as orphans in 'clank check' and warnOrphans() during link)
 */
async function filterValidMappings(
  mappings: FileMapping[],
  targetRoot: string,
): Promise<FileMapping[]> {
  const results = await Promise.all(
    mappings.map((m) => checkMappingParentExists(m, targetRoot)),
  );
  return results.filter((m): m is FileMapping => m !== null);
}

/** Check if a subdirectory clank file's parent exists in the target */
async function checkMappingParentExists(
  m: FileMapping,
  targetRoot: string,
): Promise<FileMapping | null> {
  const relPath = relative(targetRoot, m.targetPath);
  // Subdirectory clank files have /clank/ in the middle of the path
  const clankIndex = relPath.indexOf("/clank/");
  if (clankIndex !== -1) {
    // Check if parent directory exists (e.g., packages/foo for packages/foo/clank/notes.md)
    const parentDir = join(targetRoot, relPath.slice(0, clankIndex));
    if (!(await fileExists(parentDir))) {
      return null;
    }
  }
  return m;
}

/** Compute link paths, adding scope suffixes when the same target has multiple sources */
function resolveLinks(
  targetPath: string,
  files: FileMapping[],
): Array<{ overlayPath: string; linkPath: string; scope: Scope }> {
  if (files.length === 1) {
    const { overlayPath, scope } = files[0];
    return [{ overlayPath, linkPath: targetPath, scope }];
  }
  return files.map(({ overlayPath, scope }) => ({
    overlayPath,
    linkPath: join(
      dirname(targetPath),
      addScopeSuffix(basename(targetPath), scope),
    ),
    scope,
  }));
}

/** Setup project settings.json - adopt existing or create new */
async function setupProjectSettings(
  overlayRoot: string,
  gitContext: GitContext,
  targetRoot: string,
): Promise<void> {
  const overlayPath = join(
    overlayRoot,
    "targets",
    gitContext.projectName,
    "claude",
    "settings.json",
  );
  const targetPath = join(targetRoot, ".claude/settings.json");

  const inOverlay = await fileExists(overlayPath);
  const inTarget =
    (await fileExists(targetPath)) && !(await isSymlink(targetPath));

  if (inTarget && inOverlay) {
    throw new Error(
      `Conflict: settings.json exists in both target and overlay.\n` +
        `  Target: ${targetPath}\n` +
        `  Overlay: ${overlayPath}\n` +
        `Remove one to resolve.`,
    );
  }

  if (inTarget) {
    // Adopt target's settings - move to overlay
    await ensureDir(dirname(overlayPath));
    await rename(targetPath, overlayPath);
    console.log(`Moved .claude/settings.json to overlay`);
  } else if (!inOverlay) {
    // Neither exists - create blank in overlay
    await ensureDir(dirname(overlayPath));
    await writeFile(overlayPath, "{}\n", "utf-8");
    console.log(
      `Created .claude/settings.json symlink (project settings will be stored in overlay)`,
    );
  }

  // Create symlink (overlay now has the file)
  await ensureDir(dirname(targetPath));
  const linkTarget = getLinkTarget(targetPath, overlayPath);
  await createSymlink(linkTarget, targetPath);
}
