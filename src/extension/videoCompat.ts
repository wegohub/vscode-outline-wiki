import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertWriteAllowed, isUnderStaticRoot, staticRoot } from '../core/path-rules.js';
import { decodeLinkTarget, encodeLinkTarget } from '../core/markdown-links.js';
import { resolveRelativeRef, relPathBetween } from '../core/paths.js';
import { FolderState, uriForRel, exists } from './workspaceModel.js';

const run = promisify(execFile);
const pending = new Map<string, Promise<string>>();
let conversionQueue: Promise<unknown> = Promise.resolve();

/** 保留画面/时间戳，将 PCM 音轨合入同一个原生播放缓存；原视频与 Markdown 不变。 */
export async function compatibleVideo(state: FolderState, docRel: string, href: string, extensionUri: vscode.Uri): Promise<string> {
  const rel = resolveRelativeRef(docRel, decodeLinkTarget(href));
  if (!rel || !isUnderStaticRoot(rel, state.layout) || !/\.(mp4|mov|m4v)$/i.test(rel)) throw new Error('兼容声音只支持工作区 static 内的 MP4/MOV/M4V。');
  const source = uriForRel(state.folder, rel);
  if (source.scheme !== 'file') throw new Error('此工作区不能使用本机音轨转换。');
  const stat = await vscode.workspace.fs.stat(source);
  const key = createHash('sha256').update(`pcm-mov-v1:${source.toString()}:${stat.size}:${stat.mtime}`).digest('hex');
  const cacheRel = `${staticRoot(state.layout)}/video-cache/${key}.mov`;
  const output = uriForRel(state.folder, cacheRel);
  const tempRel = `${staticRoot(state.layout)}/video-cache/${randomUUID()}.mov`;
  const temp = uriForRel(state.folder, tempRel);
  assertWriteAllowed(cacheRel, 'binary', state.layout);
  assertWriteAllowed(tempRel, 'binary', state.layout);
  if (!await exists(output)) {
    let job = pending.get(key);
    if (!job) {
      job = conversionQueue.then(async () => {
        await state.ensureSelfIgnore();
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(output, '..'));
        try {
          if (process.platform === 'darwin') {
            const helper = vscode.Uri.joinPath(extensionUri, 'media', 'bin', 'video-compat-darwin').fsPath;
            await run(helper, [source.fsPath, temp.fsPath], { timeout: 300000, maxBuffer: 200000 });
          } else {
            await run('ffmpeg', ['-nostdin', '-y', '-i', source.fsPath, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'pcm_s16le', '-movflags', '+faststart', temp.fsPath], { timeout: 300000, maxBuffer: 200000 });
          }
          await vscode.workspace.fs.rename(temp, output, { overwrite: true });
          return cacheRel;
        } finally {
          if (await exists(temp)) await vscode.workspace.fs.delete(temp);
          pending.delete(key);
        }
      });
      conversionQueue = job.catch(() => {});
      pending.set(key, job);
    }
    await job;
  }
  return encodeLinkTarget(relPathBetween(docRel, cacheRel));
}
