import * as vscode from 'vscode';
import { compatibleVideo } from './videoCompat.js';
import { randomUUID } from 'node:crypto';
import { assertWriteAllowed, isUnderWikiRoot, staticRoot } from '../core/path-rules.js';
import { DOC_SUFFIX, docRelPathForSource, freePageRelPath, posixDirname, relPathBetween } from '../core/paths.js';
import { collectStaticRefs, encodeLinkTarget } from '../core/markdown-links.js';
import { deriveExt, newAssetName } from '../core/asset-paths.js';
import { isMediaPath, kindOfPath } from '../core/media-type.js';
import { appendRuleOnce } from '../core/gitignore.js';
import type { ProbeResult } from '../shared/protocol.js';
import { DocSession, MediaHooks, WIKI_VIEW_TYPE, WikiDocEditorProvider } from './docEditorProvider.js';
import { FolderState, WorkspaceModel, exists, relFromUri, uriForRel } from './workspaceModel.js';
import { migrateDocForSourceRename } from './migrate.js';
import { WikiSidebarProvider, WIKI_SIDEBAR_ID } from './wikiSidebarProvider.js';
import { probePng, probeWav } from './probeFixtures.js';

export interface OutlineWikiApi {
  /** 扩展存储目录（探针报告落在这里） */
  storagePath: string;
  /** 当前活动会话的 docRel（集成测试用来确认 webview 已就绪） */
  activeSessionDocRel(): string | null;
  /** 给活动会话投递消息（集成测试用来驱动 webview） */
  postToActiveSession(message: unknown): boolean;
}

export function activate(context: vscode.ExtensionContext): OutlineWikiApi {
  const out = vscode.window.createOutputChannel('Outline Wiki');
  context.subscriptions.push(out);

  const model = new WorkspaceModel(out);
  context.subscriptions.push(model);

  /** 探针夹具的清理函数，等 webview 回报结果后执行 */
  const pendingProbeCleanup = new Map<string, () => Promise<void>>();

  const pickMedia = async (kind: 'video' | 'audio', session: DocSession): Promise<string | undefined> => {
    const state = model.stateFor(session.folder);
    if (!state) return undefined;
    return pickMediaFromStatic(kind, state, session);
  };

  const pickMediaUrl = async (): Promise<string | undefined> => {
    const url = await vscode.window.showInputBox({
      title: '插入播放链接',
      prompt: '支持 .mp4/.mov/.webm/.mkv/.m4v/.mp3/.m4a/.wav/.ogg 等直链，或页面型播放链接',
      placeHolder: 'https://example.com/demo.mp4',
      validateInput: (value) => (/^https?:\/\/\S+$/i.test(value.trim()) ? undefined : '请填写 http(s) 链接')
    });
    if (!url) return undefined;
    const clean = url.trim();
    return `[${clean}](${clean})`;
  };

  const hooks: MediaHooks = {
    pickMedia,
    pickMediaUrl,
    async prepareVideo(session, href) {
      const state = model.stateFor(session.folder);
      if (!state) throw new Error('找不到工作区');
      return compatibleVideo(state, session.docRel, href, context.extensionUri);
    },
    async pickLocalVideo(session) {
      const state = model.stateFor(session.folder);
      if (!state) return undefined;
      const rel = await importMediaFromDisk(state, 'video');
      if (!rel) return undefined;
      const href = encodeLinkTarget(relPathBetween(session.docRel, rel));
      return `[${href}](${href})`;
    },

    async prepareProbe(session) {
      const state = model.stateFor(session.folder);
      if (!state) throw new Error('找不到工作区文件夹');
      const dirRel = `${staticRoot(state.layout)}/probe-media`;
      assertWriteAllowed(`${dirRel}/probe.png`, 'binary', state.layout);
      const dirUri = uriForRel(state.folder, dirRel);
      await vscode.workspace.fs.createDirectory(dirUri);
      await vscode.workspace.fs.writeFile(uriForRel(state.folder, `${dirRel}/probe.png`), probePng());
      await vscode.workspace.fs.writeFile(uriForRel(state.folder, `${dirRel}/probe.wav`), probeWav({}));
      let videoHref: string | undefined;
      if (context.extensionMode === vscode.ExtensionMode.Development) {
        try {
          const marker = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(state.folder, '__autoprobe__.json'))));
          if (typeof marker.video === 'string') {
            const rel = `${dirRel}/video.mp4`;
            assertWriteAllowed(rel, 'binary', state.layout);
            await vscode.workspace.fs.writeFile(uriForRel(state.folder, rel), await vscode.workspace.fs.readFile(vscode.Uri.file(marker.video)));
            videoHref = encodeLinkTarget(relPathBetween(session.docRel, rel));
          }
        } catch { /* 无额外用户视频夹具 */ }
      }
      return {
        spec: {
          videoHref,
          imageHref: encodeLinkTarget(relPathBetween(session.docRel, `${dirRel}/probe.png`)),
          audioHref: encodeLinkTarget(relPathBetween(session.docRel, `${dirRel}/probe.wav`)),
          fixtureRel: dirRel,
          expect: { math: 2, mermaid: 1 }
        },
        cleanup: async () => {
          try {
            await vscode.workspace.fs.delete(dirUri, { recursive: true, useTrash: true });
          } catch {
            /* 忽略 */
          }
        }
      };
    },

    async saveProbeReport(session, results) {
      const base = context.storageUri ?? context.globalStorageUri;
      try {
        await vscode.workspace.fs.createDirectory(base);
        const target = vscode.Uri.joinPath(base, 'probe-report.json');
        const payload = {
          at: new Date().toISOString(),
          vscodeVersion: vscode.version,
          docRel: session.docRel,
          results
        };
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`));
        const cleanup = pendingProbeCleanup.get(session.docRel);
        if (cleanup) {
          pendingProbeCleanup.delete(session.docRel);
          await cleanup();
        }
        return target.fsPath;
      } catch (err) {
        out.appendLine(`[probe] 报告落盘失败：${String(err)}`);
        return undefined;
      }
    }
  };

  const provider = new WikiDocEditorProvider(model, out, context.extensionUri, hooks);
  context.subscriptions.push(provider);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(WIKI_VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: false, enableFindWidget: true }
    })
  );

  const sidebar = new WikiSidebarProvider(model, out, context.extensionUri, hooks,
    (state, rel) => ensureDoc(state, rel, out));
  context.subscriptions.push(sidebar,
    vscode.window.registerWebviewViewProvider(WIKI_SIDEBAR_ID, sidebar, {
      webviewOptions: { retainContextWhenHidden: true }
    }));
  const activeSession = () => sidebar.isVisible() ? sidebar.activeSession() : provider.activeSession();

  // ------------------------------------------------------------------ 辅助

  const argUri = (arg: unknown): vscode.Uri | undefined => {
    if (arg instanceof vscode.Uri) return arg;
    const maybe = (arg as { resourceUri?: vscode.Uri } | undefined)?.resourceUri;
    return maybe instanceof vscode.Uri ? maybe : undefined;
  };

  const stateOf = (uri: vscode.Uri | undefined): FolderState | undefined => (uri ? model.stateFor(uri) : undefined);

  const openDocInEditor = async (docUri: vscode.Uri, beside: boolean) => {
    await vscode.commands.executeCommand(
      'vscode.openWith',
      docUri,
      WIKI_VIEW_TYPE,
      beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active
    );
  };

  const openSourceOf = async (state: FolderState, docRel: string) => {
    const sourceUri = state.sourceUriFor(docRel);
    if (!sourceUri) {
      void vscode.window.showInformationMessage('这是独立页面，没有对应的源文件。');
      return;
    }
    if (sidebar.isVisible()) await vscode.window.showTextDocument(sourceUri, { preview: false });
    else await vscode.commands.executeCommand('vscode.open', sourceUri, vscode.ViewColumn.Beside);
  };

  // ------------------------------------------------------------------ 命令

  context.subscriptions.push(
    vscode.commands.registerCommand('outlineWiki.openDoc', async (arg?: unknown) => {
      const uri = argUri(arg) ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri) {
        void vscode.window.showInformationMessage('请先打开一个文件，或在资源管理器里右键。');
        return;
      }
      const state = stateOf(uri);
      if (!state) {
        void vscode.window.showWarningMessage('该文件不在工作区内。');
        return;
      }
      const rel = relFromUri(state.folder, uri);
      if (isUnderWikiRoot(rel, state.layout)) {
        await openSourceOf(state, rel);
        return;
      }
      if (state.isExcluded(rel)) {
        void vscode.window.showWarningMessage(`「${rel}」按配置不提供 Wiki 文档（outlineWiki.excludeGlobs）。`);
        return;
      }
      await sidebar.show(uri);
    }),

    vscode.commands.registerCommand('outlineWiki.openDocFromTree', async (arg?: unknown) => {
      const uri = argUri(arg);
      if (uri) await sidebar.show(uri);
    }),

    vscode.commands.registerCommand('outlineWiki.openSource', async (arg?: unknown) => {
      const uri = argUri(arg);
      const session = uri ? provider.sessionFor(uri) : activeSession();
      if (session) {
        await openSourceOf(model.stateFor(session.folder)!, session.docRel);
        return;
      }
      if (uri) {
        const state = stateOf(uri);
        const rel = state ? relFromUri(state.folder, uri) : null;
        if (state && rel) {
          const key = rel.endsWith(DOC_SUFFIX) ? rel : null;
          if (key) await openSourceOf(state, key);
        }
      }
    }),

    vscode.commands.registerCommand('outlineWiki.newPage', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showWarningMessage('需要先打开一个工作区。');
        return;
      }
      const state = model.stateFor(folder.uri);
      if (!state) return;
      const slug = await vscode.window.showInputBox({
        title: '新建独立 Wiki 页',
        prompt: '输入页面文件名（不含后缀）',
        placeHolder: 'architecture',
        validateInput: (v) =>
          /^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5.\-]*$/.test(v.trim())
            ? undefined
            : '只能用字母、数字、中文、下划线、连字符与点'
      });
      if (!slug) return;
      const rel = freePageRelPath(slug.trim(), state.layout);
      assertWriteAllowed(rel, 'text', state.layout);
      const uri = uriForRel(state.folder, rel);
      if (await exists(uri)) {
        void vscode.window.showWarningMessage('同名页面已存在，直接打开它。');
      } else {
        await vscode.workspace.fs.createDirectory(uriForRel(state.folder, posixDirname(rel)));
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`# ${slug.trim()}\n\n`));
        await state.recordDoc(rel, `# ${slug.trim()}\n\n`, []);
      }
      await openDocInEditor(uri, false);
    }),

    vscode.commands.registerCommand('outlineWiki.rebuildIndex', async () => {
      for (const state of model.allStates()) {
        const { docs } = await state.reconcile();
        for (const docRel of docs) {
          try {
            const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uriForRel(state.folder, docRel)));
            await state.recordDoc(docRel, text, collectStaticRefs(text, docRel, state.layout));
          } catch (err) {
            out.appendLine(`[rebuildIndex] ${docRel} 读取失败：${String(err)}`);
          }
        }
        out.appendLine(`[rebuildIndex] ${vscode.workspace.asRelativePath(state.folder)}：${docs.length} 篇文档`);
      }
      void vscode.window.showInformationMessage('已重建 .metadata/index.json');
    }),

    vscode.commands.registerCommand('outlineWiki.verifyRefs', async () => {
      const missing: { docRel: string; ref: string; folder: vscode.Uri }[] = [];
      for (const state of model.allStates()) {
        for (const docRel of await state.scanDocs()) {
          const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uriForRel(state.folder, docRel)));
          for (const ref of collectStaticRefs(text, docRel, state.layout)) {
            if (!(await exists(uriForRel(state.folder, ref)))) missing.push({ docRel, ref, folder: state.folder });
          }
        }
      }
      if (missing.length === 0) {
        void vscode.window.showInformationMessage('所有静态资源引用都能在磁盘上找到。');
        return;
      }
      out.appendLine(`[verifyRefs] 共 ${missing.length} 条引用缺失：`);
      for (const m of missing) out.appendLine(`  ${m.docRel} -> ${m.ref}`);
      out.show(true);
      const pick = await vscode.window.showWarningMessage(
        `${missing.length} 条资源引用在磁盘上不存在（网盘未同步？）。详情见输出面板。`,
        '打开第一个引用它的文档'
      );
      if (pick) {
        const state = model.stateFor(missing[0]!.folder);
        if (state) await openDocInEditor(uriForRel(state.folder, missing[0]!.docRel), true);
      }
    }),

    vscode.commands.registerCommand('outlineWiki.gcAssets', async () => {
      const report: { rel: string; size: number }[] = [];
      for (const state of model.allStates()) {
        const referenced = new Set<string>();
        for (const docRel of await state.scanDocs()) {
          const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uriForRel(state.folder, docRel)));
          for (const ref of collectStaticRefs(text, docRel, state.layout)) referenced.add(ref);
        }
        const uploadPrefix = `${staticRoot(state.layout)}/upload/`;
        for (const rel of await state.scanStatic()) {
          if (!rel.startsWith(uploadPrefix) || referenced.has(rel)) continue;
          let size = 0;
          try {
            size = (await vscode.workspace.fs.stat(uriForRel(state.folder, rel))).size;
          } catch {
            /* 忽略 */
          }
          report.push({ rel, size });
        }
      }
      if (report.length === 0) {
        void vscode.window.showInformationMessage('没有发现未被引用的上传资源。');
        return;
      }
      const total = report.reduce((acc, r) => acc + r.size, 0);
      out.appendLine(`[gcAssets] 未引用 ${report.length} 个文件，合计 ${(total / 1024 / 1024).toFixed(2)}MB（只报告，不删除）：`);
      for (const r of report) out.appendLine(`  ${r.rel}  ${(r.size / 1024).toFixed(1)}kB`);
      out.show(true);
      void vscode.window.showInformationMessage(
        `${report.length} 个上传资源没有任何文档引用（合计 ${(total / 1024 / 1024).toFixed(2)}MB），已在输出面板列出，未删除任何文件。`
      );
    }),

    vscode.commands.registerCommand('outlineWiki.configGitIgnore', async () => {
      const states = model.allStates();
      if (states.length === 0) {
        void vscode.window.showWarningMessage('需要先打开一个工作区。');
        return;
      }
      for (const state of states) {
        const { rel, changed } = await state.ensureSelfIgnore();
        out.appendLine(`[gitignore] ${changed ? '已写入' : '已是最新'}：${rel}`);
      }
      const pick = await vscode.window.showInformationMessage(
        `已确保 ${staticRoot(states[0]!.layout)}/.gitignore 是"自忽略"形态：静态资源不进 git，clone 后目录仍存在。`,
        '同时写进仓库根 .gitignore'
      );
      if (pick) {
        for (const state of states) {
          const rootUri = vscode.Uri.joinPath(state.folder, '.gitignore');
          let existing = '';
          try {
            existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(rootUri));
          } catch {
            existing = '';
          }
          const next = appendRuleOnce(existing, state.layout);
          if (next !== existing) {
            await vscode.workspace.fs.writeFile(rootUri, new TextEncoder().encode(next));
            out.appendLine(`[gitignore] 已追加：${staticRoot(state.layout)}/`);
          }
        }
        void vscode.window.showInformationMessage('已更新仓库根 .gitignore。');
      }
    }),

    vscode.commands.registerCommand('outlineWiki.revealDoc', async (arg?: unknown) => {
      const uri = argUri(arg) ?? activeSession()?.documentUri();
      if (uri) await vscode.commands.executeCommand('revealFileInOS', uri);
    }),

    vscode.commands.registerCommand('outlineWiki.openInSystemPlayer', async (arg?: unknown) => {
      const uri = argUri(arg);
      if (!uri) return;
      try {
        await vscode.env.openExternal(uri);
      } catch {
        await vscode.commands.executeCommand('revealFileInOS', uri);
      }
    }),

    vscode.commands.registerCommand('outlineWiki.insertMedia', async () => {
      const session = activeSession();
      if (!session) {
        void vscode.window.showWarningMessage('请先打开一个 Wiki 文档。');
        return;
      }
      const markdown = await pickMedia('video', session);
      if (markdown) session.post({ type: 'insertMarkdown', markdown });
    }),

    vscode.commands.registerCommand('outlineWiki.insertMediaUrl', async () => {
      const session = activeSession();
      if (!session) {
        void vscode.window.showWarningMessage('请先打开一个 Wiki 文档。');
        return;
      }
      const markdown = await pickMediaUrl();
      if (markdown) session.post({ type: 'insertMarkdown', markdown });
    }),

    vscode.commands.registerCommand('outlineWiki.toggleMetadataVisibility', async () => {
      const state = model.allStates()[0];
      if (!state) return;
      const cfg = vscode.workspace.getConfiguration('files', state.folder);
      const current = cfg.get<Record<string, boolean>>('exclude') ?? {};
      const pattern = state.layout.metadataDir;
      const next = { ...current };
      if (next[pattern]) delete next[pattern];
      else next[pattern] = true;
      await cfg.update('exclude', next, vscode.ConfigurationTarget.WorkspaceFolder);
      out.appendLine(`[exclude] ${pattern} -> ${next[pattern] ? '隐藏' : '显示'}`);
    }),

    vscode.commands.registerCommand('outlineWiki.refresh', () => { void sidebar.refresh(); }),

    // Phase 0 探针：渲染 / <base> 相对解析 / Range seek / 二进制 postMessage 一次跑完
    vscode.commands.registerCommand('outlineWiki.runProbe', async () => {
      const session = activeSession();
      if (!session) {
        void vscode.window.showWarningMessage('请先打开一个 Wiki 文档（*.wiki.md）再运行探针。');
        return;
      }
      const { spec, cleanup } = await hooks.prepareProbe(session);
      pendingProbeCleanup.set(session.docRel, cleanup);
      out.appendLine(`[probe] 夹具写入 ${spec.fixtureRel}`);
      session.post({ type: 'runProbe', probe: spec });
      setTimeout(() => session.post({ type: 'binaryEcho', payload: new Uint8Array([1, 2, 3]) }), 2500);
      void vscode.window.showInformationMessage('Phase 0 探针已启动，结果会写入扩展存储目录的 probe-report.json。');
    })
  );

  // 源文件改名/移动 → 文档随迁 + 重算 static 链接（终端 git mv 走 create+delete，文档自然变"未关联"，不丢内容）
  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles(async (event) => {
      let touched = false;
      for (const { oldUri, newUri } of event.files) {
        const state = model.stateFor(newUri) ?? model.stateFor(oldUri);
        if (!state) continue;
        const oldRel = relFromUri(state.folder, oldUri);
        const newRel = relFromUri(state.folder, newUri);
        if (oldRel.endsWith(DOC_SUFFIX) || newRel.endsWith(DOC_SUFFIX)) continue; // 文档自身的移动不代管
        if (model.stateFor(newUri)?.isExcluded(newRel)) continue;
        const outcome = await migrateDocForSourceRename(state, oldRel, newRel, out);
        if (outcome.moved) {
          touched = true;
          out.appendLine(
            `[rename] ${outcome.oldDocRel} → ${outcome.newDocRel}${outcome.rewroteLinks ? '（已重算 static 链接层数）' : ''}`
          );
        } else if (outcome.skipped && outcome.skipped !== 'no-doc' && outcome.skipped !== 'same-path') {
          out.appendLine(`[rename] 跳过 ${oldRel} → ${newRel}：${outcome.skipped}`);
        }
      }
      if (touched) void sidebar.refresh();
    })
  );

  if (vscode.workspace.getConfiguration('outlineWiki').get<boolean>('autoCreateOnOpen')) {    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(async (doc) => {
        if (doc.uri.scheme !== 'file') return;
        const state = model.stateFor(doc.uri);
        if (!state) return;
        const rel = relFromUri(state.folder, doc.uri);
        if (rel.endsWith(DOC_SUFFIX) || state.isExcluded(rel)) return;
        await ensureDoc(state, rel, out, { silent: true });
      })
    );
  }

  out.appendLine('[activate] Outline Wiki 已激活');

  // 开发模式下的自动探针：工作区根放一个 __autoprobe__.json（{"out":"__probe-report.json"}）
  // 就会自动建文档 → 打开编辑器 → 跑 Phase 0 探针 → 把结果写到指定文件。
  // 用于在真实 VS Code 里自动化验证（无需人工点击），正式版不会触发。
  void maybeAutoProbe(context, model, provider, hooks, out, openDocInEditor, ensureDoc, pendingProbeCleanup, sidebar);

  // 供集成测试读取的可观测面（activate 的返回值即扩展 exports）
  return {
    storagePath: (context.storageUri ?? context.globalStorageUri).fsPath,
    activeSessionDocRel: () => activeSession()?.docRel ?? null,
    postToActiveSession: (message: unknown) => {
      const session = activeSession();
      if (!session) return false;
      session.post(message as Parameters<DocSession['post']>[0]);
      return true;
    }
  };
}

export function deactivate(): void {
  /* 没有本地服务需要关闭；其余资源随 context.subscriptions 释放 */
}

/**
 * 开发模式自动探针：方便在真实 VS Code 里无人值守地验证
 * "编辑器是否渲染 / <base> 是否生效 / Range 能否拖动 / 二进制 postMessage"。
 *
 * 触发条件（两个都满足）：ExtensionMode.Development + 工作区根存在 __autoprobe__.json
 * 文件内容形如 { "out": "__probe-report.json", "source": "src/hello.go" }
 */
async function maybeAutoProbe(
  context: vscode.ExtensionContext,
  model: WorkspaceModel,
  provider: WikiDocEditorProvider,
  hooks: MediaHooks,
  out: vscode.OutputChannel,
  openDocInEditor: (uri: vscode.Uri, beside: boolean) => Promise<void>,
  ensure: typeof ensureDoc,
  pendingCleanup: Map<string, () => Promise<void>>,
  sidebar: WikiSidebarProvider
): Promise<void> {
  if (context.extensionMode !== vscode.ExtensionMode.Development) return;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const markerUri = vscode.Uri.joinPath(folder.uri, '__autoprobe__.json');
  let marker: { out?: string; source?: string };
  try {
    marker = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(markerUri))) as {
      out?: string;
      source?: string;
    };
  } catch {
    return; // 没有标记文件就什么也不做
  }
  const outRel = marker.out ?? '__probe-report.json';
  out.appendLine(`[autoprobe] 已触发，报告将写入 ${outRel}`);

  try {
    let sourceRel = marker.source;
    if (!sourceRel) {
      const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*'),
        '**/.metadata/**',
        20
      );
      const candidate = found.find((uri) => !uri.path.endsWith('.json') && !uri.path.endsWith('.md'));
      if (!candidate) throw new Error('工作区里找不到可用的源文件');
      sourceRel = relFromUri(folder.uri, candidate);
    }
    const state = model.stateFor(folder.uri);
    if (!state) throw new Error('找不到工作区状态');

    const docUri = await ensure(state, sourceRel, out);
    // 探针文档里放上公式与 mermaid，让 Phase 4 的渲染检查有据可依
    const docRelForProbe = docRelPathForSource(sourceRel, state.layout);
    const probeContent = [
      '# hello.go',
      '',
      `[源文件：${sourceRel}](${encodeLinkTarget(relPathBetween(docRelForProbe, sourceRel))})`,
      '',
      '行内公式 $E=mc^2$，货币 $5 and $6 不该被当成公式。',
      '',
      '$$',
      '\\int_0^1 x^2 \\, dx',
      '$$',
      '',
      '```mermaid',
      'graph TD',
      '  A[开始] --> B[结束]',
      '```',
      ''
    ].join('\n');
    await vscode.workspace.fs.writeFile(docUri, new TextEncoder().encode(probeContent));
    await openDocInEditor(docUri, false);

    // 等 webview 就绪（收到 ready 并发过 init），再等编辑器挂载完成，
    // 否则探针会跑在 "<base> 已经能用但编辑器还没渲染" 的窗口里，得出假阴性。
    const session = await waitForSession(provider, docUri, 30_000);
    await waitForReady(session, 20_000);
    await sleep(3000);

    const { spec, cleanup } = await hooks.prepareProbe(session);
    pendingCleanup.set(session.docRel, cleanup);

    const resultPromise = new Promise<ProbeResult[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('探针 60s 内没有返回结果')), 60_000);
      const sub = session.onProbeResult((results) => {
        clearTimeout(timer);
        sub.dispose();
        resolve(results);
      });
    });

    // 先发二进制再跑探针：探针要读"最近一次收到的二进制消息类型"
    session.post({ type: 'binaryEcho', payload: new Uint8Array([1, 2, 3]) });
    await sleep(800);
    session.post({ type: 'runProbe', probe: spec });

    const results = await resultPromise;
    results.push(await runLocalVideoImportScenario(state));
    const phase2 = await runPhase2Scenario(folder.uri, state, out);
    const sidebarResults = await runSidebarScenario(sidebar, state, sourceRel);
    const report = {
      at: new Date().toISOString(),
      vscodeVersion: vscode.version,
      docRel: session.docRel,
      fixtureRel: spec.fixtureRel,
      results,
      sidebarResults,
      phase2
    };
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(folder.uri, outRel),
      new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`)
    );
    out.appendLine(`[autoprobe] 报告已写入 ${outRel}`);
    for (const r of results) out.appendLine(`[autoprobe] ${r.ok ? '✓' : '✗'} ${r.name}: ${r.detail.split('\n')[0]}`);
    out.appendLine(`[autoprobe] Phase 2（改名迁移）：${JSON.stringify(phase2)}`);
    await cleanup();
  } catch (err) {
    out.appendLine(`[autoprobe] 失败：${String(err)}`);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(folder.uri, outRel),
      new TextEncoder().encode(`${JSON.stringify({ error: String(err) }, null, 2)}\n`)
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Phase2Result {
  trigger: 'fs.rename' | 'workspaceEdit.renameFile' | 'none';
  docMoved: boolean;
  oldGone: boolean;
  linkRewritten: boolean;
  detail: string;
}

/**
 * Phase 2 真机场景：源文件跨层级改名 → 文档随迁 + static 链接层数重算。
 *
 * 同时探一个未验证点：`workspace.fs.rename` 会不会触发 onDidRenameFiles
 * （若不触发，说明扩展以外的方式改名需要靠 WorkspaceEdit 或用户操作触发）。
 */
async function runPhase2Scenario(
  folder: vscode.Uri,
  state: FolderState,
  out: vscode.OutputChannel
): Promise<Phase2Result> {
  const oldSource = 'src/__rename_probe__.go';
  const newSource = 'deep/nested/__rename_probe__.go';
  const oldDocRel = docRelPathForSource(oldSource, state.layout);
  const newDocRel = docRelPathForSource(newSource, state.layout);
  const oldUri = uriForRel(folder, oldSource);
  const newUri = uriForRel(folder, newSource);
  const oldDocUri = uriForRel(folder, oldDocRel);
  const newDocUri = uriForRel(folder, newDocRel);
  // 文档目录深度 2 -> 指向 .metadata/static 需要两个 ..；移到 deep/nested（深度 4）后应为三个 ..
  const linkBefore = '../../static/upload/2026-01-01/whatever.png';
  const linkAfter = '../../../static/upload/2026-01-01/whatever.png';

  const cleanup = async () => {
    for (const rel of [oldSource, newSource, oldDocRel, newDocRel]) {
      try {
        await vscode.workspace.fs.delete(uriForRel(folder, rel), { useTrash: false });
      } catch {
        /* 忽略 */
      }
    }
    for (const dir of ['src', 'deep/nested', 'deep', '.metadata/docs/src', '.metadata/docs/deep/nested', '.metadata/docs/deep']) {
      try {
        await vscode.workspace.fs.delete(uriForRel(folder, dir), { useTrash: false });
      } catch {
        /* 忽略：目录非空或不存在 */
      }
    }
  };

  try {
    await cleanup();
    await vscode.workspace.fs.createDirectory(uriForRel(folder, 'src'));
    await vscode.workspace.fs.createDirectory(uriForRel(folder, posixDirname(oldDocRel)));
    await vscode.workspace.fs.writeFile(oldUri, new TextEncoder().encode('package main\n'));
    const docText = `# rename probe\n\n![x](${linkBefore})\n`;
    await vscode.workspace.fs.writeFile(oldDocUri, new TextEncoder().encode(docText));

    // 先试 workspace.fs.rename：看它是否触发 onDidRenameFiles
    await vscode.workspace.fs.createDirectory(uriForRel(folder, 'deep/nested'));
    await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
    await sleep(1500);

    let trigger: Phase2Result['trigger'] = (await exists(newDocUri)) ? 'fs.rename' : 'none';
    if (trigger === 'none') {
      // 回退：用 WorkspaceEdit.renameFile（用户/扩展改名的标准路径）
      await vscode.workspace.fs.writeFile(oldUri, new TextEncoder().encode('package main\n'));
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(oldUri, newUri, { overwrite: true });
      await vscode.workspace.applyEdit(edit);
      await sleep(1500);
      if (await exists(newDocUri)) trigger = 'workspaceEdit.renameFile';
    }

    const docMoved = await exists(newDocUri);
    const oldGone = docMoved && !(await exists(oldDocUri));
    let linkRewritten = false;
    let detail = '';
    if (docMoved) {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(newDocUri));
      // 注意用"精确取出链接目标"比较：`../../static/...` 是 `../../../static/...` 的子串，
      // 用 includes 判断会误报"未重算"。
      const href = text.match(/\]\(([^)]+)\)/)?.[1] ?? '';
      linkRewritten = href === linkAfter;
      detail = `文档 ${oldDocRel} → ${newDocRel}；链接 ${linkRewritten ? '已重算' : '未重算'}；内容：${text.replace(/\n/g, '⏎').slice(0, 120)}`;
    } else {
      detail = `文档未随迁：${oldDocRel} 仍在? ${await exists(oldDocUri)}`;
    }
    out.appendLine(`[phase2] trigger=${trigger} moved=${docMoved} oldGone=${oldGone} linkRewritten=${linkRewritten}`);
    return { trigger, docMoved, oldGone, linkRewritten, detail };
  } catch (err) {
    return { trigger: 'none', docMoved: false, oldGone: false, linkRewritten: false, detail: `异常：${String(err)}` };
  } finally {
    await cleanup();
  }
}

async function runLocalVideoImportScenario(state: FolderState): Promise<ProbeResult> {
  // 开发探针替代 OS 选择步骤，后续导入函数与用户选择真实文件走相同路径。
  const fixtureRel = `${staticRoot(state.layout)}/__local_video_probe__/movie.mp4`;
  const fixture = uriForRel(state.folder, fixtureRel);
  const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
  assertWriteAllowed(fixtureRel, 'binary', state.layout);
  await vscode.workspace.fs.createDirectory(uriForRel(state.folder, posixDirname(fixtureRel)));
  await vscode.workspace.fs.writeFile(fixture, bytes);
  try {
    const imported = await importMediaFromDisk(state, 'video', fixture);
    const copied = imported ? await vscode.workspace.fs.readFile(uriForRel(state.folder, imported)) : undefined;
    const same = copied?.byteLength === bytes.byteLength && copied.every((byte, index) => byte === bytes[index]);
    const named = Boolean(imported?.match(/static\/upload\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.mp4$/));
    return { name: 'localVideoFileImport', ok: same && named, detail: `本机文件导入字节一致=${same}，UUID日期路径=${named}；${imported}（探针替代系统选文件步骤，不检查夹具视频解码）` };
  } finally { await vscode.workspace.fs.delete(uriForRel(state.folder, posixDirname(fixtureRel)), { recursive: true, useTrash: true }); }
}

async function runSidebarScenario(sidebar: WikiSidebarProvider, state: FolderState, sourceRel: string): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const source = uriForRel(state.folder, sourceRel);
  const missingRel = 'src/wiki-sidebar-probe.ts';
  const missing = uriForRel(state.folder, missingRel);
  const wiki = uriForRel(state.folder, docRelPathForSource(missingRel, state.layout));
  await vscode.workspace.fs.writeFile(missing, new TextEncoder().encode('// sidebar fixture\n'));
  if (await exists(wiki)) await vscode.workspace.fs.delete(wiki, { useTrash: true });
  await vscode.window.showTextDocument(source, { preview: false });
  await sidebar.show(source);
  await sleep(1500);
  const first = await sidebar.inspect();
  results.push({ name: 'sidebarExistingWiki', ok: first.sourceRel === sourceRel && first.text.length > 0 && !first.overflow, detail: JSON.stringify(first) });
  await vscode.window.showTextDocument(missing, { preview: false });
  await sidebar.refresh();
  await sleep(900);
  const empty = await sidebar.inspect();
  results.push({ name: 'sidebarMissingWiki', ok: empty.canCreate && empty.sourceRel === missingRel && !await exists(wiki), detail: JSON.stringify(empty) });
  await sidebar.inspect(true); // 点击真实 DOM 中的「创建 Wiki」按钮
  await sleep(1200);
  await sidebar.refresh();
  const created = await sidebar.inspect();
  results.push({ name: 'sidebarCreateWiki', ok: !created.canCreate && created.sourceRel === missingRel && await exists(wiki), detail: JSON.stringify(created) });
  const session = sidebar.activeSession();
  if (!session) throw new Error('创建后没有侧栏编辑会话');
  await waitForReady(session, 5000);
  const sentinel = 'sidebar rapid-switch preserved';
  session.post({ type: 'insertMarkdown', markdown: `\n\n${sentinel}\n` });
  await sleep(80); // 小于编辑器的 200ms debounce，检验切换前 flush
  await vscode.window.showTextDocument(source, { preview: false });
  await sidebar.refresh();
  await sleep(900);
  const switched = await sidebar.inspect();
  const saved = new TextDecoder().decode(await vscode.workspace.fs.readFile(wiki));
  results.push({ name: 'sidebarRapidSwitch', ok: saved.includes(sentinel) && switched.sourceRel === sourceRel && !switched.text.includes(sentinel), detail: `原文档已保存=${saved.includes(sentinel)}，当前源文件=${switched.sourceRel}，内容没有串到新文档=${!switched.text.includes(sentinel)}` });
  await vscode.window.showTextDocument(missing, { preview: false });
  await sidebar.refresh();
  await sleep(900);
  const restored = await sidebar.inspect();
  results.push({ name: 'sidebarReturnToWiki', ok: restored.text.includes(sentinel) && restored.sourceRel === missingRel, detail: JSON.stringify(restored) });
  const wikiDocument = await vscode.workspace.openTextDocument(wiki);
  const externalMarker = 'sidebar external-update preserved';
  const externalEdit = new vscode.WorkspaceEdit();
  externalEdit.insert(wiki, new vscode.Position(wikiDocument.lineCount, 0), `\n${externalMarker}\n`);
  await vscode.workspace.applyEdit(externalEdit);
  await wikiDocument.save();
  await sleep(500);
  const external = await sidebar.inspect();
  results.push({ name: 'sidebarExternalUpdate', ok: external.text.includes(externalMarker), detail: '外部 TextDocument 修改同步到侧栏=' + external.text.includes(externalMarker) });
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('workbench.view.explorer');
  await vscode.window.showTextDocument(source, { preview: false });
  await sidebar.show();
  await sleep(900);
  const resumed = await sidebar.inspect();
  results.push({ name: 'sidebarHiddenResume', ok: resumed.sourceRel === sourceRel && !resumed.text.includes(sentinel), detail: '隐藏侧栏后切换源文件，重新点击图标显示当前文件=' + (resumed.sourceRel === sourceRel) });
  await vscode.workspace.fs.delete(missing, { useTrash: true });
  await vscode.workspace.fs.delete(wiki, { useTrash: true });
  return results;
}

function waitForReady(session: DocSession, timeoutMs: number): Promise<void> {
  if (session.isReady()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const sub = session.onReady(() => {
      sub.dispose();
      resolve();
    });
    const tick = () => {
      if (session.isReady()) {
        sub.dispose();
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        sub.dispose();
        resolve();
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

function waitForSession(
  provider: WikiDocEditorProvider,
  docUri: vscode.Uri,
  timeoutMs: number
): Promise<DocSession> {  const deadline = Date.now() + timeoutMs;
  return new Promise<DocSession>((resolve, reject) => {
    const tick = () => {
      const session = provider.sessionFor(docUri);
      if (session) {
        resolve(session);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`等待会话就绪超时：${docUri.toString()}`));
        return;
      }
      setTimeout(tick, 300);
    };
    tick();
  });
}

async function ensureDoc(
  state: FolderState,
  sourceRel: string,
  out: vscode.OutputChannel,
  options: { silent?: boolean } = {}
): Promise<vscode.Uri> {
  const docRel = docRelPathForSource(sourceRel, state.layout);
  assertWriteAllowed(docRel, 'text', state.layout);
  const docUri = uriForRel(state.folder, docRel);
  if (await exists(docUri)) return docUri;

  const name = sourceRel.split('/').pop() ?? sourceRel;
  const template = `# ${name}\n\n`;
  await vscode.workspace.fs.createDirectory(uriForRel(state.folder, posixDirname(docRel)));
  await vscode.workspace.fs.writeFile(docUri, new TextEncoder().encode(template));
  await state.recordDoc(docRel, template, []);
  if (!options.silent) out.appendLine(`[doc] 新建 ${docRel}`);
  return docUri;
}

/**
 * 「插入视频/音频」：优先引用 static/ 里已有的文件（零字节搬运、不改名），
 * 也支持从磁盘导入（走文件系统复制，不经网络，也不受粘贴体积上限约束）。
 */
async function pickMediaFromStatic(
  kind: 'video' | 'audio',
  state: FolderState,
  session: DocSession
): Promise<string | undefined> {
  const candidates = (await state.scanStatic()).filter((rel) => {
    if (!isMediaPath(rel)) return false;
    const k = kindOfPath(rel);
    return kind === 'audio' ? k === 'audio' : k === 'video' || k === 'audio';
  });

  const items: (vscode.QuickPickItem & { rel?: string; action?: 'import' })[] = [];
  if (candidates.length > 0) {
    items.push(
      ...candidates.map((rel) => ({
        label: `$(file-media) ${rel.split('/').pop() ?? rel}`,
        description: rel,
        rel
      })),
      { label: '', kind: vscode.QuickPickItemKind.Separator }
    );
  }
  items.push({
    label: '$(folder-opened) 从磁盘选择并导入到 static/upload/…',
    description: candidates.length === 0 ? `static/ 下还没有媒体文件，先把文件放进 ${staticRoot(state.layout)}/ 或用这里的导入` : undefined,
    action: 'import'
  });

  const pick = await vscode.window.showQuickPick(items, {
    title: kind === 'audio' ? '插入音频' : '插入视频/音频',
    placeHolder: '引用 static/ 里已有的文件（不复制），或从磁盘导入',
    matchOnDescription: true
  });
  if (!pick) return undefined;

  let rel = pick.rel;
  if (!rel) {
    rel = await importMediaFromDisk(state);
    if (!rel) return undefined;
  }

  const href = encodeLinkTarget(relPathBetween(session.docRel, rel));
  return `[${href}](${href})`;
}

async function importMediaFromDisk(state: FolderState, kind?: 'video', probeSelection?: vscode.Uri): Promise<string | undefined> {
  const chosen = probeSelection ? [probeSelection] : await vscode.window.showOpenDialog({
    title: kind === 'video' ? '选择本机视频' : '选择要导入的文件',
    filters: kind === 'video' ? { '视频': ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi'] } : undefined,
    canSelectMany: false,
    defaultUri: state.folder
  });
  const picked = chosen?.[0];
  if (!picked) return undefined;

  if (kind === 'video' && kindOfPath(picked.path) !== 'video') {
    void vscode.window.showErrorMessage('请选择视频文件。');
    return undefined;
  }
  const cfg = vscode.workspace.getConfiguration('outlineWiki', state.folder);
  const allowed = cfg.get<string[]>('static.allowedExtensions') ?? [];
  const warnSizeMB = cfg.get<number>('static.warnSizeMB') ?? 50;
  const originalName = picked.path.split('/').pop() ?? 'file';
  const derived = deriveExt(originalName, undefined, allowed);
  if (!derived.ok) {
    void vscode.window.showErrorMessage(derived.error);
    return undefined;
  }

  let size = 0;
  try {
    size = (await vscode.workspace.fs.stat(picked)).size;
  } catch {
    /* 忽略 */
  }
  if (size > warnSizeMB * 1024 * 1024) {
    const go = await vscode.window.showWarningMessage(
      `文件 ${(size / 1024 / 1024).toFixed(1)}MB 是二进制大文件，导入后会出现在 .metadata/static/ 中（不进 git，走网盘同步）。`,
      { modal: true },
      '导入'
    );
    if (!go) return undefined;
  }

  const bytes = await vscode.workspace.fs.readFile(picked);
  const { rel: dirRel, uri: dirUri } = state.uploadDir(new Date(), 'local');
  await vscode.workspace.fs.createDirectory(dirUri);
  const rel = `${dirRel}/${newAssetName(randomUUID(), derived.ext)}`;
  assertWriteAllowed(rel, 'binary', state.layout);
  await state.ensureSelfIgnore();
  await vscode.workspace.fs.writeFile(uriForRel(state.folder, rel), bytes);
  await state.recordStatic(rel, { originalName, size: bytes.byteLength });
  return rel;
}
