import { expect, test } from "vitest";
import { deduplicateGlobs } from "../src/Gitignore.ts";

test("deduplicateGlobs removes patterns covered by universal globs", () => {
  const input = [
    "**/node_modules",
    "tools/**/node_modules", // covered (/**/ suffix)
    "packages/bar/node_modules", // covered (/ suffix)
    "tools/**/special-dir", // kept (no universal)
    "packages/custom", // kept (no universal)
  ];

  expect(deduplicateGlobs(input)).toEqual([
    "**/node_modules",
    "tools/**/special-dir",
    "packages/custom",
  ]);
});

test("deduplicateGlobs handles edge cases", () => {
  expect(deduplicateGlobs([])).toEqual([]);
  expect(deduplicateGlobs(["tools/foo", "packages/bar"])).toEqual([
    "tools/foo",
    "packages/bar",
  ]);
});
