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
import { consolidateRulesIntoAgentFiles } from "../Consolidate.ts";
import { addGitExcludes } from "../Exclude.ts";
import {
  createSymlink,
  ensureDir,
  fileExists,
  getCwd,
  getLinkTarget,
  isSymlink,
  isTrackedRealFile,
  toSlash,
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
  cleanStaleWorktreeSymlinks,
  createPromptLinks as createPromptLinksShared,
  walkOverlayFiles,
} from "../OverlayLinks.ts";
import {
  initializeWorktreeOverlay,
  isWorktreeInitialized,
} from "../Templates.ts";
import { findOrphans } from "./Check.ts";
import {
  checkVscodeTracking,
  generateVscodeSettings,
  isVscodeProject,
} from "./VsCode.ts";

interface FileMapping extends TargetMapping {
  overlayPath: string;
}

interface LinkedFile {
  path: string;
  scope: Scope;
}

interface SeparatedMappings {
  agentsMappings: FileMapping[];
  promptsMappings: FileMapping[];
  regularMappings: FileMapping[];
}

interface LinkOptions {
  verbose?: boolean;
}

/** What a link run did, reported as a summary (or in full with --verbose) */
interface LinkReport {
  stale: string[];
  linked: LinkedFile[];
  agents: string[];
  prompts: string[];
  skipped: string[];
}

/** Link overlay repository to target directory */
export async function linkCommand(
  targetDir?: string,
  options: LinkOptions = {},
): Promise<void> {
  const gitContext = await getGitContext(targetDir || (await getCwd()));
  const targetRoot = gitContext.gitRoot;
  console.log(`Linking clank overlay to: ${targetRoot}\n`);
  logGitContext(gitContext);

  const config = await loadConfig();
  const overlayRoot = expandPath(config.overlayRepo);
  await validateOverlayExists(overlayRoot);

  const stale = await cleanStaleAndCheck(targetRoot, overlayRoot, gitContext);

  await ensureDir(join(overlayRoot, "targets", gitContext.projectName));
  await maybeInitWorktree(overlayRoot, gitContext);

  const ignorePatterns = config.ignore ?? [];
  const { agentsMappings, promptsMappings, regularMappings } =
    await collectMappings(overlayRoot, gitContext, targetRoot, ignorePatterns);

  // Create symlinks
  const linked = await createLinks(regularMappings, targetRoot);
  const agentLinks = await createAgentLinks(
    agentsMappings,
    targetRoot,
    config.agents,
  );
  const prompts = await createPromptLinks(promptsMappings, targetRoot);
  logReport(
    { stale, linked, prompts, ...agentLinks },
    options.verbose ?? false,
  );

  await maybeConsolidateRules(overlayRoot, targetRoot, gitContext, config);

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

/** One reported category: a count, plus the paths behind it when listed */
interface Section {
  summary: string;
  paths: string[];
  listed: boolean;
}

/** Report what link did. Counts alone by default, full paths when verbose.
 * Skipped files are always listed - they're rare and worth a look. */
function logReport(report: LinkReport, verbose: boolean): void {
  const blocks = reportSections(report, verbose)
    .filter(({ paths }) => paths.length > 0)
    .map(sectionLines);
  if (blocks.length === 0) return;

  // one-line counts stack together; listings get a blank line around them
  const lines: string[] = [];
  let prevListing = false;
  for (const block of blocks) {
    const listing = block.length > 1;
    if (lines.length > 0 && (listing || prevListing)) lines.push("");
    lines.push(...block);
    prevListing = listing;
  }
  console.log(`\n${lines.join("\n")}`);
}

function reportSections(report: LinkReport, verbose: boolean): Section[] {
  const { stale, linked, agents, prompts, skipped } = report;
  const scopes = scopeCounts(linked);
  return [
    {
      summary: `Cleaned ${plural(stale.length, "stale worktree symlink")}`,
      paths: stale,
      listed: verbose,
    },
    {
      summary: `Linked ${plural(linked.length, "file")} ${scopes}`,
      paths: linked.map(scopedPath),
      listed: verbose,
    },
    {
      summary: `Created ${plural(agents.length, "agent symlink")}`,
      paths: agents,
      listed: verbose,
    },
    {
      summary: `Created ${plural(prompts.length, "prompt symlink")}`,
      paths: prompts,
      listed: verbose,
    },
    {
      summary: `Skipped ${plural(skipped.length, "file")} already tracked in git`,
      paths: skipped,
      listed: true,
    },
  ];
}

function sectionLines({ summary, paths, listed }: Section): string[] {
  if (!listed) return [summary];
  return [`${summary}:`, ...paths.map((path) => `  ${path}`)];
}

function scopedPath({ path, scope }: LinkedFile): string {
  return scope === "project" ? path : `${path} (${scope})`;
}

/** Per-scope tallies, e.g. "(11 global, 159 project, 3 worktree)" */
function scopeCounts(linked: LinkedFile[]): string {
  const scopes: Scope[] = ["global", "project", "worktree"];
  const tallies = scopes
    .map(
      (scope) =>
        [scope, linked.filter((f) => f.scope === scope).length] as const,
    )
    .filter(([, count]) => count > 0)
    .map(([scope, count]) => `${count} ${scope}`);
  return `(${tallies.join(", ")})`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function logGitContext(ctx: GitContext): void {
  const suffix = ctx.isWorktree ? " (worktree)" : "";
  console.log(`Project: ${ctx.projectName}`);
  console.log(`Branch: ${ctx.worktreeName}${suffix}`);
}

/** Clean stale worktree symlinks and check for problematic agent files.
 * Returns the removed symlink paths. */
async function cleanStaleAndCheck(
  targetRoot: string,
  overlayRoot: string,
  gitContext: GitContext,
): Promise<string[]> {
  const staleRemoved = await cleanStaleWorktreeSymlinks(
    targetRoot,
    overlayRoot,
    gitContext,
  );

  const classification = await classifyAgentFiles(targetRoot, overlayRoot);
  if (agentFileProblems(classification)) {
    throw new Error(formatAgentFileProblems(classification, await getCwd()));
  }
  return staleRemoved;
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
  const isAgent = ({ targetPath }: FileMapping) =>
    basename(targetPath) === "agents.md";
  const isPrompt = ({ targetPath }: FileMapping) =>
    toSlash(targetPath).includes("/.claude/prompts/");

  const agentsMappings = mappings.filter(isAgent);
  const promptsMappings = mappings.filter((m) => !isAgent(m) && isPrompt(m));
  const regularMappings = mappings.filter((m) => !isAgent(m) && !isPrompt(m));

  return { agentsMappings, promptsMappings, regularMappings };
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

/** Create agent symlinks (CLAUDE.md, GEMINI.md, AGENTS.md → agents.md) for all agents.md files.
 * Returns the created paths, plus any skipped because they're real files tracked in git. */
async function createAgentLinks(
  agentsMappings: FileMapping[],
  targetRoot: string,
  agents: string[],
): Promise<{ agents: string[]; skipped: string[] }> {
  const results = await Promise.all(
    agentsMappings.map((m) => processAgentMapping(m, targetRoot, agents)),
  );

  return {
    agents: results.flatMap((r) => r.created),
    skipped: results.flatMap((r) => r.skipped),
  };
}

/** Create prompt symlinks in all agent directories (.claude/prompts/, .gemini/prompts/, .codex/prompts/) */
async function createPromptLinks(
  promptsMappings: FileMapping[],
  targetRoot: string,
): Promise<string[]> {
  const results = await Promise.all(
    promptsMappings.map((m) => processPromptMapping(m, targetRoot)),
  );

  return results.flatMap((r) => r.created);
}

/** Consolidate rules into generated AGENTS.md/GEMINI.md if rules exist */
async function maybeConsolidateRules(
  overlayRoot: string,
  targetRoot: string,
  gitContext: GitContext,
  config: ClankConfig,
): Promise<void> {
  const consolidated = await consolidateRulesIntoAgentFiles({
    overlayRoot,
    targetRoot,
    gitContext,
    agents: config.agents,
  });
  if (consolidated.length > 0) {
    console.log(`\nGenerated consolidated agent files:`);
    for (const name of consolidated) {
      console.log(`  ${name}`);
    }
  }
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

/** Generate VS Code settings if configured */
async function maybeGenerateVscodeSettings(
  config: ClankConfig,
  targetRoot: string,
): Promise<void> {
  const setting = config.vscodeSettings ?? "auto";

  // User opted out - skip silently
  if (setting === "never") return;

  if (setting === "auto") {
    const isVscode = await isVscodeProject(targetRoot);
    if (!isVscode) return;
  }

  // Check if settings.json is tracked and show appropriate warning
  const check = await checkVscodeTracking(targetRoot);
  if (!check.canGenerate) {
    console.log(`\n${check.warning}`);
    return;
  }

  // Generate: "always" mode, or "auto" with untracked/layered settings
  console.log("");
  await generateVscodeSettings(targetRoot);
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
    if (await isTrackedRealFile(agentPath, targetRoot)) {
      skipped.push(relative(targetRoot, agentPath));
    } else {
      const linkTarget = getLinkTarget(agentPath, overlayPath);
      await createSymlink(linkTarget, agentPath);
      created.push(relative(targetRoot, agentPath));
    }
  });

  return { created, skipped };
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

/** Check if a subdirectory clank file's parent exists in the target */
async function checkMappingParentExists(
  m: FileMapping,
  targetRoot: string,
): Promise<FileMapping | null> {
  const relPath = toSlash(relative(targetRoot, m.targetPath));
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
