import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // 需要 DOM 的用例在文件顶部用 `// @vitest-environment jsdom` 单独声明
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
