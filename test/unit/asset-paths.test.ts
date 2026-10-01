import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT } from '../../src/core/path-rules.js';
import {
  deriveExt,
  extOfFileName,
  formatDateDir,
  MIME_TO_EXT,
  newAssetName,
  resolveAvailableName,
  uploadDirRel
} from '../../src/core/asset-paths.js';

const ALLOWED = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'mp3', 'pdf', 'zip'];

describe('日期目录', () => {
  const d = new Date('2026-09-30T16:30:00Z');

  it('UTC 模式可确定断言', () => {
    expect(formatDateDir(d, 'utc')).toBe('2026-09-30');
  });

  it('本地模式跟随本地日期（不写死，避免依赖机器时区）', () => {
    const local = formatDateDir(d, 'local');
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(local).toBe(expected);
  });

  it('上传目录落在 static 下', () => {
    expect(uploadDirRel(d, DEFAULT_LAYOUT, 'utc')).toBe('.metadata/static/upload/2026-09-30');
    expect(uploadDirRel(d, { metadataDir: 'm', docsDir: 'd', staticDir: 's' }, 'utc')).toBe('m/s/upload/2026-09-30');
  });
});

describe('UUID 命名', () => {
  it('拼接扩展名并统一小写', () => {
    expect(newAssetName('9f2a1c3d-4b8e-4f0a-9c31-7d5e2b8a1f44', 'PNG')).toBe(
      '9f2a1c3d-4b8e-4f0a-9c31-7d5e2b8a1f44.png'
    );
    expect(newAssetName('uuid', '.mp4')).toBe('uuid.mp4');
    expect(newAssetName('uuid', '')).toBe('uuid');
  });

  it('不做文件名净化：名字里只有 UUID 与扩展名', () => {
    const name = newAssetName('abc', 'png');
    expect(name).toMatch(/^[a-z0-9]+\.png$/);
    expect(name).not.toMatch(/[^a-z0-9.]/);
  });
});

describe('扩展名推导', () => {
  it('原文件名后缀优先', () => {
    expect(deriveExt('架构图.PNG', 'image/jpeg', ALLOWED)).toEqual({ ok: true, ext: 'png' });
  });

  it('文件名后缀不在白名单时回退到 MIME', () => {
    expect(deriveExt('photo.bmp', 'image/png', ALLOWED)).toEqual({ ok: true, ext: 'png' });
  });

  it('没有文件名时按 MIME', () => {
    expect(deriveExt(undefined, 'image/jpeg', ALLOWED)).toEqual({ ok: true, ext: 'jpg' });
    expect(deriveExt(undefined, 'video/quicktime', ALLOWED)).toEqual({ ok: true, ext: 'mov' });
    expect(deriveExt(undefined, 'audio/mpeg', ALLOWED)).toEqual({ ok: true, ext: 'mp3' });
    expect(deriveExt(undefined, 'image/png; charset=binary', ALLOWED)).toEqual({ ok: true, ext: 'png' });
  });

  it('推导不出就拒绝（不产生 .bin 垃圾）', () => {
    const r = deriveExt('noext', 'application/octet-stream', ALLOWED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('允许的类型');
    expect(deriveExt(undefined, undefined, ALLOWED).ok).toBe(false);
    expect(deriveExt('.gitignore', undefined, ALLOWED).ok).toBe(false);
    expect(deriveExt('archive.rar', 'application/x-rar-compressed', ALLOWED).ok).toBe(false);
  });

  it('extOfFileName 的边界', () => {
    expect(extOfFileName('a.png')).toBe('png');
    expect(extOfFileName('/tmp/x/Y.MP4')).toBe('mp4');
    expect(extOfFileName('noext')).toBeNull();
    expect(extOfFileName('.gitignore')).toBeNull();
    expect(extOfFileName('trailing.')).toBeNull();
    expect(extOfFileName(undefined)).toBeNull();
  });

  it('MIME 映射表里的类型都在默认白名单内', () => {
    const defaults = new Set(
      ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi',
       'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'pdf', 'zip', 'docx', 'xlsx', 'pptx', 'csv', 'txt']
    );
    for (const [mime, ext] of Object.entries(MIME_TO_EXT)) {
      expect(defaults.has(ext), `${mime} -> ${ext} 不在默认白名单里`).toBe(true);
    }
  });
});

describe('同名消解（UUID 撞了才用得上）', () => {
  it('没冲突直接用原名', () => {
    expect(resolveAvailableName('a.png', () => false)).toBe('a.png');
  });

  it('冲突依次尝试 -1 / -2', () => {
    const taken = new Set(['a.png', 'a-1.png']);
    expect(resolveAvailableName('a.png', (n) => taken.has(n))).toBe('a-2.png');
  });

  it('无扩展名也成立', () => {
    expect(resolveAvailableName('a', (n) => n === 'a')).toBe('a-1');
  });

  it('超过上限时退回带时间戳的名字（绝不覆盖已有文件）', () => {
    const out = resolveAvailableName('a.png', () => true, 0);
    expect(out).not.toBe('a.png');
    expect(out.startsWith('a-')).toBe(true);
    expect(out.endsWith('.png')).toBe(true);
  });
});
