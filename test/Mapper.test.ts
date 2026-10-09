import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import {
  addScopeSuffix,
  isAgentFile,
  type MapperContext,
  normalizeAddPath,
  overlayToTarget,
  targetToOverlay,
} from "../src/Mapper.ts";

const targetRoot = resolve("/target");
const overlayRoot = resolve("/overlay");
const gitRoot = targetRoot;
const cwd = targetRoot; // Default: running from project root

const makeContext = (branchName = "main"): MapperContext => ({
  overlayRoot: overlayRoot,
  targetRoot: targetRoot,
  gitContext: {
    projectName: "my-project",
    branchName,
    isWorktree: branchName !== "main",
    gitRoot: targetRoot,
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
  expect(normalizeAddPath("agents.md", cwd, gitRoot)).toBe(
    join(targetRoot, "agents.md"),
  );
  expect(normalizeAddPath("AGENTS.md", cwd, gitRoot)).toBe(
    join(targetRoot, "agents.md"),
  );
  expect(normalizeAddPath("CLAUDE.md", cwd, gitRoot)).toBe(
    join(targetRoot, "agents.md"),
  );
  expect(normalizeAddPath("GEMINI.md", cwd, gitRoot)).toBe(
    join(targetRoot, "agents.md"),
  );
});

test("normalizeAddPath agent files respect subdirectory", () => {
  const subCwd = join(targetRoot, "tools");
  expect(normalizeAddPath("claude.md", subCwd, gitRoot)).toBe(
    join(targetRoot, "tools", "agents.md"),
  );
  expect(normalizeAddPath("AGENTS.md", subCwd, gitRoot)).toBe(
    join(targetRoot, "tools", "agents.md"),
  );
});

test("normalizeAddPath places plain filenames in clank/", () => {
  expect(normalizeAddPath("architecture.md", cwd, gitRoot)).toBe(
    join(targetRoot, "clank", "architecture.md"),
  );
  expect(normalizeAddPath("notes.md", cwd, gitRoot)).toBe(
    join(targetRoot, "clank", "notes.md"),
  );
});

test("normalizeAddPath regular files respect subdirectory", () => {
  const subCwd = join(targetRoot, "tools");
  expect(normalizeAddPath("notes.md", subCwd, gitRoot)).toBe(
    join(targetRoot, "tools", "clank", "notes.md"),
  );
});

test("normalizeAddPath handles clank/ prefix", () => {
  expect(normalizeAddPath("clank/arch.md", cwd, gitRoot)).toBe(
    join(targetRoot, "clank", "arch.md"),
  );
  expect(normalizeAddPath("./clank/notes.md", cwd, gitRoot)).toBe(
    join(targetRoot, "clank", "notes.md"),
  );
});

test("normalizeAddPath preserves .claude/ paths", () => {
  expect(normalizeAddPath(".claude/commands/review.md", cwd, gitRoot)).toBe(
    join(targetRoot, ".claude", "commands", "review.md"),
  );
});

test("normalizeAddPath handles running from inside .claude/ directory", () => {
  // When cwd is inside .claude/, files should join directly (no clank/ prefix)
  const claudeCwd = join(targetRoot, ".claude", "commands");
  expect(normalizeAddPath("review.md", claudeCwd, gitRoot)).toBe(
    join(targetRoot, ".claude", "commands", "review.md"),
  );
  expect(normalizeAddPath("subdir/foo.md", claudeCwd, gitRoot)).toBe(
    join(targetRoot, ".claude", "commands", "subdir", "foo.md"),
  );
});

test("normalizeAddPath handles running from inside .gemini/ directory", () => {
  const geminiCwd = join(targetRoot, ".gemini", "commands");
  expect(normalizeAddPath("review.md", geminiCwd, gitRoot)).toBe(
    join(targetRoot, ".gemini", "commands", "review.md"),
  );
});

test("normalizeAddPath avoids nesting when cwd is clank/", () => {
  // When running from inside clank/ directory, don't create clank/clank
  const clankCwd = join(targetRoot, "clank");
  expect(normalizeAddPath("notes.md", clankCwd, gitRoot)).toBe(
    join(targetRoot, "clank", "notes.md"),
  );
  expect(normalizeAddPath("subdir/notes.md", clankCwd, gitRoot)).toBe(
    join(targetRoot, "clank", "subdir", "notes.md"),
  );
  // Nested clank directories should also work
  const nestedClankCwd = join(targetRoot, "tools", "clank");
  expect(normalizeAddPath("notes.md", nestedClankCwd, gitRoot)).toBe(
    join(targetRoot, "tools", "clank", "notes.md"),
  );
});

test("normalizeAddPath avoids nesting when cwd is under clank/", () => {
  const reportsCwd = join(targetRoot, "clank", "reports");
  expect(normalizeAddPath("findings.md", reportsCwd, gitRoot)).toBe(
    join(targetRoot, "clank", "reports", "findings.md"),
  );
  expect(normalizeAddPath("../notes.md", reportsCwd, gitRoot)).toBe(
    join(targetRoot, "clank", "notes.md"),
  );
  // an explicit clank/ prefix refers to the enclosing clank/ dir
  expect(normalizeAddPath("clank/archive/old.md", reportsCwd, gitRoot)).toBe(
    join(targetRoot, "clank", "reports", "archive", "old.md"),
  );
  const nestedCwd = join(targetRoot, "tools", "clank", "reports");
  expect(normalizeAddPath("findings.md", nestedCwd, gitRoot)).toBe(
    join(targetRoot, "tools", "clank", "reports", "findings.md"),
  );
});

test("normalizeAddPath anchors paths reaching above cwd in clank/", () => {
  const subCwd = join(targetRoot, "src");
  expect(normalizeAddPath("../notes.md", subCwd, gitRoot)).toBe(
    join(targetRoot, "clank", "notes.md"),
  );
});

test("normalizeAddPath handles project named 'clank'", () => {
  // When project itself is named "clank", don't strip the project root
  const clankGitRoot = resolve("/Users/lee/clank");
  const clankCwd = resolve("/Users/lee/clank");
  expect(normalizeAddPath("foo.md", clankCwd, clankGitRoot)).toBe(
    join(clankCwd, "clank", "foo.md"),
  );
});

test("normalizeAddPath handles absolute paths", () => {
  expect(
    normalizeAddPath(join(targetRoot, "clank", "notes.md"), cwd, gitRoot),
  ).toBe(join(targetRoot, "clank", "notes.md"));

  expect(
    normalizeAddPath(
      join(targetRoot, "packages", "foo", "clank", "plan.md"),
      cwd,
      gitRoot,
    ),
  ).toBe(join(targetRoot, "packages", "foo", "clank", "plan.md"));

  // Absolute agent file path gets aliased to agents.md
  expect(normalizeAddPath(join(targetRoot, "CLAUDE.md"), cwd, gitRoot)).toBe(
    join(targetRoot, "agents.md"),
  );
});

test("normalizeAddPath preserves paths with /clank/ in the middle", () => {
  // Path already contains /clank/ - don't add another prefix
  expect(normalizeAddPath("packages/foo/clank/notes.md", cwd, gitRoot)).toBe(
    join(targetRoot, "packages", "foo", "clank", "notes.md"),
  );

  // From a subdirectory
  const subCwd = join(targetRoot, "tools");
  expect(
    normalizeAddPath("packages/viewer/clank/plan.md", subCwd, gitRoot),
  ).toBe(join(targetRoot, "tools", "packages", "viewer", "clank", "plan.md"));
});

// overlayToTarget - branch files

test("overlayToTarget maps branch clank/ files to target/clank/", () => {
  const ctx = makeContext("feature-branch");
  const result = overlayToTarget(
    join(
      overlayRoot,
      "targets",
      "my-project",
      "worktrees",
      "feature-branch",
      "clank",
      "notes.md",
    ),
    ctx,
  );
  expect(result).toEqual({
    targetPath: join(targetRoot, "clank", "notes.md"),
    scope: "branch",
  });
});

test("overlayToTarget branch clank/ preserves subdirectory structure", () => {
  const ctx = makeContext("feature-branch");
  const result = overlayToTarget(
    join(
      overlayRoot,
      "targets",
      "my-project",
      "worktrees",
      "feature-branch",
      "clank",
      "subdir",
      "notes.md",
    ),
    ctx,
  );
  expect(result).toEqual({
    targetPath: join(targetRoot, "clank", "subdir", "notes.md"),
    scope: "branch",
  });
});

test("overlayToTarget maps branch agents.md to natural path", () => {
  const ctx = makeContext("feature-branch");
  const result = overlayToTarget(
    join(
      overlayRoot,
      "targets",
      "my-project",
      "worktrees",
      "feature-branch",
      "tools",
      "agents.md",
    ),
    ctx,
  );
  expect(result).toEqual({
    targetPath: join(targetRoot, "tools", "agents.md"),
    scope: "branch",
  });
});

test("overlayToTarget maps branch nested agents.md to natural path", () => {
  const ctx = makeContext("feature-branch");
  const result = overlayToTarget(
    join(
      overlayRoot,
      "targets",
      "my-project",
      "worktrees",
      "feature-branch",
      "tools",
      "packages",
      "wesl",
      "agents.md",
    ),
    ctx,
  );
  expect(result).toEqual({
    targetPath: join(targetRoot, "tools", "packages", "wesl", "agents.md"),
    scope: "branch",
  });
});

test("overlayToTarget maps branch claude/commands/ to .claude/commands/", () => {
  const ctx = makeContext("feature-branch");
  const result = overlayToTarget(
    join(
      overlayRoot,
      "targets",
      "my-project",
      "worktrees",
      "feature-branch",
      "claude",
      "commands",
      "review.md",
    ),
    ctx,
  );
  expect(result).toEqual({
    targetPath: join(targetRoot, ".claude", "commands", "review.md"),
    scope: "branch",
  });
});

test("overlayToTarget maps branch claude/agents/ to .claude/agents/", () => {
  const ctx = makeContext("feature-branch");
  const result = overlayToTarget(
    join(
      overlayRoot,
      "targets",
      "my-project",
      "worktrees",
      "feature-branch",
      "claude",
      "agents",
      "helper.md",
    ),
    ctx,
  );
  expect(result).toEqual({
    targetPath: join(targetRoot, ".claude", "agents", "helper.md"),
    scope: "branch",
  });
});

test("overlayToTarget skips unrecognized branch files", () => {
  const ctx = makeContext("feature-branch");
  const result = overlayToTarget(
    join(
      overlayRoot,
      "targets",
      "my-project",
      "worktrees",
      "feature-branch",
      "random",
      "file.md",
    ),
    ctx,
  );
  expect(result).toBeNull();
});

test("overlayToTarget skips other branches", () => {
  const ctx = makeContext("feature-branch");
  const result = overlayToTarget(
    join(
      overlayRoot,
      "targets",
      "my-project",
      "worktrees",
      "other-branch",
      "clank",
      "notes.md",
    ),
    ctx,
  );
  expect(result).toBeNull();
});

// targetToOverlay - branch scope

test("targetToOverlay branch encodes clank/ files preserving structure", () => {
  const ctx = makeContext("feature-branch");
  const result = targetToOverlay(
    join(targetRoot, "clank", "notes.md"),
    "branch",
    ctx,
  );
  expect(result).toBe(
    join(
      overlayRoot,
      "targets",
      "my-project",
      "worktrees",
      "feature-branch",
      "clank",
      "notes.md",
    ),
  );
});

test("targetToOverlay branch encodes plain files with clank/ prefix", () => {
  const ctx = makeContext("feature-branch");
  const result = targetToOverlay(join(targetRoot, "random.md"), "branch", ctx);
  expect(result).toBe(
    join(
      overlayRoot,
      "targets",
      "my-project",
      "worktrees",
      "feature-branch",
      "clank",
      "random.md",
    ),
  );
});

test("targetToOverlay branch encodes agents.md at natural path", () => {
  const ctx = makeContext("feature-branch");
  const result = targetToOverlay(
    join(targetRoot, "tools", "agents.md"),
    "branch",
    ctx,
  );
  expect(result).toBe(
    join(
      overlayRoot,
      "targets",
      "my-project",
      "worktrees",
      "feature-branch",
      "tools",
      "agents.md",
    ),
  );
});

test("targetToOverlay branch encodes .claude/commands/ to claude/commands/", () => {
  const ctx = makeContext("feature-branch");
  const result = targetToOverlay(
    join(targetRoot, ".claude", "commands", "review.md"),
    "branch",
    ctx,
  );
  expect(result).toBe(
    join(
      overlayRoot,
      "targets",
      "my-project",
      "worktrees",
      "feature-branch",
      "claude",
      "commands",
      "review.md",
    ),
  );
});

test("targetToOverlay branch encodes .claude/agents/ to claude/agents/", () => {
  const ctx = makeContext("feature-branch");
  const result = targetToOverlay(
    join(targetRoot, ".claude", "agents", "helper.md"),
    "branch",
    ctx,
  );
  expect(result).toBe(
    join(
      overlayRoot,
      "targets",
      "my-project",
      "worktrees",
      "feature-branch",
      "claude",
      "agents",
      "helper.md",
    ),
  );
});

// overlayToTarget - project files

test("overlayToTarget maps project clank/ files to target/clank/", () => {
  const ctx = makeContext();
  const result = overlayToTarget(
    join(overlayRoot, "targets", "my-project", "clank", "overview.md"),
    ctx,
  );
  expect(result).toEqual({
    targetPath: join(targetRoot, "clank", "overview.md"),
    scope: "project",
  });
});

test("overlayToTarget maps project agents.md to natural path", () => {
  const ctx = makeContext();
  const result = overlayToTarget(
    join(overlayRoot, "targets", "my-project", "tools", "agents.md"),
    ctx,
  );
  expect(result).toEqual({
    targetPath: join(targetRoot, "tools", "agents.md"),
    scope: "project",
  });
});

test("overlayToTarget maps project claude/commands/ to .claude/commands/", () => {
  const ctx = makeContext();
  const result = overlayToTarget(
    join(
      overlayRoot,
      "targets",
      "my-project",
      "claude",
      "commands",
      "build.md",
    ),
    ctx,
  );
  expect(result).toEqual({
    targetPath: join(targetRoot, ".claude", "commands", "build.md"),
    scope: "project",
  });
});

// Codex (.codex/) is a managed agent dir, like .claude/ and .gemini/

test("normalizeAddPath preserves .codex/config.toml path", () => {
  expect(normalizeAddPath(".codex/config.toml", cwd, gitRoot)).toBe(
    join(targetRoot, ".codex", "config.toml"),
  );
});

test("targetToOverlay encodes .codex/config.toml to codex/config.toml", () => {
  const ctx = makeContext();
  const result = targetToOverlay(
    join(targetRoot, ".codex", "config.toml"),
    "project",
    ctx,
  );
  expect(result).toBe(
    join(overlayRoot, "targets", "my-project", "codex", "config.toml"),
  );
});

test("overlayToTarget maps project codex/config.toml to .codex/config.toml", () => {
  const ctx = makeContext();
  const result = overlayToTarget(
    join(overlayRoot, "targets", "my-project", "codex", "config.toml"),
    ctx,
  );
  expect(result).toEqual({
    targetPath: join(targetRoot, ".codex", "config.toml"),
    scope: "project",
  });
});

test("isAgentFile does not treat .codex/config.toml as an agent file", () => {
  expect(isAgentFile("config.toml")).toBe(false);
  expect(isAgentFile(".codex/config.toml")).toBe(false);
});

// Prompts handling tests

test("normalizeAddPath preserves .claude/prompts/ paths", () => {
  expect(normalizeAddPath(".claude/prompts/foo.md", cwd, gitRoot)).toBe(
    join(targetRoot, ".claude", "prompts", "foo.md"),
  );
});

test("normalizeAddPath preserves .gemini/prompts/ paths", () => {
  expect(normalizeAddPath(".gemini/prompts/bar.md", cwd, gitRoot)).toBe(
    join(targetRoot, ".gemini", "prompts", "bar.md"),
  );
});

test("targetToOverlay encodes .claude/prompts/ to prompts/", () => {
  const ctx = makeContext();
  const result = targetToOverlay(
    join(targetRoot, ".claude", "prompts", "manifest.md"),
    "project",
    ctx,
  );
  expect(result).toBe(
    join(overlayRoot, "targets", "my-project", "prompts", "manifest.md"),
  );
});

test("targetToOverlay encodes .gemini/prompts/ to prompts/", () => {
  const ctx = makeContext();
  const result = targetToOverlay(
    join(targetRoot, ".gemini", "prompts", "manifest.md"),
    "project",
    ctx,
  );
  expect(result).toBe(
    join(overlayRoot, "targets", "my-project", "prompts", "manifest.md"),
  );
});

test("overlayToTarget maps prompts/ to .claude/prompts/ (primary target)", () => {
  const ctx = makeContext();
  const result = overlayToTarget(
    join(overlayRoot, "targets", "my-project", "prompts", "manifest.md"),
    ctx,
  );
  expect(result).toEqual({
    targetPath: join(targetRoot, ".claude", "prompts", "manifest.md"),
    scope: "project",
  });
});

test("overlayToTarget maps global prompts/ to .claude/prompts/", () => {
  const ctx = makeContext();
  const result = overlayToTarget(
    join(overlayRoot, "global", "prompts", "shared.md"),
    ctx,
  );
  expect(result).toEqual({
    targetPath: join(targetRoot, ".claude", "prompts", "shared.md"),
    scope: "global",
  });
});

test("overlayToTarget maps branch prompts/ to .claude/prompts/", () => {
  const ctx = makeContext("feature-branch");
  const result = overlayToTarget(
    join(
      overlayRoot,
      "targets",
      "my-project",
      "worktrees",
      "feature-branch",
      "prompts",
      "branch-specific.md",
    ),
    ctx,
  );
  expect(result).toEqual({
    targetPath: join(targetRoot, ".claude", "prompts", "branch-specific.md"),
    scope: "branch",
  });
});

test("addScopeSuffix suffixes project and branch scopes, not global", () => {
  expect(addScopeSuffix("notes.md", "global")).toBe("notes.md");
  expect(addScopeSuffix("notes.md", "project")).toBe("notes-project.md");
  expect(addScopeSuffix("notes.md", "branch")).toBe("notes-branch.md");
});
