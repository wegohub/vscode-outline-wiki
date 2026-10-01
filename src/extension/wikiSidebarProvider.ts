import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { WebviewToHost } from '../shared/protocol.js';
import { isUnderWikiRoot } from '../core/path-rules.js';
import { docRelPathForSource } from '../core/paths.js';
import { DocSession, MediaHooks } from './docEditorProvider.js';
import { WorkspaceModel, FolderState, exists, relFromUri, uriForRel } from './workspaceModel.js';
import { readWebviewConfig, renderWikiHtml, resolvedTheme } from './webviewHtml.js';

export const WIKI_SIDEBAR_ID = 'outlineWiki.currentFile';

/** 一个可停靠的文件 Wiki；沿用原有 TextDocument、资源入库和冲突处理。 */
export class WikiSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private session?: DocSession;
  private target?: vscode.Uri;
  private rendered?: string;
  private emptySessionId?: string;
  private source?: { state: FolderState; rel: string };
  private empty = { type: 'empty' as const, sourceRel: null as string | null, reason: '选择工作区中的源文件，查看对应的 Wiki。', canCreate: false };
  private queue: Promise<void> = Promise.resolve();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly model: WorkspaceModel,
    private readonly out: vscode.OutputChannel,
    private readonly extensionUri: vscode.Uri,
    private readonly hooks: MediaHooks,
    private readonly ensureDoc: (state: FolderState, rel: string) => Promise<vscode.Uri>
  ) {
    this.target = vscode.window.activeTextEditor?.document.uri;
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        // 点击 webview 时 activeTextEditor 可能为空；继续显示刚才的源文件。
        if (!editor) return;
        this.target = editor.document.uri;
        this.refresh();
      }),
      model.onDidChange(() => this.refresh())
    );
  }

  /** 开发宿主自动探针读取真实 DOM，而不只断言宿主状态。 */
  async inspect(create = false): Promise<Extract<WebviewToHost, { type: 'viewSnapshot' }>> {
    const view = this.view;
    if (!view) throw new Error('侧栏尚未创建');
    const id = String(Date.now());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { subscription.dispose(); reject(new Error('侧栏 DOM 探针超时')); }, 5000);
      const subscription = view.webview.onDidReceiveMessage(message => {
        if (message?.type !== 'viewSnapshot' || message.id !== id) return;
        clearTimeout(timer); subscription.dispose(); resolve(message);
      });
      void view.webview.postMessage({ type: 'inspectView', id, create, sessionId: this.session?.messageToken() ?? this.emptySessionId });
    });
  }

  isVisible(): boolean { return Boolean(this.view?.visible); }

  activeSession(): DocSession | undefined { return this.view?.visible ? this.session : undefined; }

  async show(uri?: vscode.Uri): Promise<void> {
    if (uri) this.target = uri;
    await vscode.commands.executeCommand(`${WIKI_SIDEBAR_ID}.focus`);
    await this.refresh();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.rendered = undefined;
    this.subscriptions.push(
      view.webview.onDidReceiveMessage(async message => {
        if (message?.type === 'ready' && !this.session && message.sessionId === this.emptySessionId) await view.webview.postMessage({ ...this.empty, sessionId: this.emptySessionId });
        if (message?.type === 'createWiki' && !this.session && message.sessionId === this.emptySessionId) {
          const source = this.source;
          if (!source) return;
          try {
            await this.ensureDoc(source.state, source.rel);
            await this.refresh();
          } catch (error) { void vscode.window.showErrorMessage(`创建 Wiki 失败：${String(error)}`); }
        }

      }),
      view.onDidChangeVisibility(() => { if (view.visible) this.refresh(); }),
      view.onDidDispose(() => {
        this.session?.dispose();
        this.session = undefined;
        this.view = undefined;
        this.rendered = undefined;
      })
    );
    this.refresh();
  }

  refresh(): Promise<void> {
    this.queue = this.queue.then(() => this.update()).catch(error => {
      this.out.appendLine(`[sidebar] ${String(error)}`);
      void vscode.window.showErrorMessage(`Wiki 切换失败：${String(error)}`);
    });
    return this.queue;
  }

  private async update(): Promise<void> {
    const view = this.view;
    if (!view?.visible) return;
    const uri = this.target;
    const state = uri ? this.model.stateFor(uri) : undefined;
    const rel = state && uri ? relFromUri(state.folder, uri) : undefined;
    let docUri: vscode.Uri | undefined;
    let source: { state: FolderState; rel: string } | undefined;
    let reason = '选择工作区中的源文件，查看对应的 Wiki。';
    if (state && rel !== undefined) {
      if (isUnderWikiRoot(rel, state.layout)) {
        if (rel.endsWith('.wiki.md')) docUri = uri;
        else reason = '请选择源文件，而不是 Wiki 资源文件。';
      } else if (state.isExcluded(rel)) reason = '这个文件已被 Wiki 排除规则忽略。';
      else {
        source = { state, rel };
        const candidate = uriForRel(state.folder, docRelPathForSource(rel, state.layout));
        if (await exists(candidate)) docUri = candidate;
        else reason = '还没有 Wiki，创建后即可记录说明与想法。';
      }
    } else if (uri) reason = '这个文件不在当前工作区中。';
    const key = docUri?.toString() ?? `empty:${uri?.toString() ?? ''}:${reason}`;
    if (key === this.rendered) return;
    // 先 flush 再销毁旧会话；新会话不能收到旧文档的最后一次输入。
    await this.session?.flushPending();
    if (this.view !== view) return;
    this.session?.dispose();
    this.session = undefined;
    this.source = source;
    this.rendered = key;
    if (docUri && state) {
      const document = await vscode.workspace.openTextDocument(docUri);
      this.session = new DocSession(this.model, this.out, this.extensionUri, state, document, view, this.hooks, true);
      this.session.start();
    } else {
      this.emptySessionId = randomUUID();
      this.empty = { type: 'empty', sourceRel: source?.rel ?? rel ?? null, reason, canCreate: Boolean(source) };
      const folder = state?.folder ?? this.extensionUri;
      const config = readWebviewConfig(folder);
      view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
      view.webview.html = renderWikiHtml({ webview: view.webview, extensionUri: this.extensionUri,
        docUri: uri ?? this.extensionUri, theme: resolvedTheme(config.themeSetting), config, sessionId: this.emptySessionId });
    }
  }

  dispose(): void {
    this.session?.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
