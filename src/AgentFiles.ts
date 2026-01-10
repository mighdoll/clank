import { join } from "node:path";

/** Base agent directory names (without leading dot) */
export const agentDirNames = ["claude", "gemini"];

/** Agent directories as they appear in target (with leading dot) */
export const managedAgentDirs = agentDirNames.map((d) => `.${d}`);

/** Agent file names that clank manages */
export const agentFiles = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"];

/** Directory names managed by clank (as stored in overlay, without leading dot) */
export const managedDirs = ["clank", "prompts", ...agentDirNames];

/** Directory names managed by clank (as stored in target, with leading dot) */
export const targetManagedDirs = ["clank", ...managedAgentDirs];

/** Build agent file paths mapping for a directory */
export function getAgentFilePaths(dir: string): Record<string, string> {
  return {
    agents: join(dir, "AGENTS.md"),
    claude: join(dir, "CLAUDE.md"),
    gemini: join(dir, "GEMINI.md"),
  };
}

/** Iterate over agent file paths, calling fn for each configured agent */
export async function forEachAgentPath(
  dir: string,
  agents: string[],
  fn: (agentPath: string, agentName: string) => Promise<void>,
): Promise<void> {
  const agentPaths = getAgentFilePaths(dir);
  for (const agent of agents) {
    const agentPath = agentPaths[agent.toLowerCase()];
    if (!agentPath) continue;
    await fn(agentPath, agent);
  }
}
