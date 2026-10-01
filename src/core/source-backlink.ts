import { encodeLinkTarget } from './markdown-links.js';
import { relPathBetween } from './paths.js';

/** 仅移除旧模板紧跟标题的自动回链；正文中的手写链接保留。 */
export function removeTemplateBacklink(markdown: string, docRel: string, sourceRel: string | null): string {
  if (!sourceRel) return markdown;
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(newline);
  if (!lines[0]?.startsWith('# ') || lines[1] !== '') return markdown;
  const link = `[源文件：${sourceRel}](${encodeLinkTarget(relPathBetween(docRel, sourceRel))})`;
  if (lines[2] !== link) return markdown;
  lines.splice(2, lines[3] === '' ? 2 : 1);
  return lines.join(newline);
}
