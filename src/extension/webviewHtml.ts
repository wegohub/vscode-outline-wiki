import * as vscode from 'vscode';
import { WebviewConfig, ThemeName } from '../shared/protocol.js';
import { nonce } from './workspaceModel.js';

export interface HtmlOptions {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  /** 当前文档的 URI；`<base>` 指向它，让磁盘上正确的相对链接在 webview 里原样解析 */
  docUri: vscode.Uri;
  theme: ThemeName;
  config: WebviewConfig;
  sessionId?: string;
}

/**
 * Phase 0 方案 A：`<base href="asWebviewUri(文档)">`。
 *
 * 文档与资源都根在 `.metadata/` 下，磁盘上正确的相对链接（`../../../static/upload/...`）
 * 在浏览器里按同样层数解析后正好命中，因此加载与保存都不需要改写链接。
 * 如果探针发现该方案不成立，回退方案 B（宿主侧双向改写）只改本文件与 provider 的一处开关。
 */
export function renderWikiHtml(opts: HtmlOptions): string {
  const { webview, extensionUri, docUri } = opts;
  const n = nonce();
  const asset = (...segs: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segs)).toString();

  const scriptUri = asset('dist', 'webview', 'main.js');
  const cssUri = asset('dist', 'webview', 'webview.css');
  const katexUri = asset('dist', 'webview', 'katex', 'katex.min.css');
  const mermaidUri = asset('dist', 'webview', 'mermaid.js');
  const baseHref = webview.asWebviewUri(docUri).toString();

  const mediaSrc = [`${webview.cspSource}`, opts.config.mediaAllowVideo ? 'https:' : ''].filter(Boolean).join(' ');
  const imgSrc = [`${webview.cspSource}`, 'https:', 'data:', 'blob:'].join(' ');

  const csp = [
    `default-src 'none'`,
    `script-src 'nonce-${n}' ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${imgSrc}`,
    `media-src ${mediaSrc}`,
    `font-src ${webview.cspSource}`,
    `frame-src https: http:`,
    // 父 webview 不做 XHR/fetch；用户嵌入的网页仅在独立 iframe 中联网
    `connect-src 'none'`
  ].join('; ');

  const theme = opts.theme;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<base href="${escapeAttr(baseHref)}" />
<link rel="stylesheet" href="${escapeAttr(katexUri)}" />
<link rel="stylesheet" href="${escapeAttr(cssUri)}" />
<title>Wiki</title>
</head>
<body class="outline-wiki vscode-${theme}" data-theme="${theme}">
<div id="outline-wiki-root"></div>
<script nonce="${n}">
  // 资源地址与主题交给 webview 主包；mermaid 是懒加载 chunk，按需注入 <script>
  window.__OUTLINE_WIKI__ = ${JSON.stringify({ mermaid: mermaidUri, base: baseHref, theme, sessionId: opts.sessionId })};
</script>
<script nonce="${n}" src="${escapeAttr(scriptUri)}"></script>
</body>
</html>`;
}

export function currentTheme(): ThemeName {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark';
}

export function readWebviewConfig(folder: vscode.Uri): WebviewConfig {
  const cfg = vscode.workspace.getConfiguration('outlineWiki', folder);
  const themeSetting = cfg.get<'auto' | 'light' | 'dark'>('editor.theme') ?? 'auto';
  return {
    fontSize: cfg.get<number>('editor.fontSize') ?? 16,
    themeSetting,
    readOnly: false,
    mediaAllowVideo: cfg.get<boolean>('media.allowVideo') ?? true,
    mathRejectNumericOnly: cfg.get<boolean>('math.rejectNumericOnly') ?? true,
    maxInlineUploadMB: cfg.get<number>('static.maxInlineUploadMB') ?? 16,
    allowedExtensions: cfg.get<string[]>('static.allowedExtensions') ?? []
  };
}

export function resolvedTheme(setting: 'auto' | 'light' | 'dark'): ThemeName {
  return setting === 'auto' ? currentTheme() : setting;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
