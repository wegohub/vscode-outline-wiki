import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as ReactDOM from 'react-dom';
import type { ProbeResult, ProbeSpec, ThemeName, WebviewConfig } from '../shared/protocol.js';
import { ingestFile, log, onHostMessage, post, persistState, resolveIngest, savedState } from './api.js';
import { WikiEditor } from './Editor.js';
import { runProbe } from './probe.js';

interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

interface InitState {
  markdown: string;
  docRel: string;
  docTitle: string;
  sourceRel: string | null;
  config: WebviewConfig;
  missingRefs: string[];
}

interface Persisted {
  scrollTop?: number;
  docRel?: string;
}

export function App(): JSX.Element {
  const [empty, setEmpty] = useState<{ sourceRel: string | null; reason: string; canCreate: boolean } | null>(null);
  const [init, setInit] = useState<InitState | null>(null);
  const [external, setExternal] = useState<{ rev: number; markdown: string } | null>(null);
  const [insert, setInsert] = useState<{ token: number; markdown: string } | null>(null);
  const [theme, setTheme] = useState<ThemeName>('dark');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [saving, setSaving] = useState(false);

  const probeRef = useRef<{ editorMounted: boolean; editorDetail: string; binaryEcho: boolean | null }>({
    editorMounted: false,
    editorDetail: '编辑器还未挂载',
    binaryEcho: null
  });
  const insertTokenRef = useRef(0);
  const toastIdRef = useRef(0);

  const pushToast = useCallback((level: Toast['level'], message: string) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev.slice(-2), { id, level, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), level === 'error' ? 8000 : 3500);
  }, []);

  // ---------------------------------------------------------------- 宿主消息
  useEffect(() => {
    return onHostMessage((message) => {
      switch (message.type) {
        case 'inspectView':
          if (message.create) (document.querySelector('.ow-primary') as HTMLButtonElement | null)?.click();
          post({ type: 'viewSnapshot', id: message.id,
            sourceRel: document.querySelector('.ow-shell')?.getAttribute('data-source') ?? document.querySelector('.ow-empty-path')?.getAttribute('title') ?? null,
            canCreate: Boolean(document.querySelector('.ow-primary')),
            text: document.querySelector('.ProseMirror')?.textContent ?? '',
            overflow: document.documentElement.scrollWidth > window.innerWidth
          });
          break;
        case 'empty':
          setEmpty(message);
          setInit(null);
          break;
        case 'requestFlush': {
          const acknowledge = () => post({ type: 'flushed' });
          window.addEventListener('outline-wiki-flushed', acknowledge, { once: true });
          window.dispatchEvent(new Event('outline-wiki-flush'));
          break;
        }
        case 'init':
          setEmpty(null);
          setInit({
            markdown: message.markdown,
            docRel: message.docRel,
            docTitle: message.docTitle,
            sourceRel: message.sourceRel,
            config: message.config,
            missingRefs: message.missingRefs
          });
          setTheme(message.theme);
          if (message.missingRefs.length > 0) {
            pushToast('warn', `${message.missingRefs.length} 个资源文件不在磁盘上（网盘未同步？）`);
          }
          break;
        case 'externalUpdate':
          setExternal({ rev: message.rev, markdown: message.markdown });
          break;
        case 'insertMarkdown':
          insertTokenRef.current += 1;
          setInsert({ token: insertTokenRef.current, markdown: message.markdown });
          break;
        case 'theme':
          setTheme(message.theme);
          break;
        case 'notice':
          pushToast(message.level, message.message);
          break;
        case 'saved':
          setSaving(false);

          break;
        case 'ingestResult':
          if (!message.ok) pushToast('error', message.error ?? '入库失败');
          resolveIngest(message.id, message.ok, message.url, message.error);
          break;
        case 'binaryEcho': {
          const payload: unknown = message.payload;
          probeRef.current.binaryEcho = payload instanceof Uint8Array;
          post({ type: 'probeBinary', payload: new Uint8Array([1, 2, 3]) });
          break;
        }
        case 'runProbe':
          void handleProbe(message.probe);
          break;
        default:
          break;
      }
    });
  }, [pushToast]);

  const handleProbe = useCallback(
    async (spec: ProbeSpec) => {
      const results: ProbeResult[] = await runProbe(spec, {
        editorMounted: probeRef.current.editorMounted,
        editorDetail: probeRef.current.editorDetail,
        binaryEcho: probeRef.current.binaryEcho
      });
      post({ type: 'probeResult', results });
    },
    []
  );

  // 恢复滚动位置（retainContextWhenHidden 为 false，重建时靠 getState 恢复）
  useEffect(() => {
    if (!init) return;
    const saved = savedState<Persisted>();
    if (saved?.docRel === init.docRel && saved.scrollTop) {
      window.scrollTo({ top: saved.scrollTop });
    }
  }, [init]);

  useEffect(() => {
    let timer: number | undefined;
    const onScroll = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        persistState({ scrollTop: window.scrollY, docRel: init?.docRel } satisfies Persisted);
      }, 500);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (timer) window.clearTimeout(timer);
    };
  }, [init?.docRel]);

  useEffect(() => {
    document.body.dataset.theme = theme;
    document.body.classList.toggle('vscode-dark', theme === 'dark');
    document.body.classList.toggle('vscode-light', theme === 'light');
  }, [theme]);

  // 首次渲染时告知宿主：可以发 init 了
  const readySent = useRef(false);
  useEffect(() => {
    if (readySent.current) return;
    readySent.current = true;
    post({ type: 'ready' });
  }, []);

  // 编辑器里的 ⌘S → 先 flush 再让宿主保存（save 的语义完全交给 VS Code 原生通道）
  useEffect(() => {
    const onSaveEvent = (event: Event) => {
      const done = Boolean((event as CustomEvent<{ done?: boolean }>).detail?.done);
      post({ type: 'save', close: done });
    };
    window.addEventListener('outline-wiki-save', onSaveEvent);
    return () => window.removeEventListener('outline-wiki-save', onSaveEvent);
  }, []);

  useEffect(() => {
    const insertForProbe = (event: Event) => {
      setInsert({ token: ++insertTokenRef.current, markdown: String((event as CustomEvent).detail) });
    };
    window.addEventListener('outline-wiki-probe-insert', insertForProbe);
    return () => window.removeEventListener('outline-wiki-probe-insert', insertForProbe);
  }, []);

  const handleEditorMounted = useCallback((mounted: boolean, detail: string) => {
    probeRef.current.editorMounted = mounted;
    probeRef.current.editorDetail = detail;
  }, []);

  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const open = (event: Event) => post({ type: 'openExternally', href: String((event as CustomEvent).detail) });
    window.addEventListener('outline-wiki-open-webpage', open);
    return () => window.removeEventListener('outline-wiki-open-webpage', open);
  }, []);

  // 图片/文件的粘贴与拖放：只有拿到真正文件时才拦截，纯文本粘贴交给编辑器自己处理
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const pickFile = (list: DataTransfer | null): File | null => {
      if (!list) return null;
      const files = Array.from(list.files ?? []);
      if (files.length === 0) return null;
      return files.find((f) => f.type.startsWith('image/')) ?? files[0] ?? null;
    };

    const handle = (event: ClipboardEvent | DragEvent, list: DataTransfer | null) => {
      const uriList = list?.getData?.('text/uri-list') ?? '';
      if (uriList) log('info', `拖放提供了 text/uri-list：${uriList.slice(0, 200)}`);
      const file = pickFile(list);
      if (!file) return;
      event.preventDefault();
      event.stopPropagation();
      void ingestAndInsert(file);
    };

    const ingestAndInsert = async (file: File) => {
      try {
        const { href } = await ingestFile(file);
        const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(file.name);
        const label = file.name || '图片';
        const markdown = isImage ? `![${label}](${href})` : `[${href}](${href})`;
        insertTokenRef.current += 1;
        setInsert({ token: insertTokenRef.current, markdown });
      } catch (err) {
        pushToast('error', err instanceof Error ? err.message : String(err));
      }
    };

    const onPaste = (e: Event) => handle(e as ClipboardEvent, (e as ClipboardEvent).clipboardData);
    const onDrop = (e: Event) => handle(e as DragEvent, (e as DragEvent).dataTransfer);
    el.addEventListener('paste', onPaste, true);
    el.addEventListener('drop', onDrop, true);
    return () => {
      el.removeEventListener('paste', onPaste, true);
      el.removeEventListener('drop', onDrop, true);
    };
  }, [pushToast, init?.docRel]);

  if (empty) {
    return <div className="ow-empty">
      <div className="ow-empty-icon" aria-hidden="true">✎</div>
      <h2>{empty.canCreate ? '为这个文件写点笔记' : '文件 Wiki'}</h2>
      {empty.sourceRel && <span className="ow-empty-path" title={empty.sourceRel} hidden />}
      <p>{empty.reason}</p>
      {empty.canCreate && <button className="ow-primary" onClick={() => post({ type: 'createWiki' })}>创建 Wiki</button>}
    </div>;
  }

  if (!init) {
    return (
      <div className="ow-loading">
        <div className="ow-spinner" />
        <p>正在加载 Wiki 文档…</p>
      </div>
    );
  }

  return (
    <div className="ow-shell" data-theme={theme} data-source={init.sourceRel}>
        {init.missingRefs.length > 0 && (
          <button
            type="button"
            className="ow-warn"
            title={init.missingRefs.join('\n')}
            onClick={() => pushToast('warn', `缺失：${init.missingRefs.slice(0, 3).join('、')}${init.missingRefs.length > 3 ? ' …' : ''}`)}
          >
            {init.missingRefs.length} 个资源缺失（可能未从网盘同步）
          </button>
        )}


      <div className="ow-body" ref={containerRef} style={{ fontSize: `${init.config.fontSize}px` }}>
        <WikiEditor
          config={init.config}
          theme={theme}
          defaultValue={init.markdown}
          external={external}
          insert={insert}
          saving={saving}
          onEditorMounted={handleEditorMounted}
          onRequestSave={() => setSaving(true)}
          onOpenLink={(href) => post({ type: 'openLink', href })}
          onOpenExternally={(href) => post({ type: 'openInSystemPlayer', href })}
          onReveal={(href) => post({ type: 'revealFile', href })}
          onEdit={(markdown, rev) => post({ type: 'edit', rev, markdown })}
          onFlush={(markdown, rev) => post({ type: 'flush', rev, markdown })}
          onLog={log}
          onToast={(level, message) => pushToast(level, message)}
        />
      </div>

      <div className="ow-toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`ow-toast ow-toast-${t.level}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

// React 17：用 ReactDOM.render（库内部也依赖 React 17 的这套 API，不要改成 createRoot）
const container = document.getElementById('outline-wiki-root');
if (container) {
  ReactDOM.render(<App />, container);
} else {
  post({ type: 'log', level: 'error', message: '找不到 #outline-wiki-root 挂载点' });
}
