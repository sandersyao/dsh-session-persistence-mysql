import { defineConfig } from "tsup";

/** tsup 构建配置：产出 ESM + 类型声明，对齐 DSH 包产物布局。 */
export default defineConfig({
  entry: ["src/index.ts", "src/invariant.ts"],
  format: ["esm"],
  target: "node22",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  outDir: "lib",
  external: [
    "@deepseek-ai/dsh-session",
    "@deepseek-ai/dsh-session-persistence",
    "@deepseek-ai/dsh-invariants",
    "@deepseek-ai/cordis",
  ],
});
