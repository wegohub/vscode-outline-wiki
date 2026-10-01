import type { HostToWebview, WebviewToHost } from '../shared/protocol.js';

/** `acquireVsCodeApi()` 每个 session 只能调用一次，必须在模块作用域拿 */
const vscodeApi = acquireVsCodeApi();

export function post(message: WebviewToHost): void {
  const boot = (window as unknown as { __OUTLINE_WIKI__?: { sessionId?: string } }).__OUTLINE_WIKI__;
  vscodeApi.postMessage({ ...message, sessionId: boot?.sessionId });
}

export function log(level: 'info' | 'warn' | 'error', message: string): void {
  post({ type: 'log', level, message });
}

export type HostListener = (message: HostToWebview) => void;

export function onHostMessage(listener: HostListener): () => void {
  const handler = (event: MessageEvent) => {
    const data = event.data as HostToWebview | undefined;
    const expected = (window as unknown as { __OUTLINE_WIKI__?: { sessionId?: string } }).__OUTLINE_WIKI__?.sessionId;
    if (data && expected && (data as { sessionId?: string }).sessionId === expected && typeof (data as { type?: unknown }).type === 'string') {
      listener(data);
    }
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

export function savedState<T>(): T | undefined {
  // @types/vscode-webview 的 getState() 返回 unknown，这里由调用方保证形状
  return vscodeApi.getState() as T | undefined;
}

export function persistState(state: unknown): void {
  vscodeApi.setState(state);
}

// ------------------------------------------------------------------ 入库

interface PendingIngest {
  resolve: (href: string) => void;
  reject: (error: Error) => void;
}

const pendingIngests = new Map<string, PendingIngest>();

export function resolveIngest(id: string, ok: boolean, href?: string, error?: string): void {
  const entry = pendingIngests.get(id);
  if (!entry) return;
  pendingIngests.delete(id);
  if (ok && href) entry.resolve(href);
  else entry.reject(new Error(error ?? '入库失败'));
}

export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 把 webview 手里（剪贴板/拖放）的字节交给宿主落盘。
 * 磁盘写入只能在扩展宿主执行，跨这道边界走 postMessage（本地进程间通信，不是网络）。
 * 超限时宿主会回一条明确指引，让用户改走"引用 static/ 已有文件"的路径。
 */
export function ingestFile(file: File): Promise<{ href: string; name: string }> {
  const id = uuid();
  const name = file.name || '';
  return file.arrayBuffer().then(
    (buffer) =>
      new Promise<{ href: string; name: string }>((resolve, reject) => {
        pendingIngests.set(id, { resolve: (href) => resolve({ href, name }), reject });
        post({
          type: 'ingestBytes',
          id,
          name: name || undefined,
          mime: file.type || '',
          dataBase64: toBase64(buffer)
        });
      })
  );
}


const videoRequests = new Map<string, { resolve: (href: string) => void; reject: (error: Error) => void; timer: number }>();
onHostMessage(message => {
  if (message.type !== 'compatibleVideoResult') return;
  const request = videoRequests.get(message.id);
  if (!request) return;
  clearTimeout(request.timer);
  videoRequests.delete(message.id);
  if (message.href) request.resolve(message.href);
  else request.reject(new Error(message.error ?? '无法准备播放缓存'));
});
export function prepareCompatibleVideo(href: string): Promise<string> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { videoRequests.delete(id); reject(new Error('播放缓存处理超时，请使用外部播放。')); }, 310000);
    videoRequests.set(id, { resolve, reject, timer });
    post({ type: 'requestCompatibleVideo', id, href });
  });
}
