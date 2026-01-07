import { basename, join, relative } from "node:path";
import picomatch from "picomatch";
import { managedDirs, targetManagedDirs } from "../AgentFiles.ts";
import {
  agentFileProblems,
  classifyAgentFiles,
  formatAgentFileProblems,
} from "../ClassifyFiles.ts";
import { expandPath, loadConfig } from "../Config.ts";
import { fileExists, relativePath, walkDirectory } from "../FsUtil.ts";
import { type GitContext, getGitContext } from "../Git.ts";
import { type MapperContext, overlayProjectDir } from "../Mapper.ts";
import { formatStatusLines, getOverlayStatus } from "../OverlayGit.ts";
import { type ManagedFileState, verifyManaged } from "../OverlayLinks.ts";

export interface OrphanedPath {
  overlayPath: string;
  expectedTargetDir: string;
  fileName: string;
  scope: string;
}

export type UnaddedFile = ManagedFileState & {
  /** Absolute path to the file in the target */
  targetPath: string;

  /** Path relative to target root */
  relativePath: string;
};

/** Files that should remain local and not be tracked by clank */
const localOnlyFiles = ["settings.local.json"];

/** Check for orphaned overlay paths that don't match target structure */
export async function checkCommand(): Promise<void> {
  const cwd = process.cwd();
  const gitContext = await getGitContext(cwd);
  const config = await loadConfig();
  const overlayRoot = expandPath(config.overlayRepo);
  const { gitRoot: targetRoot } = gitContext;
  const ctx: MapperContext = { overlayRoot, targetRoot, gitContext };
  const ignorePatterns = config.ignore ?? [];

  await showOverlayStatus(overlayRoot, ignorePatterns);

  const problems = await checkAllProblems(ctx, cwd, ignorePatterns);
  if (!problems) {
    console.log("No issues found. Overlay matches target structure.");
  }
}

/** Find files in clank-managed directories that aren't valid symlinks to the overlay */
export async function findUnaddedFiles(
  context: MapperContext,
): Promise<UnaddedFile[]> {
  const { targetRoot } = context;
  const unadded: UnaddedFile[] = [];

  for await (const { path, isDirectory } of walkDirectory(targetRoot)) {
    if (isDirectory) continue;

    const relPath = relative(targetRoot, path);
    if (!isInManagedDir(relPath)) continue;
    if (isLocalOnlyFile(relPath)) continue;

    const managed = await verifyManaged(path, context);
    if (managed.kind !== "valid") {
      unadded.push({ targetPath: path, relativePath: relPath, ...managed });
    }
  }

  return unadded;
}

/** Find overlay paths whose target directories don't exist */
export async function findOrphans(
  overlayRoot: string,
  targetRoot: string,
  projectName: string,
  ignorePatterns: string[] = [],
): Promise<OrphanedPath[]> {
  const orphans: OrphanedPath[] = [];
  const projectDir = overlayProjectDir(overlayRoot, projectName);

  if (!(await fileExists(projectDir))) {
    return orphans;
  }

  const isIgnored =
    ignorePatterns.length > 0 ? picomatch(ignorePatterns) : null;

  const skip = (relPath: string): boolean => {
    if (isIgnored) {
      const pathBasename = relPath.split("/").at(-1) ?? "";
      if (isIgnored(relPath) || isIgnored(pathBasename)) return true;
    }
    return false;
  };

  for await (const { path, isDirectory } of walkDirectory(projectDir, {
    skipDirs: [".git", "node_modules", "worktrees"],
    skip,
  })) {
    if (isDirectory) continue;

    const relPath = relative(projectDir, path);

    // Skip files at project root (agents.md, settings.json)
    if (!relPath.includes("/")) continue;

    // Skip standard directories that don't map to target subdirs
    if (managedDirs.some((dir) => relPath.startsWith(`${dir}/`))) {
      continue;
    }

    // This is a subdirectory file - check if target dir exists
    // e.g., tools/packages/wesl/clank/notes.md -> check tools/packages/wesl/
    const targetSubdir = extractTargetSubdir(relPath);
    if (!targetSubdir) continue;

    const expectedTargetDir = join(targetRoot, targetSubdir);
    if (!(await fileExists(expectedTargetDir))) {
      orphans.push({
        overlayPath: path,
        expectedTargetDir: targetSubdir,
        fileName: basename(path),
        scope: projectName,
      });
    }
  }

  return orphans;
}

/** Show git status of the overlay repository */
async function showOverlayStatus(
  overlayRoot: string,
  ignorePatterns: string[] = [],
): Promise<void> {
  if (!(await fileExists(overlayRoot))) {
    console.log("Overlay repository not found\n");
    return;
  }

  const lines = await getOverlayStatus(overlayRoot, ignorePatterns);

  console.log(`Overlay: ${overlayRoot}`);

  if (lines.length === 0) {
    console.log("Status: clean\n");
    return;
  }

  console.log(`Status: ${lines.length} uncommitted change(s)\n`);

  for (const formatted of formatStatusLines(lines)) {
    console.log(`  ${formatted}`);
  }
  console.log();
}

/** Run all checks and display problems. Returns true if any problems found. */
async function checkAllProblems(
  ctx: MapperContext,
  cwd: string,
  ignorePatterns: string[] = [],
): Promise<boolean> {
  const { overlayRoot, targetRoot, gitContext } = ctx;
  let hasProblems = false;

  const unadded = await findUnaddedFiles(ctx);
  if (unadded.length > 0) {
    hasProblems = true;
    showUnaddedFiles(unadded, cwd, gitContext);
  }

  const agentClassification = await classifyAgentFiles(
    targetRoot,
    overlayRoot,
    gitContext,
  );
  if (agentFileProblems(agentClassification)) {
    hasProblems = true;
    console.log(formatAgentFileProblems(agentClassification, cwd));
    console.log();
  }

  const orphans = await findOrphans(
    overlayRoot,
    targetRoot,
    gitContext.projectName,
    ignorePatterns,
  );
  if (orphans.length > 0) {
    hasProblems = true;
    showOrphanedPaths(orphans, targetRoot, overlayRoot);
  }

  return hasProblems;
}

/** Check if a path is inside a clank-managed directory */
function isInManagedDir(relPath: string): boolean {
  const parts = relPath.split("/");
  return parts.some((part) => targetManagedDirs.includes(part));
}

/** Check if a file should remain local (not tracked by clank) */
function isLocalOnlyFile(relPath: string): boolean {
  const fileName = basename(relPath);
  return localOnlyFiles.includes(fileName);
}

/** Extract the target subdirectory from an overlay path
 * @param relPath - Path relative to overlay project dir (e.g., targets/wesl-js/)
 * @returns Target subdirectory path, or null if not a subdirectory file
 * @example "tools/packages/wesl/clank/notes.md" -> "tools/packages/wesl"
 * @example "tools/packages/wesl/agents.md" -> "tools/packages/wesl"
 */
function extractTargetSubdir(relPath: string): string | null {
  // Check for /clank/ or /claude/ in path
  for (const dir of managedDirs) {
    const idx = relPath.indexOf(`/${dir}/`);
    if (idx !== -1) return relPath.slice(0, idx);
  }
  // Check for agents.md in a subdirectory
  if (relPath.endsWith("/agents.md")) {
    return relPath.slice(0, -"/agents.md".length);
  }
  return null;
}

/** Display unadded files in clank-managed directories */
function showUnaddedFiles(
  unadded: UnaddedFile[],
  cwd: string,
  gitContext: GitContext,
): void {
  const { isWorktree, worktreeName, projectName } = gitContext;
  const targetName = isWorktree
    ? `${projectName}/${worktreeName}`
    : projectName;

  const outsideOverlay = unadded.filter((f) => f.kind === "outside-overlay");
  const wrongMapping = unadded.filter((f) => f.kind === "wrong-mapping");
  const regularFiles = unadded.filter((f) => f.kind === "unadded");

  if (outsideOverlay.length > 0) {
    console.log(
      `Found ${outsideOverlay.length} stale symlink(s) in ${targetName}:\n`,
    );
    console.log("These symlinks point outside the clank overlay.");
    console.log("Remove them, then run `clank link` to recreate:\n");
    for (const file of outsideOverlay) {
      console.log(`  rm ${relativePath(cwd, file.targetPath)}`);
    }
    console.log();
  }

  if (wrongMapping.length > 0) {
    console.log(
      `Found ${wrongMapping.length} mislinked symlink(s) in ${targetName}:\n`,
    );
    console.log("These symlinks point to the wrong overlay location.");
    console.log("Remove them, then run `clank link` to recreate:\n");
    for (const file of wrongMapping) {
      console.log(`  rm ${relativePath(cwd, file.targetPath)}`);
      if (file.currentTarget && file.expectedTarget) {
        console.log(`    points to: ${file.currentTarget}`);
        console.log(`    expected:  ${file.expectedTarget}`);
      }
    }
    console.log();
  }

  if (regularFiles.length > 0) {
    console.log(
      `Found ${regularFiles.length} unadded file(s) in ${targetName}:\n`,
    );
    for (const file of regularFiles) {
      console.log(`  clank add ${relativePath(cwd, file.targetPath)}`);
    }
    console.log();
  }
}

/** Display orphaned paths and remediation prompt */
function showOrphanedPaths(
  orphans: OrphanedPath[],
  targetRoot: string,
  overlayRoot: string,
): void {
  console.log(`Found ${orphans.length} orphaned overlay path(s):\n`);
  for (const orphan of orphans) {
    console.log(`  ${orphan.fileName} (${orphan.scope})`);
    console.log(`    Overlay: ${orphan.overlayPath}`);
    console.log(`    Expected dir: ${orphan.expectedTargetDir}\n`);
  }

  console.log("Target project:", targetRoot);
  console.log("Overlay:", overlayRoot);
  console.log("\nTo fix with an agent, copy this prompt:");
  console.log("─".repeat(50));
  console.log(generateAgentPrompt(orphans, targetRoot, overlayRoot));
  console.log("─".repeat(50));
}

/** Generate agent prompt for fixing orphaned paths */
function generateAgentPrompt(
  orphans: OrphanedPath[],
  targetRoot: string,
  overlayRoot: string,
): string {
  const dirs = [...new Set(orphans.map((o) => o.expectedTargetDir))];
  const dirList = dirs.map((d) => `  - ${d}`).join("\n");

  return `Clank stores agent files (CLAUDE.md, etc.) in a separate overlay repository and symlinks them into target projects. The overlay directory structure mirrors the target project structure.

The following overlay files no longer match the target project structure.
These directories no longer exist in the target:
${dirList}

Target project: ${targetRoot}
Overlay repository: ${overlayRoot}

First, run 'clank status' to see the current state.

Investigate where these directories moved to in the target project,
then update the overlay paths to match the new structure.

Run 'clank help structure' to see how the overlay maps to targets.

When finished, run 'clank status' to verify the fix.`;
}
