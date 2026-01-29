import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../Config.ts";
import { addToGitExclude } from "../Exclude.ts";
import {
  ensureDir,
  fileExists,
  isTrackedByGit,
  writeJsonFile,
} from "../FsUtil.ts";
import { detectGitRoot } from "../Git.ts";
import {
  collectGitignorePatterns,
  patternsToVscodeExcludes,
} from "../Gitignore.ts";

export interface VscodeOptions {
  remove?: boolean;
  force?: boolean;
}

/** Result of checking if VS Code settings can be generated */
export interface VscodeTrackingCheck {
  canGenerate: boolean;
  warning?: string;
  hasBase: boolean;
}

/** Check if settings.base.json exists */
export async function hasBaseSettings(targetRoot: string): Promise<boolean> {
  return fileExists(join(targetRoot, ".vscode/settings.base.json"));
}

/** Read layered settings (base + local) if base exists */
async function readLayeredSettings(
  targetRoot: string,
): Promise<Record<string, unknown> | null> {
  const basePath = join(targetRoot, ".vscode/settings.base.json");
  const localPath = join(targetRoot, ".vscode/settings.local.json");

  if (!(await fileExists(basePath))) return null;

  let base: Record<string, unknown> = {};
  const baseContent = await readFile(basePath, "utf-8");
  try {
    base = JSON.parse(baseContent);
  } catch {
    console.warn("Warning: Could not parse settings.base.json, ignoring");
    return null;
  }

  let local: Record<string, unknown> = {};
  if (await fileExists(localPath)) {
    const localContent = await readFile(localPath, "utf-8");
    try {
      local = JSON.parse(localContent);
    } catch {
      console.warn("Warning: Could not parse settings.local.json, ignoring");
    }
  }

  // Merge exclude patterns specially (combine, don't replace)
  const baseSearch = (base["search.exclude"] as Record<string, boolean>) || {};
  const localSearch =
    (local["search.exclude"] as Record<string, boolean>) || {};
  const baseFiles = (base["files.exclude"] as Record<string, boolean>) || {};
  const localFiles = (local["files.exclude"] as Record<string, boolean>) || {};

  return {
    ...base,
    ...local,
    "search.exclude": { ...baseSearch, ...localSearch },
    "files.exclude": { ...baseFiles, ...localFiles },
  };
}

/** Check if settings.json is tracked and return appropriate warning */
export async function checkVscodeTracking(
  targetRoot: string,
): Promise<VscodeTrackingCheck> {
  const settingsPath = join(targetRoot, ".vscode/settings.json");
  const hasBase = await hasBaseSettings(targetRoot);
  const isTracked = await isTrackedByGit(settingsPath, targetRoot);

  if (!isTracked) {
    return { canGenerate: true, hasBase };
  }

  // settings.json is tracked
  if (hasBase) {
    return {
      canGenerate: false,
      hasBase,
      warning:
        "settings.base.json found but settings.json is still tracked.\n" +
        "Complete migration: git rm --cached .vscode/settings.json",
    };
  }

  return {
    canGenerate: false,
    hasBase,
    warning:
      "Skipping: .vscode/settings.json is tracked.\n" +
      "Use `clank vscode --force` to override, or migrate:\n" +
      "  mv .vscode/settings.json .vscode/settings.base.json && git rm --cached .vscode/settings.json",
  };
}

/** Generate VS Code settings to show clank files in search and explorer */
export async function vscodeCommand(options?: VscodeOptions): Promise<void> {
  const targetRoot = await detectGitRoot(process.cwd());

  if (options?.remove) {
    await removeVscodeSettings(targetRoot);
    return;
  }

  // Check if we can generate (tracking check)
  const check = await checkVscodeTracking(targetRoot);
  if (!check.canGenerate && !options?.force) {
    console.log(check.warning);
    return;
  }

  if (options?.force && !check.canGenerate) {
    console.log(
      "Note: settings.json is tracked, this will create uncommitted changes.\n",
    );
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

  const uniqueWarnings = [...new Set(negationWarnings)];
  for (const pattern of uniqueWarnings) {
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

/** Regenerate settings.json from base+local only (remove clank additions) */
async function removeLayeredSettings(
  settingsPath: string,
  layered: Record<string, unknown>,
): Promise<void> {
  delete layered["search.useIgnoreFiles"];

  if (Object.keys(layered).length === 0) {
    if (await fileExists(settingsPath)) {
      await unlink(settingsPath);
      console.log("Removed .vscode/settings.json (base+local were empty)");
    }
  } else {
    await writeJsonFile(settingsPath, layered);
    console.log(
      "Regenerated .vscode/settings.json from base+local (removed clank patterns)",
    );
  }
}

/** Remove clank-generated VS Code settings */
export async function removeVscodeSettings(targetRoot: string): Promise<void> {
  const settingsPath = join(targetRoot, ".vscode/settings.json");

  // If layered settings exist, regenerate from base+local only
  const layered = await readLayeredSettings(targetRoot);
  if (layered) {
    await removeLayeredSettings(settingsPath, layered);
    return;
  }

  // Legacy mode: selectively remove clank patterns
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

/** Merge clank exclude patterns with layered or existing settings */
async function mergeVscodeSettings(
  targetRoot: string,
  excludePatterns: Record<string, boolean>,
): Promise<Record<string, unknown>> {
  // Try layered settings first (base + local)
  const layered = await readLayeredSettings(targetRoot);

  if (layered) {
    // Layered mode: base + local + clank
    const layeredSearch =
      (layered["search.exclude"] as Record<string, boolean>) || {};
    const layeredFiles =
      (layered["files.exclude"] as Record<string, boolean>) || {};

    return {
      ...layered,
      "search.useIgnoreFiles": false,
      "search.exclude": { ...layeredSearch, ...excludePatterns },
      "files.exclude": { ...layeredFiles, ...excludePatterns },
    };
  }

  // Legacy mode: read existing settings.json
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

/** Add .vscode/settings.json and settings.local.json to .git/info/exclude */
async function addVscodeToGitExclude(targetRoot: string): Promise<void> {
  const settingsPath = join(targetRoot, ".vscode/settings.json");
  const localPath = join(targetRoot, ".vscode/settings.local.json");

  if (!(await isTrackedByGit(settingsPath, targetRoot))) {
    await addToGitExclude(targetRoot, ".vscode/settings.json");
  }
  if (!(await isTrackedByGit(localPath, targetRoot))) {
    await addToGitExclude(targetRoot, ".vscode/settings.local.json");
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
