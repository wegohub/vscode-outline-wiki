import Mocha from 'mocha';
import * as path from 'node:path';

/** @vscode/test-electron 会调用这个入口 */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 180_000 });
  mocha.addFile(path.resolve(__dirname, 'suites.js'));
  return new Promise((resolve, reject) => {
    mocha.run((failures: number) => {
      if (failures > 0) reject(new Error(`${failures} 个用例失败`));
      else resolve();
    });
  });
}
