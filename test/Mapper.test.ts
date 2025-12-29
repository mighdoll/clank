import { expect, test } from "vitest";
import {
  isAgentFile,
  type MapperContext,
  normalizeAddPath,
  overlayToTarget,
  targetToOverlay,
} from "../src/Mapper.ts";

const gitRoot = "/target";
const cwd = "/target"; // Default: running from project root

const makeContext = (worktreeName = "main"): MapperContext => ({
  overlayRoot: "/overlay",
  targetRoot: "/target",
  gitContext: {
    projectName: "my-project",
    worktreeName,
    isWorktree: worktreeName !== "main",
    gitRoot: "/target",
  },
});

test("isAgentFile identifies agent files (case-insensitive)", () => {
  expect(isAgentFile("agents.md")).toBe(true);
  expect(isAgentFile("AGENTS.md")).toBe(true);
  expect(isAgentFile("Agents.md")).toBe(true);
  expect(isAgentFile("CLAUDE.md")).toBe(true);
  expect(isAgentFile("GEMINI.md")).toBe(true);
});

test("isAgentFile does not identify regular files", () => {
  expect(isAgentFile("architecture.md")).toBe(false);
  expect(isAgentFile("README.md")).toBe(false);
  expect(isAgentFile("notes.md")).toBe(false);
});

test("normalizeAddPath normalizes agent files to agents.md", () => {
  expect(normalizeAddPath("agents.md", cwd, gitRoot)).toBe("/target/agents.md");
  expect(normalizeAddPath("AGENTS.md", cwd, gitRoot)).toBe("/target/agents.md");
  expect(normalizeAddPath("CLAUDE.md", cwd, gitRoot)).toBe("/target/agents.md");
  expect(normalizeAddPath("GEMINI.md", cwd, gitRoot)).toBe("/target/agents.md");
});

test("normalizeAddPath agent files respect subdirectory", () => {
  const subCwd = "/target/tools";
  expect(normalizeAddPath("claude.md", subCwd, gitRoot)).toBe(
    "/target/tools/agents.md",
  );
  expect(normalizeAddPath("AGENTS.md", subCwd, gitRoot)).toBe(
    "/target/tools/agents.md",
  );
});

test("normalizeAddPath places plain filenames in clank/", () => {
  expect(normalizeAddPath("architecture.md", cwd, gitRoot)).toBe(
    "/target/clank/architecture.md",
  );
  expect(normalizeAddPath("notes.md", cwd, gitRoot)).toBe(
    "/target/clank/notes.md",
  );
});

test("normalizeAddPath regular files respect subdirectory", () => {
  const subCwd = "/target/tools";
  expect(normalizeAddPath("notes.md", subCwd, gitRoot)).toBe(
    "/target/tools/clank/notes.md",
  );
});

test("normalizeAddPath handles clank/ prefix", () => {
  expect(normalizeAddPath("clank/arch.md", cwd, gitRoot)).toBe(
    "/target/clank/arch.md",
  );
  expect(normalizeAddPath("./clank/notes.md", cwd, gitRoot)).toBe(
    "/target/clank/notes.md",
  );
});

test("normalizeAddPath preserves .claude/ paths", () => {
  expect(normalizeAddPath(".claude/commands/review.md", cwd, gitRoot)).toBe(
    "/target/.claude/commands/review.md",
  );
});

test("normalizeAddPath handles running from inside .claude/ directory", () => {
  // When cwd is inside .claude/, files should join directly (no clank/ prefix)
  const claudeCwd = "/target/.claude/commands";
  expect(normalizeAddPath("review.md", claudeCwd, gitRoot)).toBe(
    "/target/.claude/commands/review.md",
  );
  expect(normalizeAddPath("subdir/foo.md", claudeCwd, gitRoot)).toBe(
    "/target/.claude/commands/subdir/foo.md",
  );
});

test("normalizeAddPath handles running from inside .gemini/ directory", () => {
  const geminiCwd = "/target/.gemini/commands";
  expect(normalizeAddPath("review.md", geminiCwd, gitRoot)).toBe(
    "/target/.gemini/commands/review.md",
  );
});

test("normalizeAddPath avoids nesting when cwd is clank/", () => {
  // When running from inside clank/ directory, don't create clank/clank
  const clankCwd = "/target/clank";
  expect(normalizeAddPath("notes.md", clankCwd, gitRoot)).toBe(
    "/target/clank/notes.md",
  );
  expect(normalizeAddPath("subdir/notes.md", clankCwd, gitRoot)).toBe(
    "/target/clank/subdir/notes.md",
  );
  // Nested clank directories should also work
  const nestedClankCwd = "/target/tools/clank";
  expect(normalizeAddPath("notes.md", nestedClankCwd, gitRoot)).toBe(
    "/target/tools/clank/notes.md",
  );
});

test("normalizeAddPath handles project named 'clank'", () => {
  // When project itself is named "clank", don't strip the project root
  const clankGitRoot = "/Users/lee/clank";
  const clankCwd = "/Users/lee/clank";
  expect(normalizeAddPath("foo.md", clankCwd, clankGitRoot)).toBe(
    "/Users/lee/clank/clank/foo.md",
  );
});

test("normalizeAddPath preserves paths with /clank/ in the middle", () => {
  // Path already contains /clank/ - don't add another prefix
  expect(normalizeAddPath("packages/foo/clank/notes.md", cwd, gitRoot)).toBe(
    "/target/packages/foo/clank/notes.md",
  );

  // From a subdirectory
  const subCwd = "/target/tools";
  expect(
    normalizeAddPath("packages/viewer/clank/plan.md", subCwd, gitRoot),
  ).toBe("/target/tools/packages/viewer/clank/plan.md");
});

// overlayToTarget - worktree files

test("overlayToTarget maps worktree clank/ files to target/clank/", () => {
  const ctx = makeContext("feature-branch");
  const result = overlayToTarget(
    "/overlay/targets/my-project/worktrees/feature-branch/clank/notes.md",
    ctx,
  );
  expect(result).toEqual({
    targetPath: "/target/clank/notes.md",
    scope: "worktree",
  });
});

test("overlayToTarget worktree clank/ preserves subdirectory structure", () => {
  const ctx = makeContext("feature-branch");
  const result = overlayToTarget(
    "/overlay/targets/my-project/worktrees/feature-branch/clank/subdir/notes.md",
    ctx,
  );
  expect(result).toEqual({
    targetPath: "/target/clank/subdir/notes.md",
    scope: "worktree",
  });
});

test("overlayToTarget maps worktree agents.md to natural path", () => {
  const ctx = makeContext("feature-branch");
  const result = overlayToTarget(
    "/overlay/targets/my-project/worktrees/feature-branch/tools/agents.md",
    ctx,
  );
  expect(result).toEqual({
    targetPath: "/target/tools/agents.md",
    scope: "worktree",
  });
});

test("overlayToTarget maps worktree nested agents.md to natural path", () => {
  const ctx = makeContext("feature-branch");
  const result = overlayToTarget(
    "/overlay/targets/my-project/worktrees/feature-branch/tools/packages/wesl/agents.md",
    ctx,
  );
  expect(result).toEqual({
    targetPath: "/target/tools/packages/wesl/agents.md",
    scope: "worktree",
  });
});

test("overlayToTarget maps worktree claude/commands/ to .claude/commands/", () => {
  const ctx = makeContext("feature-branch");
  const result = overlayToTarget(
    "/overlay/targets/my-project/worktrees/feature-branch/claude/commands/review.md",
    ctx,
  );
  expect(result).toEqual({
    targetPath: "/target/.claude/commands/review.md",
    scope: "worktree",
  });
});

test("overlayToTarget maps worktree claude/agents/ to .claude/agents/", () => {
  const ctx = makeContext("feature-branch");
  const result = overlayToTarget(
    "/overlay/targets/my-project/worktrees/feature-branch/claude/agents/helper.md",
    ctx,
  );
  expect(result).toEqual({
    targetPath: "/target/.claude/agents/helper.md",
    scope: "worktree",
  });
});

test("overlayToTarget skips unrecognized worktree files", () => {
  const ctx = makeContext("feature-branch");
  const result = overlayToTarget(
    "/overlay/targets/my-project/worktrees/feature-branch/random/file.md",
    ctx,
  );
  expect(result).toBeNull();
});

test("overlayToTarget skips other worktrees", () => {
  const ctx = makeContext("feature-branch");
  const result = overlayToTarget(
    "/overlay/targets/my-project/worktrees/other-branch/clank/notes.md",
    ctx,
  );
  expect(result).toBeNull();
});

// targetToOverlay - worktree scope

test("targetToOverlay worktree encodes clank/ files preserving structure", () => {
  const ctx = makeContext("feature-branch");
  const result = targetToOverlay("/target/clank/notes.md", "worktree", ctx);
  expect(result).toBe(
    "/overlay/targets/my-project/worktrees/feature-branch/clank/notes.md",
  );
});

test("targetToOverlay worktree encodes plain files with clank/ prefix", () => {
  const ctx = makeContext("feature-branch");
  const result = targetToOverlay("/target/random.md", "worktree", ctx);
  expect(result).toBe(
    "/overlay/targets/my-project/worktrees/feature-branch/clank/random.md",
  );
});

test("targetToOverlay worktree encodes agents.md at natural path", () => {
  const ctx = makeContext("feature-branch");
  const result = targetToOverlay("/target/tools/agents.md", "worktree", ctx);
  expect(result).toBe(
    "/overlay/targets/my-project/worktrees/feature-branch/tools/agents.md",
  );
});

test("targetToOverlay worktree encodes .claude/commands/ to claude/commands/", () => {
  const ctx = makeContext("feature-branch");
  const result = targetToOverlay(
    "/target/.claude/commands/review.md",
    "worktree",
    ctx,
  );
  expect(result).toBe(
    "/overlay/targets/my-project/worktrees/feature-branch/claude/commands/review.md",
  );
});

test("targetToOverlay worktree encodes .claude/agents/ to claude/agents/", () => {
  const ctx = makeContext("feature-branch");
  const result = targetToOverlay(
    "/target/.claude/agents/helper.md",
    "worktree",
    ctx,
  );
  expect(result).toBe(
    "/overlay/targets/my-project/worktrees/feature-branch/claude/agents/helper.md",
  );
});

// overlayToTarget - project files

test("overlayToTarget maps project clank/ files to target/clank/", () => {
  const ctx = makeContext();
  const result = overlayToTarget(
    "/overlay/targets/my-project/clank/overview.md",
    ctx,
  );
  expect(result).toEqual({
    targetPath: "/target/clank/overview.md",
    scope: "project",
  });
});

test("overlayToTarget maps project agents.md to natural path", () => {
  const ctx = makeContext();
  const result = overlayToTarget(
    "/overlay/targets/my-project/tools/agents.md",
    ctx,
  );
  expect(result).toEqual({
    targetPath: "/target/tools/agents.md",
    scope: "project",
  });
});

test("overlayToTarget maps project claude/commands/ to .claude/commands/", () => {
  const ctx = makeContext();
  const result = overlayToTarget(
    "/overlay/targets/my-project/claude/commands/build.md",
    ctx,
  );
  expect(result).toEqual({
    targetPath: "/target/.claude/commands/build.md",
    scope: "project",
  });
});

// Prompts handling tests

test("normalizeAddPath preserves .claude/prompts/ paths", () => {
  expect(normalizeAddPath(".claude/prompts/foo.md", cwd, gitRoot)).toBe(
    "/target/.claude/prompts/foo.md",
  );
});

test("normalizeAddPath preserves .gemini/prompts/ paths", () => {
  expect(normalizeAddPath(".gemini/prompts/bar.md", cwd, gitRoot)).toBe(
    "/target/.gemini/prompts/bar.md",
  );
});

test("targetToOverlay encodes .claude/prompts/ to prompts/", () => {
  const ctx = makeContext();
  const result = targetToOverlay(
    "/target/.claude/prompts/manifest.md",
    "project",
    ctx,
  );
  expect(result).toBe("/overlay/targets/my-project/prompts/manifest.md");
});

test("targetToOverlay encodes .gemini/prompts/ to prompts/", () => {
  const ctx = makeContext();
  const result = targetToOverlay(
    "/target/.gemini/prompts/manifest.md",
    "project",
    ctx,
  );
  expect(result).toBe("/overlay/targets/my-project/prompts/manifest.md");
});

test("overlayToTarget maps prompts/ to .claude/prompts/ (primary target)", () => {
  const ctx = makeContext();
  const result = overlayToTarget(
    "/overlay/targets/my-project/prompts/manifest.md",
    ctx,
  );
  expect(result).toEqual({
    targetPath: "/target/.claude/prompts/manifest.md",
    scope: "project",
  });
});

test("overlayToTarget maps global prompts/ to .claude/prompts/", () => {
  const ctx = makeContext();
  const result = overlayToTarget("/overlay/global/prompts/shared.md", ctx);
  expect(result).toEqual({
    targetPath: "/target/.claude/prompts/shared.md",
    scope: "global",
  });
});

test("overlayToTarget maps worktree prompts/ to .claude/prompts/", () => {
  const ctx = makeContext("feature-branch");
  const result = overlayToTarget(
    "/overlay/targets/my-project/worktrees/feature-branch/prompts/branch-specific.md",
    ctx,
  );
  expect(result).toEqual({
    targetPath: "/target/.claude/prompts/branch-specific.md",
    scope: "worktree",
  });
});
