import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../Config.ts";
import { addToGitExclude } from "../Exclude.ts";
import { ensureDir, fileExists, isTrackedByGit, writeJsonFile } from "../FsUtil.ts";
import { detectGitRoot } from "../Git.ts";
import {
  collectGitignorePatterns,
  patternsToVscodeExcludes,
} from "../Gitignore.ts";

export interface VscodeOptions {
  remove?: boolean;
}

/** Generate VS Code settings to show clank files in search and explorer */
export async function vscodeCommand(options?: VscodeOptions): Promise<void> {
  const targetRoot = await detectGitRoot(process.cwd());

  if (options?.remove) {
    await removeVscodeSettings(targetRoot);
    return;
  }

  await generateVscodeSettings(targetRoot);
}

/** Generate VS Code settings for a target directory */
export async function generateVscodeSettings(
  targetRoot: string,
): Promise<void> {
  console.log(`Generating VS Code settings for: ${targetRoot}\n`);

  const { patterns, negationWarnings } =
    await collectGitignorePatterns(targetRoot);

  for (const pattern of negationWarnings) {
    console.log(
      `Warning: Cannot represent negation pattern "!${pattern}" in VS Code settings.`,
    );
    console.log("  This file may be incorrectly hidden.\n");
  }

  const excludeGlobs = patternsToVscodeExcludes(patterns);
  const excludePatterns: Record<string, boolean> = {};
  for (const glob of excludeGlobs) {
    excludePatterns[glob] = true;
  }

  const mergedSettings = await mergeVscodeSettings(targetRoot, excludePatterns);

  await writeVscodeSettings(targetRoot, mergedSettings);

  const config = await loadConfig();
  if (config.vscodeGitignore !== false) {
    await addVscodeToGitExclude(targetRoot);
  }

  console.log(
    `\nVS Code will now show clank/ and .claude/ in explorer and search`,
  );
  console.log(
    `(while still respecting your ${excludeGlobs.length} gitignore patterns)`,
  );
}

/** Remove clank-generated VS Code settings */
export async function removeVscodeSettings(targetRoot: string): Promise<void> {
  const settingsPath = join(targetRoot, ".vscode/settings.json");

  if (!(await fileExists(settingsPath))) {
    return;
  }

  const content = await readFile(settingsPath, "utf-8");

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(content);
  } catch {
    console.error("Warning: Could not parse .vscode/settings.json");
    return;
  }

  // Regenerate the patterns clank would have added
  const { patterns } = await collectGitignorePatterns(targetRoot);
  const clankPatterns = patternsToVscodeExcludes(patterns);

  // Selectively remove only clank-generated patterns
  removePatterns(settings, "search.exclude", clankPatterns);
  removePatterns(settings, "files.exclude", clankPatterns);

  // Remove useIgnoreFiles (let VS Code use its default)
  delete settings["search.useIgnoreFiles"];

  if (Object.keys(settings).length === 0) {
    await unlink(settingsPath);
    console.log("Removed empty .vscode/settings.json");
  } else {
    await writeJsonFile(settingsPath, settings);
    console.log("Removed clank settings from .vscode/settings.json");
  }
}

/** Remove patterns from an exclude object, deleting the key if empty */
function removePatterns(
  settings: Record<string, unknown>,
  key: string,
  patterns: string[],
): void {
  const exclude = settings[key] as Record<string, boolean> | undefined;
  if (!exclude) return;

  for (const pattern of patterns) {
    delete exclude[pattern];
  }
  if (Object.keys(exclude).length === 0) {
    delete settings[key];
  }
}

/** Merge clank exclude patterns with existing .vscode/settings.json */
async function mergeVscodeSettings(
  targetRoot: string,
  excludePatterns: Record<string, boolean>,
): Promise<Record<string, unknown>> {
  const settingsPath = join(targetRoot, ".vscode/settings.json");

  let existingSettings: Record<string, unknown> = {};
  if (await fileExists(settingsPath)) {
    const content = await readFile(settingsPath, "utf-8");
    try {
      existingSettings = JSON.parse(content);
    } catch {
      console.warn(
        "Warning: Could not parse existing .vscode/settings.json, overwriting",
      );
    }
  }

  // Get existing exclude patterns (preserve user's patterns)
  const existingSearchExclude =
    (existingSettings["search.exclude"] as Record<string, boolean>) || {};
  const existingFilesExclude =
    (existingSettings["files.exclude"] as Record<string, boolean>) || {};

  return {
    ...existingSettings,
    "search.useIgnoreFiles": false,
    "search.exclude": { ...existingSearchExclude, ...excludePatterns },
    "files.exclude": { ...existingFilesExclude, ...excludePatterns },
  };
}

/** Write settings to .vscode/settings.json */
async function writeVscodeSettings(
  targetRoot: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const vscodeDir = join(targetRoot, ".vscode");
  const settingsPath = join(vscodeDir, "settings.json");

  await ensureDir(vscodeDir);
  await writeJsonFile(settingsPath, settings);

  console.log(`Wrote ${settingsPath}`);
}

/** Add .vscode/settings.json to .git/info/exclude */
async function addVscodeToGitExclude(targetRoot: string): Promise<void> {
  const settingsPath = join(targetRoot, ".vscode/settings.json");
  if (await isTrackedByGit(settingsPath, targetRoot)) return;
  await addToGitExclude(targetRoot, ".vscode/settings.json");
}

/** Check if target directory has VS Code artifacts */
export async function isVscodeProject(targetRoot: string): Promise<boolean> {
  // Check for .vscode directory
  const hasVscodeDir = await fileExists(join(targetRoot, ".vscode"));
  if (hasVscodeDir) return true;

  // Check for *.code-workspace files
  try {
    const files = await readdir(targetRoot);
    return files.some((f) => f.endsWith(".code-workspace"));
  } catch {
    return false;
  }
}
