/**
 * `.metadata/index.json`：唯一目的记下"磁盘推导不出的信息"并随 git 走 ——
 * 标题、时间、以及每篇文档引用了哪些静态资源（因为 static/ 不进 git，
 * 这份清单是 git 里唯一能看出"该同步哪些资源"的地方）。
 *
 * 它是缓存：损坏/版本不符/合并冲突时可以直接删掉，靠 rebuildIndex 重建，不丢内容。
 */

import { normalizeRel } from './path-rules.js';

export const INDEX_VERSION = 1;

export interface DocMeta {
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  /** 文档引用到的 static/ 资源（工作区相对路径） */
  staticRefs?: string[];
}

export interface StaticMeta {
  /** 入库时的原始文件名（UUID 命名后靠它恢复可读性） */
  originalName?: string;
  mime?: string;
  size?: number;
  sha256?: string;
  insertedAt?: string;
}

export interface WikiIndex {
  version: number;
  docs: Record<string, DocMeta>;
  static: Record<string, StaticMeta>;
}

export function emptyIndex(): WikiIndex {
  return { version: INDEX_VERSION, docs: {}, static: {} };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pickDocMeta(v: unknown): DocMeta {
  if (!isRecord(v)) return {};
  const meta: DocMeta = {};
  if (typeof v.title === 'string') meta.title = v.title;
  if (typeof v.createdAt === 'string') meta.createdAt = v.createdAt;
  if (typeof v.updatedAt === 'string') meta.updatedAt = v.updatedAt;
  if (Array.isArray(v.staticRefs)) {
    meta.staticRefs = v.staticRefs.filter((s): s is string => typeof s === 'string').map(normalizeRel);
  }
  return meta;
}

function pickStaticMeta(v: unknown): StaticMeta {
  if (!isRecord(v)) return {};
  const meta: StaticMeta = {};
  if (typeof v.originalName === 'string') meta.originalName = v.originalName;
  if (typeof v.mime === 'string') meta.mime = v.mime;
  if (typeof v.size === 'number' && Number.isFinite(v.size)) meta.size = v.size;
  if (typeof v.sha256 === 'string') meta.sha256 = v.sha256;
  if (typeof v.insertedAt === 'string') meta.insertedAt = v.insertedAt;
  return meta;
}

/** 容错解析：任何异常都退回空索引，绝不阻塞打开文档 */
export function parseIndex(text: string | null | undefined): WikiIndex {
  if (!text) return emptyIndex();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return emptyIndex();
  }
  if (!isRecord(data) || data.version !== INDEX_VERSION) return emptyIndex();
  const idx = emptyIndex();
  if (isRecord(data.docs)) {
    for (const [k, v] of Object.entries(data.docs)) {
      const key = normalizeRel(k);
      if (key.length > 0) idx.docs[key] = pickDocMeta(v);
    }
  }
  if (isRecord(data.static)) {
    for (const [k, v] of Object.entries(data.static)) {
      const key = normalizeRel(k);
      if (key.length > 0) idx.static[key] = pickStaticMeta(v);
    }
  }
  return idx;
}

/** 键排序 + 2 空格缩进 + 结尾换行：尽量让 git 合并少冲突、diff 可读 */
export function serializeIndex(idx: WikiIndex): string {
  const sortRecord = <T>(rec: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const key of Object.keys(rec).sort()) {
      const value = rec[key];
      if (value !== undefined) out[key] = value;
    }
    return out;
  };
  return `${JSON.stringify(
    { version: INDEX_VERSION, docs: sortRecord(idx.docs), static: sortRecord(idx.static) },
    null,
    2
  )}\n`;
}

export function upsertDoc(idx: WikiIndex, docRel: string, meta: DocMeta): WikiIndex {
  const key = normalizeRel(docRel);
  const prev = idx.docs[key] ?? {};
  const next: DocMeta = { ...prev, ...meta };
  if (meta.staticRefs) next.staticRefs = [...new Set(meta.staticRefs.map(normalizeRel))].sort();
  return { ...idx, docs: { ...idx.docs, [key]: next } };
}

export function upsertStatic(idx: WikiIndex, rel: string, meta: StaticMeta): WikiIndex {
  const key = normalizeRel(rel);
  return { ...idx, static: { ...idx.static, [key]: { ...(idx.static[key] ?? {}), ...meta } } };
}

export function removeDoc(idx: WikiIndex, docRel: string): WikiIndex {
  const key = normalizeRel(docRel);
  if (!(key in idx.docs)) return idx;
  const docs = { ...idx.docs };
  delete docs[key];
  return { ...idx, docs };
}

/** 与磁盘扫描结果对齐：保留已知 meta，丢弃已不存在的条目 */
export function reconcileIndex(idx: WikiIndex, docRels: readonly string[], staticRels: readonly string[]): WikiIndex {
  const docs: Record<string, DocMeta> = {};
  for (const rel of docRels) {
    const key = normalizeRel(rel);
    docs[key] = idx.docs[key] ?? {};
  }
  const statics: Record<string, StaticMeta> = {};
  for (const rel of staticRels) {
    const key = normalizeRel(rel);
    const known = idx.static[key];
    if (known) statics[key] = known;
  }
  return { version: INDEX_VERSION, docs, static: statics };
}

/** 从文档正文取标题：第一个 `# ` 一级标题 */
export function titleFromMarkdown(markdown: string): string | undefined {
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      const title = trimmed.slice(2).trim();
      if (title.length > 0) return title;
    }
    if (trimmed.length > 0 && !trimmed.startsWith('#')) break;
  }
  return undefined;
}

/** 索引里记的原始文件名（用于卡片悬浮提示、TreeView 显示） */
export function originalNameOf(idx: WikiIndex, staticRel: string): string | undefined {
  return idx.static[normalizeRel(staticRel)]?.originalName;
}
