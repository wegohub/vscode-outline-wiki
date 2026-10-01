import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT } from '../../src/core/path-rules.js';
import {
  classifyHref,
  collectStaticRefs,
  collectWorkspaceRefs,
  decodeLinkTarget,
  encodeLinkTarget,
  findLinks,
  findMissingRefs,
  isSimpleLink,
  rewriteLinks,
  rewriteStaticLinksForMove,
  workspaceRelOfHref
} from '../../src/core/markdown-links.js';

/** 目录深度 4 -> 指向 .metadata/static/... 需要三个 .. */
const DOC = '.metadata/docs/backend/internal/start.go.wiki.md';
const IMG = '../../../static/upload/2026-10-01/one.png';
const AUDIO = '../../../static/video/demo.mp4';
const SRC = '../../../../backend/internal/start.go';

describe('findLinks', () => {
  it('识别图片与链接，并给出偏移', () => {
    const md = `前 ![图](${IMG}) 后 [文档](other.wiki.md)`;
    const links = findLinks(md);
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ kind: 'image', text: '图', href: IMG });
    expect(md.slice(links[0]!.start, links[0]!.end)).toBe(links[0]!.raw);
    expect(links[1]).toMatchObject({ kind: 'link', text: '文档', href: 'other.wiki.md' });
  });

  it('带标题的链接：href 与 raw 都对', () => {
    const links = findLinks('[x](a.png "标题")');
    expect(links[0]!.href).toBe('a.png');
    expect(links[0]!.raw).toBe('[x](a.png "标题")');
  });

  it('非链接文本不误判', () => {
    expect(findLinks('这是 [不是链接] 和 (括号)')).toHaveLength(0);
    expect(findLinks('![图片没有目标]')).toHaveLength(0);
  });
});

describe('embed 形态', () => {
  it('库要求 href === 文本 才是 embed（带标题的会退化成普通链接）', () => {
    const [simple] = findLinks(`[${AUDIO}](${AUDIO})`);
    const [titled] = findLinks(`[演示](${AUDIO})`);
    expect(isSimpleLink(simple!)).toBe(true);
    expect(isSimpleLink(titled!)).toBe(false);
  });
});

describe('href 分类与编码', () => {
  it('分类', () => {
    expect(classifyHref('#anchor')).toBe('anchor');
    expect(classifyHref('https://a/b')).toBe('protocol');
    expect(classifyHref('vscode-webview://x/y')).toBe('protocol');
    expect(classifyHref('/abs/path')).toBe('absolute');
    expect(classifyHref('../static/a.png')).toBe('relative');
  });

  it('只编码破坏解析的字符，中文保持原样', () => {
    const encoded = encodeLinkTarget('.metadata/static/upload/2026-10-01/我的 图 (1)#a?b%.png');
    expect(encoded).toBe('.metadata/static/upload/2026-10-01/我的%20图%20%281%29%23a%3Fb%25.png');
    expect(encoded).not.toContain(' ');
    expect(encoded).toContain('我的');
  });

  it('编码/解码往返无损', () => {
    for (const p of [
      '.metadata/static/upload/2026-10-01/a.png',
      '.metadata/static/upload/2026-10-01/我的 图 (1).png',
      '.metadata/static/video/演示%20视频.mp4',
      '.metadata/docs/a b/c.wiki.md'
    ]) {
      expect(decodeLinkTarget(encodeLinkTarget(p))).toBe(p);
    }
  });

  it('非法百分号编码不抛错（按原文处理）', () => {
    expect(decodeLinkTarget('a%ZZb.png')).toBe('a%ZZb.png');
  });
});

describe('引用收集与缺失检测', () => {
  const md = [
    `![a](${IMG})`,
    '',
    `[v](${AUDIO})`,
    '',
    `[源码](${SRC})`,
    '',
    '[外链](https://example.com/x.png)',
    '',
    `![重复](${IMG})`
  ].join('\n');

  it('只收集 static/ 下的引用，去重排序（返回工作区相对路径）', () => {
    expect(collectStaticRefs(md, DOC, DEFAULT_LAYOUT)).toEqual([
      '.metadata/static/upload/2026-10-01/one.png',
      '.metadata/static/video/demo.mp4'
    ]);
  });

  it('收集工作区内全部相对链接（绝对 URL 不算）', () => {
    const refs = collectWorkspaceRefs(md, DOC);
    expect(refs).toContain('backend/internal/start.go');
    expect(refs).toContain('.metadata/static/upload/2026-10-01/one.png');
    expect(refs).not.toContain('https://example.com/x.png');
  });

  it('findMissingRefs 报出磁盘上不存在的资源（对应网盘未同步）', () => {
    const existing = new Set(['.metadata/static/video/demo.mp4']);
    expect(findMissingRefs(md, DOC, DEFAULT_LAYOUT, (r) => existing.has(r))).toEqual([
      '.metadata/static/upload/2026-10-01/one.png'
    ]);
  });

  it('workspaceRelOfHref 对越界链接返回 null', () => {
    expect(workspaceRelOfHref(DOC, '../../../../../../etc/passwd')).toBeNull();
  });
});

describe('移动后重算 static 链接层数', () => {
  // 旧文档目录深度 4 -> 三个 ..；新文档目录深度 3 -> 两个 ..
  const OLD_DOC = '.metadata/docs/a/b/c.wiki.md';
  const NEW_DOC = '.metadata/docs/a/c.wiki.md';
  const BEFORE = '![图](../../../static/upload/2026-10-01/a.png)';

  it('跨层级移动时改写，图片的 ! 保留', () => {
    expect(rewriteStaticLinksForMove(BEFORE, OLD_DOC, NEW_DOC, DEFAULT_LAYOUT)).toBe(
      '![图](../../static/upload/2026-10-01/a.png)'
    );
  });

  it('同目录改名不改写', () => {
    expect(rewriteStaticLinksForMove(BEFORE, OLD_DOC, '.metadata/docs/a/b/d.wiki.md', DEFAULT_LAYOUT)).toBe(BEFORE);
  });

  it('指向源码/其它文档/外链的链接不动', () => {
    const md = [
      '[源码](../../../../backend/internal/start.go)',
      '[别的文档](../other.wiki.md)',
      '[外链](https://example.com/a.png)'
    ].join('\n');
    expect(rewriteStaticLinksForMove(md, OLD_DOC, NEW_DOC, DEFAULT_LAYOUT)).toBe(md);
  });

  it('含空格的资源名在改写后仍是编码形态', () => {
    const before = '![图](../../../static/upload/2026-10-01/我的%20a.png)';
    expect(rewriteStaticLinksForMove(before, OLD_DOC, NEW_DOC, DEFAULT_LAYOUT)).toBe(
      '![图](../../static/upload/2026-10-01/我的%20a.png)'
    );
  });
});

describe('通用改写', () => {
  it('map 返回 null 表示保持原样', () => {
    const md = '[a](one.png) 和 [b](two.png)';
    expect(rewriteLinks(md, (l) => (l.href === 'one.png' ? '[a](ONE.png)' : null))).toBe(
      '[a](ONE.png) 和 [b](two.png)'
    );
  });

  it('能用于 Phase 0 方案 B 的 webview URL 双向改写', () => {
    const md = `![x](${IMG})`;
    const toWebview = rewriteLinks(md, (l) => {
      const rel = workspaceRelOfHref(DOC, l.href);
      return rel ? `![x](vscode-webview://<id>/${rel})` : null;
    });
    expect(toWebview).toBe('![x](vscode-webview://<id>/.metadata/static/upload/2026-10-01/one.png)');

    const back = rewriteLinks(toWebview, (l) => l.href.replace('vscode-webview://<id>/', '../..') && null);
    expect(back).toBe(toWebview);
  });
});
