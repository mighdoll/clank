import { lstat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { agentFiles } from "./AgentFiles.ts";
import { isTrackedByGit, relativePath, resolveSymlinkTarget, walkDirectory } from "./FsUtil.ts";
import type { GitContext } from "./Git.ts";
import { type MapperContext, targetToOverlay } from "./Mapper.ts";

/** Agent files grouped by problem type */
export interface AgentFileClassification {
  /** Tracked in git - needs conversion (git rm --cached + clank add) */
  tracked: string[];

  /** Untracked real files - needs clank add first */
  untracked: string[];

  /** Symlinks pointing somewhere other than overlay - needs removal */
  staleSymlinks: string[];

  /** Symlinks pointing to wrong path in overlay (e.g., after rename) */
  outdatedSymlinks: OutdatedSymlink[];
}

type PartialClassification = Partial<AgentFileClassification>;

export interface OutdatedSymlink {
  /** Path to the symlink in the target */
  symlinkPath: string;

  /** Where it currently points */
  currentTarget: string;

  /** Where it should point based on current location */
  expectedTarget: string;
}

/** Find all agent files in the repository and classify them.
 * Returns absolute paths in the classification.
 */
export async function classifyAgentFiles(
  targetRoot: string,
  overlayRoot: string,
  gitContext?: GitContext,
): Promise<AgentFileClassification> {
  const allAgentFiles = await findAllAgentFiles(targetRoot);
  const mapperCtx: MapperContext | undefined = gitContext
    ? { overlayRoot, targetRoot, gitContext }
    : undefined;

  const classifications = await Promise.all(
    allAgentFiles.map((f) =>
      classifySingleAgentFile(f, targetRoot, overlayRoot, mapperCtx),
    ),
  );

  return mergeClassifications(classifications);
}

/** @return true if classification has any problems */
export function agentFileProblems(
  classification: AgentFileClassification,
): boolean {
  return (
    classification.tracked.length > 0 ||
    classification.untracked.length > 0 ||
    classification.staleSymlinks.length > 0 ||
    classification.outdatedSymlinks.length > 0
  );
}

/** Format all agent file problems as a single message.
 * Paths are formatted relative to cwd for copy-paste convenience.
 */
export function formatAgentFileProblems(
  classified: AgentFileClassification,
  cwd: string,
): string {
  const sections: string[] = [];
  const rel = (p: string) => relativePath(cwd, p);

  if (classified.tracked.length > 0) {
    const commands = [
      ...classified.tracked.map((p) => `  git rm --cached ${rel(p)}`),
      ...classified.tracked.map((p) => `  clank add ${rel(p)}`),
    ];
    sections.push(`Found tracked agent files. Clank manages agent files via symlinks.

To convert to clank management:
${commands.join("\n")}`);
  }

  if (classified.untracked.length > 0) {
    const commands = classified.untracked.map((p) => `  clank add ${rel(p)}`);
    sections.push(`Found untracked agent files.

Add them to clank:
${commands.join("\n")}`);
  }

  if (classified.staleSymlinks.length > 0) {
    const commands = classified.staleSymlinks.map((p) => `  rm ${rel(p)}`);
    sections.push(`Found stale agent symlinks (not pointing to clank overlay).

Remove them, then run \`clank link\` to recreate:
${commands.join("\n")}`);
  }

  if (classified.outdatedSymlinks.length > 0) {
    const details = classified.outdatedSymlinks.map((s) => {
      const symlinkRel = rel(s.symlinkPath);
      return `  ${symlinkRel}\n    points to: ${s.currentTarget}\n    expected:  ${s.expectedTarget}`;
    });
    sections.push(`Found outdated agent symlinks (pointing to wrong overlay path).

This typically happens after a directory rename. Remove symlinks and run \`clank link\`:
${details.join("\n\n")}

To fix:
  rm ${classified.outdatedSymlinks.map((s) => rel(s.symlinkPath)).join(" ")}
  clank link`);
  }

  return sections.join("\n\n");
}

/** Classify a single agent file */
async function classifySingleAgentFile(
  filePath: string,
  targetRoot: string,
  overlayRoot: string,
  mapperCtx?: MapperContext,
): Promise<PartialClassification> {
  const stat = await lstat(filePath);

  if (stat.isSymbolicLink()) {
    return classifyAgentSymlink(filePath, overlayRoot, mapperCtx);
  }
  if (stat.isFile()) {
    const isTracked = await isTrackedByGit(filePath, targetRoot);
    return isTracked ? { tracked: [filePath] } : { untracked: [filePath] };
  }
  return {};
}

/** Classify an agent symlink - check if stale or outdated */
async function classifyAgentSymlink(
  filePath: string,
  overlayRoot: string,
  mapperCtx?: MapperContext,
): Promise<PartialClassification> {
  const absoluteTarget = await resolveSymlinkTarget(filePath);

  // Symlink doesn't point to overlay at all
  if (!absoluteTarget.startsWith(overlayRoot)) {
    return { staleSymlinks: [filePath] };
  }

  // Check if it points to the correct path within overlay
  if (mapperCtx) {
    // Agent files (CLAUDE.md, etc.) map to agents.md in overlay
    const agentsMdPath = join(dirname(filePath), "agents.md");
    const expectedTarget = targetToOverlay(agentsMdPath, "project", mapperCtx);
    if (absoluteTarget !== expectedTarget) {
      return {
        outdatedSymlinks: [
          {
            symlinkPath: filePath,
            currentTarget: absoluteTarget,
            expectedTarget,
          },
        ],
      };
    }
  }

  return {};
}

/** Merge sparse classifications into a complete classification with arrays */
function mergeClassifications(
  items: PartialClassification[],
): AgentFileClassification {
  return {
    tracked: items.flatMap((i) => i.tracked ?? []),
    untracked: items.flatMap((i) => i.untracked ?? []),
    staleSymlinks: items.flatMap((i) => i.staleSymlinks ?? []),
    outdatedSymlinks: items.flatMap((i) => i.outdatedSymlinks ?? []),
  };
}

/** Find all agent files in the repository */
async function findAllAgentFiles(targetRoot: string): Promise<string[]> {
  const files: string[] = [];
  const agentFileSet = new Set(agentFiles);

  for await (const { path, isDirectory } of walkDirectory(targetRoot)) {
    if (isDirectory) continue;
    if (agentFileSet.has(basename(path))) {
      files.push(path);
    }
  }

  return files;
}
