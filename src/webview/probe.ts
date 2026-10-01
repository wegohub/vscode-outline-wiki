import type { ProbeResult, ProbeSpec } from '../shared/protocol.js';
import { ingestFile } from './api.js';

/**
 * Phase 0 探针（webview 侧）。
 *
 * 全部自动化，不需要肉眼看 UI：
 *  1. editorMounted       —— rich-markdown-editor 是否真的在 webview 里渲染出可编辑区域
 *  2. baseResolution      —— `<base href="asWebviewUri(文档)">` 是否让磁盘上正确的相对链接原样命中
 *  3. mediaRangeSeek      —— 媒体资源能否流式加载并拖动（Range / 206 端到端）
 *  4. codecSupport        —— canPlayType 给出本机 webview 的编解码能力
 *  5. binaryPostMessage   —— postMessage 能否直传 Uint8Array（否则入库走 base64）
 */

interface ProbeContext {
  editorMounted: boolean;
  editorDetail: string;
  binaryEcho: boolean | null;
}

export async function runProbe(spec: ProbeSpec, ctx: ProbeContext): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];

  results.push({
    name: 'editorMounted',
    ok: ctx.editorMounted,
    detail: ctx.editorDetail
  });

  results.push(await checkPhase4Rendering(spec.expect));
  if (spec.expect?.math === 2) {
    let markdown = '';
    window.dispatchEvent(new CustomEvent('outline-wiki-read', { detail: { receive: (value: string) => { markdown = value; } } }));
    const ok = markdown.includes('$E=mc^2$') && markdown.includes('\\int_0^1 x^2') && markdown.includes('$5 and $6') && markdown.includes('```mermaid');
    results.push({ name: 'markdownRoundTrip', ok, detail: `序列化保留行内公式、块公式、货币和 Mermaid=${ok}；${markdown}` });
  }
  results.push(await checkIngestRoundTrip());
  results.push(await checkBaseResolution(spec.imageHref));
  results.push(await checkMediaSeek(spec.audioHref));
  results.push(checkCodecSupport());
  results.push({
    name: 'binaryPostMessage',
    ok: ctx.binaryEcho === true,
    detail:
      ctx.binaryEcho === null
        ? '宿主还没回二进制消息（超时？）'
        : ctx.binaryEcho
          ? 'host→webview 直传 Uint8Array 成功；二进制通道可用；当前入库实现仍使用 base64'
          : '二进制消息没有原样到达，入库继续用 base64（功能不受影响，只是膨胀 33%）'
  });

  results.push(await checkClipboardPaste());
  results.push(await checkMediaInsertion(spec.audioHref));
  results.push(await checkSlashMenus());
  if (spec.videoHref) results.push(await checkVideoAudio(spec.videoHref));
  return results;
}

/**
 * Phase 4：数学公式与 mermaid 是否真的渲染出来（用渲染后的 DOM 作为证据）。
 * 等 mermaid 懒加载 chunk 拉取 + 首次渲染，最多 8 秒。
 */
async function checkPhase4Rendering(expect?: { math?: number; mermaid?: number }): Promise<ProbeResult> {
  const name = 'phase4Render';
  const katexCount = document.querySelectorAll('.katex').length;
  const mathErrors = document.querySelectorAll('.ow-math-error').length;
  const mermaidHosts = document.querySelectorAll('.ow-mermaid').length;

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const svg = document.querySelectorAll('.ow-mermaid svg').length;
    const failed = document.querySelectorAll('.ow-mermaid-error').length;
    if (svg > 0 || failed > 0) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const mermaidSvg = document.querySelectorAll('.ow-mermaid svg').length;
  const mermaidError = document.querySelectorAll('.ow-mermaid-error').length;

  const wantMath = expect?.math ?? 0;
  const wantMermaid = expect?.mermaid ?? 0;
  const mathOk = wantMath === 0 || katexCount === wantMath; // 精确相等：多出来说明 $5 and $6 被误判成公式
  const mermaidOk = wantMermaid === 0 || mermaidSvg >= wantMermaid;
  return {
    name,
    ok: mathOk && mermaidOk && mathErrors === 0,
    detail: `KaTeX 节点 ${katexCount}（期望 ${wantMath}，精确相等才说明货币未被误判）、公式错误 ${mathErrors}；mermaid 容器 ${mermaidHosts}、SVG ${mermaidSvg}（期望 ${wantMermaid}）、错误 ${mermaidError}`
  };
}

/**
 * Phase 3：走真实入库通道提交一张 1x1 PNG，断言拿回来的相对链接形态正确。
 * 这条链路覆盖 webview → postMessage → 宿主落盘（UUID 命名）→ 索引记录 → 回填空链接。
 */
async function checkIngestRoundTrip(): Promise<ProbeResult> {
  const name = 'ingestRoundTrip';
  try {
    const png = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='),
      (c) => c.charCodeAt(0)
    );
    const file = new File([png], '探针 图片.PNG', { type: 'image/png' });
    const { href } = await ingestFile(file);
    // 前缀的 ../ 数量取决于文档自身深度（docs/src/... 是两个），所以只校验尾部形态
    const shape = /(?:\.\.\/)+static\/upload\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;
    return {
      name,
      ok: shape.test(href),
      detail: shape.test(href)
        ? `入库成功且命名合规（UUID + 日期目录 + 扩展名来自原名）：${href}`
        : `入库返回的链接形态不符：${href}`
    };
  } catch (err) {
    return { name, ok: false, detail: `入库失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

async function checkBaseResolution(imageHref: string): Promise<ProbeResult> {  const name = 'baseResolution';
  if (!imageHref) return { name, ok: false, detail: '没有传入图片链接' };
  const url = new URL(imageHref, document.baseURI).toString();
  return new Promise<ProbeResult>((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve({ name, ok: false, detail: `超时未加载：${imageHref}` }), 8000);
    img.onload = () => {
      clearTimeout(timer);
      resolve({
        name,
        ok: img.naturalWidth > 0,
        detail: `相对链接 ${imageHref} 解析为 ${url}，尺寸 ${img.naturalWidth}x${img.naturalHeight}`
      });
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve({
        name,
        ok: false,
        detail: `相对链接 ${imageHref} 解析为 ${url} 加载失败 —— 方案 A 不成立，需回退方案 B（宿主侧双向改写）`
      });
    };
    img.src = imageHref;
  });
}

async function checkMediaSeek(audioHref: string): Promise<ProbeResult> {
  const name = 'mediaRangeSeek';
  if (!audioHref) return { name, ok: false, detail: '没有传入音频链接' };
  const url = new URL(audioHref, document.baseURI).toString();
  const audio = document.createElement('audio');
  audio.preload = 'metadata';
  audio.src = audioHref;
  audio.style.display = 'none';
  document.body.appendChild(audio);

  try {
    await waitFor(audio, 'loadedmetadata', 8000);
    const duration = audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      return { name, ok: false, detail: `拿到了元数据但时长无效：${duration}（${url}）` };
    }
    const target = Math.min(duration * 0.6, Math.max(0, duration - 0.05));
    audio.currentTime = target;
    await waitFor(audio, 'seeked', 8000);
    const landed = audio.currentTime;
    const ok = Math.abs(landed - target) < 0.6;
    return {
      name,
      ok,
      detail: `时长 ${duration.toFixed(2)}s，seek→${landed.toFixed(2)}s（目标 ${target.toFixed(2)}s），buffered 段数 ${audio.buffered.length}${ok ? '' : '（seek 未生效）'}`
    };
  } catch (err) {
    return { name, ok: false, detail: `播放/拖动失败：${String(err)}（${url}）` };
  } finally {
    audio.remove();
  }
}

function checkCodecSupport(): ProbeResult {
  const probe = (type: string) => {
    const el = document.createElement('video');
    const verdict = el.canPlayType(type);
    return `${type} → ${verdict === '' ? '不支持' : verdict}`;
  };
  const cases = [
    'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
    'video/mp4; codecs="hvc1.1.6.L93.B0"',
    'video/webm; codecs="vp9, opus"',
    'video/webm; codecs="av01.0.05M.08"',
    'audio/wav',
    'audio/mpeg',
    'audio/flac',
    'audio/ogg; codecs="opus"',
    'video/x-matroska; codecs="avc1.42E01E"'
  ];
  const lines = cases.map(probe);
  const h264 = lines[0]!.endsWith('probably') || lines[0]!.endsWith('maybe');
  return {
    name: 'codecSupport',
    ok: h264,
    detail: lines.join('\n')
  };
}

function waitFor(target: HTMLMediaElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待 ${event} 超时`));
    }, timeoutMs);
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`媒体错误 ${String(target.error?.message ?? target.error?.code ?? 'unknown')}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, onEvent);
      target.removeEventListener('error', onError);
    };
    target.addEventListener(event, onEvent);
    target.addEventListener('error', onError);
  });
}


async function checkClipboardPaste(): Promise<ProbeResult> {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
  const clipboard = new DataTransfer();
  clipboard.items.add(new File([png], 'clipboard-probe.png', { type: 'image/png' }));
  const editor = document.querySelector('.ProseMirror');
  editor?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  const deadline = Date.now() + 8000;
  let image: HTMLImageElement | null = null;
  while (Date.now() < deadline) {
    image = document.querySelector('img[alt="clipboard-probe.png"]');
    if (image?.complete && image.naturalWidth > 0) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const silent = !document.querySelector('.ow-toasts')?.textContent?.match(/正在写入|已插入/);
  return { name: 'clipboardPasteImage', ok: Boolean(image?.naturalWidth) && silent,
    detail: `真实 paste 事件后图片已插入并加载=${Boolean(image?.naturalWidth)}，没有成功弹窗=${silent}；src=${image?.getAttribute('src')}` };
}

async function checkSlashMenus(): Promise<ProbeResult> {
  window.dispatchEvent(new CustomEvent('outline-wiki-probe-menu', { detail: '视频' }));
  await new Promise(resolve => setTimeout(resolve, 200));
  const video = [...document.querySelectorAll('#block-menu-container button')].some(button => button.textContent?.trim() === '视频');
  window.dispatchEvent(new CustomEvent('outline-wiki-probe-menu', { detail: 'embed' }));
  await new Promise(resolve => setTimeout(resolve, 200));
  const embed = [...document.querySelectorAll<HTMLButtonElement>('#block-menu-container button')].find(button => button.textContent?.trim() === '网页嵌入');
  embed?.click();
  await new Promise(resolve => setTimeout(resolve, 100));
  const input = document.querySelector<HTMLInputElement>('#block-menu-container input[type="text"]');
  if (input) {
    input.value = 'https://example.org/';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  const frame = document.querySelector<HTMLIFrameElement>('.ow-webpage iframe');
  let serialized = '';
  window.dispatchEvent(new CustomEvent('outline-wiki-read', { detail: { receive: (value: string) => { serialized = value; } } }));
  if (frame?.contentWindow) {
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'externalUpdate', rev: 99, markdown: 'untrusted-iframe-message' } }));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  let isolated = '';
  window.dispatchEvent(new CustomEvent('outline-wiki-read', { detail: { receive: (value: string) => { isolated = value; } } }));
  const safe = isolated === serialized;
  return { name: 'slashVideoAndWebEmbed', ok: safe && video && Boolean(input) && frame?.getAttribute('src') === 'https://example.org/' && serialized.includes('[https://example.org/](https://example.org/)'),
    detail: `/视频菜单=${video}，/embed地址输入=${Boolean(input)}，iframe=${frame?.getAttribute('src')}，子网页消息隔离=${safe}，Markdown保留网页链接=${serialized.includes('[https://example.org/](https://example.org/)')}` };
}


async function checkMediaInsertion(href: string): Promise<ProbeResult> {
  window.dispatchEvent(new CustomEvent('outline-wiki-probe-insert', { detail: `[${href}](${href})` }));
  const deadline = Date.now() + 5000;
  let audio: HTMLAudioElement | null = null;
  while (Date.now() < deadline) {
    audio = document.querySelector('.ow-media audio');
    if (audio && audio.duration > 0) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  let markdown = '';
  window.dispatchEvent(new CustomEvent('outline-wiki-read', { detail: { receive: (value: string) => { markdown = value; } } }));
  return { name: 'mediaNodeInsertion', ok: Boolean(audio && audio.duration > 0) && markdown.includes(`[${href}](${href})`),
    detail: `宿主插入通道的 embed 节点保留=${Boolean(audio)}，媒体元数据时长=${audio?.duration}，Markdown 保留引用=${markdown.includes(`[${href}](${href})`)}；${markdown}` };
}



async function checkVideoAudio(href: string): Promise<ProbeResult> {
  window.dispatchEvent(new CustomEvent('outline-wiki-probe-insert', { detail: `[${href}](${href})` }));
  const deadline = Date.now() + 30000;
  let player: HTMLElement | null = null;
  let video: HTMLVideoElement | null = null;
  while (Date.now() < deadline) {
    player = document.querySelector('.ow-video-player');
    video = player?.querySelector('video') ?? null;
    if (video && video.readyState > 0 && video.getAttribute('src')?.endsWith('.mov')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  let bytes = 0, seek = Infinity, pausedStable = false;
  if (video) {
    video.currentTime = 120;
    const seekDeadline = Date.now() + 5000;
    while (video.seeking && Date.now() < seekDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    seek = Math.abs(video.currentTime - 120);
    video.volume = 0.25; video.playbackRate = 1.5; video.muted = true;
    try {
      await video.play();
      await new Promise(resolve => setTimeout(resolve, 1000));
      bytes = (video as HTMLVideoElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount ?? 0;
    } catch { /* 结果会报告实际解码失败 */ }
    video.pause();
    const time = video.currentTime;
    await new Promise(resolve => setTimeout(resolve, 150));
    pausedStable = Math.abs(video.currentTime - time) < 0.05;
  }
  const single = Boolean(video?.controls && !player?.querySelector('audio') && !player?.querySelector('.ow-video-tools'));
  return { name: 'nativeVideoAudioControls', ok: single && bytes > 0 && seek < 0.3 && pausedStable && video?.volume === 0.25 && video.playbackRate === 1.5,
    detail: `单个原生 video=${single}，兼容 MOV 时长=${video?.duration}，实际解码音频字节=${bytes}，跳到120s误差=${seek}s，暂停稳定=${pausedStable}，原生音量=${video?.volume}，倍速=${video?.playbackRate}，无独立音轨/额外控件=${single}` };
}
