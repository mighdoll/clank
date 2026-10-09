import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ensureDir, fileExists, walkDirectory } from "./FsUtil.ts";
import type { GitContext } from "./Git.ts";
import { overlayBranchDir } from "./Mapper.ts";

/**
 * clank stores branch specific files in the overlay repo
 * intended for user notes and plans for each branch.
 */

/** Template variables that can be used in template files */
export interface TemplateVars {
  branch_message: string;
  /** legacy alias for branch_message, kept for existing user templates */
  worktree_message: string;
  project_name: string;
  branch_name: string;
  [key: string]: string;
}

/** Check if the branch overlay dir has already been initialized */
export async function isBranchInitialized(
  overlayRoot: string,
  gitContext: GitContext,
): Promise<boolean> {
  return await fileExists(overlayBranchDir(overlayRoot, gitContext));
}

/** Initialize branch-specific files from templates (overlay/global/init/ ==> worktrees/{branch}/) */
export async function initializeBranchOverlay(
  overlayRoot: string,
  gitContext: GitContext,
): Promise<void> {
  const templateDir = join(overlayRoot, "global/init");
  const overlayBranch = overlayBranchDir(overlayRoot, gitContext);

  if (!(await fileExists(templateDir))) {
    await ensureDir(overlayBranch);
    return;
  }

  const vars = generateTemplateVars(gitContext);

  for await (const { path, isDirectory } of walkDirectory(templateDir)) {
    if (isDirectory) continue;

    const relPath = relative(templateDir, path);
    const targetPath = join(overlayBranch, relPath);
    await createFromTemplate(path, targetPath, vars);
  }
}

/** Generate template variables from git context */
export function generateTemplateVars(gitContext: GitContext): TemplateVars {
  const { branchName, projectName } = gitContext;
  const branchMessage = `This is branch ${branchName} of project ${projectName}.`;

  return {
    branch_message: branchMessage,
    worktree_message: branchMessage,
    project_name: projectName,
    branch_name: branchName,
  };
}

/** Create a file from a template with variable substitution */
export async function createFromTemplate(
  templatePath: string,
  targetPath: string,
  vars: TemplateVars,
): Promise<void> {
  const templateContent = await readFile(templatePath, "utf-8");
  const processedContent = applyTemplate(templateContent, vars);

  await ensureDir(join(targetPath, ".."));
  await writeFile(targetPath, processedContent, "utf-8");
}

/** Replace template variables in content (uses {{variable_name}} syntax) */
export function applyTemplate(content: string, vars: TemplateVars): string {
  let result = content;

  for (const [key, value] of Object.entries(vars)) {
    const pattern = new RegExp(`\\{\\{${key}\\}\\}`, "g");
    result = result.replace(pattern, value);
  }

  return result;
}
