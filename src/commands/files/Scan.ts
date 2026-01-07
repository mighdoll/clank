import { join, relative } from "node:path";
import { expandPath, loadConfig } from "../../Config.ts";
import { resolveSymlinkTarget, walkDirectory } from "../../FsUtil.ts";
import { getGitContext } from "../../Git.ts";
import { isClankPath } from "../../Mapper.ts";
import { isAgentFilePath } from "./Dedupe.ts";

export interface FilesOptions {
  /** Include files under dot-prefixed directories (e.g. .claude/) */
  hidden?: boolean;

  /** Max depth under clank/ directories (segments after clank/) */
  depth?: string;

  /** Output NUL-separated paths */
  null?: boolean;

  /** Disable deduplication */
  dedupe?: boolean;

  /** Only include symlinks into the overlay */
  linkedOnly?: boolean;

  /** Only include non-overlay files/symlinks */
  unlinkedOnly?: boolean;

  /** Only include linked files from global scope (implies `linkedOnly`) */
  global?: boolean;

  /** Only include linked files from project scope (implies `linkedOnly`) */
  project?: boolean;

  /** Only include linked files from worktree scope (implies `linkedOnly`) */
  worktree?: boolean;
}

export type LinkState = LinkedToOverlay | NotLinkedToOverlay;

export interface FileEntry {
  absolutePath: string;
  cwdRelativePath: string;
  targetRelativePath: string;
  link: LinkState;
}

export interface FilesContext {
  cwd: string;
  gitContext: Awaited<ReturnType<typeof getGitContext>>;
  targetRoot: string;
  scanRoot: string;
  overlayRoot: string;
  agentsPreference: string[];
}

export interface NormalizedFilesOptions {
  hidden: boolean;
  depth: number | null;
  null: boolean;
  dedupe: boolean;
  linkedOnly: boolean;
  unlinkedOnly: boolean;
  scopeFilter: "global" | "project" | "worktree" | null;
}

interface LinkedToOverlay {
  kind: "linked";
  overlayPath: string;
  scope: "global" | "project" | "worktree";
}

interface NotLinkedToOverlay {
  kind: "unlinked";
}

/** Gather derived paths and configuration needed to scan the repository. */
export async function getFilesContext(
  inputPath?: string,
): Promise<FilesContext> {
  const cwd = process.cwd();
  const gitContext = await getGitContext(cwd);
  const targetRoot = gitContext.gitRoot;
  const scanRoot = resolveScanRoot(targetRoot, cwd, inputPath);
  const config = await loadConfig();

  return {
    cwd,
    gitContext,
    targetRoot,
    scanRoot,
    overlayRoot: expandPath(config.overlayRepo),
    agentsPreference: config.agents,
  };
}

/** Apply defaults and turn user-facing flags into a stable internal shape. */
export function normalizeFilesOptions(
  options?: FilesOptions,
): NormalizedFilesOptions {
  const hidden = options?.hidden ?? false;
  const depthRaw = options?.depth?.trim() ?? "";
  const depth = depthRaw === "" ? null : parseDepth(depthRaw);

  const scopeFilter = scopeFilterFromOptions({
    global: options?.global ?? false,
    project: options?.project ?? false,
    worktree: options?.worktree ?? false,
  });

  return {
    hidden,
    depth,
    null: options?.null ?? false,
    dedupe: options?.dedupe ?? true,
    linkedOnly: options?.linkedOnly ?? false,
    unlinkedOnly: options?.unlinkedOnly ?? false,
    scopeFilter,
  };
}

/** Walk the scan root and collect candidates that match filters. */
export async function collectEntries(
  ctx: FilesContext,
  opts: NormalizedFilesOptions,
): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  for await (const { path, isDirectory } of walkDirectory(ctx.scanRoot, {
    includeHiddenDirs: opts.hidden,
  })) {
    if (isDirectory) continue;
    const entry = await maybeCreateEntry(ctx, opts, path);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Check if a relative path is under a specific directory component. */
export function isInDirectory(relPath: string, dirName: string): boolean {
  return relPath.startsWith(`${dirName}/`) || relPath.includes(`/${dirName}/`);
}

/** Resolve the scan root and reject paths that escape the git repository. */
function resolveScanRoot(
  targetRoot: string,
  cwd: string,
  input?: string,
): string {
  if (!input) return targetRoot;
  const resolved = join(cwd, input);
  const rel = normalizeRelPath(relative(targetRoot, resolved));
  if (rel.startsWith("..")) {
    throw new Error(`Path is outside the git repository: ${input}`);
  }
  return resolved;
}

/** Parse a user-supplied numeric flag and reject negative/invalid values. */
function parseDepth(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || Number.isNaN(n) || n < 0) {
    throw new Error(`Invalid --depth value: ${raw}`);
  }
  return n;
}

/** Resolve scope filter from CLI options (null = no filter, show all scopes) */
function scopeFilterFromOptions(
  options: Required<Pick<FilesOptions, "global" | "project" | "worktree">>,
): "global" | "project" | "worktree" | null {
  if (options.global) return "global";
  if (options.project) return "project";
  if (options.worktree) return "worktree";
  return null;
}

/** Build a single output entry, or skip the file based on filters. */
async function maybeCreateEntry(
  ctx: FilesContext,
  opts: NormalizedFilesOptions,
  filePath: string,
): Promise<FileEntry | null> {
  const targetRel = normalizeRelPath(relative(ctx.targetRoot, filePath));
  if (!isManagedTargetPath(targetRel, opts.hidden)) return null;
  if (!passesDepthFilter(targetRel, opts.depth)) return null;

  const link = await classifyLink(filePath, ctx.overlayRoot, ctx.gitContext);
  if (!passesLinkFilter(link, opts)) return null;

  return {
    absolutePath: filePath,
    cwdRelativePath: normalizeRelPath(relative(ctx.cwd, filePath) || "."),
    targetRelativePath: targetRel,
    link,
  };
}

function normalizeRelPath(p: string): string {
  return p.replaceAll("\\", "/");
}

/** Decide whether a target-relative path is managed by clank for listing. */
function isManagedTargetPath(relPath: string, includeHidden: boolean): boolean {
  if (isAgentFilePath(relPath)) return true;
  if (isClankPath(relPath)) return true;
  if (includeHidden && isInDotAgentDir(relPath)) return true;
  return false;
}

/** Apply the clank-depth constraint only to paths under `clank/`. */
function passesDepthFilter(relPath: string, depth: number | null): boolean {
  if (depth === null) return true;
  if (!isClankPath(relPath)) return true;
  return passesClankDepth(relPath, depth);
}

/** Classify a path as linked to the overlay (and which scope) vs not. */
async function classifyLink(
  filePath: string,
  overlayRoot: string,
  gitContext: Awaited<ReturnType<typeof getGitContext>>,
): Promise<LinkState> {
  try {
    const overlayPath = await resolveSymlinkTarget(filePath);
    if (!overlayPath.startsWith(overlayRoot)) return { kind: "unlinked" };
    const scope = inferScopeFromOverlay(overlayPath, overlayRoot, gitContext);
    if (!scope) return { kind: "unlinked" };
    return { kind: "linked", overlayPath, scope };
  } catch {
    return { kind: "unlinked" };
  }
}

/** Apply linked/unlinked and scope filters consistently. */
function passesLinkFilter(
  link: LinkState,
  opts: NormalizedFilesOptions,
): boolean {
  const effectiveLinkedOnly = opts.linkedOnly || opts.scopeFilter !== null;
  if (effectiveLinkedOnly && link.kind !== "linked") return false;
  if (opts.unlinkedOnly && link.kind !== "unlinked") return false;
  if (opts.scopeFilter === null) return true;
  return link.kind === "linked" && link.scope === opts.scopeFilter;
}

function isInDotAgentDir(relPath: string): boolean {
  return isInDirectory(relPath, ".claude") || isInDirectory(relPath, ".gemini");
}

/** Enforce a max segment count beneath the nearest `clank/` path component. */
function passesClankDepth(relPath: string, depth: number): boolean {
  const marker = "/clank/";
  const idx = relPath.includes(marker) ? relPath.lastIndexOf(marker) : -1;
  const after =
    idx === -1
      ? relPath.slice("clank/".length)
      : relPath.slice(idx + marker.length);
  const segments = after.split("/").filter(Boolean);
  return segments.length <= depth;
}

/** Infer the overlay scope from a resolved overlay path and current git context. */
function inferScopeFromOverlay(
  overlayPath: string,
  overlayRoot: string,
  gitContext: Awaited<ReturnType<typeof getGitContext>>,
): "global" | "project" | "worktree" | null {
  const globalPrefix = `${join(overlayRoot, "global")}/`;
  if (overlayPath.startsWith(globalPrefix)) return "global";

  const { projectName, worktreeName } = gitContext;
  const projectPath = join(overlayRoot, "targets", projectName);
  const worktreePath = join(projectPath, "worktrees", worktreeName);
  if (overlayPath.startsWith(`${worktreePath}/`)) return "worktree";

  const projectPrefix = `${projectPath}/`;
  if (overlayPath.startsWith(projectPrefix)) return "project";

  return null;
}
