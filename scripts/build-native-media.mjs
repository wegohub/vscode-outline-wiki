import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function buildNativeMedia(root) {
  const source = path.join(root, 'src/native/video-compat.swift');
  const bin = path.join(root, 'media/bin/video-compat-darwin');
  if (process.platform !== 'darwin') {
    if (!existsSync(bin)) throw new Error('Build the bundled macOS helper on macOS before packaging.');
    return;
  }
  const stamp = path.join(root, 'dist/meta/native-media.sha256');
  const fingerprint = createHash('sha256').update(readFileSync(source)).update('macOS13-universal-v1').digest('hex');
  if (existsSync(bin) && existsSync(stamp) && readFileSync(stamp, 'utf8') === fingerprint) return;
  mkdirSync(path.dirname(bin), { recursive: true });
  const parts = ['arm64', 'x86_64'].map(arch => `${bin}.build-${arch}`);
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180000 });
    if (result.status !== 0) throw new Error(`${command}: ${result.error?.message ?? result.stderr}`);
  };
  try {
    for (let i = 0; i < parts.length; i++) run('xcrun', ['swiftc', '-O', '-target', `${['arm64', 'x86_64'][i]}-apple-macos13.0`, source, '-o', parts[i]]);
    run('lipo', ['-create', ...parts, '-output', bin]);
    mkdirSync(path.dirname(stamp), { recursive: true });
    writeFileSync(stamp, fingerprint);
    process.stdout.write('[native-media] macOS universal helper built\n');
  } finally { for (const part of parts) rmSync(part, { force: true }); }
}
