import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { cosmiconfig } from "cosmiconfig";
import { fileExists } from "./FsUtil.ts";

export const defaultOverlayDir = "clankover";

export interface ClankConfig {
  overlayRepo: string;
  agents: string[];
  /** Generate .vscode/settings.json to make clank files visible in search/explorer */
  vscodeSettings?: "auto" | "always" | "never";
  /** Add .vscode/settings.json to .git/info/exclude (default: true) */
  vscodeGitignore?: boolean;
}

const defaultConfig: ClankConfig = {
  overlayRepo: join(homedir(), defaultOverlayDir),
  agents: ["agents", "claude", "gemini"],
};

const explorer = cosmiconfig("clank");
let customConfigPath: string | undefined;

/** path to user's clank config file */
export function setConfigPath(path: string | undefined): void {
  customConfigPath = path;
}

/** Load global clank configuration from ~/.config/clank/config.js or similar */
export async function loadConfig(): Promise<ClankConfig> {
  if (customConfigPath) {
    const result = await explorer.load(customConfigPath);
    if (!result) {
      throw new Error(`Config file not found: ${customConfigPath}`);
    }
    if (result.isEmpty) {
      return defaultConfig;
    }
    return { ...defaultConfig, ...result.config };
  }

  const result = await explorer.search(getConfigDir());
  if (!result || result.isEmpty) {
    return defaultConfig;
  }
  return { ...defaultConfig, ...result.config };
}

/** Create default configuration file at ~/.config/clank/config.js */
export async function createDefaultConfig(overlayRepo?: string): Promise<void> {
  const configDir = getConfigDir();
  const configPath = customConfigPath || join(configDir, "config.js");

  const config = {
    ...defaultConfig,
    ...(overlayRepo && { overlayRepo }),
  };

  const content = `export default ${JSON.stringify(config, null, 2)};\n`;

  if (!customConfigPath) {
    await mkdir(configDir, { recursive: true });
  }

  await writeFile(configPath, content, "utf-8");
  console.log(`Config file created at: ${configPath}`);
}

/** Expand ~ in paths to home directory */
export function expandPath(path: string): string {
  if (path.startsWith("~/") || path === "~") {
    return join(homedir(), path.slice(1));
  }
  return path;
}

/** Get the expanded overlay repository path from config */
export async function getOverlayPath(): Promise<string> {
  const config = await loadConfig();
  return expandPath(config.overlayRepo);
}

/** Get the XDG config directory (respects XDG_CONFIG_HOME, defaults to ~/.config/clank) */
function getConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "clank");
}

/** Validate overlay repository exists, throw if not */
export async function validateOverlayExists(overlayRoot: string): Promise<void> {
  if (!(await fileExists(overlayRoot))) {
    throw new Error(
      `Overlay repository not found at ${overlayRoot}\nRun 'clank init' to create it`,
    );
  }
}
