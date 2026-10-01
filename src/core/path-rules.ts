/**
 * 目录职责不变量：`.metadata/` 下按"进不进 git"二分类。
 *
 * 可入 git（文本）：`index.json`、`docs/**`、`static/.gitignore`
 * 不入 git（二进制）：`static/**`
 *
 * 任何写入点都必须过 `assertWriteAllowed()`，违反即抛错。这条不变量是
 * "宿主仓库 .gitignore 只需一条规则"的前提，所以要能被单测遍历验证。
 */

export interface Layout {
  /** 元数据根目录，相对工作区根，例如 `.metadata` */
  metadataDir: string;
  /** 元数据下存放 Wiki 文档的目录，进 git */
  docsDir: string;
  /** 元数据下存放静态资源的目录，不进 git */
  staticDir: string;
}

export const DEFAULT_LAYOUT: Layout = {
  metadataDir: '.metadata',
  docsDir: 'docs',
  staticDir: 'static'
};

export type PathClass = 'text' | 'binary' | 'outside';
export type WriteKind = 'text' | 'binary';

export class PathRuleError extends Error {
  constructor(
    readonly rel: string,
    readonly kind: WriteKind,
    readonly actual: PathClass,
    message: string
  ) {
    super(message);
    this.name = 'PathRuleError';
  }
}

/** 统一成 posix 风格、去掉 `./`、折叠重复斜杠，便于跨平台比较 */
export function normalizeRel(input: string): string {
  let p = input.replace(/\\/g, '/').trim();
  p = p.replace(/^\.\//, '');
  p = p.replace(/\/{2,}/g, '/');
  p = p.replace(/\/+$/, '');
  return p;
}

function stripSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '');
}

export function normalizeLayout(layout: Layout): Layout {
  return {
    metadataDir: stripSlashes(layout.metadataDir) || DEFAULT_LAYOUT.metadataDir,
    docsDir: stripSlashes(layout.docsDir) || DEFAULT_LAYOUT.docsDir,
    staticDir: stripSlashes(layout.staticDir) || DEFAULT_LAYOUT.staticDir
  };
}

export function metadataRoot(layout: Layout): string {
  return normalizeRel(normalizeLayout(layout).metadataDir);
}

export function docsRoot(layout: Layout): string {
  const l = normalizeLayout(layout);
  return `${l.metadataDir}/${l.docsDir}`;
}

export function staticRoot(layout: Layout): string {
  const l = normalizeLayout(layout);
  return `${l.metadataDir}/${l.staticDir}`;
}

export function indexRelPath(layout: Layout): string {
  return `${metadataRoot(layout)}/index.json`;
}

/** static 目录里的自忽略文件（它是文本，且必须进 git，是不变量的唯一例外） */
export function staticGitignoreRelPath(layout: Layout): string {
  return `${staticRoot(layout)}/.gitignore`;
}

export function isUnder(rel: string, root: string): boolean {
  const r = normalizeRel(rel);
  const root2 = normalizeRel(root);
  return r === root2 || r.startsWith(`${root2}/`);
}

export function classifyPath(rel: string, layout: Layout = DEFAULT_LAYOUT): PathClass {
  const r = normalizeRel(rel);
  if (!isUnder(r, metadataRoot(layout))) return 'outside';
  if (r === indexRelPath(layout)) return 'text';
  if (r === staticGitignoreRelPath(layout)) return 'text';
  if (isUnder(r, docsRoot(layout))) return 'text';
  if (isUnder(r, staticRoot(layout))) return 'binary';
  // 元数据里的其它位置：扩展不写，交给用户
  return 'outside';
}

export function isUnderWikiRoot(rel: string, layout: Layout = DEFAULT_LAYOUT): boolean {
  return isUnder(rel, docsRoot(layout));
}

export function isUnderStaticRoot(rel: string, layout: Layout = DEFAULT_LAYOUT): boolean {
  return isUnder(rel, staticRoot(layout));
}

export function assertWriteAllowed(rel: string, kind: WriteKind, layout: Layout = DEFAULT_LAYOUT): void {
  const actual = classifyPath(rel, layout);
  if (actual === kind) return;
  const expected = kind === 'binary' ? `${staticRoot(layout)}/**` : `${docsRoot(layout)}/** 或 ${indexRelPath(layout)}`;
  throw new PathRuleError(
    rel,
    kind,
    actual,
    `目录职责不变量被破坏：${kind === 'binary' ? '二进制资源' : '文本'} 只能写入 ${expected}，实际写入 ${rel}（归类为 ${actual}）`
  );
}
