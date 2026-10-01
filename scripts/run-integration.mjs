#!/usr/bin/env node
/**
 * 用本机已安装的 VS Code 跑集成测试。
 *
 * 刻意不下载 VS Code：用你机器上的那份，才能给出与日常使用一致的版本事实
 * （integration test 会顺带跑 Phase 0 探针，产出可核对的 probe-report.json）。
 */
import { runTests } from '@vscode/test-electron';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOCAL_CODE = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const fixture = path.join(root, 'test/fixtures/workspace');

async function main() {
  const executable = process.env.VSCODE_EXECUTABLE_PATH || (existsSync(LOCAL_CODE) ? LOCAL_CODE : undefined);
  if (!executable) {
    console.error('找不到本机 VS Code，可用 VSCODE_EXECUTABLE_PATH 指定');
    process.exit(1);
  }
  try {
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, 'dist/test/integration.js'),
      launchArgs: [
        // Contents/MacOS/Code 是薄 Electron 启动器：argv[1] 必须是 app 目录，
        // 之后的参数才会转发给 VS Code 自己的 CLI 解析器。
        '/Applications/Visual Studio Code.app/Contents/Resources/app',
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-release-notes',
        '--skip-welcome',
        fixture
      ]
    });
    console.log('集成测试全部通过');
  } catch (err) {
    console.error('集成测试失败：', err);
    process.exit(1);
  }
}

await main();
