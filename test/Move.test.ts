import { lstat, mkdir, readlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { expect, test } from "vitest";
import { clank, type TestContext, withTestEnv } from "./Helpers.ts";

const clankBin = resolve("./bin/clank.ts");

/** Get path in overlay for current project */
function projectOverlay(ctx: TestContext, ...segments: string[]) {
  return join(ctx.overlayDir, "targets/my-project", ...segments);
}

/** Get path in global overlay */
function globalOverlay(ctx: TestContext, ...segments: string[]) {
  return join(ctx.overlayDir, "global", ...segments);
}

async function initAndLink(ctx: TestContext): Promise<void> {
  await execa(clankBin, ["init", ctx.overlayDir, "--config", ctx.configPath]);
  await clank(ctx, "link");
}

// =============================================================================
// Rename mode tests
// =============================================================================

test.concurrent("mv renames regular file within same scope", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);
    await clank(ctx, "add original.md");

    // Verify original exists
    const oldLink = join(ctx.targetDir, "clank/original.md");
    const oldOverlay = projectOverlay(ctx, "clank/original.md");
    expect((await lstat(oldLink)).isSymbolicLink()).toBe(true);
    expect((await lstat(oldOverlay)).isFile()).toBe(true);

    // Rename (using full clank/ path)
    await clank(ctx, "mv clank/original.md renamed.md");

    // Old should be gone
    await expect(lstat(oldLink)).rejects.toThrow();
    await expect(lstat(oldOverlay)).rejects.toThrow();

    // New should exist
    const newLink = join(ctx.targetDir, "clank/renamed.md");
    const newOverlay = projectOverlay(ctx, "clank/renamed.md");
    expect((await lstat(newLink)).isSymbolicLink()).toBe(true);
    expect((await lstat(newOverlay)).isFile()).toBe(true);

    // Symlink should point to new overlay location
    const target = await readlink(newLink);
    expect(target).toContain("renamed.md");
  }));

test.concurrent("mv renames prompt file and updates all agent symlinks", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create prompt directory and add a prompt
    const promptDir = join(ctx.targetDir, ".claude/prompts");
    await mkdir(promptDir, { recursive: true });
    await writeFile(join(promptDir, "old-prompt.md"), "# Prompt\n", "utf-8");
    await clank(ctx, "add .claude/prompts/old-prompt.md");

    // Verify prompt symlinks exist in both agent dirs
    const claudeOld = join(ctx.targetDir, ".claude/prompts/old-prompt.md");
    const geminiOld = join(ctx.targetDir, ".gemini/prompts/old-prompt.md");
    expect((await lstat(claudeOld)).isSymbolicLink()).toBe(true);
    expect((await lstat(geminiOld)).isSymbolicLink()).toBe(true);

    // Rename the prompt (from .claude/prompts directory)
    await execa(
      clankBin,
      ["mv", "old-prompt.md", "new-prompt.md", "--config", ctx.configPath],
      {
        cwd: promptDir,
      },
    );

    // Old symlinks should be gone
    await expect(lstat(claudeOld)).rejects.toThrow();
    await expect(lstat(geminiOld)).rejects.toThrow();

    // New symlinks should exist
    const claudeNew = join(ctx.targetDir, ".claude/prompts/new-prompt.md");
    const geminiNew = join(ctx.targetDir, ".gemini/prompts/new-prompt.md");
    expect((await lstat(claudeNew)).isSymbolicLink()).toBe(true);
    expect((await lstat(geminiNew)).isSymbolicLink()).toBe(true);

    // Overlay should have new name
    const newOverlay = projectOverlay(ctx, "prompts/new-prompt.md");
    expect((await lstat(newOverlay)).isFile()).toBe(true);
  }));

test.concurrent("mv errors when renaming agent files", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);
    await clank(ctx, "add CLAUDE.md");

    // Try to rename CLAUDE.md
    await expect(clank(ctx, "mv CLAUDE.md MYCLAUDE.md")).rejects.toThrow(
      "Cannot rename agent files",
    );

    // Original should still exist
    const claudePath = join(ctx.targetDir, "CLAUDE.md");
    expect((await lstat(claudePath)).isSymbolicLink()).toBe(true);
  }));

test.concurrent("mv errors when destination already exists", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);
    await clank(ctx, "add first.md");
    await clank(ctx, "add second.md");

    // Try to rename first.md to second.md
    await expect(clank(ctx, "mv clank/first.md second.md")).rejects.toThrow(
      "already exists",
    );

    // Both should still exist
    const firstLink = join(ctx.targetDir, "clank/first.md");
    const secondLink = join(ctx.targetDir, "clank/second.md");
    expect((await lstat(firstLink)).isSymbolicLink()).toBe(true);
    expect((await lstat(secondLink)).isSymbolicLink()).toBe(true);
  }));

test.concurrent("mv errors when source not managed by clank", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create a regular file (not managed by clank)
    const clankDir = join(ctx.targetDir, "clank");
    await mkdir(clankDir, { recursive: true });
    await writeFile(join(clankDir, "unmanaged.md"), "# Unmanaged\n", "utf-8");

    await expect(
      clank(ctx, "mv clank/unmanaged.md renamed.md"),
    ).rejects.toThrow("not managed by clank");
  }));

// =============================================================================
// Scope-move mode tests
// =============================================================================

test.concurrent("mv moves file from project to global scope", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);
    await clank(ctx, "add style.md --project");

    // Verify in project scope
    const projectPath = projectOverlay(ctx, "clank/style.md");
    expect((await lstat(projectPath)).isFile()).toBe(true);

    // Move to global (using full clank/ path)
    await clank(ctx, "mv clank/style.md --global");

    // Should be gone from project
    await expect(lstat(projectPath)).rejects.toThrow();

    // Should exist in global
    const globalPath = globalOverlay(ctx, "clank/style.md");
    expect((await lstat(globalPath)).isFile()).toBe(true);

    // Symlink should still work
    const linkPath = join(ctx.targetDir, "clank/style.md");
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    const target = await readlink(linkPath);
    expect(target).toContain("/global/");
  }));

test.concurrent("mv moves file from global to project scope", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);
    await clank(ctx, "add guide.md --global");

    // Verify in global scope
    const globalPath = globalOverlay(ctx, "clank/guide.md");
    expect((await lstat(globalPath)).isFile()).toBe(true);

    // Move to project (using full clank/ path)
    await clank(ctx, "mv clank/guide.md --project");

    // Should be gone from global
    await expect(lstat(globalPath)).rejects.toThrow();

    // Should exist in project
    const projectPath = projectOverlay(ctx, "clank/guide.md");
    expect((await lstat(projectPath)).isFile()).toBe(true);

    // Symlink should point to project overlay
    const linkPath = join(ctx.targetDir, "clank/guide.md");
    const target = await readlink(linkPath);
    expect(target).toContain("/targets/my-project/");
  }));

test.concurrent("mv reports when file already in target scope", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);
    await clank(ctx, "add already.md --project");

    // Try to move to project (already there)
    const result = await clank(ctx, "mv clank/already.md --project");

    // Should report "already in scope"
    expect(result.stdout).toContain("already in project scope");
  }));
