/**
 * 宿主 <-> webview 的消息协议（两端共用，改这里必须两端同步改）。
 */

export type ThemeName = 'light' | 'dark';

export interface WebviewConfig {
  /** 正文字号 px */
  fontSize: number;
  /** 主题设置：auto 时跟随 VS Code */
  themeSetting: 'auto' | 'light' | 'dark';
  readOnly: boolean;
  mediaAllowVideo: boolean;
  mathRejectNumericOnly: boolean;
  /** 粘贴/拖入体积上限（MB） */
  maxInlineUploadMB: number;
  /** 允许入库的扩展名（无点、小写） */
  allowedExtensions: string[];
}

export interface ProbeResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** Phase 0 探针：宿主准备好夹具后交给 webview 实测 */
export interface ProbeSpec {
  /** 相对于当前文档的图片链接（考验 <base> 是否生效） */
  imageHref: string;
  /** 相对于当前文档的音频链接（考验 Range / seek） */
  audioHref: string;
  videoHref?: string;
  /** 夹具的工作区相对路径，用于报告 */
  fixtureRel: string;
  /** 期望渲染出的公式/图数量（由宿主按文档内容给出，未给则不校验） */
  expect?: { math?: number; mermaid?: number };
}

export type HostToWebview =
  | {
      type: 'init';
      rev: number;
      markdown: string;
      /** 文档的工作区相对路径，例如 .metadata/docs/a/b.wiki.md */
      docRel: string;
      /** 文档正文第一个一级标题，或文件名 */
      docTitle: string;
      /** 对应的源文件相对路径；独立页面为 null */
      sourceRel: string | null;
      theme: ThemeName;
      config: WebviewConfig;
      /** 引用但磁盘上不存在的资源（网盘未同步场景） */
      missingRefs: string[];
    }
  | { type: 'empty'; sourceRel: string | null; reason: string; canCreate: boolean }
  | { type: 'requestFlush' }
  | { type: 'inspectView'; id: string; create?: boolean }
  | { type: 'externalUpdate'; rev: number; markdown: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'saved' }
  | {
      type: 'ingestResult';
      id: string;
      ok: boolean;
      /** 可立即显示的 URL（与 relPath 一致，靠 <base> 解析） */
      url?: string;
      /** 写进 markdown 的相对链接 */
      relPath?: string;
      originalName?: string;
      error?: string;
    }
  | { type: 'compatibleVideoResult'; id: string; href?: string; error?: string }
  | { type: 'insertMarkdown'; markdown: string }
  | { type: 'runProbe'; probe: ProbeSpec }
  | { type: 'binaryEcho'; payload: Uint8Array }
  | { type: 'theme'; theme: ThemeName };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'flushed' }
  | { type: 'viewSnapshot'; id: string; sourceRel: string | null; canCreate: boolean; text: string; overflow: boolean }
  | { type: 'createWiki' }
  | { type: 'openSource' }
  | { type: 'edit'; rev: number; markdown: string }
  | { type: 'flush'; rev: number; markdown: string }
  | { type: 'save'; close?: boolean }
  | { type: 'openLink'; href: string }
  | { type: 'openExternally'; href: string }
  /** 用系统播放器打开（相对链接由宿主解析为工作区文件） */
  | { type: 'openInSystemPlayer'; href: string }
  /** 在访达/资源管理器中显示 */
  | { type: 'revealFile'; href: string }
  | {
      type: 'ingestBytes';
      id: string;
      /** 原始文件名（可选，剪贴板位图没有） */
      name?: string;
      mime: string;
      dataBase64: string;
    }
  | { type: 'requestCompatibleVideo'; id: string; href: string }
  | { type: 'requestLocalVideo' }
  | { type: 'requestPickMedia'; kind: 'video' | 'audio' }
  | { type: 'requestMediaUrl' }
  | { type: 'probeResult'; results: ProbeResult[] }
  /** 探针专用：测试 postMessage 能否直传二进制 */
  | { type: 'probeBinary'; payload: Uint8Array }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export function isHostMessage(value: unknown): value is HostToWebview {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

export const DEFAULT_WEBVIEW_CONFIG: WebviewConfig = {
  fontSize: 16,
  themeSetting: 'auto',
  readOnly: false,
  mediaAllowVideo: true,
  mathRejectNumericOnly: true,
  maxInlineUploadMB: 16,
  allowedExtensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'pdf', 'zip', 'docx', 'xlsx', 'pptx', 'csv', 'txt']
};
