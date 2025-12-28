import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    forceRerunTriggers: ["**/*.ts"],
    testTimeout: 15000,
  },
});
