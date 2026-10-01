import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, staticGitignoreRelPath } from '../../src/core/path-rules.js';
import {
  appendRuleOnce,
  buildSelfIgnoreContent,
  isSelfIgnoreUpToDate,
  rootIgnoreRule
} from '../../src/core/gitignore.js';

describe('方案 A：static/.gitignore 自忽略', () => {
  it('生成内容包含两条关键规则', () => {
    const content = buildSelfIgnoreContent();
    const rules = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(rules).toEqual(['*', '!.gitignore']);
    expect(content).toContain('网盘');
    expect(content.endsWith('\n')).toBe(true);
  });

  it('落盘位置是不变量里唯一的文本例外', () => {
    expect(staticGitignoreRelPath(DEFAULT_LAYOUT)).toBe('.metadata/static/.gitignore');
  });

  it('判定已就绪', () => {
    expect(isSelfIgnoreUpToDate(null)).toBe(false);
    expect(isSelfIgnoreUpToDate('')).toBe(false);
    expect(isSelfIgnoreUpToDate('*\n')).toBe(false);
    expect(isSelfIgnoreUpToDate('*\n!.gitignore\n')).toBe(true);
    expect(isSelfIgnoreUpToDate(`# 注释\n*\n!.gitignore\n\n`)).toBe(true);
    expect(isSelfIgnoreUpToDate('*\n!.gitignore\n!keep.png\n')).toBe(false);
  });
});

describe('方案 B：仓库根 .gitignore 追加规则', () => {
  it('规则文本', () => {
    expect(rootIgnoreRule(DEFAULT_LAYOUT)).toBe('.metadata/static/');
    expect(rootIgnoreRule({ metadataDir: 'm', docsDir: 'd', staticDir: 's' })).toBe('m/s/');
  });

  it('首次追加带上说明注释', () => {
    const out = appendRuleOnce('node_modules/\n');
    expect(out).toContain('.metadata/static/');
    expect(out).toContain('Outline Wiki');
    expect(out.startsWith('node_modules/\n')).toBe(true);
  });

  it('幂等：已存在则不重复追加', () => {
    const once = appendRuleOnce('node_modules/\n');
    expect(appendRuleOnce(once)).toBe(once);
    expect(appendRuleOnce('.metadata/static/\n')).toBe('.metadata/static/\n');
    expect(appendRuleOnce('.metadata/static\n')).toBe('.metadata/static\n');
  });

  it('原文件没有结尾换行也能正确接上', () => {
    const out = appendRuleOnce('dist/');
    const lines = out.split('\n');
    expect(lines[0]).toBe('dist/');
    expect(lines.some((l) => l.trim() === '.metadata/static/')).toBe(true);
  });

  it('空文件也能处理', () => {
    expect(appendRuleOnce('')).toContain('.metadata/static/');
  });
});
