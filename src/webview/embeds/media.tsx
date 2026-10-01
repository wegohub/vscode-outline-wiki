import * as React from 'react';
import { GlobeIcon } from 'outline-icons';
import { VideoPlayer } from './videoPlayer.js';
import type { EmbedDescriptor } from 'rich-markdown-editor/dist/types';

/**
 * 媒体/附件 embed。
 *
 * markdown 形态是库内建的"简单链接" `[href](href)`（链接文本等于目标）——往返无损，
 * 在别的 Markdown 工具里就是一条可点链接；带标题的 `[演示](path)` 不会被识别为 embed。
 *
 * ⚠️ 与 nodeView 同一个约束：embed 的 component 也被库当**普通函数**调用，
 * 所以这里同样是**无 hook** 的纯函数组件；"不支持该编码"的兜底用命令式 DOM 换入。
 */

const MEDIA_RE = /\.(mp4|m4v|mov|webm|mkv|avi|mp3|m4a|aac|wav|flac|ogg|opus)(?:[?#].*)?$/i;
const FILE_RE = /\.(pdf|zip|docx|xlsx|pptx|csv|txt)(?:[?#].*)?$/i;
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'];
const MEDIA_ERR_NOT_SUPPORTED = 4;

export interface BuildEmbedsOptions {
  onOpenExternally: (href: string) => void;
  onReveal: (href: string) => void;
  onToast: (level: 'info' | 'warn' | 'error', message: string) => void;
}

interface CardProps {
  attrs: { href: string; matches?: RegExpMatchArray | null };
  isEditable?: boolean;
  isSelected?: boolean;
}

function pathOf(href: string): string {
  return href.split('#')[0]?.split('?')[0] ?? href;
}

function extOf(href: string): string {
  return (pathOf(href).match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
}

function labelOf(href: string): string {
  const path = pathOf(href);
  try {
    return decodeURIComponent(new URL(path, document.baseURI).pathname.split('/').pop() ?? path);
  } catch {
    return path.split('/').pop() ?? path;
  }
}

export function buildEmbeds(options: BuildEmbedsOptions): EmbedDescriptor[] {
  return [
    {
      title: '视频 / 音频',
      keywords: 'video audio media mp4 mov webm mkv mp3 wav 视频 音频',
      matcher: (url: string) => MEDIA_RE.test(pathOf(url)) && (url.match(MEDIA_RE) as RegExpMatchArray | null),
      component: (props: unknown) => <MediaCard {...(props as CardProps)} options={options} />
    },
    {
      title: '网页嵌入',
      keywords: 'embed iframe web webpage 网页 嵌入',
      icon: GlobeIcon,
      matcher: (url: string) => {
        try {
          const parsed = new URL(url);
          return ['https:', 'http:'].includes(parsed.protocol) && !MEDIA_RE.test(pathOf(url)) && !FILE_RE.test(pathOf(url));
        } catch { return false; }
      },
      component: (props: unknown) => <WebPageCard {...(props as CardProps)} />
    },
    {
      title: '附件',
      keywords: 'file attachment pdf zip doc 附件',
      matcher: (url: string) => FILE_RE.test(pathOf(url)) && (url.match(FILE_RE) as RegExpMatchArray | null),
      component: (props: unknown) => <FileCard {...(props as CardProps)} options={options} />
    }
  ] as EmbedDescriptor[];
}

/** 用 DOM 直接构造兜底卡片（不能依赖 React state，见文件头说明） */
function buildFallback(href: string, name: string, message: string, options: BuildEmbedsOptions): HTMLElement {
  const box = document.createElement('div');
  box.className = 'ow-media-fallback';
  const title = document.createElement('div');
  title.className = 'ow-media-fallback-title';
  title.textContent = name;
  const detail = document.createElement('div');
  detail.className = 'ow-media-fallback-detail';
  detail.textContent = message;
  const actions = document.createElement('div');
  actions.className = 'ow-media-fallback-actions';
  const mk = (label: string, fn: () => void) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', (e) => {
      e.preventDefault();
      fn();
    });
    return button;
  };
  actions.append(
    mk('用系统播放器打开', () => options.onOpenExternally(href)),
    mk('在访达/资源管理器中显示', () => options.onReveal(href))
  );
  const code = document.createElement('code');
  code.className = 'ow-media-path';
  code.textContent = href;
  actions.append(code);
  box.append(title, detail, actions);
  return box;
}

function MediaCard({ attrs, options }: CardProps & { options: BuildEmbedsOptions }): JSX.Element {
  const href = attrs.href;
  const name = labelOf(href);
  const isAudio = AUDIO_EXT.includes(extOf(href));
  const onError = (event: React.SyntheticEvent<HTMLMediaElement>) => {
    const media = event.currentTarget;
    const code = media.error?.code;
    const detail =
      code === MEDIA_ERR_NOT_SUPPORTED
        ? 'VS Code 内置解码器不支持该编码（例如 AC3/DTS 音轨、VC-1/WMV 容器）'
        : '播放失败（media error code ' + String(code ?? 'unknown') + '）';
    const host = media.closest('.ow-media');
    if (host instanceof HTMLElement) host.replaceWith(buildFallback(href, name, detail, options));
    options.onToast('warn', name + '：' + detail);
  };
  return (
    <div className={'ow-media' + (isAudio ? ' ow-media-audio' : '')} contentEditable={false}>
      <div className="ow-media-head">
        <span className="ow-media-name" title={href}>
          {name}
        </span>
        <span className="ow-media-actions">
          <button type="button" title="用系统播放器打开" onClick={() => options.onOpenExternally(href)}>
            外部播放
          </button>
        </span>
      </div>
      {isAudio ? (
        <audio controls preload="metadata" src={href} onError={onError} />
      ) : (
        <VideoPlayer href={href} onError={onError} />
      )}
    </div>
  );
}

function FileCard({ attrs, options }: CardProps & { options: BuildEmbedsOptions }): JSX.Element {
  const href = attrs.href;
  const name = labelOf(href);
  return (
    <div className="ow-file-card" contentEditable={false}>
      <span className="ow-file-badge">{(extOf(href) || 'file').toUpperCase()}</span>
      <span className="ow-file-name" title={href}>
        {name}
      </span>
      <span className="ow-file-actions">
        <a
          href={href}
          onClick={(event) => {
            event.preventDefault();
            options.onOpenExternally(href);
          }}
        >
          打开
        </a>
      </span>
    </div>
  );
}


/** iframe 是独立网页，不使用父 webview API，也不导航扩展本身。 */
function WebPageCard({ attrs }: CardProps): JSX.Element {
  return <div className="ow-webpage" contentEditable={false}>
    <div className="ow-webpage-head"><span title={attrs.href}>{new URL(attrs.href).hostname}</span>
      <a href={attrs.href} onClick={event => { event.preventDefault(); window.dispatchEvent(new CustomEvent('outline-wiki-open-webpage', { detail: attrs.href })); }}>在浏览器打开 ↗</a>
    </div>
    <iframe title={`网页：${attrs.href}`} src={attrs.href} loading="lazy" referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-forms allow-presentation" allowFullScreen />
  </div>;
}
