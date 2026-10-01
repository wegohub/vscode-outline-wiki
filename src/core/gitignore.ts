/**
 * `.gitignore` 方案：static/ 不进 git（走网盘同步），docs/ 与 index.json 进 git。
 *
 * 方案 A（推荐，自忽略目录法）：在 static/ 里放一个自忽略的 .gitignore
 *
 *     *
 *     !.gitignore
 *
 *   - `*` 忽略该目录下的一切，`!.gitignore` 让这个文件自己被提交
 *   - 于是 clone 后 static/ 目录自动存在（git 里有一个文件在这个目录中），
 *     网盘同步客户端有对位目录，宿主仓库根的 .gitignore 一行都不用改
 *
 * 方案 B：在仓库根 .gitignore 写 `.metadata/static/`。注意副作用：目录整体被忽略后
 * 无法再用 `!` 捞回里面的文件，且 clone 后目录不存在（由扩展按需创建）。
 */

import { DEFAULT_LAYOUT, Layout, normalizeLayout, staticRoot } from './path-rules.js';

export const SELF_IGNORE_HEADER = '# 由 outline-wiki 扩展生成：静态资源走网盘同步，不进 git';
export const SELF_IGNORE_HINT = '# 规则本身请保持下面两行（`*` + `!.gitignore`），扩展会按需重写本文件。';

/** 方案 A 的完整文件内容 */
export function buildSelfIgnoreContent(): string {
  return [SELF_IGNORE_HEADER, SELF_IGNORE_HINT, '', '*', '!.gitignore', ''].join('\n');
}

/** 已有内容是否已经是"自忽略且保留了 .gitignore"的状态 */
export function isSelfIgnoreUpToDate(existing: string | null): boolean {
  if (existing === null) return false;
  const rules = existing
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  return rules.length === 2 && rules[0] === '*' && rules[1] === '!.gitignore';
}

/** 方案 B：仓库根 .gitignore 里的一条规则 */
export function rootIgnoreRule(layout: Layout = DEFAULT_LAYOUT): string {
  return `${staticRoot(layout)}/`;
}

/** 幂等追加方案 B 的规则；已存在则原样返回 */
export function appendRuleOnce(existing: string, layout: Layout = DEFAULT_LAYOUT): string {
  const rule = rootIgnoreRule(layout);
  const target = rule.replace(/\/+$/, '');
  const already = existing
    .split(/\r?\n/)
    .some((l) => l.trim().replace(/\/+$/, '') === target);
  if (already) return existing;

  const { staticDir } = normalizeLayout(layout);
  const comment = `# iCode / Outline Wiki：${staticDir} 目录不进 git（走网盘同步）`;
  const body = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing;
  return `${body}${comment}\n${rule}\n`;
}
