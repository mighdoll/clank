import { lstat } from "node:fs/promises";
import { resolveSymlinkTarget } from "./FsUtil.ts";
import { type MapperContext, overlayToTarget, type Scope } from "./Mapper.ts";

/** Get scope from symlink target if it points to overlay */
export async function scopeFromSymlink(
  targetPath: string,
  context: MapperContext,
): Promise<Scope | null> {
  try {
    const stats = await lstat(targetPath);
    if (!stats.isSymbolicLink()) return null;

    const overlayPath = await resolveSymlinkTarget(targetPath);
    if (!overlayPath.startsWith(context.overlayRoot)) return null;

    const mapping = overlayToTarget(overlayPath, context);
    return mapping?.scope ?? null;
  } catch {
    return null;
  }
}
