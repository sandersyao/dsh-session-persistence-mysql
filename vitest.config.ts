import { defineConfig } from "vitest/config";

/**
 * Vitest 配置：node 环境、覆盖率门禁。
 * 覆盖率阈值对齐「为 v0.1.2-alpha.3 兼容打底」的要求。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/helpers/test-env.ts"],
    globalSetup: ["test/helpers/test-global.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 85,
        branches: 80,
      },
    },
  },
});
