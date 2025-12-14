import { rm as fsRm, lstat, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { expect, test } from "vitest";
import { clank, type TestContext, withTestEnv } from "./Helpers.ts";

const clankBin = resolve("./bin/clank.ts");

/** Get path in overlay for current project */
function overlay(ctx: TestContext, ...segments: string[]) {
  return join(ctx.overlayDir, "targets/my-project", ...segments);
}

async function initAndLink(ctx: TestContext): Promise<void> {
  await execa(clankBin, ["init", ctx.overlayDir, "--config", ctx.configPath]);
  await clank(ctx, "link");
}

test.concurrent("rm removes symlink and overlay file", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);
    await clank(ctx, "add arch.md");

    // Verify file exists
    const linkPath = join(ctx.targetDir, "clank/arch.md");
    let stat = await lstat(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);

    const overlayPath = overlay(ctx, "clank/arch.md");
    stat = await lstat(overlayPath);
    expect(stat.isFile()).toBe(true);

    // Remove it
    await clank(ctx, "rm arch.md");

    // Both should be gone
    await expect(lstat(linkPath)).rejects.toThrow();
    await expect(lstat(overlayPath)).rejects.toThrow();
  }));

test.concurrent("rm works when symlink already deleted", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);
    // Use unique name to avoid collision with init template files
    await clank(ctx, "add readme.md");

    const linkPath = join(ctx.targetDir, "clank/readme.md");
    const overlayPath = overlay(ctx, "clank/readme.md");

    // Manually delete the symlink (simulating `rm readme.md`)
    await fsRm(linkPath);
    await expect(lstat(linkPath)).rejects.toThrow();

    // Overlay file still exists
    const stat = await lstat(overlayPath);
    expect(stat.isFile()).toBe(true);

    // clank rm should still work
    await clank(ctx, "rm readme.md");

    // Overlay should be gone
    await expect(lstat(overlayPath)).rejects.toThrow();
  }));

test.concurrent("rm removes all agent symlinks and agents.md", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);
    await clank(ctx, "add CLAUDE.md");

    // Verify all symlinks exist
    const claudePath = join(ctx.targetDir, "CLAUDE.md");
    const agentsPath = join(ctx.targetDir, "AGENTS.md");
    const geminiPath = join(ctx.targetDir, "GEMINI.md");
    const overlayPath = overlay(ctx, "agents.md");

    expect((await lstat(claudePath)).isSymbolicLink()).toBe(true);
    expect((await lstat(agentsPath)).isSymbolicLink()).toBe(true);
    expect((await lstat(geminiPath)).isSymbolicLink()).toBe(true);
    expect((await lstat(overlayPath)).isFile()).toBe(true);

    // Remove using CLAUDE.md
    await clank(ctx, "rm CLAUDE.md");

    // All should be gone
    await expect(lstat(claudePath)).rejects.toThrow();
    await expect(lstat(agentsPath)).rejects.toThrow();
    await expect(lstat(geminiPath)).rejects.toThrow();
    await expect(lstat(overlayPath)).rejects.toThrow();
  }));

test.concurrent("rm with --project flag uses project scope", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);
    await clank(ctx, "add style.md --project");

    const overlayPath = overlay(ctx, "clank/style.md");
    expect((await lstat(overlayPath)).isFile()).toBe(true);

    await clank(ctx, "rm style.md --project");

    await expect(lstat(overlayPath)).rejects.toThrow();
  }));

test.concurrent("rm errors when local file is not a symlink", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create a real file (not through clank)
    const clankDir = join(ctx.targetDir, "clank");
    await mkdir(clankDir, { recursive: true });
    await writeFile(join(clankDir, "real.md"), "# Real file\n", "utf-8");

    // Also create it in overlay so it would be found
    const overlayClankDir = overlay(ctx, "clank");
    await mkdir(overlayClankDir, { recursive: true });
    await writeFile(join(overlayClankDir, "real.md"), "# Overlay\n", "utf-8");

    // rm should error
    await expect(clank(ctx, "rm real.md")).rejects.toThrow(
      "not managed by clank",
    );
  }));

test.concurrent("rm errors when file not in any overlay scope", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Try to remove a file that doesn't exist anywhere
    await expect(clank(ctx, "rm nonexistent.md")).rejects.toThrow(
      "Not found in overlay",
    );
  }));

test.concurrent("rm errors when file in multiple scopes without flag", () =>
  withTestEnv(async (ctx) => {
    // Initialize overlay
    await execa(clankBin, ["init", ctx.overlayDir, "--config", ctx.configPath]);

    // Create a feature branch in main repo
    await execa({ cwd: ctx.targetDir })`git branch feature-bar`;

    // Create worktree
    const worktreeDir = join(ctx.tempDir, "worktree-bar");
    await execa({
      cwd: ctx.targetDir,
    })`git worktree add ${worktreeDir} feature-bar`;

    const clankWorktree = (command: string) => {
      const args = command.split(" ");
      return execa(clankBin, [...args, "--config", ctx.configPath], {
        cwd: worktreeDir,
      });
    };

    await clankWorktree("link");

    // Add same file to both project and worktree scope
    await clankWorktree("add notes.md --project");
    await clankWorktree("add notes.md --worktree");

    // Delete local symlinks to force scope search
    await fsRm(join(worktreeDir, "clank/notes.md"));

    // rm without flag should error
    await expect(clankWorktree("rm notes.md")).rejects.toThrow(
      "multiple scopes",
    );

    // With flag should work
    await clankWorktree("rm notes.md --worktree");

    // Clean up worktree
    await execa({
      cwd: ctx.targetDir,
    })`git worktree remove --force ${worktreeDir}`;
  }));

test.concurrent("rm works from subdirectory", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create subdirectory
    const subDir = join(ctx.targetDir, "packages/foo");
    await mkdir(subDir, { recursive: true });

    // Add file from subdirectory
    await execa(clankBin, ["add", "notes.md", "--config", ctx.configPath], {
      cwd: subDir,
    });

    const overlayPath = overlay(ctx, "packages/foo/clank/notes.md");
    expect((await lstat(overlayPath)).isFile()).toBe(true);

    // Remove from subdirectory
    await execa(clankBin, ["rm", "notes.md", "--config", ctx.configPath], {
      cwd: subDir,
    });

    await expect(lstat(overlayPath)).rejects.toThrow();
  }));

test.concurrent("rm is idempotent (second remove reports not found)", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);
    await clank(ctx, "add temp.md");

    // First remove succeeds
    await clank(ctx, "rm temp.md");

    // Second remove should error (file no longer exists)
    await expect(clank(ctx, "rm temp.md")).rejects.toThrow("Not found");
  }));
