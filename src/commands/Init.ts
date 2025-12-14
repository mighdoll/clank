import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import {
  createDefaultConfig,
  defaultOverlayDir,
  expandPath,
} from "../Config.ts";
import { ensureDir, fileExists } from "../FsUtil.ts";

/** Initialize a new clank overlay repository */
export async function initCommand(overlayPath?: string): Promise<void> {
  const targetPath = overlayPath
    ? expandPath(overlayPath)
    : join(process.env.HOME || "~", defaultOverlayDir);

  if (await fileExists(targetPath)) {
    const hasTargets = await fileExists(join(targetPath, "targets"));
    const hasGlobal = await fileExists(join(targetPath, "global"));

    if (hasTargets && hasGlobal) {
      console.log("Overlay repository already exists!");
      return;
    }
  }

  console.log(`Initializing clank overlay repository at: ${targetPath}`);

  await ensureDir(join(targetPath, "global/clank"));
  await ensureDir(join(targetPath, "global/claude/commands"));
  await ensureDir(join(targetPath, "global/claude/agents"));
  await ensureDir(join(targetPath, "global/init"));
  await ensureDir(join(targetPath, "targets"));

  await createDefaultTemplates(targetPath);

  await createDefaultConfig(targetPath);

  // Initialize git repo and create initial commit
  await execa({ cwd: targetPath })`git init`;
  await execa({ cwd: targetPath })`git add .`;
  await execa({ cwd: targetPath })`git commit -m ${`[clank] init`}`;

  console.log(`\nOverlay repository initialized successfully!`);
  console.log(`\nNext steps:`);
  console.log(`  1. cd to your project directory`);
  console.log(`  2. Run 'clank link' to connect your project`);
  console.log(`  3. Use 'clank add <file>' to add files`);
}

/** Create default template files in overlay/global/init/clank/ */
async function createDefaultTemplates(overlayPath: string): Promise<void> {
  const initClankDir = join(overlayPath, "global/init/clank");
  await ensureDir(initClankDir);

  const planTemplate = "{{worktree_message}}\n\n# Goals\n";
  await writeFile(join(initClankDir, "plan.md"), planTemplate, "utf-8");

  await writeFile(join(initClankDir, "notes.md"), "# Notes\n\n", "utf-8");

  console.log("Created default templates in global/init/clank/");
}
