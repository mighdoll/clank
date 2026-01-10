import {
  lstat,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import * as readline from "node:readline";
import { forEachAgentPath } from "../AgentFiles.ts";
import { expandPath, loadConfig, validateOverlayExists } from "../Config.ts";
import {
  createSymlink,
  ensureDir,
  fileExists,
  getLinkTarget,
  isSymlink,
  isTrackedByGit,
  walkDirectory,
} from "../FsUtil.ts";
import { type GitContext, getGitContext } from "../Git.ts";
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
import { findUnaddedFiles } from "./Check.ts";

export type AddOptions = ScopeOptions & { interactive?: boolean };

interface AddContext {
  cwd: string;
  gitContext: GitContext;
  config: { overlayRepo: string; agents: string[] };
  overlayRoot: string;
}

/** Create agent symlinks (CLAUDE.md, GEMINI.md, AGENTS.md → agents.md) */
interface AgentLinkParams {
  overlayPath: string;
  symlinkDir: string;
  gitRoot: string;
  overlayRoot: string;
  agents: string[];
}

interface AgentLinkClassification {
  toCreate: { targetPath: string; name: string }[];
  existing: string[];
  skipped: string[];
}

type InteractiveChoice = "project" | "worktree" | "global" | "skip" | "quit";
type ScopeCounts = {
  project: number;
  worktree: number;
  global: number;
  skip: number;
};

const scopeLabels: Record<Scope, string> = {
  global: "global",
  project: "project",
  worktree: "worktree",
};

/** Add file(s) to overlay and create symlinks in target */
export async function addCommand(
  filePaths: string[],
  options: AddOptions = {},
): Promise<void> {
  const cwd = process.cwd();
  const gitContext = await getGitContext(cwd);
  const config = await loadConfig();
  const overlayRoot = expandPath(config.overlayRepo);

  await validateAddOptions(options, overlayRoot, gitContext);

  const ctx = { cwd, gitContext, config, overlayRoot };

  if (options.interactive) {
    await addAllInteractive(ctx);
    return;
  }

  if (filePaths.length === 0) {
    throw new Error(
      "No files specified. Use --interactive for interactive mode.",
    );
  }

  for (const filePath of filePaths) {
    const inputPath = join(cwd, filePath);

    if (await isDirectory(inputPath)) {
      for await (const { path, isDirectory } of walkDirectory(inputPath)) {
        if (isDirectory) continue;
        await addSingleFile(relative(cwd, path), options, ctx);
      }
    } else {
      await addSingleFile(filePath, options, ctx);
    }
  }
}

/** fail if we can't do an add with the given options */
async function validateAddOptions(
  options: AddOptions,
  overlayRoot: string,
  gitContext: GitContext,
): Promise<void> {
  await validateOverlayExists(overlayRoot);

  if (options.worktree && !gitContext.isWorktree) {
    throw new Error(
      `--worktree scope requires a git worktree.\n` +
        `You're on branch '${gitContext.worktreeName}' in the main repository.\n` +
        `Use 'git worktree add' to create a worktree, or use --project scope instead.`,
    );
  }
}

/** Interactive mode: add all unadded files with per-file scope selection */
async function addAllInteractive(ctx: AddContext): Promise<void> {
  const { cwd, gitContext, overlayRoot } = ctx;
  const context: MapperContext = {
    overlayRoot,
    targetRoot: gitContext.gitRoot,
    gitContext,
  };

  const unadded = await findUnaddedFiles(context);
  const regularFiles = unadded.filter((f) => f.kind === "unadded");

  if (regularFiles.length === 0) {
    console.log("No unadded files found.");
    return;
  }

  console.log(`Found ${regularFiles.length} unadded file(s):\n`);

  const counts: ScopeCounts = { project: 0, worktree: 0, global: 0, skip: 0 };

  for (let i = 0; i < regularFiles.length; i++) {
    const file = regularFiles[i];
    const relPath = relative(cwd, file.targetPath);
    const result = await promptAndAddFile(relPath, i, regularFiles.length, ctx);
    if (result === "quit") break;
    if (result !== "error") counts[result]++;
  }

  printSummary(counts);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Add a single file to overlay and create symlink */
async function addSingleFile(
  filePath: string,
  options: AddOptions,
  ctx: AddContext,
): Promise<void> {
  const { cwd, gitContext, config, overlayRoot } = ctx;
  const { gitRoot } = gitContext;

  const scope = resolveScopeFromOptions(options);
  /** Absolute path where symlink will be created in target repo */
  const normalizedPath = normalizeAddPath(filePath, cwd, gitRoot);
  const context: MapperContext = {
    overlayRoot,
    targetRoot: gitRoot,
    gitContext,
  };
  const overlayPath = targetToOverlay(normalizedPath, scope, context);

  const fileName = basename(normalizedPath);
  const scopeLabel =
    scope === "global" ? "global" : `${gitContext.projectName} ${scope}`;

  // Only check barePath for symlink - we want the user's input file, not clank/foo.md
  const barePath = join(cwd, filePath);

  // Check if already in overlay at a different scope
  await checkScopeConflict(barePath, scope, context, cwd);

  if (await fileExists(overlayPath)) {
    console.log(`${fileName} already exists in ${scopeLabel} overlay`);
  } else if (await isSymlink(barePath)) {
    await addSymlinkToOverlay(barePath, overlayPath, scopeLabel);
  } else {
    await addFileToOverlay(normalizedPath, barePath, overlayPath, scopeLabel);
  }

  // Check if this is an agent file (CLAUDE.md, AGENTS.md, GEMINI.md)
  if (isAgentFile(filePath)) {
    const symlinkDir = dirname(normalizedPath);
    const { agents } = config;
    const params = { overlayPath, symlinkDir, gitRoot, overlayRoot, agents };
    await createAgentLinks(params);
  } else if (isPromptFile(normalizedPath)) {
    await handlePromptFile(normalizedPath, overlayPath, gitRoot, cwd);
  } else {
    await handleRegularFile(normalizedPath, overlayPath, overlayRoot, cwd);
  }
}

/** Prompt for scope and add a single file. Returns the choice or "error". */
async function promptAndAddFile(
  relPath: string,
  index: number,
  total: number,
  ctx: AddContext,
): Promise<InteractiveChoice | "error"> {
  process.stdout.write(`[${index + 1}/${total}] ${relPath}\n`);
  process.stdout.write(
    "      (P)roject  (W)orktree  (G)lobal  (S)kip  (Q)uit  [P]: ",
  );

  const choice = await readScopeChoice(ctx.gitContext.isWorktree);

  if (choice === "quit" || choice === "skip") {
    if (choice === "quit") console.log("\nAborted.");
    else console.log();
    return choice;
  }

  const scopeOptions: ScopeOptions = {
    project: choice === "project",
    worktree: choice === "worktree",
    global: choice === "global",
  };

  try {
    await addSingleFile(relPath, scopeOptions, ctx);
    console.log();
    return choice;
  } catch (error) {
    console.error(`  Error: ${error instanceof Error ? error.message : error}`);
    console.log();
    return "error";
  }
}

/** Print summary of interactive add results */
function printSummary(counts: Record<string, number>): void {
  const parts: string[] = [];
  if (counts.project > 0) parts.push(`${counts.project} to project`);
  if (counts.worktree > 0) parts.push(`${counts.worktree} to worktree`);
  if (counts.global > 0) parts.push(`${counts.global} to global`);
  if (counts.skip > 0) parts.push(`${counts.skip} skipped`);

  if (parts.length > 0) {
    console.log(`Added ${parts.join(", ")}`);
  }
}

/** Check if file is already in overlay at a different scope, throw helpful error */
async function checkScopeConflict(
  barePath: string,
  requestedScope: Scope,
  context: MapperContext,
  cwd: string,
): Promise<void> {
  const currentScope = await scopeFromSymlink(barePath, context);
  if (currentScope && currentScope !== requestedScope) {
    const fileName = relative(cwd, barePath);
    throw new Error(
      `${fileName} is already in ${scopeLabels[currentScope]} overlay.\n` +
        `To move it to ${scopeLabels[requestedScope]} scope, use: clank mv ${fileName} --${requestedScope}`,
    );
  }
}

/** Copy a symlink to the overlay, preserving its target */
async function addSymlinkToOverlay(
  inputPath: string,
  overlayPath: string,
  scopeLabel: string,
): Promise<void> {
  const target = await readlink(inputPath);
  await ensureDir(dirname(overlayPath));
  await symlink(target, overlayPath);
  console.log(`Copied symlink ${basename(inputPath)} to ${scopeLabel} overlay`);
}

/** Copy file content to overlay */
async function addFileToOverlay(
  normalizedPath: string,
  barePath: string,
  overlayPath: string,
  scopeLabel: string,
): Promise<void> {
  await ensureDir(dirname(overlayPath));
  const content = await findSourceContent(normalizedPath, barePath);
  await writeFile(overlayPath, content, "utf-8");
  const fileName = basename(overlayPath);
  if (content) {
    console.log(`Copied ${fileName} to ${scopeLabel} overlay`);
  } else {
    console.log(`Created empty ${fileName} in ${scopeLabel} overlay`);
  }
}

async function createAgentLinks(p: AgentLinkParams): Promise<void> {
  const { overlayPath, ...classifyParams } = p;
  const { toCreate, existing, skipped } =
    await classifyAgentLinks(classifyParams);

  const promisedLinks = toCreate.map(({ targetPath }) => {
    const linkTarget = getLinkTarget(targetPath, overlayPath);
    return createSymlink(linkTarget, targetPath);
  });
  await Promise.all(promisedLinks);

  if (toCreate.length) {
    const created = toCreate.map(({ name }) => name);
    console.log(`Created symlinks: ${created.join(", ")}`);
  }

  if (existing.length) {
    console.log(`Symlinks already exist: ${existing.join(", ")}`);
  }

  if (skipped.length) {
    console.log(`Skipped (already tracked in git): ${skipped.join(", ")}`);
  }
}

/** Handle prompt file symlink creation */
async function handlePromptFile(
  normalizedPath: string,
  overlayPath: string,
  gitRoot: string,
  cwd: string,
): Promise<void> {
  const promptRelPath = getPromptRelPath(normalizedPath);
  if (promptRelPath) {
    const created = await createPromptLinks(
      overlayPath,
      promptRelPath,
      gitRoot,
    );
    if (created.length) {
      console.log(
        `Created symlinks: ${created.map((p) => relative(cwd, p)).join(", ")}`,
      );
    }
  }
}

/** Handle regular file symlink creation */
async function handleRegularFile(
  normalizedPath: string,
  overlayPath: string,
  overlayRoot: string,
  cwd: string,
): Promise<void> {
  if (await isSymlinkToOverlay(normalizedPath, overlayRoot)) {
    console.log(`Symlink already exists: ${relative(cwd, normalizedPath)}`);
  } else {
    const linkTarget = getLinkTarget(normalizedPath, overlayPath);
    await createSymlink(linkTarget, normalizedPath);
    console.log(`Created symlink: ${relative(cwd, normalizedPath)}`);
  }
}

/** Read a single keypress for scope selection */
async function readScopeChoice(
  isWorktree: boolean,
): Promise<InteractiveChoice> {
  const key = await readSingleKey();

  switch (key.toLowerCase()) {
    case "p":
    case "\r":
    case "\n":
      console.log("project");
      return "project";
    case "w":
      if (!isWorktree) {
        console.log("(not in worktree, using project)");
        return "project";
      }
      console.log("worktree");
      return "worktree";
    case "g":
      console.log("global");
      return "global";
    case "s":
      console.log("skip");
      return "skip";
    case "q":
    case "\x03": // Ctrl+C
      return "quit";
    default:
      console.log("project");
      return "project";
  }
}

/** Find content from normalized path or bare input path */
async function findSourceContent(
  normalizedPath: string,
  barePath: string,
): Promise<string> {
  // Try normalized path first (e.g., cwd/clank/foo.md)
  if (
    (await fileExists(normalizedPath)) &&
    !(await isSymlink(normalizedPath))
  ) {
    return await readFile(normalizedPath, "utf-8");
  }
  // Fall back to bare input path (e.g., cwd/foo.md)
  if ((await fileExists(barePath)) && !(await isSymlink(barePath))) {
    return await readFile(barePath, "utf-8");
  }
  return "";
}

/** Classify which agent symlinks to create vs skip */
async function classifyAgentLinks(
  p: Omit<AgentLinkParams, "overlayPath">,
): Promise<AgentLinkClassification> {
  const { symlinkDir, gitRoot, overlayRoot, agents } = p;
  const skipped: string[] = [];
  const existing: string[] = [];
  const toCreate: { targetPath: string; name: string }[] = [];

  await forEachAgentPath(symlinkDir, agents, async (targetPath) => {
    // Check if symlink already points to overlay
    if (await isSymlinkToOverlay(targetPath, overlayRoot)) {
      existing.push(basename(targetPath));
      return;
    }

    const isTrackedFile =
      (await fileExists(targetPath)) &&
      !(await isSymlink(targetPath)) &&
      (await isTrackedByGit(targetPath, gitRoot));

    if (isTrackedFile) {
      skipped.push(basename(targetPath));
    } else {
      toCreate.push({ targetPath, name: basename(targetPath) });
    }
  });

  return { toCreate, existing, skipped };
}

/** Read a single keypress from stdin (raw mode) */
function readSingleKey(): Promise<string> {
  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const onKeypress = (data: Buffer): void => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(wasRaw ?? false);
      }
      process.stdin.pause();
      process.stdin.removeListener("data", onKeypress);
      resolve(data.toString());
    };

    process.stdin.once("data", onKeypress);
  });
}
