import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT } from '../../src/core/path-rules.js';
import {
  docKeyForSource,
  docRelPathForSource,
  freePageKey,
  freePageRelPath,
  isFreePageKey,
  keyFromDocRel,
  mirrorSegment,
  mirrorSourcePath,
  posixDirname,
  posixJoin,
  relPathBetween,
  resolveRelativeRef,
  sourceFromDocRel,
  sourceFromKey,
  unmirrorSourcePath
} from '../../src/core/paths.js';

/**
 * 层级规则（本文件所有夹具都遵守）：
 * 资源的工作区相对路径形如 `.metadata/static/upload/<date>/<file>`，
 * 与文档目录（`.metadata/docs/...`）的公共前缀是 `.metadata` 这一段，
 * 所以 `..` 的个数 = 文档目录深度 − 1。
 */
const DOC = '.metadata/docs/backend/internal/start.go.wiki.md'; // 目录深度 4 -> 3 个 ..
const ASSET = '.metadata/static/upload/2026-10-01/a.png';

describe('镜像与反解', () => {
  it('普通路径原样镜像', () => {
    expect(docKeyForSource('backend/internal/start.go')).toBe('backend/internal/start.go');
    expect(docRelPathForSource('backend/internal/start.go')).toBe(
      '.metadata/docs/backend/internal/start.go.wiki.md'
    );
  });

  it('以 _ 开头的段转义，反解可逆（含双下划线）', () => {
    expect(mirrorSegment('_x')).toBe('__x');
    expect(mirrorSegment('__x')).toBe('___x');
    expect(mirrorSegment('x')).toBe('x');
    expect(unmirrorSourcePath(mirrorSourcePath('_x/__y/z.go'))).toBe('_x/__y/z.go');
  });

  it('_pages 是保留目录，与同名源文件不冲突', () => {
    expect(docKeyForSource('_pages/foo.go')).toBe('__pages/foo.go');
    expect(isFreePageKey(docKeyForSource('_pages/foo.go'))).toBe(false);
    expect(isFreePageKey(freePageKey('architecture'))).toBe(true);
  });

  it('key <-> 源路径往返', () => {
    for (const src of ['a.go', 'a/b/c.go', '_x/y.go', '前端/首页.tsx', '_pages/x.md']) {
      const key = docKeyForSource(src);
      expect(sourceFromKey(key)).toBe(src);
      const docRel = docRelPathForSource(src);
      expect(keyFromDocRel(docRel)).toBe(key);
      expect(sourceFromDocRel(docRel)).toBe(src);
    }
  });

  it('独立页面没有源文件', () => {
    const docRel = freePageRelPath('architecture');
    expect(docRel).toBe('.metadata/docs/_pages/architecture.wiki.md');
    expect(sourceFromDocRel(docRel)).toBeNull();
    expect(sourceFromDocRel(docRel, { metadataDir: '.metadata', docsDir: 'd', staticDir: 's' })).toBeNull();
  });

  it('非文档路径一律返回 null', () => {
    expect(keyFromDocRel('.metadata/docs/a.md')).toBeNull();
    expect(keyFromDocRel('.metadata/static/a.wiki.md')).toBeNull();
    expect(keyFromDocRel('.metadata/docs/a.wiki.md', { metadataDir: 'm', docsDir: 'd', staticDir: 's' })).toBeNull();
    expect(keyFromDocRel('.metadata/docs/.wiki.md')).toBeNull();
  });
});

describe('posix 路径工具', () => {
  it('dirname / join', () => {
    expect(posixDirname('.metadata/docs/a/b.wiki.md')).toBe('.metadata/docs/a');
    expect(posixDirname('a.md')).toBe('');
    expect(posixJoin('.metadata/docs/', 'a', 'b.wiki.md')).toBe('.metadata/docs/a/b.wiki.md');
  });

  it('relPathBetween 生成正确的层数', () => {
    // 目录深度 4（.metadata/docs/backend/internal）-> 三个 ..
    expect(relPathBetween(DOC, ASSET)).toBe('../../../static/upload/2026-10-01/a.png');
    // 目录深度 2（.metadata/docs）-> 一个 ..
    expect(relPathBetween('.metadata/docs/a.wiki.md', ASSET)).toBe('../static/upload/2026-10-01/a.png');
    // 独立页面（.metadata/docs/_pages，深度 3）-> 两个 ..
    expect(relPathBetween('.metadata/docs/_pages/p.wiki.md', ASSET)).toBe('../../static/upload/2026-10-01/a.png');
    // 同一目录内
    expect(relPathBetween('.metadata/docs/a.wiki.md', '.metadata/docs/b.wiki.md')).toBe('b.wiki.md');
  });

  it('resolveRelativeRef 解析回工作区相对路径', () => {
    expect(resolveRelativeRef(DOC, '../../../static/upload/2026-10-01/a.png')).toBe(
      '.metadata/static/upload/2026-10-01/a.png'
    );
    expect(resolveRelativeRef(DOC, '../../../../backend/internal/start.go')).toBe('backend/internal/start.go');
  });

  it('relPathBetween 与 resolveRelativeRef 互为逆运算', () => {
    for (const doc of [DOC, '.metadata/docs/a.wiki.md', '.metadata/docs/_pages/p.wiki.md']) {
      const href = relPathBetween(doc, ASSET);
      expect(resolveRelativeRef(doc, href)).toBe(ASSET);
    }
  });

  it('越界解析返回 null（不允许链接逃出工作区）', () => {
    expect(resolveRelativeRef('.metadata/docs/a.wiki.md', '../../../../etc/passwd')).toBeNull();
    expect(resolveRelativeRef(DOC, '../../../../../../etc/passwd')).toBeNull();
  });
});

describe('DEFAULT_LAYOUT 生效', () => {
  it('默认 layout 参与推导', () => {
    expect(docRelPathForSource('a.go', DEFAULT_LAYOUT)).toBe('.metadata/docs/a.go.wiki.md');
  });
});
