/** 资源类型判定：给 media embeds、入库白名单、Picker 过滤共用 */

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'] as const;
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi'] as const;
export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'] as const;

const IMAGE_SET = new Set<string>(IMAGE_EXTENSIONS);
const VIDEO_SET = new Set<string>(VIDEO_EXTENSIONS);
const AUDIO_SET = new Set<string>(AUDIO_EXTENSIONS);

export function extnameOf(nameOrPath: string): string {
  const base = nameOrPath.replace(/\\/g, '/').split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase();
}

export function kindOfExt(ext: string): MediaKind {
  const e = ext.replace(/^\./, '').toLowerCase();
  if (IMAGE_SET.has(e)) return 'image';
  if (VIDEO_SET.has(e)) return 'video';
  if (AUDIO_SET.has(e)) return 'audio';
  return 'file';
}

export function kindOfPath(p: string): MediaKind {
  return kindOfExt(extnameOf(p));
}

export function isImagePath(p: string): boolean {
  return kindOfPath(p) === 'image';
}

export function isMediaPath(p: string): boolean {
  const k = kindOfPath(p);
  return k === 'image' || k === 'video' || k === 'audio';
}

export function isVideoOrAudioPath(p: string): boolean {
  const k = kindOfPath(p);
  return k === 'video' || k === 'audio';
}

export function mimeOfExt(ext: string): string {
  const e = ext.replace(/^\./, '').toLowerCase();
  switch (e) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    case 'bmp':
      return 'image/bmp';
    case 'svg':
      return 'image/svg+xml';
    case 'mp4':
      return 'video/mp4';
    case 'm4v':
      return 'video/x-m4v';
    case 'mov':
      return 'video/quicktime';
    case 'webm':
      return 'video/webm';
    case 'mkv':
      return 'video/x-matroska';
    case 'avi':
      return 'video/x-msvideo';
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
      return 'audio/mp4';
    case 'aac':
      return 'audio/aac';
    case 'wav':
      return 'audio/wav';
    case 'flac':
      return 'audio/flac';
    case 'ogg':
      return 'audio/ogg';
    case 'opus':
      return 'audio/opus';
    case 'pdf':
      return 'application/pdf';
    case 'zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}
