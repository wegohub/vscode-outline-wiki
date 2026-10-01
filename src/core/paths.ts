/**
 * 源文件路径 <-> Wiki 文档路径的推导。映射完全是路径的纯函数：
 *
 *   backend/internal/start.go   ->   .metadata/docs/backend/internal/start.go.wiki.md
 *
 * `_` 转义：源路径里以 `_` 开头的段会再补一个 `_`（`_x` -> `__x`），
 * 这样 `docs/_pages/` 才能安全地保留给"独立 Wiki 页"。反解时去掉一个前导 `_`。
 */

import { DEFAULT_LAYOUT, Layout, docsRoot, normalizeLayout, normalizeRel } from './path-rules.js';

export const FREE_PAGE_DIR = '_pages';
export const DOC_SUFFIX = '.wiki.md';

export function mirrorSegment(seg: string): string {
  return seg.startsWith('_') ? `_${seg}` : seg;
}

export function unmirrorSegment(seg: string): string {
  return seg.startsWith('_') ? seg.slice(1) : seg;
}

export function mirrorSourcePath(rel: string): string {
  return normalizeRel(rel)
    .split('/')
    .filter((s) => s.length > 0)
    .map(mirrorSegment)
    .join('/');
}

export function unmirrorSourcePath(mirrored: string): string {
  return normalizeRel(mirrored)
    .split('/')
    .filter((s) => s.length > 0)
    .map(unmirrorSegment)
    .join('/');
}

/** 源文件相对路径 -> 文档 key（即 docs/ 下的镜像路径，不含后缀） */
export function docKeyForSource(sourceRel: string): string {
  return mirrorSourcePath(sourceRel);
}

export function freePageKey(slug: string): string {
  return `${FREE_PAGE_DIR}/${normalizeRel(slug)}`;
}

export function isFreePageKey(key: string): boolean {
  return normalizeRel(key).startsWith(`${FREE_PAGE_DIR}/`);
}

export function docRelPathForKey(key: string, layout: Layout = DEFAULT_LAYOUT): string {
  return `${docsRoot(layout)}/${normalizeRel(key)}${DOC_SUFFIX}`;
}

export function docRelPathForSource(sourceRel: string, layout: Layout = DEFAULT_LAYOUT): string {
  return docRelPathForKey(docKeyForSource(sourceRel), layout);
}

export function freePageRelPath(slug: string, layout: Layout = DEFAULT_LAYOUT): string {
  return docRelPathForKey(freePageKey(slug), layout);
}

/** 文档路径 -> key；不在 docs/ 下或后缀不对则返回 null */
export function keyFromDocRel(docRel: string, layout: Layout = DEFAULT_LAYOUT): string | null {
  const l = normalizeLayout(layout);
  const r = normalizeRel(docRel);
  const prefix = `${docsRoot(l)}/`;
  if (!r.startsWith(prefix) || !r.endsWith(DOC_SUFFIX)) return null;
  const key = r.slice(prefix.length, r.length - DOC_SUFFIX.length);
  return key.length > 0 ? key : null;
}

/** 文档 key -> 源文件相对路径；独立页面返回 null */
export function sourceFromKey(key: string): string | null {
  const k = normalizeRel(key);
  if (isFreePageKey(k)) return null;
  return unmirrorSourcePath(k);
}

export function sourceFromDocRel(docRel: string, layout: Layout = DEFAULT_LAYOUT): string | null {
  const key = keyFromDocRel(docRel, layout);
  return key === null ? null : sourceFromKey(key);
}

export function posixDirname(rel: string): string {
  const r = normalizeRel(rel);
  const i = r.lastIndexOf('/');
  return i < 0 ? '' : r.slice(0, i);
}

export function posixJoin(...parts: string[]): string {
  return normalizeRel(parts.filter((p) => p.length > 0).join('/'));
}

/** 从 `fromFileRel` 出发指向 `targetRel` 的相对路径（用于生成 markdown 链接） */
export function relPathBetween(fromFileRel: string, targetRel: string): string {
  const from = posixDirname(fromFileRel).split('/').filter((s) => s.length > 0);
  const to = normalizeRel(targetRel).split('/').filter((s) => s.length > 0);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  const up = from.length - common;
  const down = to.slice(common);
  const rel = [...Array(up).fill('..'), ...down].join('/');
  return rel.length === 0 ? '.' : rel;
}

/** 把文档目录 + 相对链接解析成工作区相对路径；越界返回 null */
export function resolveRelativeRef(fromFileRel: string, href: string): string | null {
  const stack = posixDirname(fromFileRel).split('/').filter((s) => s.length > 0);
  for (const seg of href.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  return stack.join('/');
}
