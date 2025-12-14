import { expect, test } from "vitest";
import { parseRepoName } from "../src/Git.ts";

test("parseRepoName parses HTTPS URLs", () => {
  expect(parseRepoName("https://github.com/user/my-repo.git")).toBe("my-repo");
  expect(parseRepoName("https://github.com/user/my-repo")).toBe("my-repo");
  expect(parseRepoName("https://gitlab.com/org/group/project.git")).toBe(
    "project",
  );
});

test("parseRepoName parses SSH URLs", () => {
  expect(parseRepoName("git@github.com:user/my-repo.git")).toBe("my-repo");
  expect(parseRepoName("git@github.com:user/my-repo")).toBe("my-repo");
  expect(parseRepoName("git@gitlab.com:org/group/project.git")).toBe("project");
});

test("parseRepoName handles URLs without .git suffix", () => {
  expect(parseRepoName("https://github.com/user/wesl-js")).toBe("wesl-js");
  expect(parseRepoName("git@github.com:user/clank")).toBe("clank");
});

test("parseRepoName falls back to basename for unusual formats", () => {
  expect(parseRepoName("/local/path/to/repo")).toBe("repo");
});
