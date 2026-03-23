import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    forceRerunTriggers: ["**/*.ts"],
    testTimeout: process.platform === "win32" ? 30000 : 15000,
  },
});
