import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    execArgv: ["--disable-warning=ExperimentalWarning"],
    testTimeout: 30_000,
  },
});
