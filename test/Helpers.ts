import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";

export interface TestContext {
  tempDir: string;
  overlayDir: string;
  targetDir: string;
  configPath: string;
}

const gitEnv = {
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

/** Create a tree-like string representation of a directory */
export async function tree(
  dir: string,
  options: { prefix?: string; ignore?: string[] } = {},
): Promise<string> {
  const { prefix = "", ignore = [".git", ".gitkeep"] } = options;
  const entries = await readdir(dir, { withFileTypes: true });
  const sorted = entries
    .filter((e) => !ignore.includes(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    const isLast = i === sorted.length - 1;
    const connector = isLast ? "└── " : "├── ";
    lines.push(prefix + connector + entry.name);

    if (entry.isDirectory()) {
      const childPrefix = prefix + (isLast ? "    " : "│   ");
      const childTree = await tree(join(dir, entry.name), {
        prefix: childPrefix,
        ignore,
      });
      if (childTree) lines.push(childTree);
    }
  }
  return lines.join("\n");
}

/** Set up a test environment with temp directories and git repo */
export async function setupTestEnvironment(): Promise<TestContext> {
  const tempDir = await mkdtemp(join(tmpdir(), "clank-test-"));
  const overlayDir = join(tempDir, "overlay");
  const targetDir = join(tempDir, "project");
  const configPath = join(tempDir, "config.js");

  await mkdir(targetDir, { recursive: true });

  // Create config pointing to test overlay
  const configContent = `export default {
  overlayRepo: "${overlayDir}",
  agents: ["agents", "claude", "gemini"]
};
`;
  await writeFile(configPath, configContent, "utf-8");

  // Initialize git repo in target
  await execa({ cwd: targetDir })`git init`;
  await execa({
    cwd: targetDir,
  })`git remote add origin https://github.com/test/my-project.git`;

  // Need at least one commit for git branch to work
  await writeFile(join(targetDir, ".gitkeep"), "", "utf-8");
  await execa({ cwd: targetDir })`git add .`;
  await execa({ cwd: targetDir, env: gitEnv })`git commit -m ${"initial"}`;

  return { tempDir, overlayDir, targetDir, configPath };
}

/** Clean up test environment */
export async function cleanupTestEnvironment(ctx: TestContext): Promise<void> {
  await rm(ctx.tempDir, { recursive: true, force: true });
}

/** Run test with isolated environment */
export async function withTestEnv(
  fn: (ctx: TestContext) => Promise<void>,
): Promise<void> {
  const ctx = await setupTestEnvironment();
  try {
    await fn(ctx);
  } finally {
    await cleanupTestEnvironment(ctx);
  }
}

const clankBin = resolve("./bin/clank.ts");

/** Run clank command in target directory */
export function clank(ctx: TestContext, command: string) {
  const args = command.split(" ");
  return execa(clankBin, [...args, "--config", ctx.configPath], {
    cwd: ctx.targetDir,
    env: { ...process.env, ...gitEnv },
  });
}

/** Check if path is a symlink */
export async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Check if path exists */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
