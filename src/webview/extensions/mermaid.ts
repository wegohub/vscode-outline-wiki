import { Plugin, PluginKey } from 'prosemirror-state';
import { log } from '../api.js';
import { Decoration, DecorationSet } from 'prosemirror-view';

/**
 * mermaid 渲染：ProseMirror 插件 + widget decoration。
 *
 * 刻意**不改 schema / serializer / parser** —— 磁盘上仍是普通的 ```mermaid 代码块，
 * 图只是一个挂在围栏后面的 widget。这样往返无损，将来迁到现役 Outline 也不丢内容。
 *
 * mermaid 本体是独立的懒加载 chunk（webview 是不透明源，不能用 dynamic import，
 * 因此用 `<script src=asWebviewUri(...)>` 注入；地址由宿主在 HTML 里注入到 window.__OUTLINE_WIKI__）。
 */

export const MERMAID_REFRESH_META = 'outlineWikiMermaidRefresh';
const key = new PluginKey<DecorationSet>('outlineWikiMermaidChunk');

const CACHE_LIMIT = 40;
let diagLogged = false;
const cache = new Map<string, string>(); // 源码哈希 -> SVG/错误 HTML

let mermaidPromise: Promise<unknown> | null = null;

function assetUrl(): string | undefined {
  return (window as unknown as { __OUTLINE_WIKI__?: { mermaid?: string } }).__OUTLINE_WIKI__?.mermaid;
}

function loadMermaid(): Promise<unknown> {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = new Promise((resolve, reject) => {
    const url = assetUrl();
    if (!url) {
      reject(new Error('没有拿到 mermaid chunk 地址'));
      return;
    }
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => {
      const mermaid = (window as unknown as { mermaid?: unknown }).mermaid;
      if (mermaid) {
        (mermaid as { initialize: (o: unknown) => void }).initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: document.body.dataset.theme === 'dark' ? 'dark' : 'default',
          fontFamily: 'inherit'
        });
        resolve(mermaid);
      } else {
        reject(new Error('mermaid chunk 已加载但没有挂到 window.mermaid'));
      }
    };
    script.onerror = () => reject(new Error('mermaid chunk 加载失败'));
    document.head.appendChild(script);
  });
  return mermaidPromise;
}

function hash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return `${h}:${text.length}`;
}

function putCache(k: string, value: string): void {
  if (cache.size >= CACHE_LIMIT) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(k, value);
}

let renderSeq = 0;

/** 把 SVG（或错误信息）灌进 widget 容器；同一个容器只渲染一次 */
function renderInto(host: HTMLElement, source: string, theme: string): void {
  const cacheKey = `${theme}|${hash(source)}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    host.innerHTML = cached;
    host.dataset.state = 'done';
    return;
  }
  host.dataset.state = 'loading';
  host.innerHTML = '<div class="ow-mermaid-loading">正在渲染 mermaid…</div>';

  void loadMermaid()
    .then(async (mermaid) => {
      const api = mermaid as { render: (id: string, text: string) => Promise<{ svg: string }> };
      const id = `ow-mermaid-${++renderSeq}`;
      try {
        const { svg } = await api.render(id, source);
        putCache(cacheKey, svg);
        if (host.isConnected) {
          host.innerHTML = svg;
          host.dataset.state = 'done';
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const html = `<div class="ow-mermaid-error"><strong>mermaid 语法错误</strong><pre>${escapeHtml(message)}</pre><code></code></div>`;
        putCache(cacheKey, html);
        if (host.isConnected) {
          host.innerHTML = html;
          host.dataset.state = 'error';
        }
      }
    })
    .catch((err: unknown) => {
      if (host.isConnected) {
        const message = err instanceof Error ? err.message : String(err);
        host.innerHTML = `<div class="ow-mermaid-error"><strong>mermaid 未加载</strong><pre>${escapeHtml(message)}</pre></div>`;
        host.dataset.state = 'error';
      }
    });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
}

function buildDecorations(doc: { descendants: (fn: (node: any, pos: number) => void) => void }): DecorationSet {
  const theme = document.body.dataset.theme === 'dark' ? 'dark' : 'default';
  const decorations: Decoration[] = [];

  doc.descendants((node: any, pos: number) => {
    // 真机实测：这个库把 ``` 围栏解析成 `code_block`（语言仍在 attrs.language），
    // 与 `code_fence` 两种都要认，否则装饰器永远插不上。
    if (node.type.name !== 'code_fence' && node.type.name !== 'code_block') return;
    const language = String(node.attrs?.language ?? '').toLowerCase();
    if (language !== 'mermaid' && language !== 'mermaidjs') return;
    const host = document.createElement('div');
    host.className = 'ow-mermaid';
    host.setAttribute('contenteditable', 'false');
    const source = node.textContent;
    // widget 的 DOM 由我们自己管：创建后立刻渲染（缓存命中时是同步的）
    queueMicrotask(() => renderInto(host, source, theme));
    decorations.push(Decoration.widget(pos + node.nodeSize, host, { side: 1 }));
  });
  // 一个围栏都没找到时，把节点序列打给宿主日志（只打一次），便于一眼定位
  if (decorations.length === 0 && !diagLogged) {
    diagLogged = true;
    const seen: string[] = [];
    doc.descendants((node: any) => {
      if (seen.length < 25) seen.push(`${node.type.name}${node.attrs?.language ? ':' + node.attrs.language : ''}`);
    });
    const hasAnyFence = seen.some((s) => s.startsWith('code_block') || s.startsWith('code_fence'));
    if (hasAnyFence) log('warn', `[mermaid] 文档里有代码围栏但语言不是 mermaid：${seen.join(', ')}`);
  }
  return DecorationSet.create(doc as never, decorations);
}

export function buildMermaidExtension(): unknown {
  return {
    type: 'extension',
    name: 'mermaid-preview',
    bindEditor() {
      /* ExtensionManager 构造时会对每个扩展无条件调用 bindEditor，必须存在 */
    },

    get plugins() {
      return [
        new Plugin({
          key,
          state: {
            init: (_config: unknown, state: { doc: unknown }) => buildDecorations(state.doc as never),
            apply: (tr: any, value: DecorationSet) => {
              if (tr.docChanged || tr.getMeta(MERMAID_REFRESH_META)) return buildDecorations(tr.doc as never);
              return value.map(tr.mapping, tr.doc);
            }
          },
          props: {
            decorations: (state: unknown) => key.getState(state as never)
          }
        })
      ];
    }
  };
}

/** 主题切换时清缓存并请求重建（由 Editor 在主题变化时调用） */
export function refreshMermaid(view: { dispatch: (tr: unknown) => void; state: { tr: { setMeta: (k: string, v: unknown) => unknown } } }): void {
  cache.clear();
  view.dispatch(view.state.tr.setMeta(MERMAID_REFRESH_META, true));
}
