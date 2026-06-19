import { relative } from "node:path";
import { execa } from "execa";
import { expandPath, loadConfig, validateOverlayExists } from "../Config.ts";
import { getCwd, toSlash } from "../FsUtil.ts";
import { type GitContext, getGitContext } from "../Git.ts";
import {
  overlayProjectDir,
  overlayWorktreeDir,
  type Scope,
  type ScopeOptions,
} from "../Mapper.ts";
import { makeIgnoreFilter } from "../OverlayGit.ts";

export interface DiffOptions extends ScopeOptions {
  /** Diff the entire overlay (all projects) — a faithful `commit` preview */
  all?: boolean;
  /** Show a diffstat summary instead of the full patch */
  stat?: boolean;
}

type IgnoreFilter = (path: string) => boolean;

/** Show uncommitted overlay changes for the current context.
 *
 * Default (no scope flag) diffs the three subtrees that feed the current
 * checkout — global + this project + this worktree — and hides other projects
 * and other branches. Scope flags narrow that; `--all` shows the whole repo. */
export async function diffCommand(options: DiffOptions = {}): Promise<void> {
  const config = await loadConfig();
  const overlayRoot = expandPath(config.overlayRepo);
  await validateOverlayExists(overlayRoot);

  const color = process.stdout.isTTY ? ["--color=always"] : [];
  const isIgnored = makeIgnoreFilter(config.ignore ?? []);
  const hasHead = await overlayHasHead(overlayRoot);

  if (options.all) {
    const body = await diffPathspecs(
      overlayRoot,
      [],
      options,
      color,
      isIgnored,
      hasHead,
    );
    return printDiff(body);
  }

  const gitContext = await getGitContext(await getCwd());
  const scopes = resolveScopes(options);
  const sections = await collectSections(scopes, {
    overlayRoot,
    gitContext,
    options,
    color,
    isIgnored,
    hasHead,
  });
  printDiff(sections.join("\n\n"));
}

/** Scopes to diff: the flags passed, or all three (contextual) when none */
function resolveScopes(options: DiffOptions): Scope[] {
  const scopes: Scope[] = [];
  if (options.global) scopes.push("global");
  if (options.project) scopes.push("project");
  if (options.worktree) scopes.push("worktree");
  return scopes.length > 0 ? scopes : ["global", "project", "worktree"];
}

interface DiffParams {
  overlayRoot: string;
  gitContext: GitContext;
  options: DiffOptions;
  color: string[];
  isIgnored: IgnoreFilter;
  hasHead: boolean;
}

/** Diff each scope, prefixing a header when more than one scope is shown */
async function collectSections(
  scopes: Scope[],
  params: DiffParams,
): Promise<string[]> {
  const { overlayRoot, gitContext, options, color, isIgnored, hasHead } =
    params;
  const withHeaders = scopes.length > 1;
  const sections: string[] = [];

  for (const scope of scopes) {
    const pathspecs = scopePathspecs(scope, overlayRoot, gitContext);
    const body = await diffPathspecs(
      overlayRoot,
      pathspecs,
      options,
      color,
      isIgnored,
      hasHead,
    );
    if (!body.trim()) continue;
    const label = scopeLabel(scope, gitContext);
    sections.push(withHeaders ? `## ${label}\n${body}` : body);
  }

  return sections;
}

/** Git pathspecs for one scope, relative to the overlay root.
 *
 * `project` excludes the worktrees subtree so each scope maps to exactly one
 * area; this exclude can't be combined with the worktree spec in a single git
 * call (excludes win over positives), so scopes are diffed separately. */
function scopePathspecs(
  scope: Scope,
  overlayRoot: string,
  gitContext: GitContext,
): string[] {
  if (scope === "global") return ["global"];
  if (scope === "worktree") {
    return [
      overlayRel(overlayRoot, overlayWorktreeDir(overlayRoot, gitContext)),
    ];
  }
  const projectRel = overlayRel(
    overlayRoot,
    overlayProjectDir(overlayRoot, gitContext.projectName),
  );
  return [projectRel, `:!${projectRel}/worktrees`];
}

function scopeLabel(scope: Scope, gitContext: GitContext): string {
  if (scope === "global") return "global";
  if (scope === "worktree") return `worktree (${gitContext.worktreeName})`;
  return `project (${gitContext.projectName})`;
}

/** Combined tracked + untracked diff for a set of pathspecs */
async function diffPathspecs(
  overlayRoot: string,
  pathspecs: string[],
  options: DiffOptions,
  color: string[],
  isIgnored: IgnoreFilter,
  hasHead: boolean,
): Promise<string> {
  const statArg = options.stat ? ["--stat"] : [];
  const tracked = hasHead
    ? await runGit(overlayRoot, [
        "diff",
        "HEAD",
        ...statArg,
        ...color,
        ...withSep(pathspecs),
      ])
    : "";
  const untracked = await untrackedSection(
    overlayRoot,
    pathspecs,
    options,
    color,
    isIgnored,
  );
  return [tracked.trimEnd(), untracked.trimEnd()].filter(Boolean).join("\n");
}

/** Untracked files rendered as additions (or listed, for --stat) */
async function untrackedSection(
  overlayRoot: string,
  pathspecs: string[],
  options: DiffOptions,
  color: string[],
  isIgnored: IgnoreFilter,
): Promise<string> {
  const listed = await runGit(overlayRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    ...withSep(pathspecs),
  ]);
  const files = listed
    .split("\n")
    .filter(Boolean)
    .filter((file) => !isIgnored(file));
  if (files.length === 0) return "";

  if (options.stat) {
    return files.map((file) => ` ${file} (new file)`).join("\n");
  }

  // Render each untracked file as a patch against /dev/null (read-only; git
  // treats /dev/null specially across platforms). Exit code 1 = "files differ".
  const patches = await Promise.all(
    files.map((file) =>
      runGit(overlayRoot, [
        "diff",
        "--no-index",
        ...color,
        "--",
        "/dev/null",
        file,
      ]),
    ),
  );
  return patches.join("");
}

/** `--` separator before pathspecs, omitted when diffing the whole repo */
function withSep(pathspecs: string[]): string[] {
  return pathspecs.length > 0 ? ["--", ...pathspecs] : [];
}

function overlayRel(overlayRoot: string, dir: string): string {
  return toSlash(relative(overlayRoot, dir));
}

/** Run git in the overlay, tolerating the non-zero exit `git diff` returns */
async function runGit(overlayRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, {
    cwd: overlayRoot,
    reject: false,
  });
  return stdout;
}

/** Whether the overlay repo has a HEAD commit to diff against */
async function overlayHasHead(overlayRoot: string): Promise<boolean> {
  const { exitCode } = await execa("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: overlayRoot,
    reject: false,
  });
  return exitCode === 0;
}

function printDiff(output: string): void {
  console.log(output.trim() ? output : "No changes");
}
