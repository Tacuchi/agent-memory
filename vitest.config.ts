import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup/sin-red.ts"],
    globalSetup: ["tests/setup/build.ts"],
    pool: "forks",
    execArgv: ["--disable-warning=ExperimentalWarning"],
    testTimeout: 30_000,
  },
});
