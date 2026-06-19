import { execa } from "execa";
import picomatch from "picomatch";
import { managedDirs } from "./AgentFiles.ts";

/** Get git status of the overlay repository */
export async function getOverlayStatus(
  overlayRoot: string,
  ignorePatterns: string[] = [],
): Promise<string[]> {
  const { stdout } = await execa({
    cwd: overlayRoot,
  })`git status --porcelain -uall`;

  const allLines = stdout.trimEnd() ? stdout.trimEnd().split("\n") : [];
  return filterIgnoredLines(allLines, ignorePatterns);
}

/** Format git status --porcelain output into readable lines */
export function formatStatusLines(lines: string[]): string[] {
  return lines.map((line) => {
    const statusCode = formatStatusCode(line.slice(0, 2));
    const filePath = line.slice(3);
    const { scope, pathParts } = parseScopedPath(filePath);
    const displayPath = shortPath(pathParts);
    return `${statusCode} ${displayPath} (${scope})`;
  });
}

/** Format git status code to single letter */
export function formatStatusCode(code: string): string {
  const c = code.trim();
  if (c === "??") return "A";
  if (c.includes("D")) return "D";
  if (c.includes("M")) return "M";
  if (c.includes("A")) return "A";
  if (c.includes("R")) return "R";
  return "?";
}

/** Build a predicate matching overlay paths against ignore patterns.
 * Matches the full path, its basename, or any directory segment (so a
 * pattern like ".obsidian" hides everything underneath it). */
export function makeIgnoreFilter(
  ignorePatterns: string[],
): (path: string) => boolean {
  if (ignorePatterns.length === 0) return () => false;

  const isIgnored = picomatch(ignorePatterns);
  return (filePath: string): boolean => {
    const segments = filePath.split("/");
    const pathBasename = segments.at(-1) ?? "";
    if (isIgnored(filePath) || isIgnored(pathBasename)) return true;
    return segments.some((segment) => isIgnored(segment));
  };
}

/** Filter out porcelain status lines matching ignore patterns */
function filterIgnoredLines(
  lines: string[],
  ignorePatterns: string[],
): string[] {
  if (ignorePatterns.length === 0) return lines;
  const ignored = makeIgnoreFilter(ignorePatterns);
  return lines.filter((line) => !ignored(line.slice(3))); // skip status + space
}

/** Parse overlay path into scope and path parts within that scope */
function parseScopedPath(filePath: string): {
  scope: string;
  pathParts: string[];
} {
  const segments = filePath.split("/");
  if (segments[0] === "global") {
    return { scope: "global", pathParts: segments.slice(1) };
  }
  if (segments[0] === "targets") {
    const project = segments[1];
    if (segments[2] === "worktrees") {
      // worktrees/<branch>/ - branch is max 2 segments (main, feat/foo)
      const afterWorktrees = segments.slice(3);
      const branchSegments = Math.min(
        2,
        Math.max(0, afterWorktrees.length - 1),
      );
      const branch = afterWorktrees.slice(0, branchSegments).join("/");
      const scope = `${project}/${branch}`;
      return { scope, pathParts: afterWorktrees.slice(branchSegments) };
    }
    return { scope: project || "unknown", pathParts: segments.slice(2) };
  }
  return { scope: "unknown", pathParts: segments };
}

/** Shorten path parts to last 2-3 meaningful segments for display */
function shortPath(pathParts: string[]): string {
  if (pathParts.length <= 2) return pathParts.join("/");

  // If file is in a managed dir, show 3 segments (parent/clank/file)
  const parentDir = pathParts[pathParts.length - 2];
  if (managedDirs.includes(parentDir)) {
    return pathParts.slice(-3).join("/");
  }
  // Otherwise show 2 segments (parent/file)
  return pathParts.slice(-2).join("/");
}
