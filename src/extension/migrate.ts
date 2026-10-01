import * as vscode from 'vscode';
import { assertWriteAllowed } from '../core/path-rules.js';
import { docRelPathForSource, posixDirname } from '../core/paths.js';
import { collectStaticRefs, rewriteStaticLinksForMove } from '../core/markdown-links.js';
import { FolderState, exists, uriForRel } from './workspaceModel.js';

export interface MigrationOutcome {
  oldDocRel: string;
  newDocRel: string;
  /** 文档文件被迁移 */
  moved: boolean;
  /** 跨层级移动导致 static 链接被重算 */
  rewroteLinks: boolean;
  /** 跳过迁移的原因（便于日志排查） */
  skipped?: 'same-path' | 'no-doc' | 'target-exists';
}

/**
 * 源文件改名/移动后，把对应的 Wiki 文档一起迁移，并重算文档内指向 static/ 的相对链接。
 *
 * 为什么放在 `onDidRenameFiles`（后置）而不是 `onWillRenameFiles` + `waitUntil(WorkspaceEdit)`：
 *  - `renameFile` 是否被 waitUntil 接受官方没有文档化，属于未验证 API；
 *  - 链接重算必须先读到磁盘内容，而 waitUntil 的回调要求同步调用，混在一起容易踩顺序坑；
 *  - 后置做法的代价只是"文档迁移"与"用户改名"不算同一个 undo 步骤，换来的是可验证与可测。
 *
 * 终端 `git mv` 通常表现为 create+delete 而不是 rename：那种情况下文档会原地变成
 * "未关联文档"（不删不改），新建文件若推导出已有文档则自动重新关联——都不会丢内容。
 */
export async function migrateDocForSourceRename(
  state: FolderState,
  oldSourceRel: string,
  newSourceRel: string,
  out: vscode.OutputChannel
): Promise<MigrationOutcome> {
  const oldDocRel = docRelPathForSource(oldSourceRel, state.layout);
  const newDocRel = docRelPathForSource(newSourceRel, state.layout);
  const base: MigrationOutcome = { oldDocRel, newDocRel, moved: false, rewroteLinks: false };

  if (oldDocRel === newDocRel) return { ...base, skipped: 'same-path' };

  const oldUri = uriForRel(state.folder, oldDocRel);
  if (!(await exists(oldUri))) return { ...base, skipped: 'no-doc' };

  const newUri = uriForRel(state.folder, newDocRel);
  if (await exists(newUri)) {
    out.appendLine(`[rename] 目标文档已存在，保留两者：${newDocRel}`);
    return { ...base, skipped: 'target-exists' };
  }

  await vscode.workspace.fs.createDirectory(uriForRel(state.folder, posixDirname(newDocRel)));
  assertWriteAllowed(newDocRel, 'text', state.layout);
  await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });

  // 跨层级移动会改变相对链接的 ../ 层数；同目录改名则原样搬运
  const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(newUri));
  const rewritten = rewriteStaticLinksForMove(text, oldDocRel, newDocRel, state.layout);
  const rewroteLinks = rewritten !== text;
  if (rewroteLinks) {
    assertWriteAllowed(newDocRel, 'text', state.layout);
    await vscode.workspace.fs.writeFile(newUri, new TextEncoder().encode(rewritten));
  }

  await state.forgetDoc(oldDocRel);
  await state.recordDoc(newDocRel, rewritten, collectStaticRefs(rewritten, newDocRel, state.layout));

  return { oldDocRel, newDocRel, moved: true, rewroteLinks };
}

/** 源文件删除时不删文档：只是变成"未关联"，等用户重新关联或手工处理 */
export function describeOrphan(state: FolderState, sourceRel: string): string {
  return docRelPathForSource(sourceRel, state.layout);
}
