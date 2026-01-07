import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { clank, withTestEnv, writeFileWithDir } from "./Helpers.ts";

async function writeProjectOverlay(
  ctx: { overlayDir: string },
  relPath: string,
  content: string,
): Promise<void> {
  await writeFileWithDir(
    join(ctx.overlayDir, "targets/my-project", relPath),
    content,
  );
}

test("clank files excludes dot-directories by default", async () => {
  await withTestEnv(async (ctx) => {
    await clank(ctx, `init ${ctx.overlayDir}`);

    await writeProjectOverlay(ctx, "agents.md", "# agents\n");
    await writeProjectOverlay(ctx, "clank/root.md", "# root\n");
    await writeProjectOverlay(ctx, "clank/sub/child.md", "# child\n");
    await writeProjectOverlay(ctx, "claude/commands/review.md", "# review\n");
    await writeProjectOverlay(ctx, "prompts/hello.md", "Hello\n");

    await clank(ctx, "link");

    await writeFileWithDir(join(ctx.targetDir, "clank/local.md"), "# local\n");

    const result = await clank(ctx, "files");
    const lines = result.stdout.trim().split("\n");

    expect(lines).toContain("AGENTS.md");
    expect(lines).not.toContain("CLAUDE.md");
    expect(lines).not.toContain("GEMINI.md");

    expect(lines).toContain("clank/root.md");
    expect(lines).toContain("clank/sub/child.md");
    expect(lines).toContain("clank/local.md");

    expect(lines.some((l) => l.startsWith(".claude/"))).toBe(false);
    expect(lines.some((l) => l.startsWith(".gemini/"))).toBe(false);
  });
});

test("clank files --hidden includes dot-directories and dedupes prompts", async () => {
  await withTestEnv(async (ctx) => {
    await clank(ctx, `init ${ctx.overlayDir}`);

    await writeProjectOverlay(ctx, "agents.md", "# agents\n");
    await writeProjectOverlay(ctx, "claude/commands/review.md", "# review\n");
    await writeProjectOverlay(ctx, "prompts/hello.md", "Hello\n");

    await clank(ctx, "link");

    const result = await clank(ctx, "files --hidden");
    const lines = result.stdout.trim().split("\n");

    expect(lines).toContain(".claude/commands/review.md");
    expect(lines).toContain(".claude/prompts/hello.md");
    expect(lines).not.toContain(".gemini/prompts/hello.md");
  });
});

test("clank files --depth filters clank/ depth", async () => {
  await withTestEnv(async (ctx) => {
    await mkdir(join(ctx.targetDir, "clank/sub"), { recursive: true });
    await writeFileWithDir(join(ctx.targetDir, "clank/root.md"), "# root\n");
    const childPath = join(ctx.targetDir, "clank/sub/child.md");
    await writeFileWithDir(childPath, "# child\n");

    const result = await clank(ctx, "files --depth 1");
    const lines = result.stdout.trim().split("\n");

    expect(lines).toContain("clank/root.md");
    expect(lines).not.toContain("clank/sub/child.md");
  });
});

test("clank files [path] limits to subtree (relative to cwd)", async () => {
  await withTestEnv(async (ctx) => {
    await mkdir(join(ctx.targetDir, "packages/foo/clank"), { recursive: true });
    await mkdir(join(ctx.targetDir, "clank"), { recursive: true });
    const aPath = join(ctx.targetDir, "packages/foo/clank/a.md");
    await writeFileWithDir(aPath, "# a\n");
    await writeFileWithDir(join(ctx.targetDir, "clank/b.md"), "# b\n");

    const result = await clank(ctx, "files packages/foo");
    const lines = result.stdout.trim().split("\n");

    expect(lines).toEqual(["packages/foo/clank/a.md"]);
  });
});

test("clank files -0 outputs NUL-separated paths", async () => {
  await withTestEnv(async (ctx) => {
    await mkdir(join(ctx.targetDir, "clank"), { recursive: true });
    await writeFileWithDir(join(ctx.targetDir, "clank/a.md"), "# a\n");
    await writeFileWithDir(join(ctx.targetDir, "clank/b.md"), "# b\n");

    const result = await clank(ctx, "files -0");

    expect(result.stdout).toBe("clank/a.md\0clank/b.md\0");
  });
});

test("clank files --linked-only excludes non-overlay files", async () => {
  await withTestEnv(async (ctx) => {
    await clank(ctx, `init ${ctx.overlayDir}`);
    await writeProjectOverlay(ctx, "clank/linked.md", "# linked\n");
    await clank(ctx, "link");

    await writeFileWithDir(join(ctx.targetDir, "clank/local.md"), "# local\n");

    const result = await clank(ctx, "files --linked-only");
    const lines = result.stdout.trim().split("\n");

    expect(lines).toContain("clank/linked.md");
    expect(lines).not.toContain("clank/local.md");
  });
});

test("clank files --unlinked-only excludes overlay symlinks", async () => {
  await withTestEnv(async (ctx) => {
    await clank(ctx, `init ${ctx.overlayDir}`);
    await writeProjectOverlay(ctx, "clank/linked.md", "# linked\n");
    await clank(ctx, "link");

    await writeFileWithDir(join(ctx.targetDir, "clank/local.md"), "# local\n");

    const result = await clank(ctx, "files --unlinked-only");
    const lines = result.stdout.trim().split("\n");

    expect(lines).not.toContain("clank/linked.md");
    expect(lines).toContain("clank/local.md");
  });
});
