import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { assertWriteAllowed, isUnderWikiRoot } from '../core/path-rules.js';
import { DOC_SUFFIX, keyFromDocRel, relPathBetween, resolveRelativeRef, sourceFromKey } from '../core/paths.js';
import { deriveExt, newAssetName } from '../core/asset-paths.js';
import {
  classifyHref,
  collectStaticRefs,
  decodeLinkTarget,
  encodeLinkTarget
} from '../core/markdown-links.js';
import { removeTemplateBacklink } from '../core/source-backlink.js';
import { titleFromMarkdown } from '../core/index-cache.js';
import {
  HostToWebview,
  ProbeResult,
  ProbeSpec,
  WebviewToHost,
  WebviewConfig,
  ThemeName
} from '../shared/protocol.js';
import { FolderState, WorkspaceModel, exists, relFromUri, uriForRel } from './workspaceModel.js';
import { readWebviewConfig, renderWikiHtml, resolvedTheme } from './webviewHtml.js';

export interface WikiSurface {
  webview: vscode.Webview;
  readonly active?: boolean;
  readonly visible?: boolean;
  onDidDispose: vscode.Event<void>;
}

export const WIKI_VIEW_TYPE = 'outlineWiki.wikiDoc';

export interface MediaHooks {
  /** 「插入视频/音频」：引用 static/ 已有文件或导入；返回要插入的 markdown */
  pickMedia(kind: 'video' | 'audio', session: DocSession): Promise<string | undefined>;
  /** 「插入播放链接」：返回要插入的 markdown */
  prepareVideo(session: DocSession, href: string): Promise<string>;
  pickLocalVideo(session: DocSession): Promise<string | undefined>;
  pickMediaUrl(): Promise<string | undefined>;
  /** 探针夹具：写入 static/__probe__/ 并返回相对链接 */
  prepareProbe(session: DocSession): Promise<{ spec: ProbeSpec; cleanup: () => Promise<void> }>;
  /** 探针结果落盘 */
  saveProbeReport(session: DocSession, results: unknown): Promise<string | undefined>;
}

/**
 * 一篇文档的编辑会话。核心职责是让"磁盘上的 markdown"始终是唯一真源：
 *  - webview 的编辑 → 全量 WorkspaceEdit（Range(0,0,lineCount,0)）
 *  - 自己造成的变更要抑制 echo，否则每次保存都会把光标顶回文首
 *  - 外部变更（git checkout / 网盘 / 其它编辑器）反推送回 webview
 *  - 保存 / 撤销 / hot exit 全部交给 VS Code 原生文本通道
 */
export class DocSession implements vscode.Disposable {
  readonly docRel: string;
  private readonly sessionId = randomUUID();
  private ready = false;
  private messageQueue: Promise<void> = Promise.resolve();
  private pendingFlush?: { resolve: () => void; reject: (error: Error) => void };
  private rev = 0;
  private knownVersion: number;
  private lastSyncedText: string;
  private readonly recentApplied: string[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private conflictPrompting = false;

  private readonly _onProbeResult = new vscode.EventEmitter<ProbeResult[]>();
  /** 探针结果（开发模式下由自动探针消费） */
  readonly onProbeResult = this._onProbeResult.event;
  private readonly _onReady = new vscode.EventEmitter<void>();
  /** webview 已就绪并收到 init */
  readonly onReady = this._onReady.event;

  constructor(
    private readonly model: WorkspaceModel,
    private readonly out: vscode.OutputChannel,
    private readonly extensionUri: vscode.Uri,
    private readonly state: FolderState,
    private readonly document: vscode.TextDocument,
    private readonly panel: WikiSurface,
    private readonly hooks: MediaHooks,
    private readonly autoSave = false
  ) {
    this.docRel = relFromUri(state.folder, document.uri);
    this.knownVersion = document.version;
    this.lastSyncedText = document.getText();
  }

  get folder(): vscode.Uri {
    return this.state.folder;
  }

  start(): void {
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.state.folder,
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'media')
      ]
    };
    this.refreshHtml();

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((raw: unknown) => {
        this.messageQueue = this.messageQueue.then(() => this.onMessage(raw)).catch((err) => {
          this.out.appendLine(`[session] ${String(err)}`);
          this.pendingFlush?.reject(new Error(String(err)));
          this.pendingFlush = undefined;
        });
      }),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChanged(e)),
      this.state.onDidChangeIndex(() => {
        void this.onWorkspaceChanged();
      }),
      vscode.window.onDidChangeActiveColorTheme(() => this.pushTheme()),
      new vscode.Disposable(() => {
        this.disposed = true;
      })
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingFlush?.reject(new Error('Wiki 会话已关闭'));
    this.pendingFlush = undefined;
    for (const d of this.disposables) d.dispose();
    this._onProbeResult.dispose();
    this._onReady.dispose();
  }

  isActive(): boolean {
    return this.panel.active ?? this.panel.visible ?? false;
  }

  /** webview 是否已经就绪（收到 ready 并已发过 init） */
  isReady(): boolean {
    return this.ready;
  }

  messageToken(): string { return this.sessionId; }

  post(message: HostToWebview): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({ ...message, sessionId: this.sessionId });
  }

  /** 切换文档前，等待浏览器同步尚未 debounce 的最后一次输入。 */
  async flushPending(): Promise<void> {
    if (!this.ready) { await this.messageQueue; return; }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFlush = undefined;
        reject(new Error('Wiki 同步超时，请重试切换。'));
      }, 5000);
      this.pendingFlush = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      };
      this.post({ type: 'requestFlush' });
    });
  }

  private config(): WebviewConfig {
    return readWebviewConfig(this.state.folder);
  }

  private theme(): ThemeName {
    return resolvedTheme(this.config().themeSetting);
  }

  refreshHtml(): void {
    this.panel.webview.html = renderWikiHtml({
      webview: this.panel.webview,
      extensionUri: this.extensionUri,
      docUri: this.document.uri,
      theme: this.theme(),
      config: this.config(),
      sessionId: this.sessionId
    });
  }

  private pushTheme(): void {
    if (!this.ready) return;
    this.post({ type: 'theme', theme: this.theme() });
  }

  // ---------------------------------------------------------------- 消息

  private async onMessage(raw: unknown): Promise<void> {
    if (typeof raw !== 'object' || raw === null) return;
    if ((raw as { sessionId?: string }).sessionId !== this.sessionId) return;
    const msg = raw as WebviewToHost;
    if (this.disposed) return;
    switch (msg.type) {
      case 'ready':
        await this.sendInit();
        return;
      case 'edit':
      case 'flush':
        await this.applyFromWebview(String(msg.markdown ?? ''));
        if (this.autoSave && this.document.isDirty) {
          if (!await this.document.save()) throw new Error('Wiki 自动保存失败，请检查文件权限。');
          this.post({ type: 'saved' });
        }
        return;
      case 'flushed':
        this.pendingFlush?.resolve();
        this.pendingFlush = undefined;
        return;
      case 'save':
        if (!await this.document.save()) throw new Error('Wiki 保存失败，请检查文件权限。');
        this.post({ type: 'saved' });
        return;
      case 'openSource': {
        const source = this.sourceUri();
        if (source) await vscode.window.showTextDocument(source, { preview: false });
        return;
      }
      case 'openLink':
        await this.openHref(String(msg.href ?? ''));
        return;
      case 'openExternally':
        await vscode.env.openExternal(vscode.Uri.parse(String(msg.href ?? '')));
        return;
      case 'openInSystemPlayer': {
        const uri = this.resolveHref(String(msg.href ?? ''));
        if (!uri) {
          this.post({ type: 'notice', level: 'warn', message: `无法解析资源地址：${String(msg.href ?? '')}` });
          return;
        }
        try {
          await vscode.env.openExternal(uri);
        } catch {
          await vscode.commands.executeCommand('revealFileInOS', uri);
        }
        return;
      }
      case 'revealFile': {
        const uri = this.resolveHref(String(msg.href ?? ''));
        if (uri) await vscode.commands.executeCommand('revealFileInOS', uri);
        return;
      }
      case 'ingestBytes':
        await this.ingest(msg);
        return;
      case 'requestCompatibleVideo': {
        // 转换不能阻塞文档保存/切换的消息队列。
        void this.hooks.prepareVideo(this, msg.href).then(
          href => this.post({ type: 'compatibleVideoResult', id: msg.id, href }),
          () => this.post({ type: 'compatibleVideoResult', id: msg.id, error: '无法生成兼容播放缓存：请使用外部播放；非 macOS 需要安装 ffmpeg。' })
        );
        return;
      }
      case 'requestLocalVideo': {
        const markdown = await this.hooks.pickLocalVideo(this);
        if (markdown) this.post({ type: 'insertMarkdown', markdown });
        return;
      }
      case 'requestPickMedia': {
        const markdown = await this.hooks.pickMedia(msg.kind === 'audio' ? 'audio' : 'video', this);
        if (markdown) this.post({ type: 'insertMarkdown', markdown });
        return;
      }
      case 'requestMediaUrl': {
        const markdown = await this.hooks.pickMediaUrl();
        if (markdown) this.post({ type: 'insertMarkdown', markdown });
        return;
      }
      case 'probeResult': {
        this._onProbeResult.fire(msg.results);
        const where = await this.hooks.saveProbeReport(this, msg.results);
        this.out.appendLine(`[probe] 结果：${JSON.stringify(msg.results, null, 2)}`);
        if (where) {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(where));
          await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
          void vscode.window.showInformationMessage(`Phase 0 探针已写入 ${where}`);
        }
        return;
      }
      case 'probeBinary': {
        // webview → host 的二进制探针（宿主侧只看类型，结果由日志记录）
        const p = msg.payload as unknown;
        const isBinary = p instanceof Uint8Array || (ArrayBuffer.isView(p) && (p as Uint8Array).BYTES_PER_ELEMENT === 1);
        this.out.appendLine(`[probe] webview→host 二进制 postMessage: ${
          isBinary ? `Uint8Array(${(p as Uint8Array).length})` : `非二进制（${typeof p}）`
        }`);
        return;
      }
      case 'log':
        this.out.appendLine(`[webview:${msg.level}] ${msg.message}`);
        return;
      default:
        return;
    }
  }

  private async sendInit(): Promise<void> {
    const original = this.document.getText();
    const markdown = removeTemplateBacklink(original, this.docRel, this.sourceRel());
    if (markdown !== original) {
      await this.applyFromWebview(markdown);
      if (!await this.document.save()) throw new Error('旧模板回链迁移保存失败');
    }
    this.lastSyncedText = markdown;
    this.knownVersion = this.document.version;

    const refs = collectStaticRefs(markdown, this.docRel, this.state.layout);
    const missingRefs: string[] = [];
    for (const rel of refs) {
      if (!(await exists(uriForRel(this.state.folder, rel)))) missingRefs.push(rel);
    }

    const sourceRel = this.sourceRel();
    this.ready = true;
    this._onReady.fire();
    this.post({
      type: 'init',
      rev: ++this.rev,
      markdown,
      docRel: this.docRel,
      docTitle: titleFromMarkdown(markdown) ?? this.docRel.split('/').pop()?.replace(DOC_SUFFIX, '') ?? 'Wiki',
      sourceRel,
      theme: this.theme(),
      config: this.config(),
      missingRefs
    });

    await this.state.recordDoc(this.docRel, markdown, refs);
    if (missingRefs.length > 0) {
      this.out.appendLine(`[refs] ${this.docRel}：${missingRefs.length} 个引用在磁盘上不存在（网盘未同步？）`);
    }
  }

  sourceRel(): string | null {
    const key = keyFromDocRel(this.docRel, this.state.layout);
    return key === null ? null : sourceFromKey(key);
  }

  documentUri(): vscode.Uri {
    return this.document.uri;
  }

  /** 相对链接 / 绝对 URL → 工作区内的 Uri */
  private resolveHref(href: string): vscode.Uri | null {
    const kind = classifyHref(href);
    if (kind === 'protocol') {
      try {
        return vscode.Uri.parse(href);
      } catch {
        return null;
      }
    }
    if (kind !== 'relative') return null;
    const rel = resolveRelativeRef(this.docRel, decodeLinkTarget(href));
    return rel === null ? null : uriForRel(this.state.folder, rel);
  }

  sourceUri(): vscode.Uri | null {
    const rel = this.sourceRel();
    return rel === null ? null : uriForRel(this.state.folder, rel);
  }

  // ---------------------------------------------------------------- 同步

  private onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    if (e.document.uri.toString() !== this.document.uri.toString()) return;
    const text = this.document.getText();

    // 自己的 echo：applyEdit 也会触发本事件，必须消费掉
    if (text === this.lastSyncedText || this.recentApplied.includes(text)) {
      this.knownVersion = e.document.version;
      return;
    }

    this.knownVersion = e.document.version;
    this.lastSyncedText = text;
    if (!this.ready) return;
    this.post({ type: 'externalUpdate', rev: ++this.rev, markdown: text });
  }

  private async applyFromWebview(markdown: string): Promise<void> {
    if (markdown === this.document.getText()) {
      this.knownVersion = this.document.version;
      return;
    }
    if (this.document.version !== this.knownVersion) {
      await this.resolveConflict(markdown);
      return;
    }
    await this.applyText(markdown);
  }

  private async applyText(markdown: string): Promise<void> {
    this.lastSyncedText = markdown;
    this.recentApplied.push(markdown);
    if (this.recentApplied.length > 8) this.recentApplied.shift();

    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, new vscode.Range(0, 0, this.document.lineCount, 0), markdown);
    const ok = await vscode.workspace.applyEdit(edit);
    if (ok) {
      this.knownVersion = this.document.version;
    } else {
      this.out.appendLine('[sync] applyEdit 返回 false，文档未更新');
      this.post({ type: 'notice', level: 'error', message: '写入文档失败，请检查文件权限。' });
      throw new Error('Wiki 文本同步失败');
    }
  }

  /** 全量替换是 last-writer-wins，applyEdit 没有任何并发控制，冲突必须自己判 */
  private async resolveConflict(incoming: string): Promise<void> {
    if (this.conflictPrompting) {
      // 已经有弹窗在等用户选择：这次编辑先丢掉并让 webview 回到磁盘内容，避免静默覆盖
      const text = this.document.getText();
      this.lastSyncedText = text;
      this.post({ type: 'externalUpdate', rev: ++this.rev, markdown: text });
      this.post({ type: 'notice', level: 'warn', message: '文档在被外部修改，刚才的一次编辑已被丢弃并重新同步。' });
      return;
    }
    this.conflictPrompting = true;
    try {
      const pick = await vscode.window.showWarningMessage(
        `Wiki 文档「${this.docRel}」被外部修改（git checkout / 网盘同步 / 其它编辑器），与你刚做的编辑冲突。`,
        '保留我的改动',
        '重新加载磁盘内容'
      );
      if (pick === '保留我的改动') {
        await this.applyText(incoming);
      } else {
        const text = this.document.getText();
        this.lastSyncedText = text;
        this.knownVersion = this.document.version;
        this.post({ type: 'externalUpdate', rev: ++this.rev, markdown: text });
      }
    } finally {
      this.conflictPrompting = false;
    }
  }

  private async onWorkspaceChanged(): Promise<void> {
    // 文档 dirty 时 VS Code 不会自动重载，这里只提醒，不擅自覆盖
    try {
      const bytes = await vscode.workspace.fs.readFile(this.document.uri);
      const disk = new TextDecoder().decode(bytes);
      if (disk !== this.document.getText() && this.document.isDirty) {
        this.post({
          type: 'notice',
          level: 'warn',
          message: '磁盘上的文档已被外部修改；保存会覆盖外部内容。'
        });
      }
    } catch {
      /* 文件被删等情况忽略 */
    }
  }

  // ---------------------------------------------------------------- 打开链接

  private async openHref(href: string): Promise<void> {
    const kind = classifyHref(href);
    if (kind === 'protocol') {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    if (kind !== 'relative') return;

    const rel = resolveRelativeRef(this.docRel, decodeLinkTarget(href));
    if (rel === null) {
      void vscode.window.showWarningMessage(`链接超出工作区范围：${href}`);
      return;
    }
    const uri = uriForRel(this.state.folder, rel);

    if (rel.endsWith(DOC_SUFFIX) && isUnderWikiRoot(rel, this.state.layout)) {
      await vscode.commands.executeCommand('vscode.openWith', uri, WIKI_VIEW_TYPE, vscode.ViewColumn.Beside);
      return;
    }
    if (await exists(uri)) {
      await vscode.commands.executeCommand('vscode.open', uri);
      return;
    }
    const pick = await vscode.window.showWarningMessage(
      `找不到 ${rel}（可能尚未从网盘同步）`,
      '检查资源引用',
      '在访达中显示'
    );
    if (pick === '检查资源引用') await vscode.commands.executeCommand('outlineWiki.verifyRefs');
    if (pick === '在访达中显示') await vscode.commands.executeCommand('revealFileInOS', uri);
  }

  // ---------------------------------------------------------------- 入库

  private async ingest(msg: {
    id: string;
    name?: string;
    mime: string;
    dataBase64: string;
  }): Promise<void> {
    const cfg = this.config();
    const derived = deriveExt(msg.name, msg.mime, cfg.allowedExtensions);
    if (!derived.ok) {
      this.post({ type: 'ingestResult', id: msg.id, ok: false, error: derived.error });
      return;
    }

    const bytes = Buffer.from(msg.dataBase64, 'base64');
    const maxBytes = Math.max(1, cfg.maxInlineUploadMB) * 1024 * 1024;
    if (bytes.byteLength > maxBytes) {
      this.post({
        type: 'ingestResult',
        id: msg.id,
        ok: false,
        error: `文件 ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB 超过上限 ${cfg.maxInlineUploadMB}MB。大文件请放进 .metadata/static/ 后用「插入视频/音频」引用。`
      });
      return;
    }

    const tzCfg = vscode.workspace
      .getConfiguration('outlineWiki', this.state.folder)
      .get<'local' | 'utc'>('static.dateTimezone');
    const { rel: dirRel, uri: dirUri } = this.state.uploadDir(new Date(), tzCfg === 'utc' ? 'utc' : 'local');
    await vscode.workspace.fs.createDirectory(dirUri);

    // UUID 命名；碰撞兜底（概率可忽略，但绝不允许覆盖已有文件）
    let name = newAssetName(randomUUID(), derived.ext);
    for (let i = 0; i < 999; i++) {
      const candidate = `${dirRel}/${name}`;
      if (!(await exists(uriForRel(this.state.folder, candidate)))) break;
      name = newAssetName(randomUUID(), derived.ext);
    }
    const staticRel = `${dirRel}/${name}`;

    // 目录职责不变量：二进制只能落在 static/ 下
    assertWriteAllowed(staticRel, 'binary', this.state.layout);

    try {
      await this.state.ensureSelfIgnore();
      await vscode.workspace.fs.writeFile(uriForRel(this.state.folder, staticRel), bytes);
    } catch (err) {
      this.post({ type: 'ingestResult', id: msg.id, ok: false, error: `写入失败：${String(err)}` });
      return;
    }

    await this.state.recordStatic(staticRel, {
      originalName: msg.name,
      mime: msg.mime,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex')
    });

    const href = encodeLinkTarget(relPathBetween(this.docRel, staticRel));
    this.post({
      type: 'ingestResult',
      id: msg.id,
      ok: true,
      url: href,
      relPath: href,
      originalName: msg.name
    });
  }
}

export class WikiDocEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
  private readonly sessions = new Map<string, DocSession>();

  constructor(
    private readonly model: WorkspaceModel,
    private readonly out: vscode.OutputChannel,
    private readonly extensionUri: vscode.Uri,
    private readonly hooks: MediaHooks
  ) {}

  dispose(): void {
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
  }

  sessionFor(uri: vscode.Uri): DocSession | undefined {
    return this.sessions.get(uri.toString());
  }

  activeSession(): DocSession | undefined {
    const all = [...this.sessions.values()];
    return all.find((s) => s.isActive()) ?? all[all.length - 1];
  }

  sessionsIn(folder: vscode.Uri): DocSession[] {
    return [...this.sessions.values()].filter((s) => s.folder.toString() === folder.toString());
  }

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    const state = this.model.stateFor(document.uri);
    if (!state) {
      void vscode.window.showErrorMessage('Wiki 文档必须位于工作区内。');
      void vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
      return;
    }
    // 一个资源一个文档模型，但仍可能被多次 resolve（隐藏后重建），旧会话必须先释放
    this.sessions.get(document.uri.toString())?.dispose();
    const session = new DocSession(this.model, this.out, this.extensionUri, state, document, panel, this.hooks);
    this.sessions.set(document.uri.toString(), session);
    panel.onDidDispose(() => {
      if (this.sessions.get(document.uri.toString()) === session) {
        this.sessions.delete(document.uri.toString());
      }
      session.dispose();
    });
    session.start();
  }
}
