import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  clank,
  clankExec,
  type TestContext,
  withTestEnv,
  writeFileWithDir,
} from "./Helpers.ts";

/** init + link, then commit so the overlay starts from a clean baseline */
async function initLinkCommit(ctx: TestContext): Promise<void> {
  await clankExec(["init", ctx.overlayDir, "--config", ctx.configPath]);
  await clank(ctx, "link");
  await clank(ctx, "commit");
}

/** Path inside the overlay repo */
function ov(ctx: TestContext, ...segments: string[]): string {
  return join(ctx.overlayDir, ...segments);
}

test.concurrent("diff shows a newly added (untracked) overlay file", () =>
  withTestEnv(async (ctx) => {
    await initLinkCommit(ctx);
    await writeFileWithDir(
      ov(ctx, "targets/my-project/clank/newnote.md"),
      "# brand new\n",
    );

    const { stdout } = await clank(ctx, "diff");

    expect(stdout).toContain("newnote.md");
    expect(stdout).toContain("+# brand new");
  }));

test.concurrent("diff shows a modified tracked overlay file", () =>
  withTestEnv(async (ctx) => {
    await initLinkCommit(ctx);
    await writeFile(
      ov(ctx, "targets/my-project/worktrees/main/clank/notes.md"),
      "# changed notes\n",
      "utf-8",
    );

    const { stdout } = await clank(ctx, "diff");

    expect(stdout).toContain("notes.md");
    expect(stdout).toContain("+# changed notes");
  }));

test.concurrent("diff (contextual) excludes other projects and other worktrees", () =>
  withTestEnv(async (ctx) => {
    await initLinkCommit(ctx);
    await writeFileWithDir(
      ov(ctx, "targets/my-project/clank/mine.md"),
      "mine\n",
    );
    await writeFileWithDir(
      ov(ctx, "targets/other-project/clank/theirs.md"),
      "theirs\n",
    );
    await writeFileWithDir(
      ov(ctx, "targets/my-project/worktrees/feature-z/clank/branchy.md"),
      "branchy\n",
    );

    const { stdout } = await clank(ctx, "diff");

    expect(stdout).toContain("mine.md");
    expect(stdout).not.toContain("theirs.md");
    expect(stdout).not.toContain("branchy.md");
  }));

test.concurrent("diff --all includes other projects", () =>
  withTestEnv(async (ctx) => {
    await initLinkCommit(ctx);
    await writeFileWithDir(
      ov(ctx, "targets/other-project/clank/theirs.md"),
      "theirs\n",
    );

    const { stdout } = await clank(ctx, "diff --all");

    expect(stdout).toContain("theirs.md");
  }));

test.concurrent("diff --global shows only the global scope", () =>
  withTestEnv(async (ctx) => {
    await initLinkCommit(ctx);
    await writeFileWithDir(ov(ctx, "global/clank/gnote.md"), "global\n");
    await writeFileWithDir(
      ov(ctx, "targets/my-project/clank/pnote.md"),
      "proj\n",
    );

    const { stdout } = await clank(ctx, "diff --global");

    expect(stdout).toContain("gnote.md");
    expect(stdout).not.toContain("pnote.md");
  }));

test.concurrent("diff --project excludes the worktree subtree", () =>
  withTestEnv(async (ctx) => {
    await initLinkCommit(ctx);
    await writeFileWithDir(
      ov(ctx, "targets/my-project/clank/pnote.md"),
      "proj\n",
    );
    await writeFileWithDir(
      ov(ctx, "targets/my-project/worktrees/main/clank/wnote.md"),
      "wt\n",
    );

    const { stdout } = await clank(ctx, "diff --project");

    expect(stdout).toContain("pnote.md");
    expect(stdout).not.toContain("wnote.md");
  }));

test.concurrent("diff reports No changes when the overlay is clean", () =>
  withTestEnv(async (ctx) => {
    await initLinkCommit(ctx);

    const { stdout } = await clank(ctx, "diff");

    expect(stdout.trim()).toBe("No changes");
  }));

test.concurrent("diff --stat shows a summary, not a full patch", () =>
  withTestEnv(async (ctx) => {
    await initLinkCommit(ctx);
    await writeFile(
      ov(ctx, "targets/my-project/worktrees/main/clank/notes.md"),
      "# changed\nmore\n",
      "utf-8",
    );

    const { stdout } = await clank(ctx, "diff --stat");

    expect(stdout).toContain("notes.md");
    expect(stdout).toContain("|");
    expect(stdout).not.toContain("@@");
  }));
