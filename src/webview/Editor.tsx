import * as React from 'react';
import RichMarkdownEditor, { theme as defaultTheme } from 'rich-markdown-editor';
import { dark as darkTheme } from 'rich-markdown-editor/dist/styles/theme.js';
import { TextSelection } from 'prosemirror-state';
import { Slice } from 'prosemirror-model';
import type { ThemeName, WebviewConfig } from '../shared/protocol.js';
import { localVideoExtension } from './extensions/slash-menu.js';
import { ingestFile } from './api.js';
import { zhDictionary } from './dictionary.zh.js';
import { buildEmbeds } from './embeds/media.js';
import { buildMathExtensions } from './extensions/math.js';
import { buildMermaidExtension, refreshMermaid } from './extensions/mermaid.js';

export interface WikiEditorProps {
  config: WebviewConfig;
  theme: ThemeName;
  defaultValue: string;
  /** 外部改动（git checkout / 网盘 / 其它编辑器）——只有这里才用 value 重建编辑器状态 */
  external: { rev: number; markdown: string } | null;
  insert: { token: number; markdown: string } | null;
  saving: boolean;
  onEditorMounted: (mounted: boolean, detail: string) => void;
  onRequestSave: () => void;
  onOpenLink: (href: string) => void;
  onOpenExternally: (href: string) => void;
  onReveal: (href: string) => void;
  onEdit: (markdown: string, rev: number) => void;
  onFlush: (markdown: string, rev: number) => void;
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  onToast: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * rich-markdown-editor（Outline 官方发布的编辑器组件）的封装。
 *
 * 关键约束：
 *  - React 17：库内部多处调用 ReactDOM.render，React 19 会直接崩
 *  - 只有外部改动才传 `value`（库会重建 state 并重置光标），常规输入一律走 onChange
 *  - 全量替换是 last-writer-wins，所以宿主那侧还有版本基线与冲突提示
 */
export function WikiEditor(props: WikiEditorProps): JSX.Element {
  const propsRef = React.useRef(props);
  propsRef.current = props;
  const editorRef = React.useRef<RichMarkdownEditor | null>(null);
  const debounceRef = React.useRef<number | undefined>(undefined);
  const lastSentRef = React.useRef<string>(props.defaultValue);
  const revRef = React.useRef(0);

  const embeds = React.useMemo(
    () =>
      buildEmbeds({
        onOpenExternally: props.onOpenExternally,
        onReveal: props.onReveal,
        onToast: props.onToast
      }),
    [props.onOpenExternally, props.onReveal, props.onToast]
  );

  const send = React.useCallback(
    (getValue: () => string, immediate: boolean) => {
      const markdown = getValue();
      if (markdown === lastSentRef.current) return;
      lastSentRef.current = markdown;
      const rev = ++revRef.current;
      if (immediate) propsRef.current.onFlush(markdown, rev);
      else propsRef.current.onEdit(markdown, rev);
    },
    []
  );

  const schedule = React.useCallback(
    (getValue: () => string) => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = undefined;
        send(getValue, false);
      }, 200);
    },
    [send]
  );

  const flush = React.useCallback(() => {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
    }
    const editor = editorRef.current;
    if (!editor) return;
    try {
      send(() => editor.value(), true);
    } catch (err) {
      propsRef.current.onLog('warn', `flush 失败：${String(err)}`);
    }
  }, [send]);

  // 关标签/隐藏前尽力把最后一次编辑送出去
  React.useEffect(() => {
    const onBeforeUnload = () => flush();
    const onRequestFlush = () => { flush(); window.dispatchEvent(new Event('outline-wiki-flushed')); };
    const onRead = (event: Event) => {
      const receive = (event as CustomEvent<{ receive: (markdown: string) => void }>).detail.receive;
      if (editorRef.current) receive(editorRef.current.value());
    };
    const onProbeMenu = (event: Event) => {
      const editor = editorRef.current;
      if (!editor) return;
      const search = String((event as CustomEvent).detail);
      const view = (editor as unknown as { view: { state: any; dispatch: (tr: any) => void; focus: () => void } }).view;
      const tr = view.state.tr.insert(view.state.doc.content.size, view.state.schema.nodes.paragraph.create());
      tr.setSelection(TextSelection.atEnd(tr.doc)).insertText(`/${search}`);
      view.dispatch(tr);
      view.focus();
      editor.handleOpenBlockMenu(search);
    };
    window.addEventListener('outline-wiki-probe-menu', onProbeMenu);
    window.addEventListener('outline-wiki-read', onRead);
    window.addEventListener('outline-wiki-flush', onRequestFlush);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('outline-wiki-flush', onRequestFlush);
      window.removeEventListener('outline-wiki-read', onRead);
      window.removeEventListener('outline-wiki-probe-menu', onProbeMenu);
      flush();
    };
  }, [flush]);

  // 挂载检测（探针用）：确认 .ProseMirror 真的渲染出来了
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const el = document.querySelector('.ProseMirror');
      const text = el?.textContent ?? '';
      props.onEditorMounted(
        Boolean(el) && text.length > 0,
        el ? `ProseMirror 已渲染，文本长度 ${text.length}` : '未找到 .ProseMirror 元素'
      );
    }, 700);
    return () => window.clearTimeout(timer);
  }, [props.onEditorMounted]);

  // 宿主插入内容（插入视频/播放链接/图片）
  React.useEffect(() => {
    if (!props.insert) return;
    const editor = editorRef.current as unknown as {
      view?: { state: { tr: { replaceSelection: (s: Slice) => { scrollIntoView: () => unknown } } }; dispatch: (t: unknown) => void; focus: () => void };
      parser?: { parse: (md: string) => { content: unknown } };
    } | null;
    if (!editor?.view || !editor.parser) {
      props.onLog('warn', '插入失败：编辑器实例还没准备好');
      return;
    }
    try {
      const parsed = editor.parser.parse(props.insert.markdown);
      // Image/Embed 有 content，但仍是不可拆开的媒体节点；maxOpen 会把它们打开并丢弃。
      const content = parsed.content as { firstChild?: { type: { name: string } }; lastChild?: { type: { name: string } } };
      const slice = new Slice(parsed.content as never, content.firstChild?.type.name === 'paragraph' ? 1 : 0,
        content.lastChild?.type.name === 'paragraph' ? 1 : 0);
      const tr = editor.view.state.tr.replaceSelection(slice);
      editor.view.dispatch(tr.scrollIntoView());
      editor.view.focus();
      const getValue = (editorRef.current as unknown as { value: () => string }).value;
      if (typeof getValue === 'function') send(() => getValue.call(editorRef.current), true);
    } catch (err) {
      props.onLog('error', `插入失败：${String(err)}`);
    }
  }, [props.insert, send]);

  /** 数学公式（math_inline/math_block）与 mermaid 预览：只用扩展口子，不动库的 schema/serializer */
  const extensions = React.useMemo(
    () => [...buildMathExtensions(() => props.config.mathRejectNumericOnly), buildMermaidExtension(), localVideoExtension()],
    [props.config.mathRejectNumericOnly]
  );

  // 主题变化 → mermaid 需要按新主题重渲染（清缓存 + 让插件重建 decorations）
  const firstTheme = React.useRef(true);
  React.useEffect(() => {
    if (firstTheme.current) {
      firstTheme.current = false;
      return;
    }
    const editor = editorRef.current as unknown as { view?: Parameters<typeof refreshMermaid>[0] } | null;
    if (editor?.view) refreshMermaid(editor.view);
  }, [props.theme]);

  const uploadImage = React.useCallback(async (file: File) => {
    const { href } = await ingestFile(file);
    return href;
  }, []);

  React.useEffect(() => {
    if (props.external) lastSentRef.current = props.external.markdown;
  }, [props.external]);

  const editorTheme = React.useMemo(() => ({
    ...(props.theme === 'dark' ? darkTheme : defaultTheme),
    background: 'var(--ow-bg)', text: 'var(--ow-fg)', cursor: 'var(--ow-fg)',
    fontFamily: 'var(--vscode-font-family, -apple-system, sans-serif)',
    fontFamilyMono: 'var(--vscode-editor-font-family, monospace)',
    link: 'var(--ow-accent)', placeholder: 'var(--ow-muted)', textSecondary: 'var(--ow-muted)',
    divider: 'var(--ow-border)', horizontalRule: 'var(--ow-border)',
    code: 'var(--ow-fg)', codeBackground: 'var(--vscode-textCodeBlock-background, rgba(128,128,128,.1))',
    codeBorder: 'var(--ow-border)', quote: 'var(--ow-muted)',
    toolbarBackground: 'var(--vscode-editorWidget-background, var(--ow-bg))',
    toolbarItem: 'var(--ow-fg)', toolbarHoverBackground: 'var(--vscode-list-hoverBackground)',
    toolbarInput: 'var(--vscode-input-background)',
    blockToolbarBackground: 'var(--vscode-editorWidget-background, var(--ow-bg))',
    blockToolbarText: 'var(--ow-fg)', blockToolbarItem: 'var(--ow-fg)',
    blockToolbarHoverBackground: 'var(--vscode-list-hoverBackground)',
    tableDivider: 'var(--ow-border)'
  }), [props.theme]);

  const editor = (
    <RichMarkdownEditor
      ref={editorRef as never}
      defaultValue={props.defaultValue}
      value={props.external?.markdown}
      placeholder={zhDictionary.placeholder}
      readOnly={props.config.readOnly}
      dark={props.theme === 'dark'}
      theme={editorTheme}
      dictionary={zhDictionary as never}
      embeds={embeds as never}
      extensions={extensions as never}
      uploadImage={uploadImage}
      autoFocus={false}
      onChange={(getValue: () => string) => schedule(getValue)}
      onBlur={() => flush()}
      onSave={({ done }: { done: boolean }) => {
        flush();
        props.onRequestSave();
        // 交给主组件发 save 消息（这里只负责 flush 与状态）
        window.dispatchEvent(new CustomEvent('outline-wiki-save', { detail: { done } }));
      }}
      onClickLink={(href: string, event: MouseEvent) => {
        event?.preventDefault?.();
        props.onOpenLink(href);
      }}
      onShowToast={(message: string, code: string) => props.onToast(code === 'error' ? 'error' : 'info', message)}
      onSearchLink={async () => []}
    />
  );

  return <EditorErrorBoundary onLog={props.onLog}>{editor}</EditorErrorBoundary>;
}

interface BoundaryProps {
  children: React.ReactNode;
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
}

interface BoundaryState {
  error: Error | null;
}

/** 库已归档，Webview 里出问题时要能看到真实原因，而不是白屏 */
class EditorErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.props.onLog('error', `编辑器渲染失败：${error.message}\n${info.componentStack ?? ''}`);
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="ow-fatal">
          <h2>Outline 编辑器渲染失败</h2>
          <pre>{this.state.error.message}</pre>
          <p>
            文档内容仍然安全地存在磁盘上。可以先用 VS Code 的「Reopen With → Text Editor」查看源码，
            并把这段报错反馈出来。
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
