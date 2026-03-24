import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  generatedMarker,
  humanizeFilename,
  stripFrontmatter,
} from "../src/Consolidate.ts";
import {
  clank,
  clankExec,
  isSymlink,
  pathExists,
  type TestContext,
  withTestEnv,
  writeFileWithDir,
} from "./Helpers.ts";

/** Get path in overlay for current project */
function overlay(ctx: TestContext, ...segments: string[]) {
  return join(ctx.overlayDir, "targets/my-project", ...segments);
}

async function initAndLink(ctx: TestContext): Promise<void> {
  await clankExec(["init", ctx.overlayDir, "--config", ctx.configPath]);
  await clank(ctx, "link");
}

// --- Unit tests for pure functions ---

test("humanizeFilename strips extension and replaces separators", () => {
  expect(humanizeFilename("api-conventions.md")).toBe("api conventions");
  expect(humanizeFilename("testing_standards.md")).toBe("testing standards");
  expect(humanizeFilename("simple.md")).toBe("simple");
  expect(humanizeFilename("multi-word-name.md")).toBe("multi word name");
});

test("stripFrontmatter extracts description and paths", () => {
  const input = `---
description: API conventions
paths: ["src/api/**/*.ts"]
---

Use REST conventions.`;

  const result = stripFrontmatter(input);
  expect(result.description).toBe("API conventions");
  expect(result.paths).toBe("src/api/**/*.ts");
  expect(result.content).toBe("Use REST conventions.");
});

test("stripFrontmatter handles no frontmatter", () => {
  const input = "Just plain content.";
  const result = stripFrontmatter(input);
  expect(result.content).toBe("Just plain content.");
  expect(result.description).toBeUndefined();
  expect(result.paths).toBeUndefined();
});

test("stripFrontmatter handles frontmatter without description or paths", () => {
  const input = `---
alwaysApply: true
---

Some rules here.`;

  const result = stripFrontmatter(input);
  expect(result.content).toBe("Some rules here.");
  expect(result.description).toBeUndefined();
  expect(result.paths).toBeUndefined();
});

test("stripFrontmatter handles quoted description", () => {
  const input = `---
description: "Testing standards"
---

Test all the things.`;

  const result = stripFrontmatter(input);
  expect(result.description).toBe("Testing standards");
});

// --- Integration tests ---

test.concurrent("no rules = no consolidation, all agent files are symlinks", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Add a CLAUDE.md (creates agents.md in overlay)
    await writeFileWithDir(overlay(ctx, "agents.md"), "Base instructions.");
    await clank(ctx, "link");

    // All three should be symlinks
    expect(await isSymlink(join(ctx.targetDir, "CLAUDE.md"))).toBe(true);
    expect(await isSymlink(join(ctx.targetDir, "AGENTS.md"))).toBe(true);
    expect(await isSymlink(join(ctx.targetDir, "GEMINI.md"))).toBe(true);
  }));

test.concurrent("consolidation generates AGENTS.md and GEMINI.md when rules exist", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Create agents.md + a rule in overlay
    await writeFileWithDir(overlay(ctx, "agents.md"), "Base instructions.");
    await writeFileWithDir(
      overlay(ctx, "claude/rules/testing.md"),
      `---
description: Testing standards
---

Always write tests.`,
    );
    await clank(ctx, "link");

    // CLAUDE.md should still be a symlink
    expect(await isSymlink(join(ctx.targetDir, "CLAUDE.md"))).toBe(true);

    // AGENTS.md and GEMINI.md should be generated files, not symlinks
    expect(await isSymlink(join(ctx.targetDir, "AGENTS.md"))).toBe(false);
    expect(await isSymlink(join(ctx.targetDir, "GEMINI.md"))).toBe(false);

    const agentsContent = await readFile(
      join(ctx.targetDir, "AGENTS.md"),
      "utf-8",
    );
    expect(agentsContent).toContain(generatedMarker);
    expect(agentsContent).toContain("Base instructions.");
    expect(agentsContent).toContain("## Testing standards");
    expect(agentsContent).toContain("Always write tests.");

    // Verify overlay paths in header
    expect(agentsContent).toContain("<!-- Source:");
    expect(agentsContent).toContain("<!-- Rules:");
  }));

test.concurrent("consolidation with paths frontmatter renders Applies to", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    await writeFileWithDir(overlay(ctx, "agents.md"), "Base.");
    await writeFileWithDir(
      overlay(ctx, "claude/rules/api.md"),
      `---
description: API conventions
paths: ["src/api/**/*.ts"]
---

Use REST.`,
    );
    await clank(ctx, "link");

    const content = await readFile(join(ctx.targetDir, "AGENTS.md"), "utf-8");
    expect(content).toContain("## API conventions");
    expect(content).toContain("Applies to: src/api/**/*.ts");
    expect(content).toContain("Use REST.");
  }));

test.concurrent("consolidation uses humanized filename when no description", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    await writeFileWithDir(overlay(ctx, "agents.md"), "Base.");
    await writeFileWithDir(
      overlay(ctx, "claude/rules/code-style.md"),
      "Use 2-space indent.",
    );
    await clank(ctx, "link");

    const content = await readFile(join(ctx.targetDir, "AGENTS.md"), "utf-8");
    expect(content).toContain("## code style");
    expect(content).toContain("Use 2-space indent.");
  }));

test.concurrent("consolidation without agents.md generates from rules only", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    // Only rules, no agents.md
    await writeFileWithDir(
      overlay(ctx, "claude/rules/testing.md"),
      `---
description: Testing standards
---

Always write tests.`,
    );
    await clank(ctx, "link");

    // CLAUDE.md should not exist (no agents.md to symlink to)
    expect(await pathExists(join(ctx.targetDir, "CLAUDE.md"))).toBe(false);

    // AGENTS.md should be generated from rules alone
    const content = await readFile(join(ctx.targetDir, "AGENTS.md"), "utf-8");
    expect(content).toContain(generatedMarker);
    expect(content).not.toContain("<!-- Source:");
    expect(content).toContain("## Testing standards");
    expect(content).toContain("Always write tests.");
  }));

test.concurrent("rules are sorted alphabetically by filename", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    await writeFileWithDir(overlay(ctx, "agents.md"), "Base.");
    await writeFileWithDir(
      overlay(ctx, "claude/rules/zebra.md"),
      "Zebra rule.",
    );
    await writeFileWithDir(
      overlay(ctx, "claude/rules/alpha.md"),
      "Alpha rule.",
    );
    await clank(ctx, "link");

    const content = await readFile(join(ctx.targetDir, "AGENTS.md"), "utf-8");
    const alphaIndex = content.indexOf("## alpha");
    const zebraIndex = content.indexOf("## zebra");
    expect(alphaIndex).toBeLessThan(zebraIndex);
  }));

test.concurrent("unlink removes generated agent files", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    await writeFileWithDir(overlay(ctx, "agents.md"), "Base.");
    await writeFileWithDir(
      overlay(ctx, "claude/rules/testing.md"),
      "Write tests.",
    );
    await clank(ctx, "link");

    // Verify generated files exist
    expect(await pathExists(join(ctx.targetDir, "AGENTS.md"))).toBe(true);
    expect(await pathExists(join(ctx.targetDir, "GEMINI.md"))).toBe(true);

    // Unlink should remove them
    await clank(ctx, "unlink");

    expect(await pathExists(join(ctx.targetDir, "AGENTS.md"))).toBe(false);
    expect(await pathExists(join(ctx.targetDir, "GEMINI.md"))).toBe(false);
    expect(await pathExists(join(ctx.targetDir, "CLAUDE.md"))).toBe(false);
  }));

test.concurrent("re-link regenerates consolidated files", () =>
  withTestEnv(async (ctx) => {
    await initAndLink(ctx);

    await writeFileWithDir(overlay(ctx, "agents.md"), "Base.");
    await writeFileWithDir(
      overlay(ctx, "claude/rules/testing.md"),
      "Write tests.",
    );
    await clank(ctx, "link");

    // Modify the rule
    await writeFile(
      overlay(ctx, "claude/rules/testing.md"),
      "Write MORE tests.",
      "utf-8",
    );
    await clank(ctx, "link");

    const content = await readFile(join(ctx.targetDir, "AGENTS.md"), "utf-8");
    expect(content).toContain("Write MORE tests.");
    expect(content).not.toContain("Write tests.");
  }));
