/**
 * markdown 里的链接处理（纯函数，可单测）。
 *
 * 磁盘上的链接永远是"相对正确"的路径，例如从 docs/backend/internal/start.go.wiki.md
 * 指向 static/upload/2026-10-01/<uuid>.png 要写 ../../../static/upload/...。
 *
 * 用途：
 *  1. 源文件跨层级移动后重算 static 链接（rewriteStaticLinksForMove）
 *  2. 收集/校验引用（collectStaticRefs / findMissingRefs）→ verifyRefs、gcAssets
 *  3. Phase 0 方案 B 的双向改写（rewriteLinks 通用映射）
 */

import { Layout, isUnderStaticRoot, normalizeRel } from './path-rules.js';
import { posixDirname, relPathBetween, resolveRelativeRef } from './paths.js';

export interface MdLink {
  /** `![alt](href)` 还是 `[text](href)` */
  kind: 'image' | 'link';
  text: string;
  href: string;
  /** 完整原文，含 `![` 或 `[` */
  raw: string;
  start: number;
  end: number;
}

/**
 * 只匹配我们可能生成/遇到的普通链接。限制（写进 docs/STORAGE.md）：
 *  - href 里不含未编码的空格与圆括号（我们自己生成时都会编码）
 *  - 标题只支持双引号形式
 *  - 不解析引用式链接、HTML 标签、autolink
 */
const LINK_RE = /(!?)\[([^\]\n]*)\]\(([^()\s]*)(?:\s+"[^"]*")?\)/g;

export function findLinks(markdown: string): MdLink[] {
  const out: MdLink[] = [];
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(markdown)) !== null) {
    const [raw, bang = '', text = '', href = ''] = m;
    out.push({
      kind: bang === '!' ? 'image' : 'link',
      text,
      href,
      raw,
      start: m.index,
      end: m.index + raw.length
    });
  }
  return out;
}

/** 库要求 href === 链接文本 才识别为 embed（`[href](href)`） */
export function isSimpleLink(link: MdLink): boolean {
  return link.kind === 'link' && link.href === link.text;
}

export type HrefKind = 'anchor' | 'absolute' | 'protocol' | 'relative';

export function classifyHref(href: string): HrefKind {
  if (href.startsWith('#')) return 'anchor';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return 'protocol';
  if (href.startsWith('/')) return 'absolute';
  return 'relative';
}

/** 只对破坏 markdown/URL 解析的字符编码；中日韩字符保持原样，避免文档变成天书 */
const ENCODE_MAP: Record<string, string> = {
  '%': '%25',
  ' ': '%20',
  '(': '%28',
  ')': '%29',
  '#': '%23',
  '?': '%3F',
  '[': '%5B',
  ']': '%5D',
  '<': '%3C',
  '>': '%3E'
};

export function encodeLinkTarget(rel: string): string {
  return normalizeRel(rel)
    .split('/')
    .map((seg) => seg.replace(/[% ()#[\]<>?]/g, (ch) => ENCODE_MAP[ch] ?? ch))
    .join('/');
}

export function decodeLinkTarget(href: string): string {
  return href
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}

/** 通用改写：map 返回替换文本，返回 null 表示保持不变 */
export function rewriteLinks(markdown: string, map: (link: MdLink) => string | null): string {
  const links = findLinks(markdown);
  let out = '';
  let cursor = 0;
  for (const link of links) {
    const replacement = map(link);
    if (replacement === null) continue;
    out += markdown.slice(cursor, link.start) + replacement;
    cursor = link.end;
  }
  return out + markdown.slice(cursor);
}

/** 相对链接 -> 工作区相对路径；绝对/协议链接/越界返回 null */
export function workspaceRelOfHref(docRel: string, href: string): string | null {
  if (classifyHref(href) !== 'relative') return null;
  const decoded = decodeLinkTarget(href);
  if (decoded.length === 0) return null;
  return resolveRelativeRef(docRel, decoded);
}

/** 收集文档引用到的 static/ 下所有资源（工作区相对路径，去重、排序） */
export function collectStaticRefs(markdown: string, docRel: string, layout: Layout): string[] {
  const set = new Set<string>();
  for (const link of findLinks(markdown)) {
    const rel = workspaceRelOfHref(docRel, link.href);
    if (rel && isUnderStaticRoot(rel, layout)) set.add(rel);
  }
  return [...set].sort();
}

/** 收集所有指向工作区内的相对链接（含源码、其它文档、资源） */
export function collectWorkspaceRefs(markdown: string, docRel: string): string[] {
  const set = new Set<string>();
  for (const link of findLinks(markdown)) {
    const rel = workspaceRelOfHref(docRel, link.href);
    if (rel) set.add(rel);
  }
  return [...set].sort();
}

/**
 * 找出"文档引用了但磁盘上不存在"的资源 → verifyRefs 命令用（对应网盘未同步的场景）。
 * 只检查 static/ 下的引用，源码文件缺失不算问题（可能只是没 checkout）。
 */
export function findMissingRefs(
  markdown: string,
  docRel: string,
  layout: Layout,
  exists: (workspaceRel: string) => boolean
): string[] {
  return collectStaticRefs(markdown, docRel, layout).filter((rel) => !exists(rel));
}

/**
 * 源文件跨层级移动 / 文档被手工移动后，重算指向 static/ 的相对链接层数。
 * 只动静态资源链接：指向源码或其它文档的链接交给 normalizeLinks 单独处理。
 */
export function rewriteStaticLinksForMove(
  markdown: string,
  oldDocRel: string,
  newDocRel: string,
  layout: Layout
): string {
  if (normalizeRel(posixDirname(oldDocRel)) === normalizeRel(posixDirname(newDocRel))) return markdown;
  return rewriteLinks(markdown, (link) => {
    const target = workspaceRelOfHref(oldDocRel, link.href);
    if (!target || !isUnderStaticRoot(target, layout)) return null;
    const nextHref = encodeLinkTarget(relPathBetween(newDocRel, target));
    const nextRaw = `${link.kind === 'image' ? '!' : ''}[${link.text}](${nextHref})`;
    return nextRaw === link.raw ? null : nextRaw;
  });
}
