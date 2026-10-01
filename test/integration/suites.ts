import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { ProbeResult } from '../../src/shared/protocol.js';

const EXT_ID = 'wegohub.outline-wiki';
const SOURCE = 'src/hello.go';
const DOC_REL = '.metadata/docs/src/hello.go.wiki.md';

interface Api {
  storagePath: string;
  activeSessionDocRel(): string | null;
  postToActiveSession(message: unknown): boolean;
}

function api(): Api {
  const ext = vscode.extensions.getExtension(EXT_ID);
  assert.ok(ext, `扩展 ${EXT_ID} 未加载`);
  return ext.exports as Api;
}

function folder(): vscode.Uri {
  const f = vscode.workspace.workspaceFolders?.[0];
  assert.ok(f, '没有打开工作区');
  return f.uri;
}

function uri(rel: string): vscode.Uri {
  return vscode.Uri.joinPath(folder(), ...rel.split('/'));
}

async function readText(rel: string): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri(rel));
  return new TextDecoder().decode(bytes);
}

async function exists(rel: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri(rel));
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`等待「${what}」超时（${timeoutMs}ms）`);
}

describe('outline-wiki 端到端', () => {
  it('激活并注册命令', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['outlineWiki.openDoc', 'outlineWiki.openSource', 'outlineWiki.rebuildIndex', 'outlineWiki.verifyRefs', 'outlineWiki.runProbe']) {
      assert.ok(commands.includes(id), `命令未注册：${id}`);
    }
  });

  it('openDoc 为源文件创建文档并写入模板', async () => {
    await vscode.commands.executeCommand('outlineWiki.openDoc', uri(SOURCE));
    await waitFor(() => exists(DOC_REL), 15_000, `${DOC_REL} 出现`);

    const text = await readText(DOC_REL);
    assert.match(text, /^# hello\.go/, '模板应以文件名标题开头');
    assert.ok(text.includes(SOURCE), '模板应包含指向源文件的相对链接');

    // 索引是缓存，但应记录这篇文档
    await vscode.commands.executeCommand('outlineWiki.rebuildIndex');
    await waitFor(() => exists('.metadata/index.json'), 15_000, 'index.json 出现');
    const indexRaw = await readText('.metadata/index.json');
    assert.ok(indexRaw.includes(DOC_REL), 'index.json 应包含该文档条目');
  });

  it('webview 载入编辑器后能接收插入指令，并把结果写回 TextDocument', async () => {
    const docUri = uri(DOC_REL);
    await vscode.commands.executeCommand('vscode.openWith', docUri, 'outlineWiki.wikiDoc', vscode.ViewColumn.Active);

    const doc = await vscode.workspace.openTextDocument(docUri);
    const before = doc.getText();

    // 等 webview 就绪（session 会记录 docRel）
    await waitFor(() => api().activeSessionDocRel() === DOC_REL, 30_000, 'webview 会话就绪');

    const marker = `探针插入-${Date.now()}`;
    const posted = api().postToActiveSession({ type: 'insertMarkdown', markdown: `\n${marker}\n` });
    assert.ok(posted, '插入指令未投递到 webview');

    // 走完 webview → 编辑器 → edit 消息 → applyEdit → TextDocument 这条真实链路
    await waitFor(() => doc.getText().includes(marker), 30_000, '插入内容出现在文档里');
    assert.notStrictEqual(doc.getText(), before, '文档内容应发生变化');
    assert.ok(doc.isDirty, '编辑后文档应处于 dirty 状态（保存由 VS Code 原生通道负责）');
    await doc.save();
    assert.ok((await readText(DOC_REL)).includes(marker), '保存后磁盘内容应包含插入内容');
  });

  it('Phase 0 探针：渲染 / <base> / Range seek / 编解码 / 二进制 postMessage', async () => {
    const reportPath = vscode.Uri.joinPath(vscode.Uri.file(api().storagePath), 'probe-report.json');
    try {
      await vscode.workspace.fs.delete(reportPath);
    } catch {
      /* 首次没有报告 */
    }

    await vscode.commands.executeCommand('outlineWiki.runProbe');
    await waitFor(async () => {
      try {
        await vscode.workspace.fs.stat(reportPath);
        return true;
      } catch {
        return false;
      }
    }, 60_000, '探针报告生成');

    const report = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(reportPath))) as {
      results: ProbeResult[];
    };
    const byName = new Map(report.results.map((r) => [r.name, r]));
    const summary = report.results.map((r) => `${r.ok ? '✓' : '✗'} ${r.name}: ${r.detail.split('\n')[0]}`).join('\n');

    // 编解码能力只要信息量，不作为失败条件
    for (const name of ['editorMounted', 'baseResolution', 'mediaRangeSeek']) {
      const result = byName.get(name);
      assert.ok(result, `探针缺少 ${name}\n${summary}`);
      assert.ok(result.ok, `探针 ${name} 失败：${result.detail}\n---\n${summary}`);
    }
    console.log(`[probe]\n${summary}`);
  });

  it('.gitignore：static/ 被忽略，docs 与 index.json 不被忽略', async () => {
    await vscode.commands.executeCommand('outlineWiki.configGitIgnore');
    await waitFor(() => exists('.metadata/static/.gitignore'), 10_000, 'static/.gitignore 出现');
    const content = await readText('.metadata/static/.gitignore');
    const rules = content.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    assert.deepStrictEqual(rules, ['*', '!.gitignore'], '自忽略文件规则应为 * + !.gitignore');
  });
});
