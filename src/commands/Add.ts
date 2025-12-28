import {
  lstat,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
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

const scopeLabels: Record<Scope, string> = {
  global: "global",
  project: "project",
  worktree: "worktree",
};

export type AddOptions = ScopeOptions;

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

interface AddContext {
  cwd: string;
  gitContext: GitContext;
  config: { overlayRepo: string; agents: string[] };
  overlayRoot: string;
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

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
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

/** Create agent symlinks (CLAUDE.md, GEMINI.md, AGENTS.md → agents.md) */
interface AgentLinkParams {
  overlayPath: string;
  symlinkDir: string;
  gitRoot: string;
  overlayRoot: string;
  agents: string[];
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

interface AgentLinkClassification {
  toCreate: { targetPath: string; name: string }[];
  existing: string[];
  skipped: string[];
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
