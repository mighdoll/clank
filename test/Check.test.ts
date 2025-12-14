import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { findUnaddedFiles } from "../src/commands/Check.ts";
import type { MapperContext } from "../src/Mapper.ts";
import {
  cleanupTestEnvironment,
  setupTestEnvironment,
  type TestContext,
} from "./Helpers.ts";

let ctx: TestContext;

/** Create a MapperContext from test context */
function createMapperContext(testCtx: TestContext): MapperContext {
  return {
    overlayRoot: testCtx.overlayDir,
    targetRoot: testCtx.targetDir,
    gitContext: {
      gitRoot: testCtx.targetDir,
      projectName: "my-project",
      worktreeName: "main",
      isWorktree: false,
    },
  };
}

test.beforeEach(async () => {
  ctx = await setupTestEnvironment();
  // Create overlay structure
  await mkdir(join(ctx.overlayDir, "targets/my-project/clank"), {
    recursive: true,
  });
});

test.afterEach(async () => {
  await cleanupTestEnvironment(ctx);
});

test("findUnaddedFiles returns empty when no clank directories exist", async () => {
  const result = await findUnaddedFiles(createMapperContext(ctx));
  expect(result).toEqual([]);
});

test("findUnaddedFiles ignores symlinks to overlay", async () => {
  // Create a file in the overlay
  const overlayFile = join(ctx.overlayDir, "targets/my-project/clank/notes.md");
  await writeFile(overlayFile, "notes content");

  // Create clank dir in target with symlink to overlay
  const targetClank = join(ctx.targetDir, "clank");
  await mkdir(targetClank);
  await symlink(overlayFile, join(targetClank, "notes.md"));

  const result = await findUnaddedFiles(createMapperContext(ctx));
  expect(result).toEqual([]);
});

test("findUnaddedFiles detects regular files in clank/", async () => {
  // Create clank dir in target with a regular file (not a symlink)
  const targetClank = join(ctx.targetDir, "clank");
  await mkdir(targetClank);
  await writeFile(join(targetClank, "unadded.md"), "unadded content");

  const result = await findUnaddedFiles(createMapperContext(ctx));
  expect(result).toEqual([
    {
      targetPath: join(ctx.targetDir, "clank/unadded.md"),
      relativePath: "clank/unadded.md",
      kind: "unadded",
    },
  ]);
});

test("findUnaddedFiles detects regular files in .claude/", async () => {
  // Create .claude dir in target with a regular file
  const targetClaude = join(ctx.targetDir, ".claude");
  await mkdir(targetClaude);
  await writeFile(join(targetClaude, "unadded.md"), "unadded content");

  const result = await findUnaddedFiles(createMapperContext(ctx));
  expect(result).toEqual([
    {
      targetPath: join(ctx.targetDir, ".claude/unadded.md"),
      relativePath: ".claude/unadded.md",
      kind: "unadded",
    },
  ]);
});

test("findUnaddedFiles detects files in nested directories", async () => {
  // Create nested clank structure
  const targetClank = join(ctx.targetDir, "clank/subdir");
  await mkdir(targetClank, { recursive: true });
  await writeFile(join(targetClank, "nested.md"), "nested content");

  const result = await findUnaddedFiles(createMapperContext(ctx));
  expect(result).toEqual([
    {
      targetPath: join(ctx.targetDir, "clank/subdir/nested.md"),
      relativePath: "clank/subdir/nested.md",
      kind: "unadded",
    },
  ]);
});

test("findUnaddedFiles detects mixed symlinks and regular files", async () => {
  // Create a file in the overlay
  const overlayFile = join(
    ctx.overlayDir,
    "targets/my-project/clank/linked.md",
  );
  await writeFile(overlayFile, "linked content");

  // Create clank dir with both symlink and regular file
  const targetClank = join(ctx.targetDir, "clank");
  await mkdir(targetClank);
  await symlink(overlayFile, join(targetClank, "linked.md"));
  await writeFile(join(targetClank, "unadded.md"), "unadded content");

  const result = await findUnaddedFiles(createMapperContext(ctx));
  expect(result).toEqual([
    {
      targetPath: join(ctx.targetDir, "clank/unadded.md"),
      relativePath: "clank/unadded.md",
      kind: "unadded",
    },
  ]);
});

test("findUnaddedFiles detects clank/ directories in subdirectories", async () => {
  // Create clank dir nested inside a subdirectory (like tools/packages/foo/clank/)
  const nestedClank = join(ctx.targetDir, "tools/packages/foo/clank");
  await mkdir(nestedClank, { recursive: true });
  await writeFile(join(nestedClank, "notes.md"), "notes content");

  const result = await findUnaddedFiles(createMapperContext(ctx));
  expect(result).toEqual([
    {
      targetPath: join(ctx.targetDir, "tools/packages/foo/clank/notes.md"),
      relativePath: "tools/packages/foo/clank/notes.md",
      kind: "unadded",
    },
  ]);
});

test("findUnaddedFiles ignores settings.local.json", async () => {
  // settings.local.json should remain local and not be reported as unadded
  const targetClaude = join(ctx.targetDir, ".claude");
  await mkdir(targetClaude);
  await writeFile(join(targetClaude, "settings.local.json"), "{}");
  await writeFile(join(targetClaude, "other.json"), "{}");

  const result = await findUnaddedFiles(createMapperContext(ctx));
  expect(result).toEqual([
    {
      targetPath: join(ctx.targetDir, ".claude/other.json"),
      relativePath: ".claude/other.json",
      kind: "unadded",
    },
  ]);
});

test("findUnaddedFiles detects symlinks pointing outside overlay", async () => {
  // Create a file outside the overlay
  const outsideFile = join(ctx.targetDir, "outside.md");
  await writeFile(outsideFile, "outside content");

  // Create clank dir with a symlink pointing outside the overlay
  const targetClank = join(ctx.targetDir, "clank");
  await mkdir(targetClank);
  await symlink(outsideFile, join(targetClank, "stale.md"));

  const result = await findUnaddedFiles(createMapperContext(ctx));
  expect(result).toEqual([
    {
      targetPath: join(ctx.targetDir, "clank/stale.md"),
      relativePath: "clank/stale.md",
      kind: "outside-overlay",
      currentTarget: outsideFile,
    },
  ]);
});

test("findUnaddedFiles detects symlinks pointing to wrong overlay location", async () => {
  // Create a file in the wrong overlay location (a different project's overlay)
  const wrongOverlayFile = join(
    ctx.overlayDir,
    "targets/other-project/clank/notes.md",
  );
  await mkdir(join(ctx.overlayDir, "targets/other-project/clank"), {
    recursive: true,
  });
  await writeFile(wrongOverlayFile, "wrong location content");

  // Create clank dir with symlink to wrong overlay location
  const targetClank = join(ctx.targetDir, "clank");
  await mkdir(targetClank);
  await symlink(wrongOverlayFile, join(targetClank, "notes.md"));

  const result = await findUnaddedFiles(createMapperContext(ctx));
  // The symlink points to overlay but maps to a different target (other-project)
  expect(result.length).toBe(1);
  expect(result[0]).toMatchObject({
    kind: "wrong-mapping",
    currentTarget: wrongOverlayFile,
  });
});
