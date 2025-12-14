import { expandPath, loadConfig } from "../Config.ts";
import { removeGitExcludes } from "../Exclude.ts";
import { fileExists, removeSymlink, walkDirectory } from "../FsUtil.ts";
import { getGitContext } from "../Git.ts";
import { isSymlinkToOverlay } from "../OverlayLinks.ts";
import { removeVscodeSettings } from "./VsCode.ts";

/** Remove all symlinks pointing to overlay repository */
export async function unlinkCommand(targetDir?: string): Promise<void> {
  const gitContext = await getGitContext(targetDir || process.cwd());
  const targetRoot = gitContext.gitRoot;

  console.log(`Removing clank symlinks from: ${targetRoot}\n`);

  // Load config to get overlay path
  const config = await loadConfig();
  const overlayRoot = expandPath(config.overlayRepo);

  if (!(await fileExists(overlayRoot))) {
    console.error(`Warning: Overlay repository not found at ${overlayRoot}`);
    console.log("Will still attempt to remove symlinks...\n");
  }

  // Walk directory and remove all symlinks to overlay
  let removedCount = 0;

  for await (const { path, isDirectory } of walkDirectory(targetRoot)) {
    if (isDirectory) continue;

    if (await isSymlinkToOverlay(path, overlayRoot)) {
      await removeSymlink(path);
      console.log(`Removed: ${path}`);
      removedCount++;
    }
  }

  await removeGitExcludes(targetRoot);
  await removeVscodeSettings(targetRoot);

  if (removedCount === 0) {
    console.log("No clank symlinks found.");
  } else {
    console.log(`\nDone! Removed ${removedCount} symlinks.`);
  }
}
