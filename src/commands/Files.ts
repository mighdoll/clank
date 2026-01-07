import { dedupeEntries } from "./files/Dedupe.ts";
import {
  collectEntries,
  type FileEntry,
  type FilesOptions,
  getFilesContext,
  normalizeFilesOptions,
} from "./files/Scan.ts";

/** List clank-managed files in the current target repository. */
export async function filesCommand(
  inputPath?: string,
  options?: FilesOptions,
): Promise<void> {
  const ctx = await getFilesContext(inputPath);
  const opts = normalizeFilesOptions(options);
  const entries = await collectEntries(ctx, opts);
  const output = buildOutput(entries, opts.dedupe, ctx.agentsPreference);
  writeOutput(output, opts.null);
}

/** Convert filtered entries to sorted, cwd-relative output paths. */
function buildOutput(
  entries: FileEntry[],
  dedupe: boolean,
  agentsPreference: string[],
): string[] {
  const filtered = dedupe ? dedupeEntries(entries, agentsPreference) : entries;
  return filtered
    .map((e) => e.cwdRelativePath)
    .sort((a, b) => a.localeCompare(b));
}

/** Emit the final list in a form that is friendly to `xargs` and friends. */
function writeOutput(paths: string[], nul: boolean): void {
  const sep = nul ? "\0" : "\n";
  process.stdout.write(paths.join(sep) + (paths.length === 0 ? "" : sep));
}
