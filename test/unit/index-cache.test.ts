import { describe, expect, it } from 'vitest';
import {
  emptyIndex,
  originalNameOf,
  parseIndex,
  reconcileIndex,
  removeDoc,
  serializeIndex,
  titleFromMarkdown,
  upsertDoc,
  upsertStatic
} from '../../src/core/index-cache.js';

describe('容错解析：索引永远不能阻塞打开文档', () => {
  it('缺失/空/非法 JSON 一律退回空索引', () => {
    expect(parseIndex(null)).toEqual(emptyIndex());
    expect(parseIndex('')).toEqual(emptyIndex());
    expect(parseIndex('{ 这不是 json')).toEqual(emptyIndex());
    expect(parseIndex('null')).toEqual(emptyIndex());
    expect(parseIndex('[]')).toEqual(emptyIndex());
  });

  it('版本不符则丢弃（可重建，不丢内容）', () => {
    expect(parseIndex(JSON.stringify({ version: 99, docs: { a: {} } }))).toEqual(emptyIndex());
  });

  it('只保留认识的字段，忽略垃圾', () => {
    const idx = parseIndex(
      JSON.stringify({
        version: 1,
        docs: {
          '.metadata/docs/a.wiki.md': { title: 'A', staticRefs: ['static/x.png', 42, null], junk: true },
          '': { title: 'empty key' }
        },
        static: { 'static/upload/1/a.png': { originalName: '架构图.png', size: 12, sha256: 'ab' } }
      })
    );
    expect(Object.keys(idx.docs)).toEqual(['.metadata/docs/a.wiki.md']);
    expect(idx.docs['.metadata/docs/a.wiki.md']).toEqual({ title: 'A', staticRefs: ['static/x.png'] });
    expect(idx.static['static/upload/1/a.png']).toEqual({ originalName: '架构图.png', size: 12, sha256: 'ab' });
  });
});

describe('序列化：目录友好（减少 merge 冲突）', () => {
  it('键排序 + 2 空格缩进 + 结尾换行', () => {
    let idx = emptyIndex();
    idx = upsertDoc(idx, '.metadata/docs/b.wiki.md', { title: 'B' });
    idx = upsertDoc(idx, '.metadata/docs/a.wiki.md', { title: 'A' });
    const text = serializeIndex(idx);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('  "version": 1');
    expect(text.indexOf('a.wiki.md')).toBeLessThan(text.indexOf('b.wiki.md'));
    // 往返稳定
    expect(serializeIndex(parseIndex(text))).toBe(text);
  });

  it('重复序列化完全一致（幂等）', () => {
    const idx = upsertStatic(upsertDoc(emptyIndex(), '.metadata/docs/a.wiki.md', { title: 'A' }), 'static/x.png', {
      size: 1
    });
    expect(serializeIndex(parseIndex(serializeIndex(idx)))).toBe(serializeIndex(idx));
  });
});

describe('更新与对齐', () => {
  it('upsertDoc 合并已有 meta 并规范化 staticRefs', () => {
    let idx = emptyIndex();
    idx = upsertDoc(idx, '.metadata/docs/a.wiki.md', { title: 'A', createdAt: 't0' });
    idx = upsertDoc(idx, '.metadata/docs/a.wiki.md', { staticRefs: ['static/b.png', 'static/a.png', 'static/a.png'] });
    expect(idx.docs['.metadata/docs/a.wiki.md']).toEqual({
      title: 'A',
      createdAt: 't0',
      staticRefs: ['static/a.png', 'static/b.png']
    });
  });

  it('removeDoc', () => {
    const idx = upsertDoc(emptyIndex(), '.metadata/docs/a.wiki.md', { title: 'A' });
    expect(Object.keys(removeDoc(idx, '.metadata/docs/a.wiki.md').docs)).toEqual([]);
    expect(removeDoc(idx, '.metadata/docs/none.wiki.md')).toBe(idx);
  });

  it('reconcileIndex 保留已知 meta、丢弃消失的条目', () => {
    let idx = emptyIndex();
    idx = upsertDoc(idx, '.metadata/docs/a.wiki.md', { title: 'A' });
    idx = upsertDoc(idx, '.metadata/docs/gone.wiki.md', { title: 'G' });
    idx = upsertStatic(idx, 'static/old.png', { size: 1 });

    const next = reconcileIndex(idx, ['.metadata/docs/a.wiki.md', '.metadata/docs/new.wiki.md'], ['static/old.png']);
    expect(Object.keys(next.docs)).toEqual(['.metadata/docs/a.wiki.md', '.metadata/docs/new.wiki.md']);
    expect(next.docs['.metadata/docs/a.wiki.md']).toEqual({ title: 'A' });
    expect(next.docs['.metadata/docs/new.wiki.md']).toEqual({});
    expect(next.static['static/old.png']).toEqual({ size: 1 });
  });
});

describe('可读性补偿（UUID 命名后靠索引记原名）', () => {
  it('titleFromMarkdown 取首个一级标题', () => {
    expect(titleFromMarkdown('# start.go 设计笔记\n\n正文')).toBe('start.go 设计笔记');
    expect(titleFromMarkdown('\n\n#  带空白的标题 \n')).toBe('带空白的标题');
    expect(titleFromMarkdown('没有标题\n# 后面的不算')).toBeUndefined();
    expect(titleFromMarkdown('')).toBeUndefined();
  });

  it('originalNameOf 读回入库时的原始文件名', () => {
    const idx = upsertStatic(emptyIndex(), 'static/upload/2026-10-01/u.png', { originalName: '架构图.png' });
    expect(originalNameOf(idx, 'static/upload/2026-10-01/u.png')).toBe('架构图.png');
    expect(originalNameOf(idx, 'static/upload/2026-10-01/other.png')).toBeUndefined();
  });
});
