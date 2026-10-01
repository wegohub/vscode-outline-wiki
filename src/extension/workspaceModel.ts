import * as vscode from 'vscode';
import {
  DEFAULT_LAYOUT,
  Layout,
  assertWriteAllowed,
  docsRoot,
  indexRelPath,
  metadataRoot,
  normalizeLayout,
  normalizeRel,
  staticGitignoreRelPath,
  staticRoot
} from '../core/path-rules.js';
import { DOC_SUFFIX, docRelPathForSource, keyFromDocRel, sourceFromKey } from '../core/paths.js';
import {
  WikiIndex,
  emptyIndex,
  parseIndex,
  reconcileIndex,
  removeDoc,
  serializeIndex,
  titleFromMarkdown,
  upsertDoc,
  upsertStatic
} from '../core/index-cache.js';
import { buildSelfIgnoreContent, isSelfIgnoreUpToDate } from '../core/gitignore.js';
import { uploadDirRel } from '../core/asset-paths.js';

export function toPosix(p: string): string {
  return normalizeRel(p.replace(/\\/g, '/'));
}

/** 把工作区相对路径拆成 Uri.joinPath 的分段 */
export function uriForRel(base: vscode.Uri, rel: string): vscode.Uri {
  return vscode.Uri.joinPath(base, ...normalizeRel(rel).split('/'));
}

export function relFromUri(folder: vscode.Uri, uri: vscode.Uri): string {
  const rel = vscode.workspace.asRelativePath(uri, false);
  return toPosix(rel);
}

export interface DocEntry {
  docRel: string;
  sourceRel: string | null;
  title: string | undefined;
  /** 源文件当前是否存在（不存在 = 未关联/孤儿） */
  sourceExists: boolean;
  staticRefs: string[];
}

/**
 * 一个工作区文件夹的元数据状态：布局、索引缓存、文档清单。
 * 索引只是缓存（可删可重建），任何损坏都不允许阻塞打开文档。
 */
export class FolderState implements vscode.Disposable {
  readonly layout: Layout;
  readonly docsUri: vscode.Uri;
  readonly staticUri: vscode.Uri;
  readonly indexUri: vscode.Uri;
  readonly metadataUri: vscode.Uri;

  private index: WikiIndex = emptyIndex();
  private indexLoaded = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidChangeIndex = new vscode.EventEmitter<void>();
  readonly onDidChangeIndex = this._onDidChangeIndex.event;

  constructor(
    readonly folder: vscode.Uri,
    private readonly out: vscode.OutputChannel
  ) {
    this.layout = readLayout(folder);
    this.metadataUri = uriForRel(folder, metadataRoot(this.layout));
    this.docsUri = uriForRel(folder, docsRoot(this.layout));
    this.staticUri = uriForRel(folder, staticRoot(this.layout));
    this.indexUri = uriForRel(folder, indexRelPath(this.layout));

    // .metadata/** 的外部改动：git checkout、网盘同步、用户手工编辑都会走这里
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, `${metadataRoot(this.layout)}/**`)
    );
    let timer: NodeJS.Timeout | undefined;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        this._onDidChangeIndex.fire();
      }, 400);
    };
    this.disposables.push(
      watcher,
      watcher.onDidCreate(schedule),
      watcher.onDidChange(schedule),
      watcher.onDidDelete(schedule),
      new vscode.Disposable(() => timer && clearTimeout(timer))
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this._onDidChangeIndex.dispose();
  }

  sourceUriFor(docRel: string): vscode.Uri | null {
    const key = keyFromDocRel(docRel, this.layout);
    if (key === null) return null;
    const sourceRel = sourceFromKey(key);
    return sourceRel === null ? null : uriForRel(this.folder, sourceRel);
  }

  docUriFor(sourceRel: string): vscode.Uri {
    return uriForRel(this.folder, docRelPathForSource(sourceRel, this.layout));
  }

  /** 该源文件是否被排除（配置的 excludeGlobs + 元数据自身） */
  isExcluded(sourceRel: string): boolean {
    const patterns = vscode.workspace.getConfiguration('outlineWiki', this.folder).get<string[]>('excludeGlobs') ?? [];
    if (sourceRel.startsWith(`${metadataRoot(this.layout)}/`)) return true;
    const anyMatch = (pattern: string) => {
      // 用 VS Code 自己的 glob 匹配能力，避免自己实现一套
      return globMatch(sourceRel, pattern);
    };
    return patterns.some(anyMatch);
  }

  async readIndex(): Promise<WikiIndex> {
    if (!this.indexLoaded) {
      try {
        const bytes = await vscode.workspace.fs.readFile(this.indexUri);
        this.index = parseIndex(new TextDecoder().decode(bytes));
      } catch {
        this.index = emptyIndex();
      }
      this.indexLoaded = true;
    }
    return this.index;
  }

  /** 串行化写入 + 原子替换（临时文件 → rename），失败只记日志，不打扰用户 */
  async mutateIndex(fn: (idx: WikiIndex) => WikiIndex): Promise<void> {
    const run = async () => {
      const current = await this.readIndex();
      const next = fn(current);
      this.index = next;
      const text = serializeIndex(next);
      assertWriteAllowed(indexRelPath(this.layout), 'text', this.layout);
      try {
        await vscode.workspace.fs.createDirectory(this.metadataUri);
        const tmp = uriForRel(this.folder, `${indexRelPath(this.layout)}.tmp`);
        await vscode.workspace.fs.writeFile(tmp, new TextEncoder().encode(text));
        await vscode.workspace.fs.rename(tmp, this.indexUri, { overwrite: true });
      } catch (err) {
        this.out.appendLine(`[index] 写入失败：${String(err)}`);
      }
      this._onDidChangeIndex.fire();
    };
    this.writeQueue = this.writeQueue.then(run, run);
    return this.writeQueue;
  }

  async recordDoc(docRel: string, markdown: string, staticRefs: string[]): Promise<void> {
    const title = titleFromMarkdown(markdown);
    await this.mutateIndex((idx) => {
      const prev = idx.docs[docRel];
      const now = new Date().toISOString();
      return upsertDoc(idx, docRel, {
        title,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
        staticRefs
      });
    });
  }

  async recordStatic(staticRel: string, meta: { originalName?: string; mime?: string; size?: number; sha256?: string }): Promise<void> {
    await this.mutateIndex((idx) => upsertStatic(idx, staticRel, { ...meta, insertedAt: new Date().toISOString() }));
  }

  /** 文档迁移后清掉旧条目（索引只是缓存，丢了也能重建） */
  async forgetDoc(docRel: string): Promise<void> {
    await this.mutateIndex((idx) => removeDoc(idx, docRel));
  }

  /** 扫描磁盘，返回文档清单（索引缺失也能工作） */
  async scanDocs(): Promise<string[]> {
    return this.walk(this.docsUri, (rel) => rel.endsWith(DOC_SUFFIX));
  }

  async scanStatic(): Promise<string[]> {
    return this.walk(this.staticUri, () => true);
  }

  private async walk(root: vscode.Uri, keep: (rel: string) => boolean): Promise<string[]> {
    const out: string[] = [];
    const rootRel = relFromUri(this.folder, root);
    const visit = async (dir: vscode.Uri, depth: number): Promise<void> => {
      if (depth > 40) return;
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(dir);
      } catch {
        return;
      }
      await Promise.all(
        entries.map(async ([name, type]) => {
          const child = vscode.Uri.joinPath(dir, name);
          const rel = relFromUri(this.folder, child);
          if (type & vscode.FileType.Directory) {
            if (type & vscode.FileType.SymbolicLink) return; // 防环
            await visit(child, depth + 1);
            return;
          }
          if (keep(rel.slice(rootRel.length + 1))) out.push(rel);
        })
      );
    };
    await visit(root, 0);
    return out.sort();
  }

  /** 与磁盘对齐索引：保留已知 meta，丢弃消失条目 */
  async reconcile(): Promise<{ docs: string[]; statics: string[] }> {
    const [docs, statics] = await Promise.all([this.scanDocs(), this.scanStatic()]);
    await this.mutateIndex((idx) => reconcileIndex(idx, docs, statics));
    return { docs, statics };
  }

  async entries(): Promise<DocEntry[]> {
    const idx = await this.readIndex();
    const docs = await this.scanDocs();
    const entries: DocEntry[] = [];
    for (const docRel of docs) {
      const key = keyFromDocRel(docRel, this.layout);
      if (key === null) continue;
      const sourceRel = sourceFromKey(key);
      entries.push({
        docRel,
        sourceRel,
        title: idx.docs[docRel]?.title,
        sourceExists: sourceRel === null ? true : await exists(uriForRel(this.folder, sourceRel)),
        staticRefs: idx.docs[docRel]?.staticRefs ?? []
      });
    }
    return entries;
  }

  uploadDir(now: Date, tz: 'local' | 'utc'): { rel: string; uri: vscode.Uri } {
    const rel = uploadDirRel(now, this.layout, tz);
    return { rel, uri: uriForRel(this.folder, rel) };
  }

  /** 保证 static/.gitignore 存在且是自忽略形态（clone 后目录即存在） */
  async ensureSelfIgnore(): Promise<{ changed: boolean; rel: string }> {
    const rel = staticGitignoreRelPath(this.layout);
    assertWriteAllowed(rel, 'text', this.layout);
    const uri = uriForRel(this.folder, rel);
    let existing: string | null = null;
    try {
      existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      existing = null;
    }
    if (isSelfIgnoreUpToDate(existing)) return { changed: false, rel };
    await vscode.workspace.fs.createDirectory(this.staticUri);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(buildSelfIgnoreContent()));
    return { changed: true, rel };
  }
}

export function readLayout(folder: vscode.Uri): Layout {
  const cfg = vscode.workspace.getConfiguration('outlineWiki', folder);
  return normalizeLayout({
    metadataDir: cfg.get<string>('metadataDir') ?? DEFAULT_LAYOUT.metadataDir,
    docsDir: cfg.get<string>('docsDir') ?? DEFAULT_LAYOUT.docsDir,
    staticDir: cfg.get<string>('staticDir') ?? DEFAULT_LAYOUT.staticDir
  });
}

export async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** 工作区文件夹级别的状态缓存 */
export class WorkspaceModel implements vscode.Disposable {
  private readonly states = new Map<string, FolderState>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly out: vscode.OutputChannel) {}

  dispose(): void {
    for (const s of this.states.values()) s.dispose();
    this.states.clear();
    this._onDidChange.dispose();
  }

  stateFor(uri: vscode.Uri): FolderState | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return undefined;
    const key = folder.uri.toString();
    let state = this.states.get(key);
    if (!state) {
      state = new FolderState(folder.uri, this.out);
      state.onDidChangeIndex(() => this._onDidChange.fire());
      this.states.set(key, state);
    }
    return state;
  }

  allStates(): FolderState[] {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      this.stateFor(folder.uri);
    }
    return [...this.states.values()];
  }
}

/** 极简 glob 匹配：支持 `**`、`*`、`?`，够用于 excludeGlobs 默认值 */
export function globMatch(path: string, pattern: string): boolean {
  const re = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '(?:.*/)?')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')}$`
  );
  return re.test(path);
}

export function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
