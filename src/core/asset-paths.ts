/**
 * 静态资源入库命名规则（`src/core/asset-paths.ts`）：
 *
 *   .metadata/static/upload/{yyyy-MM-dd}/{uuid}.{ext}
 *
 * - 扩展名只从原始文件名或 MIME 推导（UUID 本体不含语义）
 * - 不做文件名净化（UUID 天然无空格/中文/非法字符/保留名/长度问题）
 * - 不做内容去重（同一张图贴两次就是两个文件），可选按内容去重见 dedupeByContent
 * - UUID 工厂与时钟可注入，单测完全确定化
 */

import { DEFAULT_LAYOUT, Layout, staticRoot } from './path-rules.js';

export const UPLOAD_DIR = 'upload';

export type TimeZoneMode = 'local' | 'utc';

export function formatDateDir(now: Date, tz: TimeZoneMode): string {
  if (tz === 'utc') {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function uploadDirRel(now: Date, layout: Layout = DEFAULT_LAYOUT, tz: TimeZoneMode = 'local'): string {
  return `${staticRoot(layout)}/${UPLOAD_DIR}/${formatDateDir(now, tz)}`;
}

export function newAssetName(uuid: string, ext: string): string {
  const clean = ext.replace(/^\./, '').toLowerCase();
  return clean.length === 0 ? uuid : `${uuid}.${clean}`;
}

/** MIME -> 扩展名（只覆盖常见类型；未知类型由调用方按白名单拒绝） */
export const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
  'video/x-m4v': 'm4v',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/csv': 'csv',
  'text/plain': 'txt'
};

export type DeriveExtResult = { ok: true; ext: string } | { ok: false; error: string };

export function extOfFileName(name: string | undefined): string | null {
  if (!name) return null;
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return null;
  return base.slice(i + 1).toLowerCase();
}

/**
 * 推导扩展名：原文件名后缀优先，其次 MIME 映射；都不在白名单里则拒绝。
 * 直接拒绝而不是退回 `.bin`，避免在 static/ 里堆积无法识别的垃圾。
 */
export function deriveExt(
  originalName: string | undefined,
  mime: string | undefined,
  allowed: readonly string[]
): DeriveExtResult {
  const allow = new Set(allowed.map((e) => e.replace(/^\./, '').toLowerCase()));
  const fromName = extOfFileName(originalName);
  if (fromName && allow.has(fromName)) return { ok: true, ext: fromName };

  const normalizedMime = (mime ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const fromMime = normalizedMime.length > 0 ? MIME_TO_EXT[normalizedMime] : undefined;
  if (fromMime && allow.has(fromMime)) return { ok: true, ext: fromMime };

  const listed = [...allow].sort().join(', ');
  const got = [fromName ? `文件名后缀 .${fromName}` : undefined, normalizedMime ? `类型 ${normalizedMime}` : undefined]
    .filter(Boolean)
    .join(' / ');
  return {
    ok: false,
    error: `不支持的文件类型${got ? `（${got}）` : ''}。允许的类型：${listed}`
  };
}

/** 同名消解：返回第一个可用的名字。UUID 命名下碰撞概率可忽略，这里只是兜底。 */
export function resolveAvailableName(
  name: string,
  exists: (candidate: string) => boolean,
  limit = 999
): string {
  if (!exists(name)) return name;
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  for (let i = 1; i <= limit; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!exists(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}${ext}`;
}

/** 短哈希前缀，供"按内容去重"开关使用 */
export function shortHash(sha256Hex: string): string {
  return sha256Hex.slice(0, 16);
}
