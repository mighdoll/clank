import {
  lstat,
  mkdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { expect, test } from "vitest";
import {
  clank,
  isSymlink,
  pathExists,
  type TestContext,
  tree,
  withTestEnv,
} from "./Helpers.ts";

const clankBin = resolve("./bin/clank.ts");

/** Get path in overlay for current project */
function overlay(ctx: TestContext, ...segments: string[]) {
  return join(ctx.overlayDir, "targets/my-project", ...segments);
}

async function initAndLink(ctx: TestContext): Promise<void> {
  await execa(clankBin, ["init", ctx.overlayDir, "--config", ctx.configPath]);
  await clank(ctx, "link");
}

/** Create .vscode/settings.json with user patterns for testing */
async function createUserVscodeSettings(ctx: TestContext): Promise<void> {
  const vscodeDir = join(ctx.targetDir, ".vscode");
  await mkdir(vscodeDir, { recursive: true });
  await writeFile(
    join(vscodeDir, "settings.json"),
    JSON.stringify(
      {
        "editor.fontSize": 14,
        "search.exclude": { "**/my-custom-pattern": true },
        "files.exclude": { "**/my-custom-pattern": true },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

test.concurrent("init and link creates overlay and target structure", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    const overlayStructure = await tree(ctx.overlayDir);
    expect(overlayStructure).toMatchInlineSnapshot(`
      "├── global
      │   ├── clank
      │   ├── claude
      │   │   ├── agents
      │   │   └── commands
      │   └── init
      │       └── clank
      │           ├── notes.md
      │           └── plan.md
      └── targets
          └── my-project
              ├── claude
              │   └── settings.json
              └── worktrees
                  └── main
                      └── clank
                          ├── notes.md
                          └── plan.md"
    `);

    const targetStructure = await tree(ctx.targetDir);
    expect(targetStructure).toMatchInlineSnapshot(`
      "├── .claude
      │   └── settings.json
      └── clank
          ├── notes.md
          └── plan.md"
    `);
  }));

test.concurrent("add CLAUDE.md creates agents.md and all agent symlinks", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);
    await clank(ctx, "add CLAUDE.md");

    // Verify agents.md in overlay (agent files go to project root, not clank/)
    const agentsStat = await lstat(overlay(ctx, "agents.md"));
    expect(agentsStat.isFile()).toBe(true);

    // Verify all agent symlinks created directly by add
    const claudeStat = await lstat(join(ctx.targetDir, "CLAUDE.md"));
    expect(claudeStat.isSymbolicLink()).toBe(true);

    const agentsLinkStat = await lstat(join(ctx.targetDir, "AGENTS.md"));
    expect(agentsLinkStat.isSymbolicLink()).toBe(true);

    const geminiStat = await lstat(join(ctx.targetDir, "GEMINI.md"));
    expect(geminiStat.isSymbolicLink()).toBe(true);
  }));

test.concurrent("link recreates subdirectory agent symlinks", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create a subdirectory and add CLAUDE.md from there
    const subDir = join(ctx.targetDir, "packages/foo");
    await mkdir(subDir, { recursive: true });

    // Run clank add from subdirectory
    await execa(clankBin, ["add", "CLAUDE.md", "--config", ctx.configPath], {
      cwd: subDir,
    });

    // Verify agents.md in overlay at subdirectory level
    const agentsStat = await lstat(
      overlay(ctx, "packages", "foo", "agents.md"),
    );
    expect(agentsStat.isFile()).toBe(true);

    // Remove symlinks
    await clank(ctx, "unlink");

    // Verify symlinks removed
    await expect(lstat(join(subDir, "CLAUDE.md"))).rejects.toThrow();

    // Re-link and verify subdirectory agent symlinks are recreated
    await clank(ctx, "link");

    const claudeStat = await lstat(join(subDir, "CLAUDE.md"));
    expect(claudeStat.isSymbolicLink()).toBe(true);

    const agentsLinkStat = await lstat(join(subDir, "AGENTS.md"));
    expect(agentsLinkStat.isSymbolicLink()).toBe(true);

    const geminiStat = await lstat(join(subDir, "GEMINI.md"));
    expect(geminiStat.isSymbolicLink()).toBe(true);
  }));

test.concurrent("add plain file goes to clank/ (project scope)", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);
    await clank(ctx, "add arch.md");

    const archStat = await lstat(overlay(ctx, "clank/arch.md"));
    expect(archStat.isFile()).toBe(true);

    const linkStat = await lstat(join(ctx.targetDir, "clank/arch.md"));
    expect(linkStat.isSymbolicLink()).toBe(true);
  }));

test.concurrent("add with --worktree fails in non-worktree context", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    await expect(clank(ctx, "add notes.md --worktree")).rejects.toThrow(
      "--worktree scope requires a git worktree",
    );
  }));

test.concurrent("add with --project creates project-specific command", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);
    await clank(ctx, "add .claude/commands/build.md --project");

    const cmdStat = await lstat(overlay(ctx, "claude", "commands", "build.md"));
    expect(cmdStat.isFile()).toBe(true);
  }));

test.concurrent("unlink removes symlinks", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Add some files and link
    await clank(ctx, "add CLAUDE.md");
    await clank(ctx, "add arch.md");
    await clank(ctx, "link");

    // Unlink
    await clank(ctx, "unlink");

    // Verify symlinks removed
    await expect(lstat(join(ctx.targetDir, "CLAUDE.md"))).rejects.toThrow();
    await expect(lstat(join(ctx.targetDir, "clank/arch.md"))).rejects.toThrow();
  }));

test.concurrent("add --worktree in git worktree creates branch-specific file", () =>
  withTestEnv(async (ctx) => {
    // Initialize overlay
    await execa(clankBin, ["init", ctx.overlayDir, "--config", ctx.configPath]);

    // Create a feature branch in main repo
    await execa({ cwd: ctx.targetDir })`git branch feature-foo`;

    // Create worktree directory and checkout feature branch
    const worktreeDir = join(ctx.tempDir, "worktree-foo");
    await execa({
      cwd: ctx.targetDir,
    })`git worktree add ${worktreeDir} feature-foo`;

    // Helper to run clank in worktree
    const clankWorktree = (command: string) => {
      const args = command.split(" ");
      return execa(clankBin, [...args, "--config", ctx.configPath], {
        cwd: worktreeDir,
      });
    };

    // Link in worktree
    await clankWorktree("link");

    // Add worktree-specific file, project-scoped file, and worktree agent file
    await clankWorktree("add foo.md --worktree");
    await clankWorktree("add proj.md");
    await clankWorktree("add CLAUDE.md --worktree");

    // Validate overlay structure
    const overlayStructure = await tree(ctx.overlayDir);
    expect(overlayStructure).toMatchInlineSnapshot(`
      "├── global
      │   ├── clank
      │   ├── claude
      │   │   ├── agents
      │   │   └── commands
      │   └── init
      │       └── clank
      │           ├── notes.md
      │           └── plan.md
      └── targets
          └── my-project
              ├── clank
              │   └── proj.md
              ├── claude
              │   └── settings.json
              └── worktrees
                  └── feature-foo
                      ├── agents.md
                      └── clank
                          ├── foo.md
                          ├── notes.md
                          └── plan.md"
    `);

    // Validate worktree target structure
    const targetStructure = await tree(worktreeDir);
    expect(targetStructure).toMatchInlineSnapshot(`
      "├── .claude
      │   └── settings.json
      ├── AGENTS.md
      ├── clank
      │   ├── foo.md
      │   ├── notes.md
      │   ├── plan.md
      │   └── proj.md
      ├── CLAUDE.md
      └── GEMINI.md"
    `);

    // Clean up worktree
    await execa({
      cwd: ctx.targetDir,
    })`git worktree remove --force ${worktreeDir}`;
  }));

test.concurrent("add from subdirectory creates correct overlay structure", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create subdirectory in target
    const subDir = join(ctx.targetDir, "tools/packages/wesl");
    await mkdir(subDir, { recursive: true });

    // Run clank add from subdirectory
    const args = ["add", "notes.md", "--config", ctx.configPath];
    await execa(clankBin, args, { cwd: subDir });

    // Verify overlay structure - should NOT have double clank/
    const overlayStructure = await tree(ctx.overlayDir);
    expect(overlayStructure).toMatchInlineSnapshot(`
      "├── global
      │   ├── clank
      │   ├── claude
      │   │   ├── agents
      │   │   └── commands
      │   └── init
      │       └── clank
      │           ├── notes.md
      │           └── plan.md
      └── targets
          └── my-project
              ├── claude
              │   └── settings.json
              ├── tools
              │   └── packages
              │       └── wesl
              │           └── clank
              │               └── notes.md
              └── worktrees
                  └── main
                      └── clank
                          ├── notes.md
                          └── plan.md"
    `);

    // Verify symlink in subdirectory
    const linkStat = await lstat(join(subDir, "clank/notes.md"));
    expect(linkStat.isSymbolicLink()).toBe(true);
  }));

test.concurrent("link recreates subdirectory clank symlinks", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create subdirectory in target
    const subDir = join(ctx.targetDir, "packages/foo");
    await mkdir(subDir, { recursive: true });

    // Add file from subdirectory
    await execa(clankBin, ["add", "notes.md", "--config", ctx.configPath], {
      cwd: subDir,
    });

    // Verify symlink exists
    const linkPath = join(subDir, "clank/notes.md");
    let linkStat = await lstat(linkPath);
    expect(linkStat.isSymbolicLink()).toBe(true);

    // Unlink
    await clank(ctx, "unlink");
    await expect(lstat(linkPath)).rejects.toThrow();

    // Re-link and verify subdirectory clank symlinks are recreated
    await clank(ctx, "link");

    linkStat = await lstat(linkPath);
    expect(linkStat.isSymbolicLink()).toBe(true);
  }));

test.concurrent("add moves existing clank/ file content to overlay", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create file with content in target
    const clankDir = join(ctx.targetDir, "clank");
    await mkdir(clankDir, { recursive: true });
    const filePath = join(clankDir, "existing.md");
    await writeFile(filePath, "# Original content\n", "utf-8");

    // Run clank add
    await clank(ctx, "add existing.md");

    // Verify content was moved to overlay
    const overlayContent = await readFile(
      overlay(ctx, "clank", "existing.md"),
      "utf-8",
    );
    expect(overlayContent).toBe("# Original content\n");

    // Verify original is now a symlink
    const linkStat = await lstat(filePath);
    expect(linkStat.isSymbolicLink()).toBe(true);
  }));

test.concurrent("add copies file outside of clank/ to overlay", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create file at bare path (not in clank/)
    const barePath = join(ctx.targetDir, "notes.md");
    await writeFile(barePath, "# Notes from bare path\n", "utf-8");

    // Run clank add
    await clank(ctx, "add notes.md");

    // Verify content was copied to overlay
    const overlayContent = await readFile(
      overlay(ctx, "clank", "notes.md"),
      "utf-8",
    );
    expect(overlayContent).toBe("# Notes from bare path\n");

    // Verify symlink created at clank/notes.md
    const linkStat = await lstat(join(ctx.targetDir, "clank/notes.md"));
    expect(linkStat.isSymbolicLink()).toBe(true);

    // Verify original bare file still exists (not moved)
    const bareStat = await lstat(barePath);
    expect(bareStat.isFile()).toBe(true);
  }));

test.concurrent("add directory adds all files in directory", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create a directory with multiple files
    const docsDir = join(ctx.targetDir, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "guide.md"), "# Guide\n", "utf-8");
    await writeFile(join(docsDir, "api.md"), "# API\n", "utf-8");

    // Run clank add on the directory
    await clank(ctx, "add docs");

    // Verify both files were copied to overlay
    const guideContent = await readFile(
      overlay(ctx, "clank", "docs", "guide.md"),
      "utf-8",
    );
    expect(guideContent).toBe("# Guide\n");

    const apiContent = await readFile(
      overlay(ctx, "clank", "docs", "api.md"),
      "utf-8",
    );
    expect(apiContent).toBe("# API\n");

    // Verify symlinks were created
    const guideStat = await lstat(join(ctx.targetDir, "clank/docs/guide.md"));
    expect(guideStat.isSymbolicLink()).toBe(true);

    const apiStat = await lstat(join(ctx.targetDir, "clank/docs/api.md"));
    expect(apiStat.isSymbolicLink()).toBe(true);
  }));

test.concurrent("add symlink preserves symlink target in overlay", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create a real file and a symlink to it
    const realFile = join(ctx.targetDir, "real-data.txt");
    await writeFile(realFile, "real content\n", "utf-8");

    const symlinkPath = join(ctx.targetDir, "link-to-data.txt");
    await symlink(realFile, symlinkPath);

    // Run clank add on the symlink
    await clank(ctx, "add link-to-data.txt");

    // Verify overlay contains a symlink (not a regular file)
    const overlayPath = overlay(ctx, "clank", "link-to-data.txt");
    const overlayStat = await lstat(overlayPath);
    expect(overlayStat.isSymbolicLink()).toBe(true);

    // Verify the symlink target is preserved
    const overlayTarget = await readlink(overlayPath);
    expect(overlayTarget).toBe(realFile);

    // Verify symlink created at clank/link-to-data.txt pointing to overlay
    const targetLinkPath = join(ctx.targetDir, "clank/link-to-data.txt");
    const targetStat = await lstat(targetLinkPath);
    expect(targetStat.isSymbolicLink()).toBe(true);
  }));

test.concurrent("errors on tracked CLAUDE.md with conversion instructions", () =>
  withTestEnv(async (ctx) => {
    // Initialize overlay
    await execa(clankBin, ["init", ctx.overlayDir, "--config", ctx.configPath]);

    // Create and track CLAUDE.md in the target repo
    const claudePath = join(ctx.targetDir, "CLAUDE.md");
    await writeFile(claudePath, "# My tracked CLAUDE.md\n", "utf-8");
    await execa({ cwd: ctx.targetDir })`git add CLAUDE.md`;
    await execa({ cwd: ctx.targetDir })`git commit -m ${"add CLAUDE.md"}`;

    // Run clank link - should error with instructions
    await expect(clank(ctx, "link")).rejects.toThrow(
      "Found tracked agent files",
    );

    // Verify CLAUDE.md is still there (unchanged)
    const claudeStat = await lstat(claudePath);
    expect(claudeStat.isFile()).toBe(true);

    const content = await readFile(claudePath, "utf-8");
    expect(content).toBe("# My tracked CLAUDE.md\n");
  }));

test.concurrent("errors on untracked CLAUDE.md with add instructions", () =>
  withTestEnv(async (ctx) => {
    // Initialize overlay
    await execa(clankBin, ["init", ctx.overlayDir, "--config", ctx.configPath]);

    // Create untracked CLAUDE.md in the target repo
    const claudePath = join(ctx.targetDir, "CLAUDE.md");
    await writeFile(claudePath, "# My untracked CLAUDE.md\n", "utf-8");

    // Run clank link - should error with instructions
    await expect(clank(ctx, "link")).rejects.toThrow(
      "Found untracked agent files",
    );

    // Verify CLAUDE.md is still there (unchanged)
    const claudeStat = await lstat(claudePath);
    expect(claudeStat.isFile()).toBe(true);
  }));

test.concurrent("clank add with path works for subdirectory agent files", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create subdirectory
    const subDir = join(ctx.targetDir, "packages/foo");
    await mkdir(subDir, { recursive: true });

    // Run clank add with path from git root
    await execa(
      clankBin,
      ["add", "packages/foo/CLAUDE.md", "--config", ctx.configPath],
      { cwd: ctx.targetDir },
    );

    // Verify agents.md in overlay at subdirectory level
    const agentsStat = await lstat(
      overlay(ctx, "packages", "foo", "agents.md"),
    );
    expect(agentsStat.isFile()).toBe(true);

    // Verify symlink was created in the subdirectory
    const claudeStat = await lstat(join(subDir, "CLAUDE.md"));
    expect(claudeStat.isSymbolicLink()).toBe(true);
  }));

test.concurrent("init creates git repo with initial commit", () =>
  withTestEnv(async (ctx) => {
    await execa(clankBin, ["init", ctx.overlayDir, "--config", ctx.configPath]);

    // Verify git repo exists and has initial commit
    const { stdout: log } = await execa({
      cwd: ctx.overlayDir,
    })`git log --oneline`;

    expect(log).toContain("[clank] init");
  }));

test.concurrent("commit creates commit with default message", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Add a file to the overlay
    await clank(ctx, "add notes.md");

    // Modify the file to create uncommitted changes
    const notesPath = join(ctx.overlayDir, "targets/my-project/clank/notes.md");
    await writeFile(notesPath, "# Updated notes\n", "utf-8");

    // Run clank commit
    await clank(ctx, "commit");

    // Verify commit was created with default message
    const { stdout: log } = await execa({
      cwd: ctx.overlayDir,
    })`git log --oneline -1`;

    expect(log).toContain("[clank] update");
  }));

test.concurrent("commit with -m flag uses custom message", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Add a file to the overlay
    await clank(ctx, "add arch.md");

    // Modify the file to create uncommitted changes
    const archPath = join(
      ctx.overlayDir,
      "targets",
      "my-project",
      "clank",
      "arch.md",
    );
    await writeFile(archPath, "# Architecture\n", "utf-8");

    // Run clank commit with message
    await execa(
      clankBin,
      ["commit", "-m", "add architecture docs", "--config", ctx.configPath],
      { cwd: ctx.targetDir },
    );

    // Verify commit was created with custom message
    const { stdout: log } = await execa({
      cwd: ctx.overlayDir,
    })`git log --oneline -1`;

    expect(log).toContain("[clank] add architecture docs");
  }));

test.concurrent("commit with no changes reports nothing to commit", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Commit any changes from link first
    await clank(ctx, "commit");

    // Run clank commit again with no pending changes
    const { stdout } = await clank(ctx, "commit");

    expect(stdout).toContain("Nothing to commit");
  }));

test.concurrent("link warns about orphaned paths", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create a subdirectory structure in target and add a file
    const subDir = join(ctx.targetDir, "packages/foo");
    await mkdir(subDir, { recursive: true });
    await execa(clankBin, ["add", "notes.md", "--config", ctx.configPath], {
      cwd: subDir,
    });

    // Now remove the subdirectory from target (simulating directory rename)
    const { rm } = await import("node:fs/promises");
    await rm(join(ctx.targetDir, "packages"), { recursive: true });

    // Run link again - should warn about orphaned path
    const { stdout } = await clank(ctx, "link");

    expect(stdout).toContain("orphaned overlay path");
    expect(stdout).toContain("clank check");
  }));

test.concurrent("check reports orphaned paths with agent prompt", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create a subdirectory structure in target and add a file
    const subDir = join(ctx.targetDir, "packages/foo");
    await mkdir(subDir, { recursive: true });
    await execa(clankBin, ["add", "notes.md", "--config", ctx.configPath], {
      cwd: subDir,
    });

    // Remove the subdirectory from target
    const { rm } = await import("node:fs/promises");
    await rm(join(ctx.targetDir, "packages"), { recursive: true });

    // Run check - should report orphaned path with details
    const { stdout } = await clank(ctx, "check");

    expect(stdout).toContain("orphaned overlay path");
    expect(stdout).toContain("notes.md");
    expect(stdout).toContain("packages/foo");
    expect(stdout).toContain("clank help structure");
  }));

test.concurrent("check reports no issues when structure matches", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Just add a normal file at project root
    await clank(ctx, "add notes.md");

    const { stdout } = await clank(ctx, "check");

    expect(stdout).toContain("No issues found");
  }));

test.concurrent("vscode generates settings from gitignore", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create a .gitignore with some patterns
    await writeFile(
      join(ctx.targetDir, ".gitignore"),
      "node_modules/\ndist/\n*.log\nclank/\n",
      "utf-8",
    );

    await clank(ctx, "vscode");

    const settingsPath = join(ctx.targetDir, ".vscode/settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    expect(settings["search.useIgnoreFiles"]).toBe(false);
    expect(settings["search.exclude"]["**/node_modules"]).toBe(true);
    expect(settings["search.exclude"]["**/dist"]).toBe(true);
    expect(settings["files.exclude"]["**/node_modules"]).toBe(true);
    // clank/ should NOT be in exclude (it's a clank-managed pattern)
    expect(settings["search.exclude"]["**/clank"]).toBeUndefined();
  }));

test.concurrent("vscode warns on negation patterns", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create a .gitignore with negation pattern
    await writeFile(
      join(ctx.targetDir, ".gitignore"),
      "*.log\n!important.log\n",
      "utf-8",
    );

    const { stdout } = await clank(ctx, "vscode");

    expect(stdout).toContain("negation pattern");
    expect(stdout).toContain("important.log");
  }));

test.concurrent("vscode --remove cleans up settings", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create a .gitignore
    await writeFile(
      join(ctx.targetDir, ".gitignore"),
      "node_modules/\n",
      "utf-8",
    );

    // Generate settings
    await clank(ctx, "vscode");

    const settingsPath = join(ctx.targetDir, ".vscode/settings.json");
    let settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(settings["search.useIgnoreFiles"]).toBe(false);

    // Remove settings
    await clank(ctx, "vscode --remove");

    // Settings should be removed (file may be deleted if empty)
    try {
      settings = JSON.parse(await readFile(settingsPath, "utf-8"));
      expect(settings["search.useIgnoreFiles"]).toBeUndefined();
      expect(settings["search.exclude"]).toBeUndefined();
    } catch {
      // File was deleted because it was empty - that's fine too
    }
  }));

test.concurrent("vscode merges with existing settings", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create existing .vscode/settings.json
    const vscodeDir = join(ctx.targetDir, ".vscode");
    await mkdir(vscodeDir, { recursive: true });
    await writeFile(
      join(vscodeDir, "settings.json"),
      '{\n  "editor.fontSize": 14\n}\n',
      "utf-8",
    );

    // Create a .gitignore
    await writeFile(
      join(ctx.targetDir, ".gitignore"),
      "node_modules/\n",
      "utf-8",
    );

    await clank(ctx, "vscode");

    const settingsPath = join(ctx.targetDir, ".vscode/settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    // Original settings should be preserved
    expect(settings["editor.fontSize"]).toBe(14);
    // New settings should be added
    expect(settings["search.useIgnoreFiles"]).toBe(false);
  }));

test.concurrent("vscode preserves user exclude patterns on generate and remove", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);
    await createUserVscodeSettings(ctx);
    await writeFile(join(ctx.targetDir, ".gitignore"), "node_modules/\n");

    // Generate - should merge, not replace
    await clank(ctx, "vscode");
    const settingsPath = join(ctx.targetDir, ".vscode/settings.json");
    let settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    // User's pattern preserved, clank's pattern added
    expect(settings["search.exclude"]["**/my-custom-pattern"]).toBe(true);
    expect(settings["files.exclude"]["**/my-custom-pattern"]).toBe(true);
    expect(settings["search.exclude"]["**/node_modules"]).toBe(true);

    // Remove - should only remove clank patterns
    await clank(ctx, "vscode --remove");
    settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    // User's pattern still there, clank's pattern gone
    expect(settings["search.exclude"]["**/my-custom-pattern"]).toBe(true);
    expect(settings["files.exclude"]["**/my-custom-pattern"]).toBe(true);
    expect(settings["search.exclude"]["**/node_modules"]).toBeUndefined();
    expect(settings["editor.fontSize"]).toBe(14);
  }));

test.concurrent("link auto-generates vscode settings when .vscode exists", () =>
  withTestEnv(async (ctx) => {
    // Create .vscode directory before linking (makes it a VS Code project)
    const vscodeDir = join(ctx.targetDir, ".vscode");
    await mkdir(vscodeDir, { recursive: true });
    await writeFile(
      join(vscodeDir, "settings.json"),
      '{"editor.fontSize": 14}\n',
      "utf-8",
    );

    // Create a .gitignore
    await writeFile(
      join(ctx.targetDir, ".gitignore"),
      "node_modules/\n",
      "utf-8",
    );

    await initAndLink(ctx);

    // VS Code settings should have been auto-generated
    const settingsPath = join(ctx.targetDir, ".vscode/settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    expect(settings["search.useIgnoreFiles"]).toBe(false);
    expect(settings["editor.fontSize"]).toBe(14);
  }));

test.concurrent("link skips vscode settings when settings.json is tracked by git", () =>
  withTestEnv(async (ctx) => {
    // Create and commit .vscode/settings.json before linking
    const vscodeDir = join(ctx.targetDir, ".vscode");
    await mkdir(vscodeDir, { recursive: true });
    const originalSettings = '{"editor.fontSize": 14}\n';
    await writeFile(join(vscodeDir, "settings.json"), originalSettings, "utf-8");

    // Track the settings file in git
    await execa("git", ["add", ".vscode/settings.json"], { cwd: ctx.targetDir });
    await execa("git", ["commit", "-m", "add vscode settings"], {
      cwd: ctx.targetDir,
    });

    // Create a .gitignore
    await writeFile(
      join(ctx.targetDir, ".gitignore"),
      "node_modules/\n",
      "utf-8",
    );

    await initAndLink(ctx);

    // VS Code settings should NOT have been modified
    const settingsPath = join(ctx.targetDir, ".vscode/settings.json");
    const settings = await readFile(settingsPath, "utf-8");
    expect(settings).toBe(originalSettings);
  }));

test.concurrent("add .claude/prompts/ creates symlinks in both .claude and .gemini", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create a prompt file in .claude/prompts/
    const claudePromptsDir = join(ctx.targetDir, ".claude/prompts");
    await mkdir(claudePromptsDir, { recursive: true });
    await writeFile(
      join(claudePromptsDir, "manifest.md"),
      "# Manifest prompt\n",
      "utf-8",
    );

    // Run clank add on the prompt file
    await clank(ctx, "add .claude/prompts/manifest.md");

    // Verify prompt was stored in overlay at prompts/ (not claude/prompts/)
    const overlayPromptPath = overlay(ctx, "prompts", "manifest.md");
    const overlayStat = await lstat(overlayPromptPath);
    expect(overlayStat.isFile()).toBe(true);

    // Verify content was preserved
    const content = await readFile(overlayPromptPath, "utf-8");
    expect(content).toBe("# Manifest prompt\n");

    // Verify symlink created in .claude/prompts/
    const claudeSymlink = join(ctx.targetDir, ".claude/prompts/manifest.md");
    const claudeStat = await lstat(claudeSymlink);
    expect(claudeStat.isSymbolicLink()).toBe(true);

    // Verify symlink created in .gemini/prompts/
    const geminiSymlink = join(ctx.targetDir, ".gemini/prompts/manifest.md");
    const geminiStat = await lstat(geminiSymlink);
    expect(geminiStat.isSymbolicLink()).toBe(true);

    // Verify both symlinks point to the same overlay file
    const claudeTarget = await readlink(claudeSymlink);
    const geminiTarget = await readlink(geminiSymlink);
    expect(claudeTarget).toContain("prompts/manifest.md");
    expect(geminiTarget).toContain("prompts/manifest.md");
  }));

test.concurrent("link recreates prompt symlinks in both agent directories", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create and add a prompt file
    const claudePromptsDir = join(ctx.targetDir, ".claude/prompts");
    await mkdir(claudePromptsDir, { recursive: true });
    await writeFile(
      join(claudePromptsDir, "test.md"),
      "# Test prompt\n",
      "utf-8",
    );
    await clank(ctx, "add .claude/prompts/test.md");

    const claudePrompt = join(ctx.targetDir, ".claude/prompts/test.md");
    const geminiPrompt = join(ctx.targetDir, ".gemini/prompts/test.md");

    // Verify symlinks exist
    expect(await isSymlink(claudePrompt)).toBe(true);
    expect(await isSymlink(geminiPrompt)).toBe(true);

    // Unlink and verify removed
    await clank(ctx, "unlink");
    expect(await pathExists(claudePrompt)).toBe(false);
    expect(await pathExists(geminiPrompt)).toBe(false);

    // Re-link and verify recreated
    await clank(ctx, "link");
    expect(await isSymlink(claudePrompt)).toBe(true);
    expect(await isSymlink(geminiPrompt)).toBe(true);
  }));
