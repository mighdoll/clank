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

/** Filter out lines matching ignore patterns */
function filterIgnoredLines(
  lines: string[],
  ignorePatterns: string[],
): string[] {
  if (ignorePatterns.length === 0) return lines;

  const isIgnored = picomatch(ignorePatterns);
  return lines.filter((line) => {
    const filePath = line.slice(3); // Skip status code + space
    const segments = filePath.split("/");
    const pathBasename = segments.at(-1) ?? "";

    // Check full path and basename
    if (isIgnored(filePath) || isIgnored(pathBasename)) return false;

    // Check each directory segment (for patterns like ".obsidian")
    for (const segment of segments) {
      if (isIgnored(segment)) return false;
    }

    return true;
  });
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
      return {
        scope: `${project}/${branch}`,
        pathParts: afterWorktrees.slice(branchSegments),
      };
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
