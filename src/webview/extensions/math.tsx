import * as React from 'react';
import katex from 'katex';

/**
 * 数学公式：真节点（math_inline / math_block），markdown 形态与现役 Outline 一致
 * （`$…$` / `$$…$$`），因此文档在 GitHub/其它工具里也能渲染。
 *
 * ⚠️ 真机踩到的关键约束：库的 `ComponentView` 把 `component` 当**普通函数**调用，
 * 因此 nodeView 组件里**绝对不能用 React hooks**（会抛 Invalid hook call，把整个编辑器搞挂）。
 * 所以这里是纯函数组件：编辑态用命令式 DOM 换入 textarea，提交后由 ProseMirror 事务重建 nodeView。
 */

const INLINE = 'math_inline';
const BLOCK = 'math_block';

function looksLikeMoney(content: string): boolean {
  return /^[\d\s.,]+$/.test(content);
}

interface MdItLike {
  inline: { ruler: { before: (anchor: string, name: string, fn: unknown) => void } };
  block: { ruler: { before: (anchor: string, name: string, fn: unknown) => void } };
}

function installRules(rejectNumericOnly: () => boolean) {
  return [
    (md: unknown) => {
      const tokenizer = md as MdItLike;

      // 行内：$…$，要求开 $ 后非空白、闭 $ 前非空白、内容非空、不跨行
      tokenizer.inline.ruler.before('emphasis', INLINE, (state: any, silent: boolean) => {
        const start = state.pos;
        if (state.src.charCodeAt(start) !== 0x24) return false;
        const next = state.src.charCodeAt(start + 1);
        if (Number.isNaN(next) || next === 0x20 || next === 0x09) return false;
        let end = -1;
        for (let i = start + 1; i < state.posMax; i++) {
          const ch = state.src.charCodeAt(i);
          if (ch === 0x0a) break;
          if (ch === 0x5c) {
            i++;
            continue;
          }
          if (ch === 0x24) {
            end = i;
            break;
          }
        }
        if (end < 0 || end === start + 1) return false;
        const prev = state.src.charCodeAt(end - 1);
        if (prev === 0x20 || prev === 0x09) return false;
        const content = state.src.slice(start + 1, end);
        if (content.trim().length === 0) return false;
        if (rejectNumericOnly() && looksLikeMoney(content)) return false;
        if (!silent) {
          const token = state.push(INLINE, '', 0);
          token.content = content;
          token.markup = '$';
        }
        state.pos = end + 1;
        return true;
      });

      // 块级：行首 $$ 到闭合 $$（也接受单行 $$x$$）
      tokenizer.block.ruler.before('fence', BLOCK, (state: any, startLine: number, endLine: number, silent: boolean) => {
        const begin = state.bMarks[startLine] + state.tShift[startLine];
        const max = state.eMarks[startLine];
        if (state.src.slice(begin, begin + 2) !== '$$') return false;

        let content = '';
        let nextLine = startLine;
        const rest = state.src.slice(begin + 2, max).trim();
        if (rest.endsWith('$$') && rest.length > 2) {
          content = rest.slice(0, -2).trim();
        } else {
          const lines: string[] = rest.length > 0 ? [rest] : [];
          let closed = false;
          nextLine = startLine + 1;
          for (; nextLine < endLine; nextLine++) {
            const lineBegin = state.bMarks[nextLine] + state.tShift[nextLine];
            const lineEnd = state.eMarks[nextLine];
            const line = state.src.slice(lineBegin, lineEnd);
            if (line.trim() === '$$') {
              closed = true;
              break;
            }
            lines.push(line);
          }
          if (!closed) return false;
          content = lines.join('\n').trim();
        }
        if (content.length === 0) return false;

        if (!silent) {
          const token = state.push(BLOCK, 'div', 0);
          token.content = content;
          token.markup = '$$';
          token.map = [startLine, nextLine + 1];
          state.line = nextLine + 1;
        }
        return true;
      });
    }
  ];
}

interface NodeProps {
  node: { type: { name: string }; textContent: string; attrs: { source?: string }; nodeSize: number };
  isEditable?: boolean;
  isSelected?: boolean;
  view?: {
    state: {
      schema: { text: (t: string) => unknown };
      tr: { replaceWith: (a: number, b: number, n: unknown) => { scrollIntoView: () => unknown } };
    };
    dispatch: (tr: unknown) => void;
    focus: () => void;
  };
  getPos?: () => number;
}

function startEditing(host: HTMLElement, props: NodeProps, source: string, rows: number): void {
  const original = host.innerHTML;
  const textarea = document.createElement('textarea');
  textarea.className = 'ow-math-input';
  textarea.rows = rows;
  textarea.value = source;
  host.innerHTML = '';
  host.appendChild(textarea);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const next = textarea.value;
    host.innerHTML = original;
    if (!commit || next === source) return;
    const { view, getPos } = props;
    if (!view || !getPos) return;
    const pos = getPos();
    const type = props.node.type as unknown as { create: (attrs: unknown, content?: unknown) => unknown };
    const node = type.create({ source: next });
    view.dispatch(view.state.tr.replaceWith(pos, pos + props.node.nodeSize, node).scrollIntoView());
    view.focus();
  };

  textarea.addEventListener('blur', () => finish(true));
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      finish(true);
    }
  });
}

/** 无 hook 的纯函数组件（见文件头说明） */
function FormulaView(props: NodeProps): JSX.Element {
  const display = props.node.type.name === BLOCK;
  const source = props.node.attrs.source ?? props.node.textContent;
  let html: string | null = null;
  try {
    html = katex.renderToString(source, { displayMode: display, throwOnError: true, output: 'html' });
  } catch {
    html = null;
  }

  return (
    <span
      className={`ow-math${display ? ' ow-math-block' : ''}${props.isSelected ? ' is-selected' : ''}`}
      contentEditable={false}
      title={props.isEditable ? '点击编辑公式（⌘⏎ 完成 / Esc 取消）' : source}
      onClick={(event: React.MouseEvent<HTMLSpanElement>) => {
        if (props.isEditable) startEditing(event.currentTarget, props, source, display ? 3 : 1);
      }}
    >
      {html !== null ? (
        <span className="ow-math-render" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <span className="ow-math-error">
          <code>{source}</code>
          <em>公式语法有误</em>
        </span>
      )}
    </span>
  );
}

/** 返回两个节点扩展 + 一个承载 markdown-it 规则的扩展 */
export function buildMathExtensions(rejectNumericOnly: () => boolean): unknown[] {
  const bindEditor = () => {
    /* ExtensionManager 构造时会对每个扩展无条件调用，必须存在 */
  };

  const inlineNode = {
    type: 'node',
    name: INLINE,
    bindEditor,
    get schema() {
      return { inline: true, group: 'inline', atom: true, attrs: { source: { default: '' } }, marks: '' };
    },
    component: FormulaView,
    toMarkdown(state: any, node: any) {
      state.write(`$${(node.attrs.source ?? node.textContent)}$`);
    },
    parseMarkdown() {
      return { node: INLINE, noCloseToken: true, getAttrs: (token: { content: string }) => ({ source: token.content }) };
    }
  };

  const blockNode = {
    type: 'node',
    name: BLOCK,
    bindEditor,
    get schema() {
      return { group: 'block', atom: true, attrs: { source: { default: '' } }, marks: '' };
    },
    component: FormulaView,
    toMarkdown(state: any, node: any) {
      state.ensureNewLine();
      state.write('$$\n');
      state.write(node.attrs.source ?? node.textContent);
      state.write('\n$$\n\n');
    },
    parseMarkdown() {
      return { node: BLOCK, noCloseToken: true, getAttrs: (token: { content: string }) => ({ source: token.content }) };
    }
  };

  const rules = {
    type: 'extension',
    name: 'math-rules',
    bindEditor,
    get rulePlugins() {
      return installRules(rejectNumericOnly);
    }
  };

  return [inlineNode, blockNode, rules];
}
