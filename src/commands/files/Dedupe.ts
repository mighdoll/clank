import { dirname } from "node:path";
import { agentFiles } from "../../AgentFiles.ts";
import { getPromptRelPath } from "../../Mapper.ts";
import { partition } from "../../Util.ts";
import { type FileEntry, isInDirectory } from "./Scan.ts";

/** Apply dedupe rules for agent files and prompt fanout paths. */
export function dedupeEntries(
  entries: FileEntry[],
  agentsPreference: string[],
): FileEntry[] {
  const dedupedAgents = dedupeAgentFiles(entries, agentsPreference);
  return dedupePromptFiles(dedupedAgents, agentsPreference);
}

/** Check if a relative path ends with an agent filename (CLAUDE.md, etc.) */
export function isAgentFilePath(relPath: string): boolean {
  const base = relPath.split("/").at(-1)?.toLowerCase();
  if (!base) return false;
  return agentFiles.some((f) => f.toLowerCase() === base);
}

/** Keep at most one agent file per directory, using the configured preference order. */
function dedupeAgentFiles(
  entries: FileEntry[],
  agentsPreference: string[],
): FileEntry[] {
  const byDir = Map.groupBy(entries, (e) =>
    isAgentFilePath(e.targetRelativePath) ? dirname(e.targetRelativePath) : "",
  );
  const preferred = agentPreferenceToFilename(agentsPreference);

  return [...byDir].flatMap(([dirKey, group]) => {
    if (dirKey === "") return group;
    const [candidates, others] = partition(group, (e) =>
      isAgentFilePath(e.targetRelativePath),
    );
    const chosen = chooseByBasename(candidates, preferred);
    return chosen ? [...others, chosen] : others;
  });
}

/** Keep only one prompt path per prompt-relative filename, using agent preference order. */
function dedupePromptFiles(
  entries: FileEntry[],
  agentsPreference: string[],
): FileEntry[] {
  const preferred = agentPreferenceToDotAgentDir(agentsPreference);
  const promptGroups = Map.groupBy(
    entries,
    (e) => getPromptRelPath(e.absolutePath) ?? "",
  );

  return [...promptGroups].flatMap(([key, group]) => {
    if (key === "") return group;
    const chosen = choosePreferredPrompt(group, preferred);
    return chosen ? [chosen] : [];
  });
}

/** Convert config preference strings into a basename priority list. */
function agentPreferenceToFilename(preference: string[]): string[] {
  return mapPreference(
    preference,
    { agents: "AGENTS.md", claude: "CLAUDE.md", gemini: "GEMINI.md" },
    ["AGENTS.md", "CLAUDE.md", "GEMINI.md"],
  );
}

/** Select a single representative entry, preferring basenames in priority order. */
function chooseByBasename(
  entries: FileEntry[],
  preferredBasenames: string[],
): FileEntry | null {
  const byBase = new Map(
    entries.map((e) => [basenameUpper(e.targetRelativePath), e]),
  );
  for (const base of preferredBasenames) {
    const found = byBase.get(base.toUpperCase());
    if (found) return found;
  }
  // Fallback: pick first alphabetically (entries should never be empty here)
  const sorted = entries.toSorted((a, b) =>
    a.cwdRelativePath.localeCompare(b.cwdRelativePath),
  );
  return sorted[0] ?? null;
}

/** Convert config preference strings into a dot-agent directory priority list. */
function agentPreferenceToDotAgentDir(preference: string[]): string[] {
  return mapPreference(preference, { claude: ".claude", gemini: ".gemini" }, [
    ".claude",
    ".gemini",
  ]);
}

/** Pick the prompt entry to keep based on which agent directory it lives under. */
function choosePreferredPrompt(
  entries: FileEntry[],
  preferredDirs: string[],
): FileEntry | null {
  const byDir = new Map<string, FileEntry>();
  for (const e of entries) {
    const rel = e.targetRelativePath;
    if (isInDirectory(rel, ".claude/prompts")) {
      byDir.set(".claude", e);
    } else if (isInDirectory(rel, ".gemini/prompts")) {
      byDir.set(".gemini", e);
    }
  }
  for (const dir of preferredDirs) {
    const found = byDir.get(dir);
    if (found) return found;
  }
  const sorted = entries.toSorted((a, b) =>
    a.cwdRelativePath.localeCompare(b.cwdRelativePath),
  );
  return sorted[0];
}

/** Map preference strings through a mapping, with defaults if empty. */
function mapPreference(
  preference: string[],
  mapping: Record<string, string>,
  defaults: string[],
): string[] {
  const order = preference.map((p) => mapping[p.toLowerCase()]).filter(Boolean);
  return order.length > 0 ? order : defaults;
}

function basenameUpper(relPath: string): string {
  const base = relPath.split("/").at(-1) ?? "";
  return base.toUpperCase();
}
