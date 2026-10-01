import { defineConfig } from '@vscode/test-cli';

/**
 * 官方测试宿主：它自己下载一份匹配的 VS Code（macOS 上布局稳定），
 * 避免用本机 app bundle 时要跟 Electron/CLI 启动参数较劲。
 *
 * 测试文件是打包产物 dist/test/suites.js（内含 Phase 0 探针的全部自动化检查）。
 */
export default defineConfig({
  files: 'dist/test/suites.js',
  workspaceFolder: 'test/fixtures/workspace',
  version: 'stable',
  launchArgs: ['--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
  mocha: {
    timeout: 180000,
    color: true
  }
});
