import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  PathRuleError,
  assertWriteAllowed,
  classifyPath,
  docsRoot,
  indexRelPath,
  isUnderStaticRoot,
  isUnderWikiRoot,
  metadataRoot,
  staticGitignoreRelPath,
  staticRoot
} from '../../src/core/path-rules.js';

describe('layout roots', () => {
  it('默认布局根目录', () => {
    expect(metadataRoot(DEFAULT_LAYOUT)).toBe('.metadata');
    expect(docsRoot(DEFAULT_LAYOUT)).toBe('.metadata/docs');
    expect(staticRoot(DEFAULT_LAYOUT)).toBe('.metadata/static');
    expect(indexRelPath(DEFAULT_LAYOUT)).toBe('.metadata/index.json');
    expect(staticGitignoreRelPath(DEFAULT_LAYOUT)).toBe('.metadata/static/.gitignore');
  });

  it('自定义目录名同样成立（不变量按配置解析）', () => {
    const layout = { metadataDir: 'wiki-meta', docsDir: 'pages', staticDir: 'blobs' };
    expect(docsRoot(layout)).toBe('wiki-meta/pages');
    expect(classifyPath('wiki-meta/pages/a.wiki.md', layout)).toBe('text');
    expect(classifyPath('wiki-meta/blobs/upload/x.png', layout)).toBe('binary');
    expect(classifyPath('.metadata/docs/a.wiki.md', layout)).toBe('outside');
  });

  it('容忍多余斜杠与前导 ./', () => {
    expect(classifyPath('./.metadata//docs/a.wiki.md')).toBe('text');
    expect(classifyPath('.metadata/static/')).toBe('binary');
  });
});

describe('classifyPath：目录职责二分类', () => {
  it('可入 git 的文本', () => {
    expect(classifyPath('.metadata/index.json')).toBe('text');
    expect(classifyPath('.metadata/docs/backend/internal/start.go.wiki.md')).toBe('text');
    expect(classifyPath('.metadata/docs/_pages/architecture.wiki.md')).toBe('text');
    // 唯一例外：static 里的自忽略文件是文本且必须进 git
    expect(classifyPath('.metadata/static/.gitignore')).toBe('text');
  });

  it('不进 git 的二进制资源', () => {
    expect(classifyPath('.metadata/static/upload/2026-10-01/abc.png')).toBe('binary');
    expect(classifyPath('.metadata/static/video/demo.mp4')).toBe('binary');
  });

  it('元数据内的未知位置不属于扩展', () => {
    expect(classifyPath('.metadata/other/thing.txt')).toBe('outside');
    expect(classifyPath('.metadata')).toBe('outside');
  });

  it('元数据外一律 outside', () => {
    expect(classifyPath('backend/internal/start.go')).toBe('outside');
    expect(classifyPath('README.md')).toBe('outside');
    // 形似但不是：注意 `.metadata2` 不是 `.metadata` 的子路径
    expect(classifyPath('.metadata2/docs/a.wiki.md')).toBe('outside');
  });

  it('前缀判定不会把相似目录算进来', () => {
    expect(isUnderWikiRoot('.metadata/docsx/a.wiki.md')).toBe(false);
    expect(isUnderStaticRoot('.metadata/staticx/a.png')).toBe(false);
    expect(isUnderStaticRoot('.metadata/static')).toBe(true);
  });
});

describe('assertWriteAllowed：写入点必须过这道断言', () => {
  it('合法写入通过', () => {
    expect(() => assertWriteAllowed('.metadata/docs/a.wiki.md', 'text')).not.toThrow();
    expect(() => assertWriteAllowed('.metadata/index.json', 'text')).not.toThrow();
    expect(() => assertWriteAllowed('.metadata/static/.gitignore', 'text')).not.toThrow();
    expect(() => assertWriteAllowed('.metadata/static/upload/2026-10-01/a.png', 'binary')).not.toThrow();
  });

  it('二进制写进 docs 必须抛错', () => {
    expect(() => assertWriteAllowed('.metadata/docs/a.png', 'binary')).toThrow(PathRuleError);
  });

  it('文本写进 static 必须抛错（自忽略文件除外）', () => {
    expect(() => assertWriteAllowed('.metadata/static/notes.md', 'text')).toThrow(PathRuleError);
  });

  it('写进元数据未知位置必须抛错', () => {
    expect(() => assertWriteAllowed('.metadata/other/a.txt', 'text')).toThrow(PathRuleError);
    expect(() => assertWriteAllowed('.metadata/other/a.png', 'binary')).toThrow(PathRuleError);
  });

  it('写进工作区源码（元数据外）必须抛错', () => {
    expect(() => assertWriteAllowed('backend/internal/start.go', 'text')).toThrow(PathRuleError);
  });

  it('错误信息带上允许的目录，方便定位', () => {
    expect(() => assertWriteAllowed('.metadata/docs/a.png', 'binary')).toThrow(/\.metadata\/static/);
  });
});
