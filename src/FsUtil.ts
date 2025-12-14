import { lstat, mkdir, readdir, readFile, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { execFileAsync } from "./Exec.ts";

/**
 * Create a symbolic link, removing existing link/file first
 * @param target - The path the symlink should point to (absolute)
 * @param linkPath - The location of the symlink itself (absolute)
 */
export async function createSymlink(
  target: string,
  linkPath: string,
): Promise<void> {
  await ensureDir(dirname(linkPath));

  try {
    await unlink(linkPath);
  } catch {
    // File doesn't exist, which is fine
  }

  await symlink(target, linkPath);
}

/** Remove a symlink if it exists */
export async function removeSymlink(linkPath: string): Promise<void> {
  try {
    const stats = await lstat(linkPath);
    if (stats.isSymbolicLink()) {
      await unlink(linkPath);
    }
  } catch {
    // Symlink doesn't exist, which is fine
  }
}

/**
 * Get the symlink target path (absolute)
 * @param _from - The location of the symlink (unused, kept for API compatibility)
 * @param to - The target of the symlink (absolute)
 * @returns Absolute path to the target
 */
export function getLinkTarget(_from: string, to: string): string {
  return to;
}

/** Recursively walk a directory, yielding all files and directories */
export async function* walkDirectory(
  dir: string,
  options: { skipDirs?: string[] } = {},
): AsyncGenerator<{ path: string; isDirectory: boolean }> {
  const skipDirs = options.skipDirs || [".git", "node_modules"];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (skipDirs.includes(entry.name)) continue;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        yield { path: fullPath, isDirectory: true };
        yield* walkDirectory(fullPath, options);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        yield { path: fullPath, isDirectory: false };
      }
    }
  } catch (_error) {
    // Directory doesn't exist or can't be read
    return;
  }
}

/** Ensure directory exists, creating it recursively if needed */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

/** Check if a file exists */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Check if a file is tracked by git */
export async function isTrackedByGit(
  filePath: string,
  repoRoot: string,
): Promise<boolean> {
  try {
    const relPath = relative(repoRoot, filePath);
    await execFileAsync("git", ["ls-files", "--error-unmatch", relPath], {
      cwd: repoRoot,
    });
    return true;
  } catch {
    return false;
  }
}

/** Check if a path is a symlink */
export async function isSymlink(filePath: string): Promise<boolean> {
  try {
    const stats = await lstat(filePath);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Get path relative to cwd, or "." if same directory */
export function relativePath(cwd: string, path: string): string {
  return relative(cwd, path) || ".";
}

/** Resolve a symlink to its absolute target path */
export async function resolveSymlinkTarget(linkPath: string): Promise<string> {
  const target = await readlink(linkPath);
  return isAbsolute(target) ? target : join(dirname(linkPath), target);
}

/** Read a file if it exists, returning null if not found */
export async function readFileIfExists(
  filePath: string,
): Promise<string | null> {
  if (!(await fileExists(filePath))) return null;
  return await readFile(filePath, "utf-8");
}

/** Read and parse a JSON file */
export async function readJsonFile<T = Record<string, unknown>>(
  filePath: string,
): Promise<T | null> {
  const content = await readFileIfExists(filePath);
  if (!content) return null;
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/** Write an object as formatted JSON */
export async function writeJsonFile(
  filePath: string,
  data: unknown,
): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}
