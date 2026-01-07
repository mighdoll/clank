import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { agentFiles, targetManagedDirs } from "./AgentFiles.ts";
import { filterClankLines } from "./Exclude.ts";
import { fileExists, walkDirectory } from "./FsUtil.ts";
import { getGitDir } from "./Git.ts";
import { partition } from "./Util.ts";

/** A parsed gitignore pattern with context */
export interface GitignorePattern {
  /** The gitignore pattern (e.g., "node_modules/", "*.log") */
  pattern: string;
  /** Directory containing the .gitignore, relative to repo root (empty for root) */
  basePath: string;
  /** Whether this is a negation pattern (starts with !) */
  negation: boolean;
  /** Path to the source file this pattern came from */
  source: string;
}

/** Result of collecting patterns, including warnings */
export interface CollectResult {
  /** All collected gitignore patterns */
  patterns: GitignorePattern[];
  /** Negation patterns that were skipped (can't be represented in VS Code) */
  negationWarnings: string[];
}

/** Options for parsing a gitignore file */
interface ParseOptions {
  /** Directory containing the .gitignore, relative to repo root (default: "") */
  basePath?: string;
  /** Whether to skip the clank-managed section in .git/info/exclude */
  skipClankSection?: boolean;
}

/** Collect all gitignore patterns from a repository */
export async function collectGitignorePatterns(
  targetRoot: string,
): Promise<CollectResult> {
  const result: CollectResult = { patterns: [], negationWarnings: [] };

  // 1. Read .git/info/exclude
  const gitDir = await getGitDir(targetRoot);
  if (gitDir) {
    const excludePath = join(gitDir, "info/exclude");
    await parseGitignoreFile(excludePath, result, { skipClankSection: true });
  }

  // 2. Read root .gitignore
  await parseGitignoreFile(join(targetRoot, ".gitignore"), result);

  // 3. Find nested .gitignore files
  for (const path of await findNestedGitignores(targetRoot)) {
    const basePath = relative(targetRoot, dirname(path));
    await parseGitignoreFile(path, result, { basePath });
  }

  return result;
}

/** Convert a gitignore pattern to VS Code glob format */
export function gitignoreToVscodeGlob(pattern: GitignorePattern): string {
  let glob = pattern.pattern;

  // Handle trailing slash (directory only) - strip it
  if (glob.endsWith("/")) {
    glob = glob.slice(0, -1);
  }

  // Handle leading slash (anchored to base directory)
  if (glob.startsWith("/")) {
    glob = glob.slice(1);
    // If in subdirectory, prefix with basePath
    if (pattern.basePath) {
      glob = `${pattern.basePath}/${glob}`;
    }
    // Anchored patterns don't need ** prefix
    return glob;
  }

  // Unanchored patterns in subdirectories
  if (pattern.basePath) {
    // Pattern can match anywhere under basePath
    return `${pattern.basePath}/**/${glob}`;
  }

  // Unanchored patterns at root - can match anywhere
  if (!glob.startsWith("**/") && !glob.includes("/")) {
    glob = `**/${glob}`;
  }

  return glob;
}

/** Check if a pattern matches clank-managed files */
export function isClankPattern(glob: string): boolean {
  // Normalize: remove leading **/ and trailing /
  const normalized = glob.replace(/^\*\*\//, "").replace(/\/$/, "");

  // Check against managed directories
  for (const dir of targetManagedDirs) {
    if (
      normalized === dir ||
      normalized.startsWith(`${dir}/`) ||
      normalized.endsWith(`/${dir}`)
    ) {
      return true;
    }
  }

  // Check against agent files
  for (const agentFile of agentFiles) {
    if (normalized === agentFile || normalized.endsWith(`/${agentFile}`)) {
      return true;
    }
  }

  return false;
}

/** Convert collected patterns to VS Code exclude globs, filtering clank patterns */
export function patternsToVscodeExcludes(
  patterns: GitignorePattern[],
): string[] {
  const globs = patterns
    .filter((p) => !p.negation)
    .map(gitignoreToVscodeGlob)
    .filter((glob) => !isClankPattern(glob));

  return deduplicateGlobs([...new Set(globs)]);
}

/**
 * Remove globs that are already covered by broader patterns.
 * e.g., if `** /node_modules` exists, remove `tools/** /node_modules`
 */
export function deduplicateGlobs(globs: string[]): string[] {
  // Partition into universal (**/) and specific patterns
  const [universal, specific] = partition(globs, (g) => g.startsWith("**/"));

  // Get suffixes that universal patterns cover (without **/ prefix)
  const coveredSuffixes = new Set(universal.map((g) => g.slice(3)));

  // Keep specific patterns not covered by a universal pattern
  const uncovered = specific.filter((glob) => {
    for (const suffix of coveredSuffixes) {
      if (glob.endsWith(`/**/${suffix}`) || glob.endsWith(`/${suffix}`)) {
        return false;
      }
    }
    return true;
  });

  return [...universal, ...uncovered];
}

/** Parse a gitignore file and accumulate results */
async function parseGitignoreFile(
  source: string,
  result: CollectResult,
  options: ParseOptions = {},
): Promise<void> {
  if (!(await fileExists(source))) return;

  const content = await readFile(source, "utf-8");
  const parsed = parseGitignoreContent(content, source, options);
  result.patterns.push(...parsed.patterns);
  result.negationWarnings.push(...parsed.negationWarnings);
}

/** Find all nested .gitignore files (excluding root) */
async function findNestedGitignores(targetRoot: string): Promise<string[]> {
  const gitignores: string[] = [];
  const rootGitignore = join(targetRoot, ".gitignore");

  for await (const { path, isDirectory } of walkDirectory(targetRoot)) {
    if (isDirectory) continue;
    if (basename(path) === ".gitignore" && path !== rootGitignore) {
      gitignores.push(path);
    }
  }

  return gitignores;
}

/** Parse gitignore file content into patterns */
function parseGitignoreContent(
  content: string,
  source: string,
  options: ParseOptions,
): { patterns: GitignorePattern[]; negationWarnings: string[] } {
  const rawLines = content.split("\n");
  const lines = options.skipClankSection
    ? filterClankLines(rawLines)
    : rawLines;
  const basePath = options.basePath ?? "";

  const patterns: GitignorePattern[] = [];
  const negationWarnings: string[] = [];

  for (const line of lines) {
    const { pattern, negation } = parseLine(line.trim(), source, basePath);
    if (pattern) patterns.push(pattern);
    if (negation) negationWarnings.push(negation);
  }

  return { patterns, negationWarnings };
}

/** Parse a single gitignore line */
function parseLine(
  trimmed: string,
  source: string,
  basePath: string,
): { pattern?: GitignorePattern; negation?: string } {
  // Skip empty lines and comments
  if (!trimmed || trimmed.startsWith("#")) return {};

  const isNegation = trimmed.startsWith("!");
  const pattern = isNegation ? trimmed.slice(1) : trimmed;

  if (isNegation) {
    return { negation: pattern };
  }
  return { pattern: { pattern, basePath, negation: false, source } };
}