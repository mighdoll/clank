import { execa } from "execa";
import { expandPath, loadConfig, validateOverlayExists } from "../Config.ts";
import { formatStatusLines, getOverlayStatus } from "../OverlayGit.ts";

export interface CommitOptions {
  message?: string;
}

/** Commit all changes in the overlay repository */
export async function commitCommand(
  options: CommitOptions = {},
): Promise<void> {
  const config = await loadConfig();
  const overlayRoot = expandPath(config.overlayRepo);

  await validateOverlayExists(overlayRoot);

  const message = options.message || "update";
  const fullMessage = `[clank] ${message}`;

  const lines = await getOverlayStatus(overlayRoot);

  if (lines.length === 0) {
    console.log("Nothing to commit");
    return;
  }

  await execa({ cwd: overlayRoot })`git add .`;
  await execa({ cwd: overlayRoot })`git commit -m ${fullMessage}`;

  console.log(`Committed: ${fullMessage}`);
  for (const line of formatStatusLines(lines)) {
    console.log(`  ${line}`);
  }
}
